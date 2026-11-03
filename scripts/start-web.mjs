#!/usr/bin/env node
/**
 * Browser-mode launcher: starts the standalone Rondo Host web entry
 * (dist/host/web-index.mjs) with the same env whitelist the desktop
 * supervisor uses, plus the public web root it serves.
 *
 *   RONDO_DATA_ROOT=/absolute/synthetic/root npm run start:web
 *   RONDO_DATA_ROOT=/abs/dir npm run start:web   # explicit (also used by checks)
 *
 * Stop with Ctrl-C (graceful DRAIN close). URL: http://127.0.0.1:47623/
 */
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envDataRoot = process.env['RONDO_DATA_ROOT'];
if (!envDataRoot || !envDataRoot.startsWith('/')) throw new Error('This isolated MVP candidate requires an explicit absolute RONDO_DATA_ROOT.');
const dataRoot = envDataRoot;

for (const dir of [join(dataRoot, 'learning'), join(dataRoot, 'technical', 'logs')]) {
  mkdirSync(dir, { recursive: true });
}

process.stdout.write(`Rondo 浏览器模式启动\n  数据根: ${dataRoot}\n`);

const child = spawn(process.execPath, [join(ROOT, 'dist', 'host', 'web-index.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RONDO_DATA_ROOT: dataRoot,
    RONDO_CONTENT_ROOT: join(ROOT, 'dist', 'content'),
    RONDO_WEB_ROOT: join(ROOT, 'dist', 'web'),
  },
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 128 : 0));
});
