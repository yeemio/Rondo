#!/usr/bin/env node
/**
 * package:mac — builds a LOCAL UNSIGNED candidate Rondo.app (darwin-arm64).
 * No install, no codesign, no notarization, no distribution (frozen R0
 * boundary): the output stays under build/out for inspection only.
 *
 * Steps (all real, no fake placeholders):
 *  1. stage a production app dir: dist/ + vendored DSH closure + a runtime
 *     package.json (production dependencies + the same file: overrides as
 *     the root) ;
 *  2. npm install --omit=dev inside the staging dir (production closure);
 *  3. @electron/packager with the locked Electron 44.7.0, asar disabled so
 *     the candidate's contents stay inspectable.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');
const staging = join(buildDir, 'package-staging');
const outDir = join(buildDir, 'out');

if (!existsSync(join(root, 'dist', 'main', 'index.cjs'))) {
  console.error('package:mac FAIL: dist/main/index.cjs missing — run npm run build first');
  process.exit(1);
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// dist + vendor (the file: dependencies resolve inside staging)
cpSync(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
cpSync(join(root, 'vendor'), join(staging, 'vendor'), { recursive: true });

const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeManifest = {
  name: 'rondo',
  productName: 'Rondo',
  version: rootManifest.version,
  private: true,
  description: rootManifest.description,
  main: 'dist/main/index.cjs',
  dependencies: rootManifest.dependencies,
  overrides: rootManifest.overrides,
};
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`);

console.log('package:mac: installing production closure into staging...');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: staging,
  stdio: 'inherit',
});

console.log('package:mac: running @electron/packager (Electron 44.7.0, unsigned)...');
const appPaths = await packager({
  dir: staging,
  name: 'Rondo',
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: '44.7.0',
  out: outDir,
  asar: false,
  overwrite: true,
  quiet: false,
});

if (appPaths.length !== 1) {
  console.error(`package:mac FAIL: unexpected packager output ${JSON.stringify(appPaths)}`);
  process.exit(1);
}
const appPath = appPaths[0];
console.log(`package:mac OK (UNSIGNED local candidate): ${appPath}`);
console.log('package:mac: NOT installed, NOT signed, NOT notarized — R0 boundary.');
