/**
 * Trade command group - real trade execution
 *
 * forgex trade buy | sell | batch | sniper
 *
 * Optimization: returns txHash directly after sending, without waiting for confirmation or tracking details
 */

import { Command } from 'commander';
import { getGroup, ensurePasswordAndValidate } from '../../wallet-store.js';
import { loadConfig } from '../../config.js';
import { output, error, info, suppressConsole, restoreConsole, getOutputFormat } from '../../output.js';
import {
  fetchTradeContext,
  executeTrades,
  buildWalletList,
  getTokenBalance,
} from '../../adapters/sdk-adapter.js';
import { getDataSource } from '../../data-source.js';
import type { TrackingContext } from '../../tx-tracker/index.js';

/**
 * Fire-and-forget: track transaction results in background to update local holdings/balances.
 * Does not block output or process exit.
 */
function trackInBackground(
  result: { success: boolean; txHashes?: string[]; bundleId?: string },
  tokenCA: string,
  groupId: number,
  tradeType: TrackingContext['txType'],
  walletAddresses: string[],
): void {
  if (!result.success) return;

  const ds = getDataSource();
  const context: TrackingContext = {
    ca: tokenCA,
    groupId,
    txType: tradeType,
    wallets: walletAddresses,
    jitoBundle: result.bundleId,
  };

  const doTrack = async () => {
    if (result.bundleId && result.txHashes) {
      await ds.trackBundle(result.bundleId, result.txHashes, context);
    } else if (result.txHashes && result.txHashes.length > 0) {
      await ds.trackBatch(
        result.txHashes.map(txHash => ({ txHash, context })),
      );
    }
  };

  doTrack().catch(() => {
    // Silent fail - tracking is best-effort, should not affect CLI exit
  });
}

export function registerTradeCommands(program: Command): void {
  const tradeCmd = program
    .command('trade')
    .description('Trade operations');

  // ============================================================
  // forgex trade buy - real batch buy
  // ============================================================
  tradeCmd
    .command('buy')
    .description('Batch buy tokens')
    .requiredOption('--group <groupId>', 'Wallet group ID')
    .requiredOption('--token <ca>', 'Token contract address')
    .requiredOption('--amount <sol>', 'Amount per wallet (SOL)')
    .option('--slippage <bps>', 'Slippage (bps, e.g. 300 = 3%)', '300')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--dry-run', 'Dry run only, no actual execution', false)
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();
        const config = loadConfig();
        const groupId = Number(options.group);
        const amount = Number(options.amount);
        const slippageBps = Number(options.slippage);
        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;

        if (isNaN(groupId)) { error('--group must be a valid number'); process.exit(1); }
        if (isNaN(amount) || amount <= 0) { error('--amount must be a number greater than 0'); process.exit(1); }
        if (isNaN(slippageBps) || slippageBps <= 0 || slippageBps > 5000) { error('--slippage must be a number between 1-5000'); process.exit(1); }
        if (isNaN(priorityFee) || priorityFee < 0) { error('--priority-fee must be a non-negative number'); process.exit(1); }

        const group = getGroup(groupId);
        if (!group) { error(`Wallet group ${groupId} does not exist`); process.exit(1); }
        if (group.wallets.length === 0) { error('No wallets in wallet group'); process.exit(1); }

        const slippage = slippageBps / 10;
        info(`Fetching trade context for token ${options.token}...`);
        const context = await fetchTradeContext(options.token);
        info(`DEX: ${context.exchangeName}, Price: ${context.priceInSol} SOL`);

        const wallets = buildWalletList(group);
        if (getOutputFormat() === 'json') suppressConsole();

        info(`Submitting buy trades: ${wallets.length} wallets, ${options.amount} SOL each...`);
        const result = await executeTrades({
          context, wallets, tradeType: 'buy',
          amountPerWallet: options.amount, slippage, priorityFee,
          simulate: options.dryRun,
        });
        restoreConsole();
        output(result);
        if (!options.dryRun) trackInBackground(result, options.token, groupId, 'buy', wallets.map(w => w.address));
        if (!result.success && !options.dryRun) process.exit(1);
      } catch (e: any) {
        restoreConsole();
        error('Buy failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex trade sell - real batch sell
  // ============================================================
  tradeCmd
    .command('sell')
    .description('Batch sell tokens')
    .requiredOption('--group <groupId>', 'Wallet group ID')
    .requiredOption('--token <ca>', 'Token contract address')
    .requiredOption('--amount <value>', 'Sell amount: percentage (e.g. 50%), all, or specific token amount')
    .option('--slippage <bps>', 'Slippage (bps, e.g. 300 = 3%)', '300')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--dry-run', 'Dry run only, no actual execution', false)
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();
        const config = loadConfig();
        const groupId = Number(options.group);
        const slippageBps = Number(options.slippage);
        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;

        if (isNaN(groupId)) { error('--group must be a valid number'); process.exit(1); }
        if (isNaN(slippageBps) || slippageBps <= 0 || slippageBps > 5000) { error('--slippage must be a number between 1-5000'); process.exit(1); }
        if (isNaN(priorityFee) || priorityFee < 0) { error('--priority-fee must be a non-negative number'); process.exit(1); }

        const group = getGroup(groupId);
        if (!group) { error(`Wallet group ${groupId} does not exist`); process.exit(1); }
        if (group.wallets.length === 0) { error('No wallets in wallet group'); process.exit(1); }

        const slippage = slippageBps / 10;

        // Pre-validate amount format
        const amountRaw = options.amount as string;
        if (amountRaw.endsWith('%')) {
          const pctVal = Number(amountRaw.replace('%', ''));
          if (isNaN(pctVal) || pctVal <= 0 || pctVal > 100) {
            error(`Invalid percentage: ${amountRaw}, valid range 1%-100%`);
            process.exit(1);
          }
        } else if (amountRaw !== 'all') {
          const numVal = Number(amountRaw);
          if (isNaN(numVal) || numVal <= 0) {
            error(`Invalid sell amount: ${amountRaw}, enter a positive number, percentage (e.g. 50%), or all`);
            process.exit(1);
          }
        }

        info(`Fetching trade context for token ${options.token}...`);
        const context = await fetchTradeContext(options.token);
        info(`DEX: ${context.exchangeName}, Price: ${context.priceInSol} SOL`);

        const wallets = buildWalletList(group);

        let amountPerWallet: string | string[];
        if (amountRaw === 'all' || amountRaw.endsWith('%')) {
          info('Querying token balances for wallets...');
          const balances = await Promise.all(
            wallets.map(w => getTokenBalance(w.address, options.token))
          );
          if (amountRaw === 'all') {
            amountPerWallet = balances.map(bal => String(bal));
          } else {
            const pct = Number(amountRaw.replace('%', '')) / 100;
            amountPerWallet = balances.map(bal => String(bal * pct));
          }
          const hasBalance = balances.some(b => b > 0);
          if (!hasBalance) { error('All wallet token balances are 0, cannot sell'); process.exit(1); }
        } else {
          amountPerWallet = amountRaw;
        }

        if (getOutputFormat() === 'json') suppressConsole();
        info(`Submitting sell trades: ${wallets.length} wallets...`);
        const result = await executeTrades({
          context, wallets, tradeType: 'sell',
          amountPerWallet, slippage, priorityFee,
          simulate: options.dryRun,
        });
        restoreConsole();
        output(result);
        if (!options.dryRun) trackInBackground(result, options.token, groupId, 'sell', wallets.map(w => w.address));
        if (!result.success && !options.dryRun) process.exit(1);
      } catch (e: any) {
        restoreConsole();
        error('Sell failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex trade batch - real batch trade (volume mode)
  // ============================================================
  tradeCmd
    .command('batch')
    .description('Batch trade (volume mode)')
    .requiredOption('--group <groupId>', 'Wallet group ID')
    .requiredOption('--token <ca>', 'Token contract address')
    .requiredOption('--type <type>', 'Trade type: buy | sell | buyWithSell')
    .option('--mode <mode>', 'Volume mode: 1b1s | 1b2s | 1b3s | 2b1s | 3b1s', '1b1s')
    .option('--amount <sol>', 'Trade amount (SOL)', '0.01')
    .option('--slippage <bps>', 'Slippage (bps, e.g. 300 = 3%)', '300')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--dry-run', 'Dry run only, no actual execution', false)
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();
        const config = loadConfig();
        const groupId = Number(options.group);
        const amount = Number(options.amount);
        const slippageBps = Number(options.slippage);
        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;

        if (isNaN(groupId)) { error('--group must be a valid number'); process.exit(1); }
        if (isNaN(amount) || amount <= 0) { error('--amount must be a number greater than 0'); process.exit(1); }
        if (isNaN(slippageBps) || slippageBps <= 0 || slippageBps > 5000) { error('--slippage must be a number between 1-5000'); process.exit(1); }
        if (isNaN(priorityFee) || priorityFee < 0) { error('--priority-fee must be a non-negative number'); process.exit(1); }

        const validTypes = ['buy', 'sell', 'buyWithSell'];
        if (!validTypes.includes(options.type)) { error(`--type invalid: "${options.type}", must be buy | sell | buyWithSell`); process.exit(1); }
        const validModes = ['1b1s', '1b2s', '1b3s', '2b1s', '3b1s'];
        if (!validModes.includes(options.mode)) { error(`--mode invalid: "${options.mode}", must be 1b1s | 1b2s | 1b3s | 2b1s | 3b1s`); process.exit(1); }

        const group = getGroup(groupId);
        if (!group) { error(`Wallet group ${groupId} does not exist`); process.exit(1); }

        const slippage = slippageBps / 10;
        info(`Fetching trade context for token ${options.token}...`);
        const context = await fetchTradeContext(options.token);
        info(`DEX: ${context.exchangeName}, Price: ${context.priceInSol} SOL`);

        const wallets = buildWalletList(group);
        if (getOutputFormat() === 'json') suppressConsole();

        info(`Submitting batch trade: mode ${options.mode}, type ${options.type}, ${wallets.length} wallets...`);
        const result = await executeTrades({
          context, wallets, tradeType: options.type as any,
          amountPerWallet: options.amount, slippage, priorityFee,
          volumeType: options.mode, simulate: options.dryRun,
        });
        restoreConsole();
        output(result);
        if (!options.dryRun) {
          const txType = options.type === 'sell' ? 'sell' : 'buy';
          trackInBackground(result, options.token, groupId, txType as TrackingContext['txType'], wallets.map(w => w.address));
        }
        if (!result.success && !options.dryRun) process.exit(1);
      } catch (e: any) {
        restoreConsole();
        error('Batch trade failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex trade sniper - real sniper buy
  // ============================================================
  tradeCmd
    .command('sniper')
    .description('Sniper buy')
    .requiredOption('--group <groupId>', 'Wallet group ID')
    .requiredOption('--token <ca>', 'Token contract address')
    .requiredOption('--amounts <amounts>', 'Buy amount per wallet (comma-separated, in SOL)')
    .option('--slippage <bps>', 'Slippage (bps, e.g. 500 = 5%)', '500')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--dry-run', 'Dry run only, no actual execution', false)
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();
        const config = loadConfig();
        const groupId = Number(options.group);
        const slippageBps = Number(options.slippage);
        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;

        if (isNaN(groupId)) { error('--group must be a valid number'); process.exit(1); }
        if (isNaN(slippageBps) || slippageBps <= 0 || slippageBps > 5000) { error('--slippage must be a number between 1-5000'); process.exit(1); }
        if (isNaN(priorityFee) || priorityFee < 0) { error('--priority-fee must be a non-negative number'); process.exit(1); }

        const group = getGroup(groupId);
        if (!group) { error(`Wallet group ${groupId} does not exist`); process.exit(1); }

        const amounts = options.amounts.split(',').map(Number);
        for (let i = 0; i < amounts.length; i++) {
          if (isNaN(amounts[i]) || amounts[i] <= 0) {
            error(`Amount #${i + 1} in --amounts is invalid`);
            process.exit(1);
          }
        }
        if (amounts.length !== group.wallets.length) {
          error(`Amount count (${amounts.length}) does not match wallet count (${group.wallets.length})`);
          process.exit(1);
        }

        const slippage = slippageBps / 10;
        info(`Fetching trade context for token ${options.token}...`);
        const context = await fetchTradeContext(options.token);
        info(`DEX: ${context.exchangeName}, Price: ${context.priceInSol} SOL`);

        const wallets = buildWalletList(group);
        if (getOutputFormat() === 'json') suppressConsole();

        info(`Submitting sniper trades: ${wallets.length} wallets...`);
        const result = await executeTrades({
          context, wallets, tradeType: 'sniperBuy',
          amountPerWallet: amounts.map(a => String(a)),
          slippage, priorityFee, simulate: options.dryRun,
        });
        restoreConsole();
        output(result);
        if (!options.dryRun) trackInBackground(result, options.token, groupId, 'buy', wallets.map(w => w.address));
        if (!result.success && !options.dryRun) process.exit(1);
      } catch (e: any) {
        restoreConsole();
        error('Sniper trade failed', e.message);
        process.exit(1);
      }
    });
}
