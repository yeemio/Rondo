// Compatibility evidence only. Uses the donor's installed public packages read-only.
// This is not Rondo product code, an independent installation, or an authorization test.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const donorRoot = '/Users/yeemio/AI/gitrep/OwlcodaE';
const projectRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const resolveDonor = createRequire(path.join(donorRoot, 'package.json'));
const identities = {};
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver']) {
  const manifestPath = resolveDonor.resolve(`${name}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  identities[name] = { version: manifest.version, manifestPath, entry: resolveDonor.resolve(name) };
}
assert.equal(identities['@deepseek-ai/cordis'].version, '4.0.5');
assert.equal(identities['@deepseek-ai/dsh-host-webserver'].version, '0.2.1-rc.2.owlcoda.1');
const { Context } = await import(pathToFileURL(resolveDonor.resolve('@deepseek-ai/cordis')));
const { default: WebServer } = await import(pathToFileURL(resolveDonor.resolve('@deepseek-ai/dsh-host-webserver')));
const temporaryRoot = await mkdtemp(path.join(projectRoot, '.rondo-compat-'));
let context;
let database;
let origin;
const observations = {};
try {
  database = new DatabaseSync(path.join(temporaryRoot, 'synthetic.sqlite'));
  database.exec('CREATE TABLE receipt (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  observations.sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  context = new Context();
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  origin = context.webServer.getOrigin();
  context.webServer.register({
    kind: 'exact', path: '/rondo-probe/command',
    handler(req, res) {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      database.prepare('INSERT OR IGNORE INTO receipt VALUES (?, ?)').run('synthetic-command-1', 7);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(database.prepare('SELECT * FROM receipt WHERE id = ?').get('synthetic-command-1')));
    },
  });
  context.webServer.register({
    kind: 'exact', path: '/rondo-probe/receipt',
    handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(database.prepare('SELECT * FROM receipt WHERE id = ?').get('synthetic-command-1')));
    },
  });
  const request = (route, options = {}) => fetch(`${origin}${route}`, { ...options, signal: AbortSignal.timeout(5000) });
  for (let i = 0; i < 2; i++) {
    const response = await request('/rondo-probe/command', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'synthetic-command-1', value: 7 });
  }
  observations.commandDeliveries = 2;
  observations.persistedRows = database.prepare('SELECT COUNT(*) AS count FROM receipt').get().count;
  assert.equal(observations.persistedRows, 1);
  database.close();
  database = new DatabaseSync(path.join(temporaryRoot, 'synthetic.sqlite'));
  observations.afterDatabaseReopen = await (await request('/rondo-probe/receipt')).json();
  assert.deepEqual(observations.afterDatabaseReopen, { id: 'synthetic-command-1', value: 7 });
  observations.unregisteredRoutes = {};
  for (const route of ['/api/terminal', '/api/remotes', '/api/settings']) {
    const response = await request(route);
    observations.unregisteredRoutes[route] = response.status;
    assert.equal(response.status, 404);
  }
  await context.fiber.dispose();
  context = undefined;
  await assert.rejects(request('/rondo-probe/receipt'));
  observations.listenerClosed = true;
} finally {
  if (context) await context.fiber.dispose();
  if (database?.isOpen) database.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({
  schemaVersion: 1,
  status: 'PASS',
  recordedAt: new Date().toISOString(),
  runtime: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch },
  packageResolution: 'READ_ONLY_DONOR_INSTALL_NOT_RONDO_INSTALL',
  identities,
  observations,
  scope: 'Public DSH HTTP composition and synthetic SQLite write/read/reopen only',
  notVerified: ['independent dependency installation', 'product profile', 'React browser UI', 'family authorization', 'crash recovery', 'C++ isolation', 'model gateway', 'learning effect'],
  externalProviderCalls: 0,
  temporaryRootRemoved: true,
}, null, 2));
