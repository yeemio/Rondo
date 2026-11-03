#!/usr/bin/env node
/**
 * Web bundle builder.
 *
 *   node scripts/build-web.mjs product  -> dist/web/app.js + index.html     (main.tsx; NO mock)
 *   node scripts/build-web.mjs mock     -> dist/web/app.dev.js + index.dev.html (MOCK_ONLY dev entry)
 *
 * Product bundle must never include the mock client or private content; the
 * check at the end fails the build if it does (boundary guard, complements
 * tests/content).
 */
import { build } from 'esbuild';
import { cpSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'product';
const DIST=resolve(process.env.RONDO_DIST_DIR ?? join(ROOT,'dist'));

const entry =
  mode === 'mock' ? join(ROOT, 'apps/web/src/main.dev.tsx') : join(ROOT, 'apps/web/src/main.tsx');
const outfile = mode === 'mock' ? join(DIST,'web','app.dev.js') : join(DIST,'web','app.js');

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile,
  minify: false,
  logLevel: 'warning',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  jsx: 'automatic',
});

if (mode === 'mock') {
  copyFileSync(join(ROOT, 'apps/web/index.dev.html'), join(DIST,'web','index.dev.html'));
} else {
  copyFileSync(join(ROOT, 'apps/web/index.html'), join(DIST,'web','index.html'));
}

// boundary guard: product bundle must not contain mock markers or private paths
if (mode === 'product') {
  const js = readFileSync(outfile, 'utf8');
  const violations = [];
  for (const marker of ['createMockRondo', 'MockStore', 'mock-client', 'content/cylinder/private', 'answerHint', 'mis-appearance-long-edge']) {
    if (js.includes(marker)) violations.push(marker);
  }
  if (violations.length > 0) {
    console.error(`PRODUCT BUNDLE BOUNDARY VIOLATION: ${violations.join(', ')}`);
    process.exit(1);
  }
  console.log('product bundle OK: no mock/private markers');
}
if(mode==='product')cpSync(join(ROOT,'apps/web/public/gesp'),join(DIST,'web/gesp'),{recursive:true});
console.log(`built ${outfile} (${mode}); ${Object.keys(result.metafile.outputs).length} outputs`);
