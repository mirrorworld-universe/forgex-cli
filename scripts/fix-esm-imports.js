/**
 * fix-esm-imports.js
 *
 * Postbuild script: fix two classes of import problems in compiled ESM output.
 *
 * Problem 1 — Directory imports (moduleResolution:"bundler" emits bare dirs)
 *   `from '../pump'`  →  `from '../pump/index.js'`
 *   `from './config'` →  `from './config.js'`
 *
 * Problem 2 — TypeScript path aliases not rewritten by tsc
 *   `from '@/utils'`      →  relative path to dist/src/utils/index.js
 *   `from '@/api'`        →  relative path to dist/src/adapters/api.js
 *   `from '@/store'`      →  relative path to dist/src/shims/store.js
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir   = resolve(__dirname, '..', 'dist');
const srcDistDir = join(distDir, 'src');   // dist/src/

// ── Path alias map (mirrors tsconfig.json "paths") ────────────────────────
// Keys are prefix strings; values are absolute paths in dist/
// Ordered longest-first so more-specific rules win.
const ALIAS_MAP = [
  { prefix: '@/store/slices/', target: join(srcDistDir, 'shims', 'store') },
  { prefix: '@/store/',        target: join(srcDistDir, 'shims', 'store') },
  { prefix: '@/store',         target: join(srcDistDir, 'shims', 'store') },
  { prefix: '@/api/',          target: join(srcDistDir, 'adapters', 'api') },
  { prefix: '@/api',           target: join(srcDistDir, 'adapters', 'api') },
  { prefix: '@cli/',           target: srcDistDir + '/' },
  { prefix: '@/',              target: srcDistDir + '/' },
];

// ── Walk dist/ for all .js files ──────────────────────────────────────────
function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walk(full));
    } else if (entry.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

// ── Resolve an absolute target path → .js or /index.js ───────────────────
function resolveToFile(abs) {
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) {
      const idx = join(abs, 'index.js');
      if (existsSync(idx)) return idx;
    } else {
      return abs; // path already points to a file
    }
  }
  if (existsSync(abs + '.js')) return abs + '.js';
  return null;
}

// ── Convert an absolute file path to a relative specifier from `fromDir` ──
function toRelativeSpecifier(fromDir, absTarget) {
  let rel = relative(fromDir, absTarget).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// ── Main ──────────────────────────────────────────────────────────────────
const files = walk(distDir);

// Matches import/export specifiers (both relative and @-aliased)
const importRe = /((?:from|export\s+\*\s+from)\s+)(["'])([@.][^"']*)\2/g;

let totalFixed = 0;

for (const file of files) {
  const fileDir = dirname(file);
  let src = readFileSync(file, 'utf-8');
  let changed = false;

  src = src.replace(importRe, (match, keyword, quote, specifier) => {
    // ── Already has a file extension → skip (only for relative imports, not aliases) ──
    if (!specifier.startsWith('@') && (/\.[cm]?js$/.test(specifier) || specifier.endsWith('.json'))) {
      return match;
    }

    let absTarget = null;

    // ── Case 1: path alias (@/ or @cli/) ──
    if (specifier.startsWith('@')) {
      for (const { prefix, target } of ALIAS_MAP) {
        if (specifier.startsWith(prefix)) {
          const rest = specifier.slice(prefix.length);
          // target may end with '/' (wildcard) or be a fixed path
          const candidate = target.endsWith('/')
            ? target + rest
            : target;
          absTarget = resolveToFile(candidate);
          break;
        }
      }
      if (!absTarget) {
        console.warn(`[fix-esm] Unresolved alias: ${specifier}  in  ${file}`);
        return match;
      }
      const rel = toRelativeSpecifier(fileDir, absTarget);
      changed = true;
      totalFixed++;
      return `${keyword}${quote}${rel}${quote}`;
    }

    // ── Case 2: relative import without extension ──
    const abs = resolve(fileDir, specifier);
    absTarget = resolveToFile(abs);
    if (absTarget) {
      const rel = toRelativeSpecifier(fileDir, absTarget);
      changed = true;
      totalFixed++;
      return `${keyword}${quote}${rel}${quote}`;
    }

    console.warn(`[fix-esm] Cannot resolve: ${specifier}  in  ${file}`);
    return match;
  });

  if (changed) {
    writeFileSync(file, src, 'utf-8');
  }
}

console.log(`[fix-esm] Fixed ${totalFixed} specifiers across ${files.length} files.`);
