#!/usr/bin/env node

/**
 * ForgeX CLI Entry Point
 *
 * Solana on-chain market-making system CLI tool
 *
 * Startup flow:
 * 1. Detect if wallet store uses legacy format (plaintext private keys); if so, auto-migrate to encrypted format
 * 2. Build command tree and parse CLI arguments
 */

import { createProgram } from '../src/index.js';
import { migrateToEncryptedStore, setMasterPassword } from '../src/wallet-store.js';
import { trackCommand, shutdownTelemetry } from '../src/telemetry.js';

/**
 * Extract global --password argument from argv (before the subcommand name).
 *
 * Not registered as a Commander global option because wallet import-group / export-group
 * already have a --password subcommand option; registering it on program would conflict.
 */
function extractGlobalPassword(argv: string[]): {
  password: string | null;
  cleanedArgv: string[];
} {
  const cleaned = [...argv];
  for (let i = 2; i < cleaned.length; i++) {
    // Non-dash argument means we've reached the subcommand name; stop searching
    if (!cleaned[i].startsWith('-')) break;

    if (cleaned[i].startsWith('--password=')) {
      const pw = cleaned[i].substring('--password='.length);
      cleaned.splice(i, 1);
      return { password: pw, cleanedArgv: cleaned };
    }
    if (cleaned[i] === '--password' && i + 1 < cleaned.length) {
      const pw = cleaned[i + 1];
      cleaned.splice(i, 2);
      return { password: pw, cleanedArgv: cleaned };
    }

    // Skip other --key value global arguments (e.g. --format json)
    if (cleaned[i].startsWith('--') && !cleaned[i].includes('=')) i++;
  }
  return { password: null, cleanedArgv: cleaned };
}

async function main(): Promise<void> {
  // Extract global --password (highest priority: --password > FORGEX_PASSWORD env > interactive prompt)
  const { password, cleanedArgv } = extractGlobalPassword(process.argv);
  if (password) setMasterPassword(password);

  // Detect and migrate legacy wallet store (plaintext private keys -> AES encryption)
  await migrateToEncryptedStore();

  const program = createProgram();

  // Telemetry: track command execution (extract subcommand name)
  const args = cleanedArgv.slice(2).filter(a => !a.startsWith('-'));
  const command = args.join(' ') || 'help';
  trackCommand(command);

  program.parse(cleanedArgv);
}

main()
  .catch((err) => {
    console.error('Startup failed:', err.message || err);
    process.exit(1);
  })
  .finally(() => {
    shutdownTelemetry().catch(() => {});
  });
