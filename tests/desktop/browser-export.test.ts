import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadExportFile, exportFiles } from '../../apps/web/src/client/browser-export';
import { createHttpFaces } from '../../apps/web/src/client/http-transport';
const payload = { schemaVersion: 1, generatedAt: 1, scopeHash: 'a'.repeat(64), categories: { ALIASES: [{ alias: '<img src=x onerror=alert(1)>中文' }] } };

test('plain UTF-8 export keeps learner markup inert and rejects unknown top-level categories', () => {
  const files = exportFiles(payload, 'op-test');
  assert.ok(files[1].text.includes('<img src=x onerror=alert(1)>中文'));
  assert.equal(files[1].type, 'text/plain;charset=utf-8');
  assert.throws(() => exportFiles({ ...payload, categories: { credentials: [] } }, 'op-test'));
});

test('confirmation prepares two frozen files without downloads; each later click starts exactly one', async (t) => {
  let clicks = 0;
  let requests = 0;
  const names: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { requests++; return { ok: true, json: async () => ({ ok: true, value: payload }) } as Response; });
  const result = await createHttpFaces().desktop.saveExport({ preparedExportRef: 'op-test' });
  assert.ok(result.ok);
  const ready = result.value as { saved: boolean; delivery: string; files: ReturnType<typeof exportFiles> };
  assert.equal(ready.delivery, 'READY'); assert.equal(ready.saved, false); assert.equal(ready.files.length, 2);
  assert.equal(requests, 1);
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { appendChild() {} }, createElement: () => ({ href: '', download: '', remove() {}, click(this: { download: string }) { clicks++; names.push(this.download); } }) } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document'); });
  const snapshot = JSON.stringify(ready.files);
  assert.equal(clicks, 0);
  assert.equal(downloadExportFile(ready.files[0]).delivery, 'DOWNLOAD_INITIATED');
  assert.equal(clicks, 1);
  assert.equal(downloadExportFile(ready.files[1]).delivery, 'DOWNLOAD_INITIATED');
  assert.equal(clicks, 2); assert.equal(requests, 1);
  assert.deepEqual(names, ['rondo-op-test.json', 'rondo-op-test-summary.txt']);
  assert.equal(JSON.stringify(ready.files), snapshot);
  (document as unknown as { createElement: () => unknown }).createElement = () => ({ remove() {}, click() { throw new Error('blocked'); } });
  const failed = downloadExportFile(ready.files[1]);
  assert.equal(failed.delivery, 'FAILED'); assert.equal(failed.saved, false);
  assert.equal(JSON.stringify(ready.files), snapshot);
});

test('denial, malformed reference and transfer interruption produce no browser download', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return { ok: true, json: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'denied' } }) } as Response; });
  const faces = createHttpFaces();
  assert.equal((await faces.desktop.saveExport({ preparedExportRef: 'op-test' })).ok, false);
  assert.equal((await faces.desktop.saveExport({ preparedExportRef: 42 })).ok, false);
  assert.equal(requests, 1);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('connection lost'); });
  assert.equal((await faces.desktop.saveExport({ preparedExportRef: 'op-test' })).ok, false);
});

