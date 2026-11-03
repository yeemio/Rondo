/**
 * Rondo desktop transport probe (TEST FIXTURE — never part of the product
 * candidate). Moved from the old apps/web/src/main.ts diagnostics page; built
 * ONLY when RONDO_BUILD_PROBE=1 (tooling/build.mjs) into dist/web/__probe/
 * and loaded by the check:desktop harness through the real preload surface.
 *
 * integrated/ wiring: the self-test asserts the REAL wired behavior
 * (rondoLearning service, real auth, real router ops) — no R0 placeholder
 * expectations. Transport-layer checks stay decoupled from C's product UI.
 *
 * Uses ONLY: public contracts + the desktop-client adapter over the fixed
 * preload surface. No server contracts, no Node/Electron imports.
 */
import type { RondoWindowApi } from '../../../../adapters/desktop-client/preload-api';
import {
  createDesktopPort,
  createLocalAuthPort,
  createPlatformInfo,
  createRondoClient,
  RondoClientError,
} from '../../../../adapters/desktop-client/index';
import type { PlatformInfo } from '../../../../adapters/desktop-client/platform-info';
import { randomUUID } from '../../../../apps/web/src/uuid';
import { PROTOCOL_VERSION } from '../../../../modules/contracts/public/protocol';
import { parseEnvelope } from '../../../../modules/contracts/public/envelope';

const api = (window as unknown as {
  Rondo: RondoWindowApi['Rondo'];
  RondoAuth: RondoWindowApi['RondoAuth'];
  RondoDesktop: RondoWindowApi['RondoDesktop'];
  RondoPlatform: RondoWindowApi['RondoPlatform'];
});
const client = createRondoClient(api.Rondo);
const auth = createLocalAuthPort(api.RondoAuth);
const desktop = createDesktopPort(api.RondoDesktop);
const platformInfo = createPlatformInfo(api.RondoPlatform);

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function dlRow(dl: HTMLElement, key: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.append(dt, dd);
}

async function renderIdentity(): Promise<PlatformInfo> {
  const info = await platformInfo();
  const identityDl = el('identity');
  identityDl.replaceChildren();
  dlRow(identityDl, 'protocolVersion', info.protocolVersion);
  dlRow(identityDl, 'Electron (main)', info.electronVersion);
  dlRow(identityDl, 'Host epoch', info.host ? info.host.hostEpoch : '—（未就绪）');
  dlRow(identityDl, 'Host phase', info.hostStatus.hostPhase);
  dlRow(identityDl, 'Node (Host, utility)', info.host?.nodeVersion ?? '—');
  dlRow(identityDl, 'SQLite (Host, rondoLearning)', info.host?.sqliteVersion ?? '—');
  dlRow(identityDl, 'schemaVersion', String(info.host?.schemaVersion ?? '—'));
  dlRow(identityDl, 'activeServices (Host)', (info.host?.activeServices ?? []).join(', ') || '—');
  dlRow(identityDl, 'registeredReleases (Host)', (info.host?.registeredReleases ?? []).join(', ') || '—（内容契约缺口，见 host 日志）');
  dlRow(identityDl, 'contentGaps (Host)', (info.host?.contentGaps ?? []).map((g) => `${g.releaseId}:${g.code}`).join(', ') || '—');
  dlRow(identityDl, 'startedFromExistingRoot', String(info.host?.startedFromExistingRoot ?? '—'));
  const pathsDl = el('paths');
  pathsDl.replaceChildren();
  dlRow(pathsDl, 'dataRoot', info.dataRoot);
  dlRow(pathsDl, 'learning/', info.paths.learning);
  dlRow(pathsDl, 'content/', info.paths.content);
  el('host-phase').textContent = info.hostStatus.hostPhase;
  return info;
}

interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

async function waitReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await desktop.hostStatus();
    if (status.hostPhase === 'READY') return;
    if (Date.now() > deadline) throw new Error(`hostStatus 未在 ${timeoutMs}ms 内到达 READY（当前 ${status.hostPhase}）`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function expectClientError(
  run: () => Promise<unknown>,
  code: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    await run();
    return { ok: false, detail: `期望错误 ${code}，实际成功返回` };
  } catch (error) {
    if (error instanceof RondoClientError) {
      return error.code === code
        ? { ok: true, detail: `${error.code}: ${error.message}` }
        : { ok: false, detail: `期望 ${code}，实际 ${error.code}` };
    }
    return { ok: false, detail: `非预期异常类型：${String(error)}` };
  }
}

/** Fixed key/passphrase so run1 (create) and run2 (idempotent repeat) both pass. */
const PROBE_SETUP_KEY = 'probe-setup-key-check-desktop-0001';
const PROBE_PASSPHRASE = 'probe-passphrase-0001';

async function selfTest(): Promise<{ pass: boolean; checks: CheckResult[]; info: PlatformInfo }> {
  const checks: CheckResult[] = [];
  const record = async (name: string, run: () => Promise<CheckResult['status'] | string>) => {
    try {
      const outcome = await run();
      if (outcome === 'PASS' || outcome === 'FAIL' || outcome === 'SKIP') {
        checks.push({ name, status: outcome, detail: '' });
      } else {
        checks.push({ name, status: 'PASS', detail: outcome });
      }
    } catch (error) {
      checks.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const readyDeadline = Date.now() + 20000;
  let info: PlatformInfo;
  for (;;) {
    info = await platformInfo();
    if (info.host || Date.now() > readyDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  checks.push({
    name: 'platformInfo 身份读回（rondoLearning 新来源）',
    status:
      info.host && info.host.sqliteVersion !== null && info.host.activeServices.some((s) => s.includes('learning-wiring'))
        ? 'PASS'
        : 'FAIL',
    detail: info.host
      ? `epoch ${String(info.host.hostEpoch).slice(0, 8)} sqlite=${info.host.sqliteVersion} services=${info.host.activeServices.join(',')}`
      : 'host 未就绪',
  });

  await record('hostStatus 到达 READY', async () => {
    await waitReady(20000);
    return `phase=READY`;
  });

  await record('无会话 command 返回 UNAUTHENTICATED', async () => {
    await auth.lock().catch(() => undefined);
    const envelope = parseEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: 'family.createLearner',
      target: { scope: 'FAMILY' },
      payload: { alias: 'rondo-probe' },
    });
    const result = await expectClientError(() => client.command(envelope), 'UNAUTHENTICATED');
    if (!result.ok) throw new Error(result.detail);
    return result.detail;
  });

  await record('auth.setupGuardian 真实建档（run2 幂等重放）', async () => {
    const session = await auth.setupGuardian({
      idempotencyKey: PROBE_SETUP_KEY,
      familyDisplayName: '探针家庭',
      guardianDisplayName: '探针',
      passphrase: PROBE_PASSPHRASE,
    });
    if (session.role !== 'GUARDIAN' || session.familyId.length === 0) {
      throw new Error(`会话非预期: ${JSON.stringify(session)}`);
    }
    return `GUARDIAN family=${session.familyId.slice(0, 12)}…`;
  });

  await record('query 走真实路由返回有效投影', async () => {
    const projection = await client.query({ kind: 'catalog.availableLessons' });
    if (projection.kind !== 'catalog.availableLessons' || !Array.isArray(projection.lessons)) {
      throw new Error(`投影非预期: ${JSON.stringify(projection).slice(0, 160)}`);
    }
    const gapNote = (info.host?.contentGaps ?? []).length > 0 ? `（内容契约缺口 ${(info.host?.contentGaps ?? []).map((g) => g.releaseId).join(',')}，见 host 日志）` : '';
    return `lessons=${projection.lessons.length}${gapNote}`;
  });

  await record('receipt 查询返回 NOT_FOUND', async () => {
    const lookup = await client.receipt({ idempotencyKey: randomUUID(), commandKind: 'family.createLearner' });
    if (lookup.status !== 'NOT_FOUND') throw new Error(`期望 NOT_FOUND，实际 ${JSON.stringify(lookup)}`);
    return 'NOT_FOUND';
  });

  await record('auth.session 存在并可锁定为 null', async () => {
    const active = await auth.session();
    if (active === null || active.role !== 'GUARDIAN') throw new Error(`期望 GUARDIAN 会话，实际 ${JSON.stringify(active)}`);
    const locked = await auth.lock();
    if (locked.locked !== true) throw new Error('lock 未返回 locked=true');
    const after = await auth.session();
    if (after !== null) throw new Error(`锁定后期望 null，实际 ${JSON.stringify(after)}`);
    return 'locked → null';
  });

  await record('subscribeInvalidation 订阅/退订', async () => {
    let hit = false;
    const unsubscribe = client.subscribeInvalidation(() => {
      hit = true;
    });
    unsubscribe();
    return hit ? '异常触发' : '订阅与退订正常';
  });

  await record('cancelQuit 在无退出流程时返回 IDLE', async () => {
    const state = await desktop.cancelQuit();
    if (state.phase !== 'IDLE') throw new Error(`期望 IDLE，实际 ${state.phase}`);
    return state.phase;
  });

  const pass = checks.every((check) => check.status !== 'FAIL');
  renderIdentity().catch(() => undefined);
  return { pass, checks, info };
}

function renderSelfTest(result: { pass: boolean; checks: CheckResult[] }): void {
  const ul = el('selftest');
  ul.replaceChildren();
  for (const check of result.checks) {
    const li = document.createElement('li');
    const status = document.createElement('span');
    status.className = check.status === 'PASS' ? 'ok' : check.status === 'FAIL' ? 'fail' : 'skip';
    status.textContent = `[${check.status}] `;
    li.append(status, document.createTextNode(check.name));
    if (check.detail) {
      const detail = document.createElement('div');
      detail.className = 'sub';
      detail.textContent = check.detail;
      li.append(detail);
    }
    ul.append(li);
  }
}

declare global {
  interface Window {
    __rondoSelfTest(): Promise<{ pass: boolean; checks: { name: string; status: string; detail: string }[]; info: unknown }>;
  }
}

window.__rondoSelfTest = async () => {
  const result = await selfTest();
  renderSelfTest(result);
  return { pass: result.pass, checks: result.checks, info: result.info };
};

void el<HTMLButtonElement>('btn-refresh').addEventListener('click', () => {
  void renderIdentity();
});
void el<HTMLButtonElement>('btn-selftest').addEventListener('click', () => {
  void selfTest().then(renderSelfTest).catch((error: unknown) => {
    renderSelfTest({ pass: false, checks: [{ name: '自检执行', status: 'FAIL', detail: String(error) }] });
  });
});
void el<HTMLButtonElement>('btn-quit').addEventListener('click', () => {
  void desktop.requestQuit().then(
    (state) => {
      el('quit-log').textContent = `requestQuit -> ${state.phase}\n`;
    },
    (error: unknown) => {
      el('quit-log').textContent = `requestQuit 失败：${String(error)}\n`;
    },
  );
});
void el<HTMLButtonElement>('btn-cancel').addEventListener('click', () => {
  void desktop.cancelQuit().then(
    (state) => {
      el('quit-log').textContent += `cancelQuit -> ${state.phase}\n`;
    },
    (error: unknown) => {
      el('quit-log').textContent += `cancelQuit 失败：${String(error)}\n`;
    },
  );
});

void renderIdentity().catch((error: unknown) => {
  el('identity').replaceChildren();
  dlRow(el('identity'), '错误', String(error));
});
