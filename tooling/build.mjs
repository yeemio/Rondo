#!/usr/bin/env node
/**
 * Rondo build (esbuild, per ARCHITECTURE §7): separate bundles for
 * Main (CJS), preload (CJS), Host (ESM, DSH external) and Web (IIFE).
 * The static DSH profile is copied verbatim to dist/host/cordis.yml.
 *
 * integrated/ wiring:
 * - Web step = C's product entry through scripts/build-web.mjs (product
 *   mode; mock/dev entry excluded from the product tree).
 * - The transport probe (tests/desktop/fixtures/probe) is built ONLY when
 *   RONDO_BUILD_PROBE=1, into dist/web/__probe/ — it never enters a product
 *   candidate (package:mac does not set the env).
 * - scripts/build-content.mjs runs after the web step and emits both the
 *   content/cylinder tree and dist/content (the B release layout the Host
 *   reads through RONDO_CONTENT_ROOT).
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(process.env.RONDO_DIST_DIR ?? join(root, 'dist'));
if (!dist.startsWith(root + '/')) throw new Error('Build output must stay inside this candidate.');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const nodeCommon = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: 'linked',
  logLevel: 'warning',
};

async function buildMain() {
  await build({
    ...nodeCommon,
    format: 'cjs',
    entryPoints: [
      { in: join(root, 'apps/desktop/main.ts'), out: 'index' },
      { in: join(root, 'apps/desktop/preload.cts'), out: 'preload' },
    ],
    outdir: join(dist, 'main'),
    outExtension: { '.js': '.cjs' },
    external: ['electron'],
  });
}

async function buildHost() {
  await build({
    ...nodeCommon,
    format: 'esm',
    entryPoints: [
      { in: join(root, 'apps/host/main.ts'), out: 'index' },
      { in: join(root, 'apps/host/web-main.ts'), out: 'web-index' },
    ],
    outdir: join(dist, 'host'),
    outExtension: { '.js': '.mjs' },
    external: ['electron', '@deepseek-ai/*'],
    loader: { '.sql': 'text', '.yml': 'text' },
  });
  await build({
    ...nodeCommon,
    format: 'esm',
    entryPoints: [
      { in: join(root, 'apps/host/services/ipc-router.ts'), out: 'services/ipc-router' },
      { in: join(root, 'apps/host/services/learning-wiring.ts'), out: 'services/learning-wiring' },
      { in: join(root, 'apps/host/services/web-gateway.ts'), out: 'services/web-gateway' },
    ],
    outdir: join(dist, 'host'),
    outExtension: { '.js': '.mjs' },
    external: ['electron', '@deepseek-ai/*'],
    loader: { '.sql': 'text', '.yml': 'text' },
  });
  // The static profiles: entries resolve relative to the config file, so the
  // yml must sit beside the host bundle and its services directory.
  cpSync(join(root, 'apps/host/profile/cordis.yml'), join(dist, 'host', 'cordis.yml'));
  cpSync(join(root, 'apps/host/profile/cordis-web.yml'), join(dist, 'host', 'cordis-web.yml'));
}

/** Web step: C's product entry via scripts/build-web.mjs (product mode, no mock). */
async function buildWeb() {
  execFileSync(process.execPath, [join(root, 'scripts/build-web.mjs'), 'product'], { stdio: 'inherit' });
}

/** Transport probe (test fixture): ONLY when RONDO_BUILD_PROBE=1. */
async function buildProbe() {
  const probeDir = join(dist, 'web', '__probe');
  await build({
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
  console.log('build: probe fixture -> dist/web/__probe (RONDO_BUILD_PROBE=1 only)');
}

/** Content step: all content families (cylinder + themes-a + cpp) into dist/content. */
function buildContent() {
  for (const script of ['build-content.mjs', 'build-content-themes.mjs', 'build-content-cpp.mjs', 'build-content-mvp.mjs','build-content-ai.mjs','build-content-gesp.mjs','build-content-math6.mjs']) {
    execFileSync(process.execPath, [join(root, 'scripts', script)], { stdio: 'inherit' });
  }
}

await buildMain();
await buildHost();
await buildWeb();
if (process.env.RONDO_BUILD_PROBE === '1') {
  await buildProbe();
}
buildContent();
console.log('build: dist/main dist/host dist/web dist/content OK');
