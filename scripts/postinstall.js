/**
 * Postinstall script: patch third-party packages for Node.js ESM compatibility.
 *
 * Patch 1 — @coral-xyz/anchor
 *   anchor 0.31.0 has no "exports" field; Node.js ESM named-export heuristic
 *   fails for BN. Fix: generate a thin ESM wrapper and add an exports field.
 *
 * Patch 2 — @meteora-ag/dlmm
 *   Its ESM build (index.mjs) has broken directory imports inside anchor.
 *   Fix: redirect ESM consumers to the CJS build (index.js).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeModules = resolve(__dirname, '..', 'node_modules');

// ── Patch 1: @coral-xyz/anchor ────────────────────────────────────────────
const anchorDir     = resolve(nodeModules, '@coral-xyz', 'anchor');
const anchorPkgPath = resolve(anchorDir, 'package.json');

if (existsSync(anchorPkgPath)) {
  const pkg = JSON.parse(readFileSync(anchorPkgPath, 'utf-8'));

  const needsBytesSubpath = pkg.exports?.['./dist/cjs/utils/bytes'] !== './dist/cjs/utils/bytes/index.js';

  if (!pkg.exports) {
    const wrapperPath = resolve(anchorDir, 'esm-wrapper.mjs');
    const wrapperCode = `// Auto-generated ESM wrapper for @coral-xyz/anchor CJS build
import anchor from './dist/cjs/index.js';

export const {
  BN, web3, getProvider, setProvider, AnchorProvider,
  utils, IdlError, ProgramErrorStack, AnchorError, ProgramError,
  LangErrorCode, LangErrorMessage, translateError,
  BorshInstructionCoder, BorshAccountsCoder, BorshEventCoder,
  BorshCoder, SystemCoder, Program, parseIdlErrors,
  toInstruction, validateAccounts, translateAddress,
  splitArgsAndCtx, EventManager, EventParser,
  AccountClient, MethodsBuilderFactory, Native,
  workspace, Wallet,
} = anchor;

export default anchor;
`;
    writeFileSync(wrapperPath, wrapperCode);

    pkg.exports = {
      '.': {
        import:  './esm-wrapper.mjs',
        require: './dist/cjs/index.js',
      },
      // Allow CJS subpath access (e.g. @meteora-ag/dlmm requires this)
      './dist/cjs/utils/bytes':   './dist/cjs/utils/bytes/index.js',
      './dist/cjs/utils/bytes/*': './dist/cjs/utils/bytes/*.js',
      './*':            './*',
      './package.json': './package.json',
    };

    writeFileSync(anchorPkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[postinstall] Patched @coral-xyz/anchor with ESM wrapper');
  } else if (needsBytesSubpath) {
    // exports already exists but is missing the bytes subpath
    pkg.exports['./dist/cjs/utils/bytes']    = './dist/cjs/utils/bytes/index.js';
    pkg.exports['./dist/cjs/utils/bytes/*']  = './dist/cjs/utils/bytes/*.js';
    writeFileSync(anchorPkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[postinstall] Updated @coral-xyz/anchor exports with bytes subpath');
  }
}

// ── Patch 2: @meteora-ag/dlmm ─────────────────────────────────────────────
const meteoraDir     = resolve(nodeModules, '@meteora-ag', 'dlmm');
const meteoraPkgPath = resolve(meteoraDir, 'package.json');

if (existsSync(meteoraPkgPath)) {
  const pkg = JSON.parse(readFileSync(meteoraPkgPath, 'utf-8'));

  if (pkg.exports?.['.']?.import !== './dist/index.js') {
    if (pkg.exports?.['.']) {
      pkg.exports['.'].import  = './dist/index.js';
      pkg.exports['.'].default = './dist/index.js';
    }
    writeFileSync(meteoraPkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[postinstall] Patched @meteora-ag/dlmm to use CJS build for ESM imports');
  }
}
