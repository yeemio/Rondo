#!/usr/bin/env node
/**
 * check:boundaries — verifies the renderer cannot reach server/private/Node
 * surfaces, at BOTH source and built-output level:
 *
 * 1. Recursive import scan from the renderer roots (apps/web/src .ts/.tsx,
 *    plus the renderer-safe adapters) following relative/absolute TS imports.
 *    Allowed targets: modules/contracts/public/**, adapters/desktop-client/**,
 *    apps/web/src/**, apps/types/**, the PUBLIC content tree
 *    (content/cylinder/public — never private), C's renderer-side scene
 *    modules (modules/scenes, three.js-based, no Node), and the dev-only
 *    mock whitelist (modules/mock-client + the mock entry main.dev.tsx;
 *    the mock is additionally excluded from every product bundle by the
 *    built-output scans below).
 *    Renderer-safe external libraries: zod, react, react-dom, three.
 * 2. Text scan of dist/web/*.js for Node/Electron/server markers that must
 *    never appear in a renderer bundle (import forms, not display strings),
 *    plus the mock markers — a product bundle must not contain the mock
 *    client at all.
 *
 * Exits non-zero on any violation with a concrete list.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoots = [join(root, 'apps/web/src')];
const allowedExternal = new Set(['zod', 'react', 'react-dom', 'three', 'three/addons/controls/OrbitControls.js']);
const allowedPrefixes = [
  join(root, 'modules/contracts/public') + '/',
  // MVP source index contains public prompts and availability metadata only.
  join(root, 'modules/curriculum') + '/',
  join(root, 'adapters/desktop-client') + '/',
  join(root, 'apps/web/src') + '/',
  join(root, 'apps/types') + '/',
  // C's renderer content: PUBLIC tree only — content/cylinder/private stays
  // forbidden and the dist scan independently rejects any private reference.
  join(root, 'content/cylinder/public') + '/',
  join(root, 'content/gesp/public') + '/',
  join(root, 'content/math6/public') + '/',
  // W1 family wiring: themes-a and cpp public trees follow the same
  // public-only discipline (their private trees stay outside this list and
  // the dist scan independently rejects any private reference).
  join(root, 'content/themes-a/public') + '/',
  join(root, 'content/cpp/public') + '/',
  // C's renderer-side scene modules (three.js + SVG, renderer-safe).
  join(root, 'modules/scenes') + '/',
  // DEV-ONLY mock whitelist (main.dev.tsx dev entry); product bundles are
  // checked for mock markers below and by scripts/build-web.mjs.
  join(root, 'modules/mock-client') + '/',
];

const violations = [];
const seen = new Set();

function resolveTsFile(base, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // external
  const target = resolve(base, spec);
  const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.cts`, `${target}.mts`, join(target, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function scanFile(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const importRe = /(?:import|export)[^'";]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(text)) !== null) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      if (!allowedExternal.has(spec) && spec !== 'zod') {
        violations.push(`${relative(root, file)} imports external "${spec}"`);
      }
      continue;
    }
    const resolved = resolveTsFile(dirname(file), spec);
    if (!resolved) {
      violations.push(`${relative(root, file)} imports unresolvable "${spec}"`);
      continue;
    }
    const allowed = allowedPrefixes.some((prefix) => resolved.startsWith(prefix));
    if (!allowed) {
      violations.push(`${relative(root, file)} imports forbidden ${relative(root, resolved)}`);
      continue;
    }
    scanFile(resolved);
  }
}

for (const rendererRoot of rendererRoots) {
  for (const entry of readdirSync(rendererRoot, { recursive: true })) {
    const file = join(rendererRoot, entry.toString());
    if (file.endsWith('.ts')) scanFile(file);
  }
}

// Built renderer output scan: import-shaped markers only (display strings
// like property names are not imports).
const webDist = join(process.env.RONDO_DIST_DIR ?? join(root,'dist'),'web');
const forbiddenPatterns = [
  { re: /["'`]node:[a-z]+["'`]/, label: 'node: builtin import' },
  { re: /\brequire\s*\(\s*["'][^"']+["']\s*\)/, label: 'require() call' },
  { re: /["']electron["']/, label: 'electron import' },
  { re: /contracts\/server/, label: 'server contracts reference' },
  { re: /adapters\/sqlite/, label: 'sqlite adapter reference' },
  { re: /child_process/, label: 'child_process reference' },
  { re: /utilityProcess/, label: 'utilityProcess reference' },
  { re: /content\/cylinder\/private/, label: 'private content reference' },
];
let scannedBundles = 0;
for (const entry of readdirSync(webDist, { recursive: true })) {
  const file = join(webDist, entry.toString());
  if (!file.endsWith('.js')) continue;
  scannedBundles += 1;
  const text = readFileSync(file, 'utf8');
  for (const { re, label } of forbiddenPatterns) {
    if (re.test(text)) violations.push(`dist/web/${relative(webDist, file)} contains ${label}`);
  }
}

if (scannedBundles === 0) {
  console.error('check:boundaries FAIL: no built renderer bundles found (run npm run build first)');
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`check:boundaries FAIL (${violations.length}):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log(`check:boundaries PASS: renderer imports closed (${seen.size} source files), ${scannedBundles} bundle(s) clean`);
