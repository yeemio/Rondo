/**
 * HTTP transport for the browser product entry: the same fixed preload faces
 * (adapters/desktop-client/preload-api.ts) implemented over same-origin
 * fetch against the Host's web gateway routes (apps/host/services/
 * web-gateway.ts) instead of the desktop preload's window.rondo.
 *
 * Rules (frozen, mirror of the desktop transport):
 * - fixed literal paths only — there is no generic (op, payload) channel;
 * - responses are IpcResult envelopes, unwrapped by the very same renderer
 *   adapters (createRondoClient & co) that wrap the preload faces;
 * - a network-level failure of a WRITE command is surfaced with
 *   transport='RECEIPT_UNKNOWN' so the frozen delivery-unknown replay rule in
 *   createRondoClient replays the ORIGINAL idempotency key through the
 *   receipt query — never resends the command;
 * - other faces surface transport='HOST_DISCONNECTED';
 * - invalidation notices arrive over a real SSE stream (browser lifecycle:
 *   EventSource reconnects on its own); notices are schema-validated by the
 *   gateway before push and re-validated by createRondoClient before the UI
 *   sees them.
 *
 * Renderer-safe: fetch/EventSource only, no Node, no Electron.
 */
import { exportFiles } from './browser-export';
import { safeParseSaveExportInput } from '../../../../modules/contracts/public/desktop';
import type { IpcResult } from '../../../../adapters/desktop-client/ipc-result';
import type {
  RondoAuthPreloadApi,
  RondoBundlePreloadApi,
  RondoDesktopPreloadApi,
  RondoPreloadApi,
  RondoViewPreloadApi,
} from '../../../../adapters/desktop-client/preload-api';

function networkError(message: string, transport: 'RECEIPT_UNKNOWN' | 'HOST_DISCONNECTED'): IpcResult<never> {
  return {
    ok: false,
    error: { code: 'INVALID_OPERATION', message, context: undefined },
    transport,
  } as IpcResult<never>;
}

async function post(path: string, body: unknown, failureTransport: 'RECEIPT_UNKNOWN' | 'HOST_DISCONNECTED'): Promise<IpcResult<unknown>> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? null),
    });
    if (!res.ok && res.status !== 200) {
      // Guard/schema rejections still carry an IpcResult envelope.
      const text = await res.text();
      try {
        return JSON.parse(text) as IpcResult<unknown>;
      } catch {
        return networkError(`本机 Host 拒绝了请求（HTTP ${res.status}）。`, failureTransport);
      }
    }
    return (await res.json()) as IpcResult<unknown>;
  } catch (err) {
    return networkError(
      `本机 Host 连接中断：${err instanceof Error ? err.message : String(err)}`,
      failureTransport,
    );
  }
}

async function get(path: string): Promise<IpcResult<unknown>> {
  try {
    const res = await fetch(path, { method: 'GET' });
    if (!res.ok && res.status !== 200) {
      const text = await res.text();
      try {
        return JSON.parse(text) as IpcResult<unknown>;
      } catch {
        return networkError(`本机 Host 拒绝了请求（HTTP ${res.status}）。`, 'HOST_DISCONNECTED');
      }
    }
    return (await res.json()) as IpcResult<unknown>;
  } catch (err) {
    return networkError(
      `本机 Host 连接中断：${err instanceof Error ? err.message : String(err)}`,
      'HOST_DISCONNECTED',
    );
  }
}

/** The full fixed face bundle over HTTP. One instance per product page. */
export function createHttpFaces(): RondoBundlePreloadApi {
  const clientFace: RondoPreloadApi = {
    command: (envelope) => post('/rondo/command', envelope, 'RECEIPT_UNKNOWN'),
    query: (request) => post('/rondo/query', request, 'HOST_DISCONNECTED'),
    receipt: (request) => post('/rondo/receipt', request, 'HOST_DISCONNECTED'),
    subscribeInvalidation: (cb) => {
      const source = new EventSource('/rondo/invalidation');
      source.onmessage = (event: MessageEvent<string>) => {
        try {
          cb(JSON.parse(event.data));
        } catch {
          // Garbage frames are dropped; createRondoClient re-validates anyway.
        }
      };
      return () => source.close();
    },
  };

  const authFace: RondoAuthPreloadApi = {
    setupGuardian: (input) => post('/rondo/auth/setupGuardian', input, 'HOST_DISCONNECTED'),
    unlockGuardian: (input) => post('/rondo/auth/unlockGuardian', input, 'HOST_DISCONNECTED'),
    enterLearner: (input) => post('/rondo/auth/enterLearner', input, 'HOST_DISCONNECTED'),
    lock: () => post('/rondo/auth/lock', null, 'HOST_DISCONNECTED'),
    session: () => post('/rondo/auth/session', null, 'HOST_DISCONNECTED'),
  };

  const desktopFace: RondoDesktopPreloadApi = {
    saveExport: async (input) => {
      const parsed = safeParseSaveExportInput(input);
      if (!parsed.success) return networkError('导出引用无效。', 'HOST_DISCONNECTED');
      const result = await post('/rondo/desktop/saveExport', parsed.data, 'HOST_DISCONNECTED');
      if (!result.ok) return result;
      try { return { ok: true, value: { saved: false, delivery: 'READY', files: exportFiles(result.value, parsed.data.preparedExportRef) } }; }
      catch { return networkError('导出数据校验失败，未发起下载。', 'HOST_DISCONNECTED'); }
    },
    // A browser has no desktop quit flow; refusing honestly (no route, no
    // fake state) — closing or refreshing the page IS the browser lifecycle.
    requestQuit: () =>
      Promise.resolve(networkError('浏览器版本没有退出流程；关闭页面即可退出。', 'HOST_DISCONNECTED') as IpcResult<unknown>),
    cancelQuit: () =>
      Promise.resolve(networkError('浏览器版本没有退出流程；关闭页面即可退出。', 'HOST_DISCONNECTED') as IpcResult<unknown>),
    hostStatus: () => get('/rondo/status'),
  };

  const viewFace: RondoViewPreloadApi = {
    getEvaluation: (input) => post('/rondo/view/getEvaluation', input, 'HOST_DISCONNECTED'),
    getHints: (input) => post('/rondo/view/getHints', input, 'HOST_DISCONNECTED'),
    getReviewCard: (input) => post('/rondo/view/getReviewCard', input, 'HOST_DISCONNECTED'),
    getMigration: (input) => post('/rondo/view/getMigration', input, 'HOST_DISCONNECTED'),
    getTimelineDetail: (input) => post('/rondo/view/getTimelineDetail', input, 'HOST_DISCONNECTED'),
    listLearners: () => post('/rondo/view/listLearners', {}, 'HOST_DISCONNECTED'),
    listAttempts: (input) => post('/rondo/view/listAttempts', input ?? {}, 'HOST_DISCONNECTED'),
    registerExplanationRevision: (input) => post('/rondo/view/registerExplanationRevision', input, 'HOST_DISCONNECTED'),
    getLastDeletionScopeHash: () => post('/rondo/view/getLastDeletionScopeHash', {}, 'HOST_DISCONNECTED'),
    nowMs: () => post('/rondo/view/nowMs', {}, 'HOST_DISCONNECTED'),
  };

  return {
    client: clientFace,
    auth: authFace,
    desktop: desktopFace,
    view: viewFace,
    platform: { info: () => get('/rondo/platform/info') },
  };
}
