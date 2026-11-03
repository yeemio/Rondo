#!/usr/bin/env node
/**
 * check:desktop — real-window desktop check with synthetic data root.
 *
 * Spawns the actual Electron app twice against a throwaway data root:
 *  run 1: the main window loads the transport probe fixture
 *         (rondo://app/__probe/index.html — built here from
 *         tests/desktop/fixtures/probe), the renderer self-test runs the
 *         narrow IPC round trips through the real preload against the REAL
 *         wired Host (identity readback incl. the rondoLearning service,
 *         READY, query/command/receipt/auth), a hidden product window loads
 *         rondo://app/index.html (C's UI) and its window.rondo surface is
 *         verified, then requestQuit() drives the full quit flow and the
 *         process must exit 0 AFTER host-exit is logged;
 *  run 2: reopen on the SAME data root (recovery entry), wait READY with
 *         startedFromExistingRoot=true, quit again.
 *
 * Content-release registration gaps (B/C contract gaps) are recorded as FAIL
 * items with the Host's stable refusal codes — never hidden.
 *
 * Evidence sources: the renderer self-test result (via CDP Runtime.evaluate)
 * and the structured lifecycle logs under the synthetic data root. Any
 * unverifiable step is reported NOT_RUN with its reason — never faked.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

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

/** Builds the transport probe fixture into dist/web/__probe (check harness only). */
async function buildProbeFixture() {
  const probeDir = join(root, 'dist', 'web', '__probe');
  await esbuild({
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    entryPoints: [{ in: join(root, 'tests/desktop/fixtures/probe/main.tsx'), out: 'app' }],
    outdir: probeDir,
    sourcemap: 'linked',
    logLevel: 'warning',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    jsx: 'automatic',
  });
  copyFileSync(join(root, 'tests/desktop/fixtures/probe/index.html'), join(probeDir, 'index.html'));
}

/** Waits for the page script to be up, then runs the self-test (returns its value). */
async function waitForSelfTest(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      return await cdp.evaluate('window.__rondoSelfTest()', { awaitPromise: true });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`page self-test never became available: ${lastError}`);
}

function spawnElectron(port, dataRoot) {
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainBundle], {
    env: { ...process.env, RONDO_DATA_ROOT: dataRoot, RONDO_CHECK_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`));
  const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  return { child, exit };
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '-';
  console.log(`${tag} ${name}: ${detail}`);
}

let failed = false;

async function runOnce(label, dataRoot, { expectExistingRoot }) {
  const port = await freePort();
  const { child, exit } = spawnElectron(port, dataRoot);
  let cdp = null;
  let quitRequested = false;
  // Failure-path hygiene: an Electron child must never outlive this harness —
  // not on a thrown step (page-target timeout, CDP error) and not on a hung
  // quit. SIGTERM first, SIGKILL after a grace period.
  const ensureChildDead = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const ended = await Promise.race([exit, sleep(5000).then(() => null)]);
    if (ended === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  };
  try {
    const page = await findPageTarget(port, 'rondo://app/__probe/', 60000);
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const selfTest = await waitForSelfTest(cdp);
    if (!selfTest || typeof selfTest !== 'object') throw new Error('selftest returned nothing');
    record(`${label}: renderer 自检`, selfTest.pass ? 'PASS' : 'FAIL', `${selfTest.checks.filter((c) => c.status === 'PASS').length}/${selfTest.checks.length} 通过`);
    for (const check of selfTest.checks) {
      if (check.status !== 'PASS') record(`${label}: ${check.name}`, check.status === 'FAIL' ? 'FAIL' : 'NOT_RUN', check.detail || '');
    }
    const info = selfTest.info ?? {};
    record(`${label}: Host 身份读回`, info.host ? 'PASS' : 'FAIL', info.host ? `epoch=${String(info.host.hostEpoch).slice(0, 8)} node=${info.host.nodeVersion} sqlite=${info.host.sqliteVersion} services=${JSON.stringify(info.host.activeServices)}` : 'host 未就绪');
    record(`${label}: 数据根读回`, info.dataRoot === dataRoot ? 'PASS' : 'FAIL', String(info.dataRoot));
    if (expectExistingRoot) {
      record(`${label}: 恢复进入（已有数据根）`, info.host?.startedFromExistingRoot === true ? 'PASS' : 'FAIL', `startedFromExistingRoot=${String(info.host?.startedFromExistingRoot)}`);
    }
    // Content registration facts from the wired Host (contract gaps are FAILs).
    const registered = info.host?.registeredReleases ?? [];
    const gaps = info.host?.contentGaps ?? [];
    record(
      `${label}: 内容 release 登记`,
      gaps.length === 0 && registered.length === 2 ? 'PASS' : 'FAIL',
      `registered=[${registered.join(',')}] gaps=[${gaps.map((g) => `${g.releaseId}:${g.code}`).join(', ')}]` +
        (gaps.length > 0 ? ' — CONTRACT_CHANGE_REQUIRED（B 冻结内容 schema 无法表达 C 内容，见接线回传）' : ''),
    );
    // Product entry (C's UI) loads through the real preload with the three
    // faces + view present (hidden window opened by Main in check mode).
    let productCdp = null;
    try {
      const productPage = await findPageTarget(port, 'rondo://app/index', 30000);
      productCdp = await Cdp.connect(productPage.webSocketDebuggerUrl);
      const faces = await productCdp.evaluate(
        '(function(){var r=window.rondo;return {present:!!r,client:!!(r&&r.client&&typeof r.client.command==="function"&&typeof r.client.query==="function"),auth:!!(r&&r.auth&&typeof r.auth.session==="function"),desktop:!!(r&&r.desktop&&typeof r.desktop.hostStatus==="function"),view:!!(r&&r.view&&typeof r.view.nowMs==="function")};})()',
      );
      const threeFaces = faces && faces.present && faces.client && faces.auth && faces.desktop;
      record(
        `${label}: 产品入口加载 + window.rondo 三面`,
        threeFaces ? 'PASS' : 'FAIL',
        `rondo://app/index.html client=${faces?.client} auth=${faces?.auth} desktop=${faces?.desktop} view=${faces?.view}`,
      );
      // (the product window is a SECOND window: ipc-routes keys the trusted
      // sender to the main window only, so channel drives run on the probe
      // page — the product page keeps the surface-presence check above.)
      void productCdp;
    } catch (err) {
      record(`${label}: 产品入口加载 + window.rondo 三面`, 'FAIL', err instanceof Error ? err.message : String(err));
      void 0;
    } finally {
      productCdp?.close();
    }
      // End-to-end learning flow through the REAL trusted-window surface
      // (preload -> Main -> Host -> v2 rule judging -> view projections).
      // Only driven once (run1); run2 reuses the data root with an ACTIVE
      // attempt and is recorded NOT_RUN instead of replaying keys.
      if (!expectExistingRoot) {
        const flow = await cdp.evaluate(
          `(async function () {
            try {
            const w = window.rondo;
            const uuid = () => crypto.randomUUID();
            const unwrap = (r) => (r && r.ok ? r.value : Promise.reject(new Error('FLOW-UNWRAP:' + JSON.stringify(r))));
            const session = unwrap(await w.auth.setupGuardian({ idempotencyKey: 'probe-setup-key-check-desktop-0001', familyDisplayName: '探针家庭', guardianDisplayName: '探针', passphrase: 'probe-passphrase-0001' }));
            if (!session || session.role !== 'GUARDIAN') return { ok: false, step: 'setupGuardian' };
            const created = unwrap(await w.client.command({ protocolVersion: 'rondo.v1', commandId: uuid(), idempotencyKey: 'probe-flow-learner-0001', kind: 'family.createLearner', target: { scope: 'FAMILY' }, payload: { alias: 'flow-kid' } }));
            const learnerId = created.effectRefs.find((r) => r.startsWith('learner:')).slice('learner:'.length);
            const ls = unwrap(await w.auth.enterLearner({ learnerId }));
            if (!ls || ls.role !== 'LEARNER') return { ok: false, step: 'enterLearner' };
            const catalog = unwrap(await w.client.query({ kind: 'catalog.availableLessons' }));
            if (!catalog || !Array.isArray(catalog.lessons)) return { ok: false, step: 'catalog', lessons: catalog && catalog.lessons };
            if (catalog.lessons.length !== 2) return { ok: false, step: 'catalog-count', count: catalog.lessons.length, lessons: catalog.lessons.map((l) => l.releaseId) };
            const l2 = catalog.lessons.find((l) => l.releaseId === 'rondo.cyl.l2-r1');
            if (!l2) return { ok: false, step: 'catalog-l2-missing', lessons: catalog.lessons.map((l) => l.releaseId) };
            const release = l2.releaseId;
            const started = unwrap(await w.client.command({ protocolVersion: 'rondo.v1', commandId: uuid(), idempotencyKey: 'probe-flow-start-' + uuid(), kind: 'learning.startAttempt', target: { scope: 'LEARNER', learnerId }, payload: { releaseId: release } }));
            if (started.status !== 'APPLIED') return { ok: false, step: 'startAttempt', receipt: started };
            const attemptId = started.effectRefs.find((r) => r.startsWith('attempt:')).slice('attempt:'.length);
            const av = unwrap(await w.client.query({ kind: 'learning.attemptView', attemptId }));
            const cycleId = av.currentCycle.cycleId;
            const bind = { releaseId: release, questionInstanceId: av.currentCycle.questionInstanceId, rendererContractVersion: '1' };
            const cmd = async (kind, payload, extra) => unwrap(await w.client.command({ protocolVersion: 'rondo.v1', commandId: uuid(), idempotencyKey: 'probe-flow-' + uuid(), kind, target: { scope: 'LEARNER', learnerId, attemptId }, binding: bind, payload, ...(extra || {}) }));
            const pred = await cmd('learning.recordPrediction', { prediction: { claims: [] }, uncertain: true });
            if (pred.status !== 'APPLIED') return { ok: false, step: 'recordPrediction', receipt: pred };
            const op = await cmd('learning.commitOperation', { operation: { type: 'SetUnroll', valuePermille: 1000 } }, { expectedAttemptVersion: 2 });
            if (op.status !== 'APPLIED') return { ok: false, step: 'commitOperation', receipt: op };
            const MAPPING = { kind: 'objectMapping', pairs: [
              { leftId: 'cyl-part-height-line', rightId: 'net-edge-1' },
              { leftId: 'cyl-part-base-circle', rightId: 'net-edge-2' },
              { leftId: 'cyl-part-height-line', rightId: 'net-edge-3' },
              { leftId: 'cyl-part-base-circle', rightId: 'net-edge-4' },
            ] };
            const sub = await cmd('learning.submitResponse', { response: [MAPPING] }, { expectedAttemptVersion: 3 });
            if (sub.status !== 'APPLIED') return { ok: false, step: 'submitResponse', receipt: sub };
            const ev = unwrap(await w.view.getEvaluation({ cycleId }));
            const nowMs = unwrap(await w.view.nowMs({}));
            const learners = unwrap(await w.view.listLearners({}));
            return { ok: !!ev && ev.verdict === 'CORRECT' && typeof nowMs === 'number' && learners.length === 1, step: 'done', verdict: ev && ev.verdict, itemResults: ev && ev.itemResults && ev.itemResults.length };
            } catch (e) {
              return { ok: false, step: 'threw', message: String(e && e.message), stack: String(e && e.stack).slice(0, 160) };
            }
          })()`,
          { awaitPromise: true },
        );
        record(
          `${label}: 真实窗口学习全流程（建档→进入学习者→开始任务→预测→展开→提交→判分→视图读回）`,
          flow && flow.ok ? 'PASS' : 'FAIL',
          flow && flow.ok ? `verdict=${flow.verdict} itemResults=${flow.itemResults}（L2 release；L1 已随双 release 登记进入目录）` : JSON.stringify(flow).slice(0, 220),
        );
      } else {
        record(
          `${label}: 真实窗口学习全流程`,
          'NOT_RUN',
          'run2 复用数据根（run1 已驱动全流程，避免幂等键重放）',
        );
      }
    // Full quit flow driven from the real renderer surface.
    await cdp.evaluate('window.RondoDesktop.requestQuit()', { awaitPromise: false });
    quitRequested = true;
  } finally {
    cdp?.close();
    if (!quitRequested) await ensureChildDead();
  }
  const exitRace = await Promise.race([exit, sleep(30000).then(() => null)]);
  if (exitRace === null) {
    record(`${label}: 应用退出`, 'FAIL', '30s 内未退出（quit flow 卡死）');
    await ensureChildDead();
    failed = true;
    return null;
  }
  record(`${label}: 应用退出码`, exitRace.code === 0 ? 'PASS' : 'FAIL', `code=${exitRace.code} signal=${exitRace.signal ?? ''}`);
  return exitRace;
}

function verifyLogs(dataRoot) {
  const desktopLog = readJsonLines(join(dataRoot, 'technical', 'logs', 'desktop-lifecycle.log'));
  const hostLog = readJsonLines(join(dataRoot, 'technical', 'logs', 'host-lifecycle.log'));
  const events = desktopLog.map((line) => line.event);
  const hostEvents = hostLog.map((line) => line.event);

  const requireOrder = (list, sequence, label) => {
    let cursor = 0;
    for (const item of list) {
      if (item === sequence[cursor]) cursor += 1;
    }
    record(label, cursor === sequence.length ? 'PASS' : 'FAIL', `观察到 ${cursor}/${sequence.length}（${sequence.join(' → ')}）`);
  };

  requireOrder(events, ['app-start', 'window-created', 'host-fork', 'host-ready', 'app-exit'], 'desktop 生命周期顺序（首启）');
  requireOrder(events, ['quit-flow', 'app-exit'], 'quit-flow 先于 app 退出记录');
  requireOrder(hostEvents, ['host-starting', 'host-ready', 'host-db-closed', 'host-exit'], 'host 生命周期顺序（含关库）');

  const hostExitLine = hostLog.find((line) => line.event === 'host-exit');
  const appExitLine = desktopLog.find((line) => line.event === 'app-exit');
  if (hostExitLine && appExitLine) {
    record('Host 真退出先于应用退出', hostExitLine.ts <= appExitLine.ts ? 'PASS' : 'FAIL', `host-exit@${hostExitLine.ts} app-exit@${appExitLine.ts}`);
  } else {
    record('Host 真退出先于应用退出', 'FAIL', '缺少 host-exit 或 app-exit 记录');
  }
  const closeLine = hostLog.find((line) => line.event === 'host-db-closed');
  if (closeLine) {
    record('关库屏障（walCheckpointed）', closeLine.closeReport?.walCheckpointed ? 'PASS' : 'FAIL', JSON.stringify(closeLine.closeReport));
  } else {
    record('关库屏障（walCheckpointed）', 'FAIL', '缺少 host-db-closed 记录');
  }
}

async function main() {
  if (!existsSync(mainBundle)) {
    console.error('check:desktop FAIL: dist/main/index.cjs missing — run npm run build first');
    process.exit(1);
  }
  await buildProbeFixture();
  const dataRoot = mkdtempSync(join(tmpdir(), 'rondo-check-desktop-'));
  console.log(`synthetic data root: ${dataRoot}`);

  const first = await runOnce('run1', dataRoot, { expectExistingRoot: false });
  if (first && first.code === 0) {
    await runOnce('run2', dataRoot, { expectExistingRoot: true });
  } else {
    record('run2（关闭重开）', 'NOT_RUN', 'run1 未正常退出，跳过重开验证');
  }

  verifyLogs(dataRoot);

  const dbPath = join(dataRoot, 'learning', 'learning.sqlite');
  record('learning.sqlite 已创建', existsSync(dbPath) ? 'PASS' : 'FAIL', dbPath);

  failed = failed || results.some((r) => r.status === 'FAIL');
  const report = {
    at: new Date().toISOString(),
    dataRoot,
    summary: failed ? 'FAIL' : 'PASS',
    results,
  };
  writeFileSync(join(outDir, 'check-desktop-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`check:desktop ${failed ? 'FAIL' : 'PASS'} (report: build/check-desktop-report.json)`);
  if (!failed) rmSync(dataRoot, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`check:desktop FAIL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
