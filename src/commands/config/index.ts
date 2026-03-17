/**
 * Configuration management command group
 *
 * forgex config init | set | get | list
 */

import { Command } from 'commander';
import {
  initConfig,
  loadConfig,
  setConfigValue,
  getConfigValue,
  CONFIG_FILE,
} from '../../config.js';
import { output, success, error } from '../../output.js';

export function registerConfigCommands(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Configuration management');

  // forgex config init
  configCmd
    .command('init')
    .description('Initialize config file')
    .option('--rpc-url <url>', 'Solana RPC node URL')
    .option('--codex-api-key <key>', 'Codex API Key')
    .option('--network <network>', 'Network type: mainnet | devnet | testnet')
    .action((options) => {
      try {
        const overrides: Record<string, unknown> = {};
        if (options.rpcUrl) overrides.rpcUrl = options.rpcUrl;
        if (options.codexApiKey) overrides.codexApiKey = options.codexApiKey;
        if (options.network) overrides.network = options.network;

        const config = initConfig(overrides as any);
        output({ success: true, configFile: CONFIG_FILE, config });
        success(`Config file created: ${CONFIG_FILE}`);
      } catch (e: any) {
        error('Failed to initialize config', e.message);
        process.exit(1);
      }
    });

  // forgex config set <key> <value>
  configCmd
    .command('set <key> <value>')
    .description('Set config value')
    .action((key, value) => {
      try {
        setConfigValue(key, value);
        output({ success: true, key, value: getConfigValue(key) });
        success(`Config updated: ${key} = ${value}`);
      } catch (e: any) {
        error('Failed to set config', e.message);
        process.exit(1);
      }
    });

  // forgex config get [key]
  configCmd
    .command('get [key]')
    .description('Get config value')
    .action((key) => {
      try {
        if (key) {
          const value = getConfigValue(key);
          if (value === undefined) {
            error(`Config key does not exist: ${key}`);
            process.exit(1);
          }
          output({ key, value });
        } else {
          const config = loadConfig();
          output(config);
        }
      } catch (e: any) {
        error('Failed to read config', e.message);
        process.exit(1);
      }
    });

  // forgex config list
  configCmd
    .command('list')
    .description('List all config')
    .action(() => {
      try {
        const config = loadConfig();
        output(config);
      } catch (e: any) {
        error('Failed to read config', e.message);
        process.exit(1);
      }
    });
}
