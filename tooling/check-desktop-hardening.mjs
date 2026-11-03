#!/usr/bin/env node
/**
 * check:desktop-hardening — adversarial real-window rounds that extend (and
 * never weaken) check:desktop. Three app launches against one throwaway data
 * root:
 *
 *  launch 1 (RONDO_HARDENING_CHECK=1): the app itself opens a hidden second
 *    BrowserWindow with the SAME preload on a harness-supplied file:// origin
 *    (only Main can attach a preload, so the harness cannot build this attack
 *    surface alone). H1 drives every public channel (Rondo/RondoAuth/
 *    RondoDesktop/RondoPlatform) from that untrusted sender and asserts each
 *    is refused with UNKNOWN_RENDERER, ipc-sender-denied is logged, and the
 *    main window is unaffected. H2 externally SIGKILLs the Host utility
 *    process while a batch of queries is in flight and asserts disconnect
 *    detection (host-exit + STOPPED projection), pending-read loss semantics
 *    (HOST_DISCONNECTED, no fabricated data), no READY illusion, and that the
 *    quit flow still finishes cleanly (H3).
 *
 *  launch 2 (recovery entry): asserts recovery on the same data root with a
 *    NEW host epoch, then H2b fires commands at the Host and SIGKILLs it:
 *    pending writes must surface RECEIPT_UNKNOWN and the quit flow must NOT
 *    silently exit while unknown writes exist (it must stay blocked in the
 *    prompting phase — the discard dialog is a native surface the harness
 *    cannot click, so the instance is externally force-quit, which is itself
 *    the real "user force-quits at the prompt" scenario).
 *
 *  launch 3 (recovery again): asserts a new epoch again and a fully clean
 *    quit (host-db-closed walCheckpointed, host-exit before app-exit, exit 0).
 *
 * Evidence: renderer surfaces via CDP + structured lifecycle logs. Every
 * unverifiable step is recorded NOT_RUN/FAIL with its reason — never faked.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = join(root, 'node_modules', '.bin', 'electron');
const mainBundle = join(root, 'dist', 'main', 'index.cjs');
const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

function readJsonLines(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    // Without this, a page/app teardown (e.g. the real quit under test)
    // leaves pending calls unresolved and the harness could even exit 0
    // silently once no other handles remain.
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('cdp connection closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', resolveOpen);
      ws.addEventListener('error', () => rejectOpen(new Error(`ws connect failed: ${url}`)));
    });
    return new Cdp(ws);
  }
  call(method, params) {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(message);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    }
    return result.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function findPageTarget(port, urlPrefix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await waitForHttp(`http://127.0.0.1:${port}/json`, 5000).catch(() => []);
    const page = targets.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix));
    if (page) return page;
    await sleep(400);
  }
  throw new Error(`timeout waiting for page target ${urlPrefix}`);
}

async function pollEvaluate(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      // awaitPromise:true works for plain values too, and is REQUIRED for
      // promise-producing expressions (hostStatus().then(...)) — with false
      // the evaluate never observes the settled value.
      const value = await cdp.evaluate(expression, { awaitPromise: true });
      if (value) return value;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError}` : ''}`);
}

const BRIDGES = '!!(window.Rondo && window.RondoAuth && window.RondoDesktop && window.RondoPlatform)';

function spawnApp(dataRoot, extraEnv) {
  const port = freePort();
  return port.then((resolvedPort) => {
    const child = spawn(
      electronBin,
      [`--remote-debugging-port=${resolvedPort}`, mainBundle],
      {
        env: { ...process.env, RONDO_DATA_ROOT: dataRoot, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`));
    const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    return { child, exit, port: resolvedPort };
  });
}

function psLines() {
  const out = execSync('ps -axo pid=,ppid=,command=', { encoding: 'utf8' });
  const lines = [];
  for (const line of out.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) lines.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return lines;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The real Electron main process (child of the npm cli wrapper we spawned). */
function findElectronMainPid(wrapperPid) {
  const hit = psLines().find(
    (l) =>
      l.ppid === wrapperPid &&
      l.command.includes('Electron.app/Contents/MacOS/Electron') &&
      l.command.includes('dist/main/index.cjs'),
  );
  if (hit) return hit.pid;
  const loose = psLines().find((l) => l.command.includes('Electron.app/Contents/MacOS/Electron') && l.command.includes('dist/main/index.cjs'));
  if (loose) return loose.pid;
  throw new Error('electron main process not found in process table');
}

/**
 * The Host utility process: Chromium marks utilityProcess children with
 * --type=utility --utility-sub-type=node.mojom.NodeService (the entry path is
 * NOT in argv — verified empirically on Electron 44 / macOS). Scoped to our
 * app instance by parent pid AND the data-root-scoped --user-data-dir.
 */
function findHostPid(electronMainPid, dataRoot) {
  const userDataDir = join(dataRoot, 'desktop');
  const candidates = psLines().filter(
    (l) =>
      l.command.includes('--utility-sub-type=node.mojom.NodeService') &&
      l.command.includes(`--user-data-dir=${userDataDir}`),
  );
  if (candidates.length === 1) {
    const scoped = candidates.find((l) => l.ppid === electronMainPid);
    return { pid: candidates[0].pid, parentMatched: Boolean(scoped) };
  }
  const byParent = candidates.filter((l) => l.ppid === electronMainPid);
  if (byParent.length === 1) return { pid: byParent[0].pid, parentMatched: true };
  throw new Error(`host utility process not uniquely identifiable (candidates=${candidates.length})`);
}

function segmentBy(list, startEvent) {
  const segments = [];
  let current = null;
  for (const line of list) {
    if (line.event === startEvent) {
      if (current) segments.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) segments.push(current);
  return segments;
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '-';
  console.log(`${tag} ${name}: ${detail}`);
}

const uuidPage = "(crypto.randomUUID ? crypto.randomUUID() : 'probe-' + Date.now() + '-' + Math.random().toString(16).slice(2))";

/** Fires a batch of in-flight Host requests from the real preload surface and
 *  records every outcome into window.__probe without awaiting. */
function probeExpression(protocolVersion, queries, commands) {
  const parts = [];
  for (let i = 0; i < queries; i += 1) {
    parts.push(`window.Rondo.query({ kind: 'catalog.availableLessons' }).then(
      (r) => window.__probe.push({ t: 'query', answered: !!(r && r.ok), transport: (r && r.transport) || null, code: (r && r.error && r.error.code) || null, status: (r && r.value && r.value.status) || null }),
      (e) => window.__probe.push({ t: 'query', threw: String((e && (e.transport || e.message)) || e).slice(0, 120) })
    );`);
  }
  for (let i = 0; i < commands; i += 1) {
    parts.push(`window.Rondo.command({
      protocolVersion: ${JSON.stringify(protocolVersion)},
      commandId: ${uuidPage},
      idempotencyKey: ${uuidPage},
      kind: 'family.createLearner',
      target: { scope: 'FAMILY' },
      payload: { alias: 'rondo-probe' }
    }).then(
      (r) => window.__probe.push({ t: 'command', answered: !!(r && r.ok), transport: (r && r.transport) || null, code: (r && r.error && r.error.code) || null, receipt: (r && r.value && r.value.status) || null }),
      (e) => window.__probe.push({ t: 'command', threw: String((e && (e.transport || e.message)) || e).slice(0, 120) })
    );`);
  }
  return `(function () {
    window.__probe = [];
    ${parts.join('\n')}
    return ${queries + commands};
  })()`;
}

const LOST_QUERY_TRANSPORTS = new Set(['HOST_DISCONNECTED', 'HOST_RESPONSE_UNKNOWN']);
const LOST_COMMAND_TRANSPORTS = new Set(['RECEIPT_UNKNOWN', 'HOST_DISCONNECTED']);

/**
 * Classifies probe outcomes. `transport: null` means Desktop Main answered
 * from the Host itself (domain errors keep no transport) — i.e. the request
 * was answered before the kill. Pending-at-death requests surface the lost
 * transports; a RECEIPT_UNKNOWN count is the pending-WRITE proof.
 */
function classifyProbe(probe, expected) {
  const hostAnswered = probe.filter((p) => p.answered === true || (p.answered === false && p.transport === null));
  const lostQueries = probe.filter((p) => p.t === 'query' && p.answered === false && LOST_QUERY_TRANSPORTS.has(p.transport));
  const lostCommands = probe.filter((p) => p.t === 'command' && p.answered === false && LOST_COMMAND_TRANSPORTS.has(p.transport));
  const other = probe.filter((p) => !hostAnswered.includes(p) && !lostQueries.includes(p) && !lostCommands.includes(p));
  const complete = hostAnswered.length + lostQueries.length + lostCommands.length === expected && other.length === 0;
  const receiptUnknown = lostCommands.filter((p) => p.transport === 'RECEIPT_UNKNOWN').length;
  return { hostAnswered, lostQueries, lostCommands, other, complete, receiptUnknown };
}

async function connectAndReady(app, label, timeoutMs = 90000) {
  const mainPage = await findPageTarget(app.port, 'rondo://app', timeoutMs);
  const cdp = await Cdp.connect(mainPage.webSocketDebuggerUrl);
  await pollEvaluate(cdp, BRIDGES, 30000, `${label} preload bridges`);
  await pollEvaluate(
    cdp,
    "window.RondoDesktop.hostStatus().then((r) => !!r.ok && r.value.hostPhase === 'READY')",
    timeoutMs,
    `${label} host READY`,
  );
  return cdp;
}

async function main() {
  if (!existsSync(mainBundle)) {
    console.error('check:desktop-hardening FAIL: dist/main/index.cjs missing — run npm run build first');
    process.exit(1);
  }
  const dataRoot = mkdtempSync(join(tmpdir(), 'rondo-hardening-'));
  console.log(`synthetic data root: ${dataRoot}`);

  let failed = false;
  const meta = { dataRoot, launches: [] };

  // Minimal attacker page on a real file:// origin (a genuinely foreign origin
  // for the sender/origin assertions; about:blank would be an opaque origin).
  const attackerDir = mkdtempSync(join(tmpdir(), 'rondo-attacker-'));
  const attackerHtml = join(attackerDir, 'attacker.html');
  writeFileSync(attackerHtml, '<!doctype html><title>attacker probe</title><p>foreign-origin probe page</p>\n');
  const foreignUrl = pathToFileURL(attackerHtml).href;

  const desktopLogPath = join(dataRoot, 'technical', 'logs', 'desktop-lifecycle.log');
  const hostLogPath = join(dataRoot, 'technical', 'logs', 'host-lifecycle.log');

  let cleanupPids = [];
  try {
    // ------------------------------------------------------------------
    // Launch 1: foreign-window attack + Host SIGKILL + quit-after-crash
    // ------------------------------------------------------------------
    const app1 = await spawnApp(dataRoot, {
      RONDO_HARDENING_CHECK: '1',
      RONDO_HARDENING_FOREIGN_URL: foreignUrl,
    });
    meta.launches.push({ label: 'launch1', foreignWindow: foreignUrl });
    cleanupPids.push(app1.child.pid);
    const electronMainPid = findElectronMainPid(app1.child.pid);
    cleanupPids.push(electronMainPid);
    let cdpMain = null;
    try {
      cdpMain = await connectAndReady(app1, 'launch1');
      const info1 = await cdpMain.evaluate('window.RondoPlatform.info()');
      const pv1 = info1.value?.protocolVersion;
      const epoch1 = info1.value?.host?.hostEpoch ?? null;
      meta.epoch1 = epoch1;
      record('launch1: 基线 Host READY + 身份读回', epoch1 ? 'PASS' : 'FAIL', `epoch=${epoch1 ? String(epoch1).slice(0, 8) : '无'}`);
      const baselineQuery = await cdpMain.evaluate("window.Rondo.query({ kind: 'catalog.availableLessons' })");
      record(
        'launch1: 基线 query 稳定错误读回',
        baselineQuery && baselineQuery.ok === false && baselineQuery.error?.code === 'UNAUTHENTICATED' ? 'PASS' : 'FAIL',
        JSON.stringify(baselineQuery).slice(0, 160),
      );

      // --- H1: foreign-window sender/frame/origin rejection -------------
      let cdpAtk = null;
      try {
        const atkPage = await findPageTarget(app1.port, 'file://', 20000);
        cdpAtk = await Cdp.connect(atkPage.webSocketDebuggerUrl);
        let mounted = true;
        try {
          await pollEvaluate(cdpAtk, BRIDGES, 15000, 'attacker preload bridges');
        } catch (err) {
          mounted = false;
          record(
            'H1: 外源窗口 preload 挂载（file:// + 同 preload）',
            'FAIL',
            `preload 未在外源 origin 挂载：${err instanceof Error ? err.message : String(err)}`,
          );
          failed = true;
        }
        if (mounted) {
          record('H1: 外源窗口构造（file:// 源 + 同 preload + 桥可用）', 'PASS', foreignUrl);

          const pv = pv1;
          const channels = [
            ['rondo:command', `window.Rondo.command({ protocolVersion: ${JSON.stringify(pv)}, commandId: ${uuidPage}, idempotencyKey: ${uuidPage}, kind: 'family.createLearner', target: { scope: 'FAMILY' }, payload: { alias: 'rondo-probe' } })`],
            ['rondo:query', "window.Rondo.query({ kind: 'catalog.availableLessons' })"],
            ['rondo:receipt', `window.Rondo.receipt({ idempotencyKey: ${uuidPage}, commandKind: 'family.createLearner' })`],
            ['rondo:auth:setupGuardian', `window.RondoAuth.setupGuardian({ idempotencyKey: ${uuidPage}, familyDisplayName: '探针家庭', guardianDisplayName: '探针', passphrase: 'probe-passphrase-000' })`],
            ['rondo:auth:unlockGuardian', "window.RondoAuth.unlockGuardian({ passphrase: 'probe-passphrase-000' })"],
            ['rondo:auth:enterLearner', `window.RondoAuth.enterLearner({ learnerId: ${uuidPage} })`],
            ['rondo:auth:lock', 'window.RondoAuth.lock()'],
            ['rondo:auth:session', 'window.RondoAuth.session()'],
            ['rondo:desktop:saveExport', `window.RondoDesktop.saveExport({ preparedExportRef: ${uuidPage} })`],
            ['rondo:desktop:requestQuit', 'window.RondoDesktop.requestQuit()'],
            ['rondo:desktop:cancelQuit', 'window.RondoDesktop.cancelQuit()'],
            ['rondo:desktop:hostStatus', 'window.RondoDesktop.hostStatus()'],
            ['rondo:platform:info', 'window.RondoPlatform.info()'],
            ['rondo:view:getEvaluation', `window.rondo.view.getEvaluation({ cycleId: ${uuidPage} })`],
            ['rondo:view:nowMs', 'window.rondo.view.nowMs()'],
          ];
          for (const [channel, expression] of channels) {
            let outcome;
            let detail;
            try {
              const res = await cdpAtk.evaluate(expression);
              if (res && res.ok === false && res.error?.code === 'UNKNOWN_RENDERER') {
                outcome = 'PASS';
                detail = `拒绝：UNKNOWN_RENDERER${res.transport ? ` transport=${res.transport}` : ''}`;
              } else {
                outcome = 'FAIL';
                detail = `非预期返回：${JSON.stringify(res).slice(0, 200)}`;
              }
            } catch (err) {
              outcome = 'FAIL';
              detail = `调用异常：${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
            }
            record(`H1: 拒绝 ${channel}（外源 sender）`, outcome, detail);
            if (outcome === 'FAIL') failed = true;
          }

          const segments1 = segmentBy(readJsonLines(desktopLogPath), 'app-start');
          const denied = (segments1[0] ?? []).filter((l) => l.event === 'ipc-sender-denied');
          const reasons = new Set(denied.map((l) => l.reason));
          record(
            'H1: ipc-sender-denied 逐次记录（全部通道，reason=sender）',
            denied.length >= channels.length && reasons.size === 1 && reasons.has('sender') ? 'PASS' : 'FAIL',
            `denied=${denied.length} channels=${channels.length} reasons=${[...reasons].join(',') || '无'}`,
          );
          if (!(denied.length >= channels.length && reasons.has('sender'))) failed = true;

          const foreignWindowLine = (segments1[0] ?? []).find((l) => l.event === 'window-created' && l.foreign === true);
          record('H1: 外源窗口生命周期记录（foreign 标记）', foreignWindowLine ? 'PASS' : 'FAIL', foreignWindowLine ? `windowId=${foreignWindowLine.windowId}` : '缺少 foreign window-created');

          // Main window unaffected: same epoch, still READY, identical stable
          // host-answered error, app process alive despite the attacker's
          // denied requestQuit.
          await sleep(1000);
          const afterStatus = await cdpMain.evaluate('window.RondoDesktop.hostStatus()');
          const afterInfo = await cdpMain.evaluate('window.RondoPlatform.info()');
          const afterQuery = await cdpMain.evaluate("window.Rondo.query({ kind: 'catalog.availableLessons' })");
          const appStillAlive = alive(app1.child.pid) && alive(electronMainPid);
          const unaffected =
            afterStatus?.value?.hostPhase === 'READY' &&
            afterStatus?.value?.canAcceptCommands === true &&
            afterInfo?.value?.host?.hostEpoch === epoch1 &&
            afterQuery?.ok === false &&
            afterQuery?.error?.code === baselineQuery?.error?.code &&
            appStillAlive;
          record(
            'H1: 攻击后主窗口不受影响（READY/epoch 不变/稳定错误一致/应用未退出）',
            unaffected ? 'PASS' : 'FAIL',
            `phase=${afterStatus?.value?.hostPhase} epoch同=${afterInfo?.value?.host?.hostEpoch === epoch1} code=${afterQuery?.error?.code} alive=${appStillAlive}`,
          );
          if (!unaffected) failed = true;
        }
      } finally {
        cdpAtk?.close();
      }

      // --- H2: external SIGKILL of the Host while queries are in flight --
      const { pid: hostPid1, parentMatched } = findHostPid(electronMainPid, dataRoot);
      record(
        'H2: Host utility 进程定位（NodeService 子类型 + 数据根 user-data-dir）',
        'PASS',
        `pid=${hostPid1} ppid 匹配=${parentMatched}（argv 不含入口路径，按 Chromium utility 子类型定位）`,
      );
      const killAt = Date.now();
      // Deterministic in-flight construction: SIGSTOP freezes the Host (a
      // realistic hung-Host failure mode) so responses become impossible,
      // then a batch of queries is fired through the real preload surface and
      // lands in the supervisor's pending map bound to the live epoch, and
      // only then does SIGKILL land. Measured without the freeze: the Host
      // answers 80 queries faster than one signal delivery, so pending
      // requests could not be observed reliably.
      const expected1 = 200;
      process.kill(hostPid1, 'SIGSTOP');
      await sleep(150);
      await cdpMain.evaluate(probeExpression(pv1, expected1, 0), { awaitPromise: false });
      await sleep(300);
      process.kill(hostPid1, 'SIGKILL');
      await sleep(5000);
      const probe = (await cdpMain.evaluate('window.__probe')) ?? [];
      const cls1 = classifyProbe(probe, expected1);
      record(
        'H2: 未决读请求按丢失语义失效（HOST_DISCONNECTED，无假数据）',
        cls1.complete && cls1.lostQueries.length >= 1 ? 'PASS' : 'FAIL',
        `expected=${expected1} host应答=${cls1.hostAnswered.length} lostQuery=${cls1.lostQueries.length} 异形=${cls1.other.length} ${JSON.stringify(cls1.lostQueries.slice(0, 2))}`,
      );
      if (!(cls1.complete && cls1.lostQueries.length >= 1)) failed = true;

      const statusAfterKill = await cdpMain.evaluate('window.RondoDesktop.hostStatus()');
      record(
        'H2: 断连被检测（host-exit 日志 + STOPPED 投影）',
        statusAfterKill?.value?.hostPhase === 'STOPPED' && statusAfterKill?.value?.canAcceptCommands === false ? 'PASS' : 'FAIL',
        JSON.stringify(statusAfterKill),
      );
      if (statusAfterKill?.value?.hostPhase !== 'STOPPED') failed = true;

      const postDeathQuery = await cdpMain.evaluate("window.Rondo.query({ kind: 'catalog.availableLessons' })");
      const postDeathOk =
        postDeathQuery?.ok === false &&
        postDeathQuery?.error?.code === 'HOST_RECOVERING' &&
        postDeathQuery?.transport === 'HOST_DISCONNECTED';
      record(
        'H2: 断连后查询不返数据（HOST_RECOVERING/HOST_DISCONNECTED）',
        postDeathOk ? 'PASS' : 'FAIL',
        JSON.stringify(postDeathQuery).slice(0, 200),
      );
      if (!postDeathOk) failed = true;

      const seg1 = segmentBy(readJsonLines(desktopLogPath), 'app-start')[0] ?? [];
      const hostExit1 = seg1.find((l) => l.event === 'host-exit' && l.ts >= killAt - 2000);
      const illusion = seg1.filter((l) => (l.event === 'host-ready' || l.event === 'host-fork') && hostExit1 && l.ts > hostExit1.ts);
      const pendingAtExit = typeof hostExit1?.pendingCount === 'number' ? hostExit1.pendingCount : 0;
      record(
        'H2: 无就绪假象（host-exit 携带在途计数 + 其后无 host-fork/host-ready）',
        hostExit1 && illusion.length === 0 && pendingAtExit >= 100 ? 'PASS' : 'FAIL',
        `host-exit=${hostExit1 ? `ts=${hostExit1.ts} pendingCount=${hostExit1.pendingCount}` : '缺失'} 断连后就绪类事件=${illusion.length}`,
      );
      if (!(hostExit1 && illusion.length === 0 && pendingAtExit >= 100)) failed = true;

      // --- H3: quit-after-crash completes cleanly ------------------------
      // Fire-and-forget: the invoke readback races with renderer teardown at
      // the real quit, so the flow's terminal phase is verified from the
      // lifecycle log (quit-flow phase transitions + app-exit reason).
      cdpMain.evaluate('window.RondoDesktop.requestQuit()', { awaitPromise: false }).catch(() => {});
      const exit1 = await Promise.race([app1.exit, sleep(40000).then(() => null)]);
      const exitOk = exit1 !== null && exit1.code === 0;
      const seg1Quit = segmentBy(readJsonLines(desktopLogPath), 'app-start')[0] ?? [];
      const quitPhases = ['PROMPTING', 'SAVING', 'COMPLETING', 'COMPLETED'];
      const phasesHit = quitPhases.map((p) => seg1Quit.some((l) => l.event === 'quit-flow' && l.to === p));
      const appExit1Reason = seg1Quit.find((l) => l.event === 'app-exit')?.reason;
      record(
        'H3: 崩溃后退出路径干净（PROMPTING→SAVING→COMPLETING→COMPLETED + exit 0）',
        exitOk && phasesHit.every(Boolean) && appExit1Reason === 'quit-flow-completed' ? 'PASS' : 'FAIL',
        `相位=${quitPhases.filter((_, i) => phasesHit[i]).join('→') || '无'} appExit=${String(appExit1Reason)} exit=${exit1 ? `code=${exit1.code} signal=${exit1.signal ?? ''}` : '40s 未退出'}`,
      );
      if (!(exitOk && phasesHit.every(Boolean) && appExit1Reason === 'quit-flow-completed')) failed = true;

      const seg1After = segmentBy(readJsonLines(desktopLogPath), 'app-start')[0] ?? [];
      const hostExitVerified = seg1After.find((l) => l.event === 'quit-flow' && l.step === 'host-exit-verified');
      const forkCount1 = seg1After.filter((l) => l.event === 'host-fork').length;
      const exitCount1 = seg1After.filter((l) => l.event === 'host-exit').length;
      const appExit1 = seg1After.find((l) => l.event === 'app-exit');
      const crashQuitOk =
        hostExitVerified &&
        forkCount1 === 1 &&
        exitCount1 === 1 &&
        appExit1 &&
        hostExit1 &&
        hostExit1.ts <= appExit1.ts;
      record(
        'H3: 无自动重启（单 fork/单 host-exit，host-exit 先于 app-exit）',
        crashQuitOk ? 'PASS' : 'FAIL',
        `fork=${forkCount1} hostExit=${exitCount1} host-exit-verified=${Boolean(hostExitVerified)} appExit=${Boolean(appExit1)}`,
      );
      if (!crashQuitOk) failed = true;
    } finally {
      cdpMain?.close();
    }
    cleanupPids = cleanupPids.filter((pid) => alive(pid));

    // ------------------------------------------------------------------
    // Launch 2: recovery entry + pending-write RECEIPT_UNKNOWN + unknown
    // writes must NOT let the app exit silently (prompting blocks; harness
    // force-quits — the real "user force-quit at the dialog" scenario).
    // ------------------------------------------------------------------
    const app2 = await spawnApp(dataRoot, {});
    meta.launches.push({ label: 'launch2', foreignWindow: null });
    cleanupPids.push(app2.child.pid);
    const electronMainPid2 = findElectronMainPid(app2.child.pid);
    cleanupPids.push(electronMainPid2);
    let cdp2 = null;
    try {
      cdp2 = await connectAndReady(app2, 'launch2');
      const info2 = await cdp2.evaluate('window.RondoPlatform.info()');
      const epoch2 = info2.value?.host?.hostEpoch ?? null;
      meta.epoch2 = epoch2;
      const hostSegs = segmentBy(readJsonLines(hostLogPath), 'host-starting');
      const hostSeg2 = hostSegs[hostSegs.length - 1] ?? [];
      const recovering = hostSeg2.find((l) => l.event === 'host-recovering');
      const recoveryVerified = hostSeg2.find((l) => l.event === 'host-recovery-verified');
      const recoveryOk =
        info2.value?.host?.startedFromExistingRoot === true &&
        Boolean(recovering) &&
        Boolean(recoveryVerified) &&
        epoch2 !== null &&
        epoch2 !== meta.epoch1;
      record(
        'H4: 同根恢复进入（startedFromExistingRoot + host-recovering + 新 epoch）',
        recoveryOk ? 'PASS' : 'FAIL',
        `existingRoot=${String(info2.value?.host?.startedFromExistingRoot)} recovering=${Boolean(recovering)} verified=${Boolean(recoveryVerified)} epoch新=${epoch2 !== meta.epoch1}`,
      );
      if (!recoveryOk) failed = true;

      const { pid: hostPid2 } = findHostPid(electronMainPid2, dataRoot);
      // Deterministic in-flight construction (see H2): SIGSTOP freezes the
      // Host so the fired commands are genuinely pending at SIGKILL time and
      // must surface RECEIPT_UNKNOWN (the replay-original-idempotency-key
      // semantics), not a post-exit rejection.
      const expected2 = 80;
      process.kill(hostPid2, 'SIGSTOP');
      await sleep(150);
      await cdp2.evaluate(probeExpression(info2.value?.protocolVersion, 40, 40), { awaitPromise: false });
      await sleep(300);
      process.kill(hostPid2, 'SIGKILL');
      await sleep(5000);
      const probe2 = (await cdp2.evaluate('window.__probe')) ?? [];
      const cls2 = classifyProbe(probe2, expected2);
      record(
        'H2b: 未决写按 RECEIPT_UNKNOWN 失效（客户端重放原幂等键语义）',
        cls2.complete && cls2.receiptUnknown >= 1 ? 'PASS' : 'FAIL',
        `expected=${expected2} host应答=${cls2.hostAnswered.length} RECEIPT_UNKNOWN=${cls2.receiptUnknown} lostCommand(含竞态HOST_DISCONNECTED)=${cls2.lostCommands.length} lostQuery=${cls2.lostQueries.length} 异形=${cls2.other.length}`,
      );
      if (!(cls2.complete && cls2.receiptUnknown >= 1)) failed = true;

      const status2 = await cdp2.evaluate('window.RondoDesktop.hostStatus()');
      record(
        'H2b: 未知写投影到 UI 状态（pendingUnknownCommands=true）',
        status2?.value?.pendingUnknownCommands === true ? 'PASS' : 'FAIL',
        JSON.stringify(status2),
      );
      if (status2?.value?.pendingUnknownCommands !== true) failed = true;

      // requestQuit with unknown writes: the flow must enter PROMPTING and
      // NOT proceed (no SAVING/COMPLETED, no app-exit, no write freeze). The
      // native discard dialog cannot be clicked by the harness, so we observe
      // the block at log/IPC level and then force-quit externally.
      await cdp2.evaluate('window.RondoDesktop.requestQuit()', { awaitPromise: false }).catch(() => {});
      let blocked = true;
      let blockDetail = '';
      const blockDeadline = Date.now() + 8000;
      while (Date.now() < blockDeadline) {
        const segNow = segmentBy(readJsonLines(desktopLogPath), 'app-start')[1] ?? [];
        const prompting = segNow.find((l) => l.event === 'quit-flow' && l.from === 'IDLE' && l.to === 'PROMPTING');
        const proceeded = segNow.find(
          (l) =>
            l.event === 'quit-flow' && (l.to === 'SAVING' || l.to === 'COMPLETED' || l.step === 'host-exit-verified'),
        );
        const appExited = segNow.some((l) => l.event === 'app-exit');
        let statusNow = null;
        try {
          statusNow = await cdp2.evaluate('window.RondoDesktop.hostStatus()');
        } catch {
          // app gone (would itself mean the exit was NOT blocked)
        }
        if (prompting && !proceeded && !appExited && statusNow?.value?.hostPhase === 'STOPPED') {
          blocked = true;
          blockDetail = `PROMPTING 在案 ts=${prompting.ts}；无 SAVING/COMPLETED/app-exit；hostPhase=${statusNow.value.hostPhase}（未冻结为 QUIESCING）`;
          break;
        }
        if (proceeded || appExited || !statusNow) {
          blocked = false;
          blockDetail = `未知写未阻断退出：${JSON.stringify(proceeded ?? { exited: appExited || !statusNow })}`;
          break;
        }
        await sleep(500);
      }
      record('H2b: 未知写阻断静默退出（PROMPTING 后不推进，不冻结写）', blocked ? 'PASS' : 'FAIL', blockDetail || '8s 内未观察到 PROMPTING');
      if (!blocked) failed = true;

      cdp2.close();
      cdp2 = null;
      const mainPid2 = electronMainPid2;
      process.kill(mainPid2, 'SIGKILL');
      const exit2 = await Promise.race([app2.exit, sleep(20000).then(() => null)]);
      record(
        'H2b: 测试收尾外杀（等价用户在丢弃确认框处强退）',
        exit2 !== null ? 'PASS' : 'FAIL',
        exit2 ? `wrapper exit code=${exit2.code} signal=${exit2.signal ?? ''}` : '20s 未退出',
      );
    } finally {
      cdp2?.close();
    }
    cleanupPids = cleanupPids.filter((pid) => alive(pid));

    // ------------------------------------------------------------------
    // Launch 3: recovery again (after prompt-force-quit) + fully clean quit.
    // ------------------------------------------------------------------
    const app3 = await spawnApp(dataRoot, {});
    meta.launches.push({ label: 'launch3', foreignWindow: null });
    cleanupPids.push(app3.child.pid);
    const electronMainPid3 = findElectronMainPid(app3.child.pid);
    cleanupPids.push(electronMainPid3);
    let cdp3 = null;
    try {
      cdp3 = await connectAndReady(app3, 'launch3');
      const info3 = await cdp3.evaluate('window.RondoPlatform.info()');
      const epoch3 = info3.value?.host?.hostEpoch ?? null;
      meta.epoch3 = epoch3;
      record(
        'H4: 强退后再恢复（新 epoch，不继承旧 epoch）',
        epoch3 && epoch3 !== meta.epoch2 && epoch3 !== meta.epoch1 && info3.value?.host?.startedFromExistingRoot === true ? 'PASS' : 'FAIL',
        `epoch新=${Boolean(epoch3 && epoch3 !== meta.epoch2)} existingRoot=${String(info3.value?.host?.startedFromExistingRoot)}`,
      );
      if (!(epoch3 && epoch3 !== meta.epoch2)) failed = true;

      cdp3.evaluate('window.RondoDesktop.requestQuit()', { awaitPromise: false }).catch(() => {});
      const exit3 = await Promise.race([app3.exit, sleep(40000).then(() => null)]);
      const seg3Quit = segmentBy(readJsonLines(desktopLogPath), 'app-start')[2] ?? [];
      const completed3 = seg3Quit.some((l) => l.event === 'quit-flow' && l.to === 'COMPLETED');
      const clean3 = completed3 && exit3 !== null && exit3.code === 0;
      record('H4: 崩溃史后干净退出（COMPLETED + exit 0）', clean3 ? 'PASS' : 'FAIL', `COMPLETED=${completed3} exit=${exit3 ? exit3.code : '超时'}`);
      if (!clean3) failed = true;

      const hostSegs3 = segmentBy(readJsonLines(hostLogPath), 'host-starting');
      const hostSeg3 = hostSegs3[hostSegs3.length - 1] ?? [];
      const dbClosed = hostSeg3.find((l) => l.event === 'host-db-closed');
      const walOk = dbClosed?.closeReport?.walCheckpointed === true;
      const hostExit3 = hostSeg3.find((l) => l.event === 'host-exit');
      const seg3 = segmentBy(readJsonLines(desktopLogPath), 'app-start')[2] ?? [];
      const appExit3 = seg3.find((l) => l.event === 'app-exit');
      const orderOk = dbClosed && hostExit3 && appExit3 && dbClosed.ts <= hostExit3.ts && hostExit3.ts <= appExit3.ts;
      record(
        'H4: 崩溃史后关库屏障（walCheckpointed + db-closed → host-exit → app-exit）',
        walOk && orderOk ? 'PASS' : 'FAIL',
        `walCheckpointed=${String(dbClosed?.closeReport?.walCheckpointed)} dbClosed=${Boolean(dbClosed)} 顺序=${orderOk}`,
      );
      if (!(walOk && orderOk)) failed = true;
    } finally {
      cdp3?.close();
    }
  } catch (err) {
    failed = true;
    record('hardening 运行异常', 'FAIL', err instanceof Error ? err.stack : String(err));
  } finally {
    // Force-kill anything still alive, including orphaned Chromium helpers
    // (children of a killed Electron main survive momentarily on macOS).
    const extra = [];
    for (const pid of cleanupPids) {
      if (alive(pid)) {
        for (const line of psLines()) {
          if (line.ppid === pid) extra.push(line.pid);
        }
      }
    }
    for (const pid of [...cleanupPids, ...extra]) {
      if (alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }

  failed = failed || results.some((r) => r.status === 'FAIL');
  const report = { harness: 'check-desktop-hardening', at: new Date().toISOString(), dataRoot, meta, summary: failed ? 'FAIL' : 'PASS', results };
  writeFileSync(join(outDir, 'check-desktop-hardening-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`check:desktop-hardening ${failed ? 'FAIL' : 'PASS'} (report: build/check-desktop-hardening-report.json)`);
  if (!failed) {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(attackerDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`check:desktop-hardening FAIL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
