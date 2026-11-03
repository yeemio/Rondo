import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const LIMITS = Object.freeze({ sourceBytes: 32768, inputBytes: 16384, outputBytes: 65536, binaryBytes: 7 * 1024 * 1024, compileWallMs: 30000, runWallMs: 3000, runCpuSeconds: 2, compileMemoryMiB: 512, runMemoryMiB: 128, scratchMiB: 8, queuedJobs: 4, sessionJobs: 100 });
const TERMINAL = new Set(['OK', 'COMPILE_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT', 'BINARY_LIMIT', 'CANCELLED', 'CAPABILITY_UNAVAILABLE', 'INTERNAL_ERROR', 'UNKNOWN']);
const WORKER_RESULTS = new Set(['OK', 'COMPILE_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT', 'BINARY_LIMIT', 'INTERNAL_ERROR']);
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function docker(args, { input, timeoutMs = 10000, maxBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['--context', 'orbstack', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = [], err = [], count = 0, reason;
    const timeout = setTimeout(() => { reason = new Error('Docker command timed out'); child.kill('SIGKILL'); }, timeoutMs);
    const consume = target => chunk => {
      count += chunk.length;
      if (count > maxBytes) { reason = new Error('Docker response exceeded limit'); child.kill('SIGKILL'); }
      else target.push(chunk);
    };
    child.stdout.on('data', consume(out)); child.stderr.on('data', consume(err));
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); if (reason) reject(reason); else resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class CompilerService {
  constructor(config) {
    this.config = config;
    this.instanceId = randomUUID();
    this.jobs = new Map(); this.requests = new Map(); this.removals = new Map(); this.queue = [];
    this.active = null; this.closed = false; this.available = false;
  }

  async verify() {
    const context = await docker(['context', 'inspect', 'orbstack', '--format', '{{.Endpoints.docker.Host}}']);
    if (context.code || !context.stdout.toString().trim().startsWith('unix://')) throw new Error('A local Unix-socket Docker context is required');
    if (!/^sha256:[a-f0-9]{64}$/.test(this.config.imageId)) throw new Error('Worker image must be pinned by image ID');
    const image = await docker(['image', 'inspect', this.config.imageId, '--format', '{{.Id}} {{.Os}}/{{.Architecture}}']);
    if (image.code || image.stdout.toString().trim() !== `${this.config.imageId} linux/arm64`) throw new Error('Pinned worker image is unavailable or has a different platform');
    const info = await docker(['info', '--format', '{{json .SecurityOptions}} {{.CgroupVersion}} {{.OSType}}']);
    if (info.code || !info.stdout.toString().includes('name=seccomp') || !info.stdout.toString().trim().endsWith('2 linux')) throw new Error('seccomp and cgroup v2 are required');
    this.available = true;
  }

  capability() {
    return { available: this.available && !this.closed, instanceId: this.instanceId, compilerContractId: this.config.compilerContractId, compiler: 'GNU g++ 13.2.0', standard: 'C++11', flags: ['-O2', '-std=c++11', '-DONLINE_JUDGE'], platform: 'Linux arm64', imageId: this.config.imageId, limits: LIMITS, scope: 'local-design-workbench', persistence: 'memory-only', grading: false };
  }

  submit(payload) {
    if (!this.available || this.closed) throw Object.assign(new Error('编译环境不可用'), { statusCode: 503 });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['requestId', 'source', 'stdin'].includes(key))) throw Object.assign(new Error('请求字段不正确'), { statusCode: 400 });
    const { requestId, source, stdin = '' } = payload;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId) || typeof source !== 'string' || typeof stdin !== 'string') throw Object.assign(new Error('需要请求标识、代码和输入文本'), { statusCode: 400 });
    if (!source.trim() || Buffer.byteLength(source, 'utf8') > LIMITS.sourceBytes || Buffer.byteLength(stdin, 'utf8') > LIMITS.inputBytes) throw Object.assign(new Error('代码限 32 KiB，输入限 16 KiB'), { statusCode: 413 });
    const digest = sha256(JSON.stringify([source, stdin, this.config.compilerContractId]));
    if (this.requests.has(requestId)) {
      const existing = this.jobs.get(this.requests.get(requestId));
      if (existing.digest !== digest) throw Object.assign(new Error('同一请求标识不能提交不同代码'), { statusCode: 409 });
      return this.read(existing.id);
    }
    if (this.queue.length >= LIMITS.queuedJobs || this.jobs.size >= LIMITS.sessionJobs) throw Object.assign(new Error('本次工作台队列已满'), { statusCode: 429 });
    const id = randomUUID();
    const job = { id, requestId, source, stdin, digest, sourceHash: sha256(source), inputHash: sha256(stdin), state: 'QUEUED', phase: 'queue', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), container: null, cancelRequested: false, containers: [], executionCount: 0, result: null };
    this.jobs.set(id, job); this.requests.set(requestId, id); this.queue.push(id);
    queueMicrotask(() => this.pump());
    return this.read(id);
  }

  read(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { id: job.id, requestId: job.requestId, instanceId: this.instanceId, state: job.state, phase: job.phase, terminal: TERMINAL.has(job.state), createdAt: job.createdAt, updatedAt: job.updatedAt, compilerContractId: this.config.compilerContractId, imageId: this.config.imageId, platform: this.config.platform, sourceHash: job.sourceHash, inputHash: job.inputHash, executionCount: job.executionCount, cancelRequested: job.cancelRequested, result: job.result };
  }

  setState(job, state, phase = job.phase) { job.state = state; job.phase = phase; job.updatedAt = new Date().toISOString(); }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL.has(job.state)) return this.read(id);
    job.cancelRequested = true;
    if (job.state === 'QUEUED') {
      this.queue = this.queue.filter(key => key !== id); this.setState(job, 'CANCELLED');
    } else {
      this.setState(job, 'CANCEL_REQUESTED');
      if (job.container) await this.removeContainer(job.container);
    }
    return this.read(id);
  }

  async removeContainer(name) {
    // This name is generated here and never accepted from an HTTP request.
    if (!name.startsWith(`rondo-cpp-${this.instanceId.slice(0, 8)}-`)) throw new Error('Foreign container rejected');
    // Cancellation and completion share the same removal and absence readback.
    if (this.removals.has(name)) return this.removals.get(name);
    const removal = (async () => {
      await docker(['rm', '-f', name], { timeoutMs: 10000, maxBytes: 8192 });
      const check = await docker(['container', 'inspect', name, '--format', '{{.State.Running}}'], { maxBytes: 8192 });
      if (check.code !== 0 && /No such (object|container)/i.test(check.stderr.toString())) return true;
      throw new Error('Container removal could not be confirmed');
    })().finally(() => this.removals.delete(name));
    this.removals.set(name, removal);
    return removal;
  }

  async container(job, phase, input) {
    const compile = phase === 'compile';
    const name = `rondo-cpp-${this.instanceId.slice(0, 8)}-${job.id}-${phase}`;
    const memory = compile ? 512 : 128;
    const args = ['create', '-i', '--name', name, '--label', 'org.rondo.scope=cpp-workbench-20261028', '--label', `org.rondo.instance=${this.instanceId}`, '--network=none', '--ipc=none', '--cgroupns=private', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=65534:65534', '--pids-limit', compile ? '64' : '2', '--memory', `${memory}m`, '--memory-swap', `${memory}m`, '--cpus=1', '--ulimit', 'core=0:0', '--ulimit', 'nofile=64:64', '--tmpfs', '/work:rw,exec,nosuid,nodev,size=8388608,mode=1777', '--workdir=/work', '--restart=no', '--log-driver=none', this.config.imageId, phase];
    let removed = false;
    const created = await docker(args, { maxBytes: 8192 });
    if (created.code !== 0) throw new Error(`Container creation failed: ${created.stderr.toString().slice(0, 300)}`);
    job.container = name; job.containers.push(name);
    try {
      if (job.cancelRequested) { await this.removeContainer(name); removed = true; return { cancelled: true }; }
      const watchdog = setTimeout(() => { job.watchdog = true; this.removeContainer(name).catch(() => {}); }, compile ? 40000 : 10000);
      let result;
      try { result = await docker(['start', '-a', '-i', name], { input, timeoutMs: compile ? 45000 : 15000 }); }
      finally { clearTimeout(watchdog); }
      if (job.cancelRequested) { await this.removeContainer(name); removed = true; return { cancelled: true }; }
      if (job.watchdog) throw new Error('Worker supervision did not return a confirmed result');
      const state = await docker(['container', 'inspect', name, '--format', '{{json .State}}'], { maxBytes: 8192 });
      if (state.code) throw new Error('Worker state unavailable');
      const readback = JSON.parse(state.stdout.toString());
      if (readback.Running) throw new Error('Worker did not stop');
      if (readback.OOMKilled) return { status: 'MEMORY_LIMIT', stdout: '', stderr: '', cpuMs: null, wallMs: null, maxRssKiB: null, exitCode: readback.ExitCode, signal: 9 };
      if (result.code !== 0) throw new Error(`Worker protocol failed (${result.code}): ${result.stderr.toString().slice(0, 300)}`);
      const lineEnd = result.stdout.indexOf(10);
      if (lineEnd < 0 || lineEnd > 180000) throw new Error('Malformed worker response');
      const data = JSON.parse(result.stdout.subarray(0, lineEnd).toString('utf8'));
      const binary = result.stdout.subarray(lineEnd + 1);
      if (!WORKER_RESULTS.has(data.status) || !Number.isInteger(data.binaryBytes) || data.binaryBytes !== binary.length || binary.length > LIMITS.binaryBytes) throw new Error('Invalid worker result');
      if (typeof data.stdoutB64 !== 'string' || typeof data.stderrB64 !== 'string') throw new Error('Invalid worker output');
      const stdout = Buffer.from(data.stdoutB64, 'base64'), stderr = Buffer.from(data.stderrB64, 'base64');
      if (stdout.length + stderr.length > LIMITS.outputBytes) throw new Error('Worker output limit was not enforced');
      return { status: data.status, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutBytes: stdout.length, stderrBytes: stderr.length, cpuMs: data.cpuMs, wallMs: data.wallMs, maxRssKiB: data.maxRssKiB, exitCode: data.exitCode, signal: data.signal, binary };
    } finally {
      if (!removed) await this.removeContainer(name);
      job.container = null;
    }
  }

  async pump() {
    if (this.active || this.closed || !this.queue.length) return;
    const job = this.jobs.get(this.queue.shift()); this.active = job.id;
    try {
      this.setState(job, 'COMPILING', 'compile'); job.executionCount += 1;
      const compiled = await this.container(job, 'compile', Buffer.from(job.source, 'utf8'));
      if (compiled.cancelled || job.cancelRequested) { this.setState(job, 'CANCELLED'); return; }
      const { binary, ...compileResult } = compiled;
      job.result = { compilation: compileResult, execution: null };
      if (compiled.status !== 'OK') { this.setState(job, compiled.status); return; }
      if (!binary?.length) throw new Error('Compiler returned no executable');
      const input = Buffer.from(job.stdin, 'utf8'), header = Buffer.alloc(8);
      header.writeUInt32LE(binary.length, 0); header.writeUInt32LE(input.length, 4);
      this.setState(job, 'RUNNING', 'run');
      const executed = await this.container(job, 'run', Buffer.concat([header, binary, input]));
      if (executed.cancelled || job.cancelRequested) { this.setState(job, 'CANCELLED'); return; }
      const { binary: ignored, ...execution } = executed;
      job.result.execution = execution; this.setState(job, executed.status);
    } catch (error) {
      job.result = { ...job.result, infrastructureError: String(error.message).slice(0, 400) };
      this.setState(job, 'UNKNOWN');
    } finally {
      this.active = null;
      queueMicrotask(() => this.pump());
    }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.jobs.values()].filter(job => !TERMINAL.has(job.state)).map(job => this.cancel(job.id)));
  }

  /** Called only with server-resolved logical runs after their learning-data deletion commits. */
  forgetDeletionRun(runId, instanceId) {
    if (instanceId !== this.instanceId) return { owned: false, deleted: 0, pending: 0 };
    const privatePrefix = `${runId}-private-`;
    const matches = [...this.jobs.values()].filter(job => job.requestId === `${runId}-visible` ||
      (job.requestId.startsWith(privatePrefix) && /^(0|[1-9][0-9]*)$/.test(job.requestId.slice(privatePrefix.length))));
    let deleted = 0, pending = 0;
    for (const job of matches) {
      if (!TERMINAL.has(job.state) || job.state === 'UNKNOWN' || job.container || this.active === job.id ||
          this.queue.includes(job.id) || job.containers.some(name => this.removals.has(name))) { pending++; continue; }
      this.jobs.delete(job.id);
      if (this.requests.get(job.requestId) === job.id) this.requests.delete(job.requestId);
      deleted++;
    }
    return { owned: true, deleted, pending };
  }
}

export async function configuredService() {
  const config = JSON.parse(await readFile(new URL('./worker-lock.json', import.meta.url), 'utf8'));
  const service = new CompilerService(config); await service.verify(); return service;
}
