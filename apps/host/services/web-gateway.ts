/**
 * Rondo web gateway (Host side, browser-first batch 2026-10-27).
 *
 * Mirrors the desktop IPC discipline (apps/desktop/ipc-routes.ts) over the
 * DSH web server instead of Electron IPC:
 * - closed literal route set — one exact route per frozen op/channel, no
 *   generic (op, payload) passthrough and no path/command strings from the
 *   page;
 * - every inbound body is schema-validated with the frozen public contracts
 *   (zod) before anything reaches rondoRouter, exactly like the IPC routes;
 * - sender assertion on every API route: the Host header must be the local
 *   bind, an Origin header (when present) must be the server's own origin,
 *   and Sec-Fetch-Site (when present, always sent by modern browsers) must be
 *   same-origin/none. This is transport hygiene against cross-origin pages
 *   and DNS rebinding — user identity is NOT derived from it; it stays the
 *   server-side session (guardian/learner auth) exactly as on desktop;
 * - the static fallback serves ONLY the public web dist (dist/web) with the
 *   same containment verification as the rondo:// protocol handler; dist/
 *   content (private tasks/answers) is never reachable through HTTP;
 * - responses use the IpcResult envelope so the renderer adapters
 *   (createRondoClient & co) unwrap them identically to the preload faces.
 *
 * Desktop-only faces are honest in the browser: requestQuit/cancelQuit have
 * no route (the client reports the capability gap instead of faking a quit),
 * saveExport returns only a confirmed family export payload. A browser download
 * is not evidence of disk persistence and never completes the domain operation.
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { appendFileSync, createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { getHostRuntime } from '../runtime';
import { safeParseEnvelope, commandKindSchema } from '../../../modules/contracts/public/envelope';
import { idSchema } from '../../../modules/contracts/public/protocol';
import { safeParsePublicQuery } from '../../../modules/contracts/public/queries';
import {
  safeParseEnterLearnerInput,
  safeParseSetupGuardianInput,
  safeParseUnlockGuardianInput,
} from '../../../modules/contracts/public/auth';
import type {} from './learning-wiring';
import { safeParseSaveExportInput } from '../../../modules/contracts/public/desktop';
import { safeParseInvalidationNotice } from '../../../modules/contracts/public/client';
import { rondoError, rondoErrorCodeSchema } from '../../../modules/contracts/public/errors';
import type { RondoError } from '../../../modules/contracts/public/errors';
import { ipcOk, ipcErr, type IpcResult } from '../../../adapters/desktop-client/ipc-result';
import type { RondoOpError } from './ipc-router';

declare module '@deepseek-ai/cordis' {
  interface Context {
    rondoWebGateway: RondoWebGateway;
  }
}

/** Browser-facing platform facts served at /rondo/platform/info (honest readback, no desktop claims). */
export interface WebPlatformInfo {
  protocolVersion: string;
  surface: 'web';
  hostPhase: string;
  hostEpoch: string;
  nodeVersion: string;
  sqliteVersion: string;
  dshFamily: string | null;
  activeServices: readonly string[];
  schemaVersion: number;
  registeredReleases: readonly string[];
  guardianConfigured: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export default class RondoWebGateway extends Service {
  static inject = ['webServer', 'rondoRouter', 'rondoLearning'];

  private readonly sseClients = new Set<ServerResponse>();
  private platformInfoProvider: (() => Promise<WebPlatformInfo>) | null = null;

  constructor(ctx: Context) {
    super(ctx, 'rondoWebGateway');
    this.registerRoutes();
  }

  /** Set by apps/host/web-main.ts once identity facts exist (before READY). */
  setPlatformInfoProvider(provider: () => Promise<WebPlatformInfo>): void {
    this.platformInfoProvider = provider;
  }

  /**
   * Host -> browser invalidation push (SSE). Notices are schema-validated
   * here, the same gate the desktop preload applies before a notice reaches
   * the page. No business emitter exists yet in either surface.
   */
  pushInvalidation(notice: unknown): void {
    if (!safeParseInvalidationNotice(notice).success) return;
    const frame = `data: ${JSON.stringify(notice)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(frame);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  // -- request plumbing --------------------------------------------------------

  private log(event: string, facts: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: Date.now(), event, ...facts });
    try {
      appendFileSync(join(getHostRuntime().dataRoot, 'technical', 'logs', 'web-gateway.log'), `${line}\n`);
    } catch {
      // Logging must never block request handling.
    }
  }

  private allowedHostHeaders(): Set<string> {
    const port = this.ctx.webServer.port ?? 0;
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  }

  private allowedOrigins(): Set<string> {
    const port = this.ctx.webServer.port ?? 0;
    return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  }

  /**
   * Transport-hygiene guard for every route (API and static): local Host
   * header, same-origin Origin when present, same-origin/none fetch metadata
   * when present. Denials are logged with the reason and answered with the
   * frozen UNKNOWN_RENDERER code, mirroring ipc-routes' sender assertion.
   */
  private guard(req: IncomingMessage, res: ServerResponse): boolean {
    const host = typeof req.headers['host'] === 'string' ? req.headers['host'] : null;
    if (!host || !this.allowedHostHeaders().has(host)) {
      this.log('web-sender-denied', { reason: 'host', host });
      this.json(res, ipcErr(rondoError('UNKNOWN_RENDERER', '未信任的消息来源。')), 403);
      return false;
    }
    const origin = typeof req.headers['origin'] === 'string' ? req.headers['origin'] : null;
    if (origin !== null && !this.allowedOrigins().has(origin)) {
      this.log('web-sender-denied', { reason: 'origin', origin });
      this.json(res, ipcErr(rondoError('UNKNOWN_RENDERER', '未信任的消息来源。')), 403);
      return false;
    }
    const fetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : null;
    if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      this.log('web-sender-denied', { reason: 'fetch-site', fetchSite });
      this.json(res, ipcErr(rondoError('UNKNOWN_RENDERER', '未信任的消息来源。')), 403);
      return false;
    }
    return true;
  }

  private json(res: ServerResponse, value: IpcResult<unknown>, status = 200): void {
    if (res.writableEnded) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(value));
  }

  /** Reads and JSON-parses the request body; responds and returns undefined on failure. */
  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        this.json(res, ipcErr(rondoError('SCHEMA_MISMATCH', '请求体过大。')), 400);
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      this.json(res, ipcErr(rondoError('SCHEMA_MISMATCH', '请求体不是合法 JSON。')), 400);
      return undefined;
    }
  }

  /** Maps a router/learning error into the IpcResult envelope (errFromWire parity). */
  private toIpcError(err: unknown): IpcResult<never> {
    const opError = err as Partial<RondoOpError>;
    if (opError && typeof opError.rondo === 'object' && opError.rondo !== null) {
      const rondo = opError.rondo;
      return ipcErr(rondoError(rondo.code, rondo.message, rondo.context));
    }
    const wireCode = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
    const codeCheck = rondoErrorCodeSchema.safeParse(wireCode);
    const message = err instanceof Error ? err.message : String(err);
    this.log('web-internal-error', { message });
    return ipcErr(
      codeCheck.success
        ? rondoError(codeCheck.data, message)
        : rondoError('INVALID_OPERATION', 'Host 内部错误，已记录技术日志。'),
    );
  }

  private async dispatch(res: ServerResponse, op: string, payload: unknown): Promise<void> {
    try {
      const result = await this.ctx.rondoRouter.dispatch(op, payload);
      this.json(res, ipcOk(result));
    } catch (err) {
      this.json(res, this.toIpcError(err));
    }
  }

  private schemaError(res: ServerResponse, domain: string): void {
    this.json(res, ipcErr(rondoError('SCHEMA_MISMATCH', `${domain}未通过 schema 校验。`)));
  }

  // -- route table ---------------------------------------------------------------

  private registerRoutes(): void {
    const ws = this.ctx.webServer;
    const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
      ws.register({ kind: 'exact', path, handler });
    };

    // -- client face ------------------------------------------------------------
    route('/rondo/command', async (req, res) => {
      if (!this.guard(req, res)) return;
      const body = await this.readBody(req, res);
      if (body === undefined) return;
      const parsed = safeParseEnvelope(body);
      if (!parsed.success) return this.schemaError(res, '命令信封');
      await this.dispatch(res, 'command', parsed.data);
    });

    route('/rondo/query', async (req, res) => {
      if (!this.guard(req, res)) return;
      const body = await this.readBody(req, res);
      if (body === undefined) return;
      const parsed = safeParsePublicQuery(body);
      if (!parsed.success) return this.schemaError(res, '查询请求');
      await this.dispatch(res, 'query', parsed.data);
    });

    route('/rondo/receipt', async (req, res) => {
      if (!this.guard(req, res)) return;
      const body = await this.readBody(req, res);
      if (body === undefined) return;
      const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
      const key = record ? idSchema.safeParse(record['idempotencyKey']) : null;
      const kind = record ? commandKindSchema.safeParse(record['commandKind']) : null;
      if (!key || !kind || !key.success || !kind.success) return this.schemaError(res, '回执查询');
      await this.dispatch(res, 'receipt', { idempotencyKey: key.data, commandKind: kind.data });
    });

    // -- auth face ---------------------------------------------------------------
    const authRoute = (
      path: string,
      op: 'auth.setupGuardian' | 'auth.unlockGuardian' | 'auth.enterLearner',
      validate: (input: unknown) => boolean,
    ): void => {
      route(path, async (req, res) => {
        if (!this.guard(req, res)) return;
        const body = await this.readBody(req, res);
        if (body === undefined) return;
        if (!validate(body)) return this.schemaError(res, '认证操作');
        await this.dispatch(res, op, body);
      });
    };
    authRoute('/rondo/auth/setupGuardian', 'auth.setupGuardian', (input) => safeParseSetupGuardianInput(input).success);
    authRoute('/rondo/auth/unlockGuardian', 'auth.unlockGuardian', (input) => safeParseUnlockGuardianInput(input).success);
    authRoute('/rondo/auth/enterLearner', 'auth.enterLearner', (input) => safeParseEnterLearnerInput(input).success);

    route('/rondo/auth/lock', async (req, res) => {
      if (!this.guard(req, res)) return;
      await this.dispatch(res, 'auth.lock', undefined);
    });
    route('/rondo/auth/session', async (req, res) => {
      if (!this.guard(req, res)) return;
      await this.dispatch(res, 'auth.session', undefined);
    });

    // -- view face (closed op set) -------------------------------------------------
    const idOf = (body: unknown, field: string): string | null => {
      if (typeof body !== 'object' || body === null) return null;
      const parsed = idSchema.safeParse((body as Record<string, unknown>)[field]);
      return parsed.success ? parsed.data : null;
    };
    const viewIdRoute = (
      path: string,
      op: 'view.getEvaluation' | 'view.getHints' | 'view.getReviewCard' | 'view.getMigration' | 'view.getTimelineDetail' | 'view.registerExplanationRevision',
      field: 'cycleId' | 'learnerId' | 'attemptId',
    ): void => {
      route(path, async (req, res) => {
        if (!this.guard(req, res)) return;
        const body = await this.readBody(req, res);
        if (body === undefined) return;
        const id = idOf(body, field);
        if (id === null) return this.schemaError(res, `视图查询 ${op}`);
        await this.dispatch(res, op, { [field]: id });
      });
    };
    viewIdRoute('/rondo/view/getEvaluation', 'view.getEvaluation', 'cycleId');
    viewIdRoute('/rondo/view/getHints', 'view.getHints', 'cycleId');
    viewIdRoute('/rondo/view/getReviewCard', 'view.getReviewCard', 'cycleId');
    viewIdRoute('/rondo/view/getMigration', 'view.getMigration', 'learnerId');
    viewIdRoute('/rondo/view/getTimelineDetail', 'view.getTimelineDetail', 'attemptId');
    viewIdRoute('/rondo/view/registerExplanationRevision', 'view.registerExplanationRevision', 'cycleId');

    route('/rondo/view/listLearners', async (req, res) => {
      if (!this.guard(req, res)) return;
      await this.dispatch(res, 'view.listLearners', {});
    });
    route('/rondo/view/listAttempts', async (req, res) => {
      if (!this.guard(req, res)) return;
      const body = await this.readBody(req, res);
      if (body === undefined) return;
      if (body === null || (typeof body === 'object' && Object.keys(body as object).length === 0)) {
        return await this.dispatch(res, 'view.listAttempts', {});
      }
      const learnerId = idOf(body, 'learnerId');
      if (learnerId === null) return this.schemaError(res, '视图查询 view.listAttempts');
      await this.dispatch(res, 'view.listAttempts', { learnerId });
    });
    route('/rondo/view/getLastDeletionScopeHash', async (req, res) => {
      if (!this.guard(req, res)) return;
      await this.dispatch(res, 'view.getLastDeletionScopeHash', {});
    });
    route('/rondo/view/nowMs', async (req, res) => {
      if (!this.guard(req, res)) return;
      await this.dispatch(res, 'view.nowMs', {});
    });

    // -- status / platform ---------------------------------------------------------
    route('/rondo/status', async (req, res) => {
      if (!this.guard(req, res)) return;
      await this.dispatch(res, 'status', undefined);
    });
    route('/rondo/platform/info', async (req, res) => {
      if (!this.guard(req, res)) return;
      const provider = this.platformInfoProvider;
      if (!provider) return this.json(res, ipcErr(rondoError('INVALID_OPERATION', 'Host 身份尚未就绪。')));
      try {
        this.json(res, ipcOk(await provider()));
      } catch (err) {
        this.json(res, this.toIpcError(err));
      }
    });

    // -- desktop face (honest browser subset) ----------------------------------------
    route('/rondo/desktop/saveExport', async (req, res) => {
      if (!this.guard(req, res)) return;
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const body = await this.readBody(req, res);
      if (body === undefined) return;
      const parsed = safeParseSaveExportInput(body);
      if (!parsed.success) return this.schemaError(res, '导出请求');
      try {
        const payload = await this.ctx.rondoLearning.browserExport(parsed.data.preparedExportRef);
        this.json(res, ipcOk(payload));
      } catch (err) {
        this.json(res, this.toIpcError(err));
      }
    });

    // -- invalidation SSE -------------------------------------------------------------
    route('/rondo/invalidation', (req, res) => {
      if (!this.guard(req, res)) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(':connected\n\n');
      this.sseClients.add(res);
      req.on('close', () => {
        this.sseClients.delete(res);
      });
    });

    // -- static fallback: public web dist ONLY -------------------------------------------
    ws.registerFallback((req, res) => {
      void this.serveStatic(req, res);
    });
  }

  /**
   * Containment-verified static serving of dist/web — the same rules as the
   * rondo:// protocol handler: decoded path, no NUL/../traversal, '/' maps to
   * index.html, resolved target must stay inside webRoot and is explicitly
   * excluded from contentRoot. dist/content (private tasks/answers) is never
   * served.
   */
  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    if (!this.guard(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }
    const runtime = getHostRuntime();
    const webRoot = runtime.webRoot;
    if (!webRoot) {
      res.statusCode = 500;
      res.end('web root not configured');
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://rondo.invalid').pathname);
    } catch {
      res.statusCode = 400;
      res.end('bad path');
      return;
    }
    if (pathname.includes('\0') || pathname.includes('..')) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const resolved = resolve(webRoot, `.${pathname}`);
    const insideWeb = resolved === webRoot || resolved.startsWith(webRoot + sep);
    const contentRoot = runtime.contentRoot;
    const insideContent = resolved === contentRoot || resolved.startsWith(contentRoot + sep);
    if (!insideWeb || insideContent) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    let stats;
    try {
      stats = statSync(resolved);
    } catch {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (!stats.isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const ext = resolved.slice(resolved.lastIndexOf('.'));
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(resolved);
    stream.on('error', () => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end('read error');
      }
    });
    stream.pipe(res);
  }
}
