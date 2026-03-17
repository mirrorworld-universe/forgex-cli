/**
 * ForgeX CLI Main Entry
 *
 * Registers all command groups and builds the complete CLI command tree.
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bindProgram } from './output.js';
import { registerConfigCommands } from './commands/config/index.js';
import { registerWalletCommands } from './commands/wallet/index.js';
import { registerTradeCommands } from './commands/trade/index.js';
import { registerToolsCommands } from './commands/tools/index.js';
import { registerTransferCommands } from './commands/transfer/index.js';
import { registerTokenCommands } from './commands/token/index.js';
import { registerQueryCommands } from './commands/query/index.js';

export function createProgram(): Command {
  const program = new Command();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const packageJsonPath = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  program
    .name('forgex')
    .description('ForgeX CLI - Solana on-chain market-making command-line tool')
    .version(pkg.version)
    .option('--format <format>', 'Output format: json | table | minimal', 'json');

  // Show --password global option in --help
  program.addHelpText(
    'after',
    `
Global Options (before subcommand):
  --password <password>    Wallet encryption password (skips interactive prompt, suitable for scripts/Agent automation)
                           Priority: --password > FORGEX_PASSWORD env var > interactive prompt
                           Example: forgex --password "pwd" wallet list-groups
`
  );

  // Bind program instance to output module so --format global flag takes effect
  bindProgram(program);

  // Register command groups
  registerConfigCommands(program);
  registerWalletCommands(program);
  registerTradeCommands(program);
  registerToolsCommands(program);
  registerTransferCommands(program);
  registerTokenCommands(program);
  registerQueryCommands(program);

  return program;
}
