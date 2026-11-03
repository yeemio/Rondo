/**
 * Rondo Desktop Main (R0).
 *
 * Frozen desktop-base requirements implemented here:
 * - single instance; second instance focuses the existing window;
 * - rondo://app custom privileged protocol mapping ONLY the packaged public
 *   web resources, with path normalization plus containment verification;
 * - BrowserWindow hardening: contextIsolation + sandbox + nodeIntegration:false
 *   + webSecurity:true; navigation denied; window-open denied; permission
 *   requests denied;
 * - independent Application Support/Rondo data root (env override for the
 *   check harness), Electron session redirected into it;
 * - Host supervision over utilityProcess with epoch-bound wire protocol;
 * - closing the window IS the quit flow (no darwin hide-and-keep-running).
 */
import { appendFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, net, protocol, session } from 'electron';
import { ensureDataRoot, resolveDataRoot } from './paths';
import { LifecycleLog } from './lifecycle-log';
import { HostSupervisor } from './host-supervisor';
import { registerDesktopIpc, APP_ORIGIN } from './ipc-routes';
import { QuitFlowController } from './quit-flow-controller';
import { safeParseInvalidationNotice } from '../../modules/contracts/public/client';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import { rondoError, rondoErrorCodeSchema } from '../../modules/contracts/public/errors';
import { ipcErr, ipcOk, type IpcResult } from '../../adapters/desktop-client/ipc-result';
import type { PlatformInfo } from '../../adapters/desktop-client/platform-info';

// Must run before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'rondo', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// The app root is two levels above this bundle both in dev (A-platform/dist)
// and in the packaged candidate (resources/app/dist).
const appRoot = resolve(__dirname, '..', '..');
const webRoot = join(appRoot, 'dist', 'web');
// Packaged content root (B release layout, public+private) read by the Host
// through the env whitelist. The renderer protocol NEVER maps anything under
// this directory (explicit exclusion below).
const contentRoot = join(appRoot, 'dist', 'content');
const hostEntry = join(appRoot, 'dist', 'host', 'index.mjs');

// Redirect Electron's own storage into the independent data root BEFORE
// anything session-related initializes.
const dataRoot = resolveDataRoot(app.getPath('appData'), process.env['RONDO_DATA_ROOT']);
const paths = ensureDataRoot(dataRoot);
app.setPath('userData', paths.desktop);
app.setPath('logs', join(paths.technicalLogs, 'electron'));

const log = new LifecycleLog(paths.technicalLogs);
log.write('app-start', {
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  dataRoot,
  appRoot,
});

if (!app.requestSingleInstanceLock()) {
  log.write('app-exit', { reason: 'second-instance' });
  app.quit();
} else {
  void boot();
}

let mainWindow: BrowserWindow | null = null;
let supervisor: HostSupervisor | null = null;
let quitFlow: QuitFlowController | null = null;

async function boot(): Promise<void> {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  await app.whenReady();

  // Custom protocol: rondo://app/<public resource> ONLY. The mapped path set
  // is dist/web plus its public resources; dist/content (the Host-side
  // content, including its private subtree) is explicitly excluded even
  // though the webRoot containment check already cannot reach it.
  protocol.handle('rondo', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') {
      return new Response('not found', { status: 404 });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad path', { status: 400 });
    }
    if (pathname.includes('\0') || pathname.includes('..')) {
      return new Response('forbidden', { status: 403 });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const resolved = resolve(webRoot, `.${pathname}`);
    const insideWeb = resolved === webRoot || resolved.startsWith(webRoot + sep);
    const insideContent = resolved === contentRoot || resolved.startsWith(contentRoot + sep);
    if (!insideWeb || insideContent) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).href);
  });

  // System permission requests are denied by default (no camera/microphone in scope).
  for (const ses of [session.defaultSession]) {
    ses.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    ses.setPermissionCheckHandler((_wc, _permission) => false);
  }

  supervisor = new HostSupervisor(hostEntry, dataRoot, contentRoot, log, (message) => {
    appendFileSync(join(paths.technicalLogs, 'desktop-lifecycle.log'), `${JSON.stringify({ ts: Date.now(), event: 'host-boot-failed', message })}\n`);
  });
  quitFlow = new QuitFlowController({
    supervisor,
    getWindow: () => mainWindow,
    log,
  });

  createWindow();

  // Test-only hardening surface (inert unless the check harness sets
  // RONDO_HARDENING_CHECK=1): one hidden second BrowserWindow with the SAME
  // preload on a harness-supplied foreign origin, so check-desktop-hardening
  // can drive the real IPC surface from an untrusted sender/frame/origin.
  // Only Main can attach a preload, so the harness cannot construct this
  // attack surface by itself. Normal operation never creates such a window;
  // it shares the hardened webPreferences and is NOT registered as the
  // trusted window anywhere (ipc-routes keys on the main window only).
  if (process.env.RONDO_HARDENING_CHECK === '1') {
    const foreignWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        additionalArguments: [],
      },
    });
    log.write('window-created', {
      windowId: foreignWindow.id,
      webContentsId: foreignWindow.webContents.id,
      foreign: true,
    });
    void foreignWindow.loadURL(process.env.RONDO_HARDENING_FOREIGN_URL ?? 'about:blank');
  }

  // IPC handlers must exist before the Host starts so the renderer can poll
  // identity/status while the Host is still booting.
  registerDesktopIpc({
    getWindow: () => mainWindow,
    supervisor,
    quitFlow,
    log,
    platformInfo,
    saveExportViaDialog,
  });

  supervisor.onEvent = (kind, notice) => {
    if (kind !== 'invalidation' || !mainWindow) return;
    if (!safeParseInvalidationNotice(notice).success) return;
    mainWindow.webContents.send('rondo:invalidation', notice);
  };

  try {
    const identity = await supervisor.start();
    log.write('host-ready', { hostEpoch: identity.hostEpoch, sqlite: identity.sqliteVersion });
  } catch (err) {
    log.write('host-boot-failed', { detail: err instanceof Error ? err.message : String(err) });
    // The window still opens and shows the failure through the diagnostics
    // surface; a desktop whose Host never became READY is not usable, so
    // surface it loudly and keep the quit flow available.
  }

  app.on('before-quit', (event) => {
    if (!quitFlow || quitFlow.isQuitAllowed) return;
    event.preventDefault();
    void quitFlow.requestQuit();
  });

  app.on('window-all-closed', () => {
    // Closing the window is the quit flow; no background residence on darwin.
    if (!quitFlow || quitFlow.isQuitAllowed) {
      app.quit();
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'Rondo · 回旋曲',
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#101418',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [],
    },
  });
  log.write('window-created', { windowId: mainWindow.id, webContentsId: mainWindow.webContents.id });
  supervisor?.setSenderBinding({
    source: 'desktop-main',
    windowId: mainWindow.id,
    webContentsId: mainWindow.webContents.id,
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  mainWindow.on('close', (event) => {
    if (quitFlow && !quitFlow.isQuitAllowed) {
      event.preventDefault();
      void quitFlow.requestQuit();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // Check-harness mode (RONDO_CHECK_DESKTOP=1): the main window loads the
  // transport probe page (dist/web/__probe/index.html, fixtures-built) and a
  // hidden second window loads the real product entry so the harness can
  // verify both surfaces in one run.
  const checkMode = process.env.RONDO_CHECK_DESKTOP === '1';
  if (checkMode) {
    void mainWindow.loadURL(`${APP_ORIGIN}/__probe/index.html`);
    const productWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        additionalArguments: [],
      },
    });
    log.write('window-created', {
      windowId: productWindow.id,
      webContentsId: productWindow.webContents.id,
      product: true,
    });
    productWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    productWindow.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    void productWindow.loadURL(`${APP_ORIGIN}/index.html`);
    productWindow.on('close', (event) => {
      if (quitFlow && !quitFlow.isQuitAllowed) event.preventDefault();
    });
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

function platformInfo(): PlatformInfo {
  const identity = supervisor?.hostIdentity ?? null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    mainNodeVersion: process.versions.node,
    dataRoot,
    paths: {
      root: paths.root,
      learning: paths.learning,
      content: paths.content,
      desktop: paths.desktop,
      technicalDsh: paths.technicalDsh,
      technicalLogs: paths.technicalLogs,
      temporary: paths.temporary,
    },
    host:
      identity === null
        ? null
        : {
            hostPhase: identity.hostPhase,
            hostEpoch: identity.hostEpoch,
            nodeVersion: identity.nodeVersion,
            electronVersion: identity.electronVersion,
            sqliteVersion: identity.sqliteVersion,
            dshFamily: identity.dshFamily,
            activeServices: [...identity.activeServices],
            schemaVersion: identity.schemaVersion,
            startedFromExistingRoot: identity.startedFromExistingRoot,
            bootMs: identity.bootMs,
            ...(identity.registeredReleases !== undefined
              ? { registeredReleases: [...identity.registeredReleases] }
              : {}),
            ...(identity.contentGaps !== undefined
              ? { contentGaps: identity.contentGaps.map((gap) => ({ releaseId: gap.releaseId, code: gap.code })) }
              : {}),
            ...(identity.guardianConfigured !== undefined
              ? { guardianConfigured: identity.guardianConfigured }
              : {}),
          },
    hostStatus: quitFlow
      ? quitFlow.hostStatusProjection()
      : { hostPhase: 'STARTING', canAcceptCommands: false, pendingUnknownCommands: false },
  };
}

async function saveExportViaDialog(
  window: BrowserWindow,
  preparedExportRef: string,
): Promise<IpcResult<unknown>> {
  // The Host must confirm an export exists for the ref before any dialog opens.
  try {
    const fetchResult = (await supervisor?.request('query', {
      kind: 'guardian.exportStatus',
      exportId: preparedExportRef,
    })) as unknown;
    void fetchResult;
  } catch (error) {
    const wire = (error as { hostError?: { code: string; message: string } }).hostError;
    const codeCheck = rondoErrorCodeSchema.safeParse(wire?.code);
    return ipcErr(
      rondoError(codeCheck.success ? codeCheck.data : 'CAPABILITY_UNAVAILABLE', wire?.message ?? '导出能力尚未接入。'),
    );
  }
  const choice = await dialog.showSaveDialog(window, {
    title: '导出 Rondo 数据',
    defaultPath: `rondo-export-${preparedExportRef.slice(0, 8)}.json`,
  });
  if (choice.canceled || !choice.filePath) return ipcOk({ saved: false });
  // R0: no business export content exists; the confirmed write-through is
  // B's export service. Report honestly instead of writing a stub file.
  return ipcErr(
    rondoError('CAPABILITY_UNAVAILABLE', '导出内容由后续批次接入；已确认引用但暂无可写内容。'),
  );
}
