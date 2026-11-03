/**
 * Rondo preload (CommonJS). Exposes ONLY fixed-function surfaces through
 * contextBridge — the frozen RondoClient shape, the five LocalAuthPort
 * operations, the fixed DesktopPort actions, the A-owned diagnostics surface,
 * and the aggregate `rondo` bundle (client/auth/desktop/view) the product
 * entry consumes (apps/web/src/client/ports.ts productPorts). Every channel is
 * a literal; there is no (channel, ...args) passthrough, no path or command
 * strings from the renderer.
 *
 * Invalidation notices are schema-validated here before reaching the page:
 * garbage pushed over the event channel is dropped, not forwarded.
 */
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const { safeParseInvalidationNotice } = require('../../modules/contracts/public/client') as typeof import('../../modules/contracts/public/client');

function call(channel: string, payload?: unknown): Promise<unknown> {
  return ipcRenderer.invoke(channel, payload);
}

const clientFace = {
  command: (envelope: unknown) => call('rondo:command', envelope),
  query: (request: unknown) => call('rondo:query', request),
  receipt: (request: unknown) => call('rondo:receipt', request),
  subscribeInvalidation: (cb: (notice: unknown) => void) => {
    const listener = (_event: unknown, notice: unknown) => {
      if (safeParseInvalidationNotice(notice).success) cb(notice);
    };
    ipcRenderer.on('rondo:invalidation', listener);
    return () => {
      ipcRenderer.removeListener('rondo:invalidation', listener);
    };
  },
};

const authFace = {
  setupGuardian: (input: unknown) => call('rondo:auth:setupGuardian', input),
  unlockGuardian: (input: unknown) => call('rondo:auth:unlockGuardian', input),
  enterLearner: (input: unknown) => call('rondo:auth:enterLearner', input),
  lock: () => call('rondo:auth:lock'),
  session: () => call('rondo:auth:session'),
};

const desktopFace = {
  saveExport: (input: unknown) => call('rondo:desktop:saveExport', input),
  requestQuit: () => call('rondo:desktop:requestQuit'),
  cancelQuit: () => call('rondo:desktop:cancelQuit'),
  hostStatus: () => call('rondo:desktop:hostStatus'),
};

// Fixed per-op literals of the closed view channel set (`rondo:view:<op>`).
const viewFace = {
  getEvaluation: (input: { cycleId: string }) => call('rondo:view:getEvaluation', input),
  getHints: (input: { cycleId: string }) => call('rondo:view:getHints', input),
  getReviewCard: (input: { cycleId: string }) => call('rondo:view:getReviewCard', input),
  getMigration: (input: { learnerId: string }) => call('rondo:view:getMigration', input),
  getTimelineDetail: (input: { attemptId: string }) => call('rondo:view:getTimelineDetail', input),
  listLearners: () => call('rondo:view:listLearners', {}),
  listAttempts: (input: { learnerId?: string }) => call('rondo:view:listAttempts', input ?? {}),
  registerExplanationRevision: (input: { cycleId: string }) => call('rondo:view:registerExplanationRevision', input),
  getLastDeletionScopeHash: () => call('rondo:view:getLastDeletionScopeHash', {}),
  nowMs: () => call('rondo:view:nowMs', {}),
};

contextBridge.exposeInMainWorld('Rondo', clientFace);

contextBridge.exposeInMainWorld('RondoAuth', authFace);

contextBridge.exposeInMainWorld('RondoDesktop', desktopFace);

contextBridge.exposeInMainWorld('RondoPlatform', {
  info: () => call('rondo:platform:info'),
});

contextBridge.exposeInMainWorld('rondo', {
  client: clientFace,
  auth: authFace,
  desktop: desktopFace,
  view: viewFace,
  platform: { info: () => call('rondo:platform:info') },
});
