/**
 * Market making tools command group - real transaction execution
 *
 * forgex tools turnover | volume | robot-price
 *
 * Phase 3 upgrade:
 * - Use DataSource facade instead of direct sdk-adapter balance queries
 * - Integrate TxTracker for automatic transaction result tracking
 * - Add ensurePasswordAndValidate for password verification
 * - Add suppressConsole/restoreConsole to prevent JSON output pollution
 * - Improve input parameter validation
 * - Improve --daemon mode support
 * - Fix slippage bps -> percentage conversion
 */

import { Command } from 'commander';
import { getGroup, getDecryptedPrivateKey, ensurePasswordAndValidate } from '../../wallet-store.js';
import { loadConfig } from '../../config.js';
import { output, error, info, suppressConsole, restoreConsole, getOutputFormat } from '../../output.js';
import {
  fetchTradeContext,
  executeTrades,
  executeBatchTurnoverTrade,
  buildWalletList,
} from '../../adapters/sdk-adapter.js';
import { getDataSource } from '../../data-source.js';

export function registerToolsCommands(program: Command): void {
  const toolsCmd = program
    .command('tools')
    .description('Professional market making tools');

  // ============================================================
  // forgex tools turnover - real turnover trade
  // ============================================================
  toolsCmd
    .command('turnover')
    .description('Turnover trade (zero-slippage turnover between wallets, using Jito Bundle)')
    .requiredOption('--from-group <id>', 'Source wallet group ID')
    .requiredOption('--to-group <id>', 'Target wallet group ID')
    .requiredOption('--token <ca>', 'Token contract address')
    .option('--amount <value>', 'Amount: fixed token count | percentage (e.g. 50%) | all', 'all')
    .option('--interval <ms>', 'Transfer interval (ms)', '1000')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--slippage <bps>', 'Slippage (bps, e.g. 100 = 1%)', '100')
    .option('--dry-run', 'Simulate only, do not execute', false)
    .option('--fallback-send-tx', 'Fallback to sendTransaction when Bundle fails (no same-block guarantee)', false)
    .option('--daemon', 'Daemon mode (continuous execution)', false)
    .option('--rounds <n>', 'Number of rounds (0=infinite)', '1')
    .action(async (options) => {
      try {
        // Password verification
        await ensurePasswordAndValidate();

        const config = loadConfig();
        const fromGroupId = Number(options.fromGroup);
        const toGroupId = Number(options.toGroup);

        // Parameter validation
        if (isNaN(fromGroupId)) {
          error('--from-group must be a valid number');
          process.exit(1);
        }
        if (isNaN(toGroupId)) {
          error('--to-group must be a valid number');
          process.exit(1);
        }

        const fromGroup = getGroup(fromGroupId);
        const toGroup = getGroup(toGroupId);

        if (!fromGroup) { error(`Source wallet group ${fromGroupId} does not exist`); process.exit(1); }
        if (!toGroup) { error(`Target wallet group ${toGroupId} does not exist`); process.exit(1); }
        if (fromGroup.wallets.length === 0) { error('Source wallet group has no wallets'); process.exit(1); }
        if (toGroup.wallets.length === 0) { error('Target wallet group has no wallets'); process.exit(1); }

        const slippageBps = Number(options.slippage);
        if (isNaN(slippageBps) || slippageBps <= 0 || slippageBps > 5000) {
          error('--slippage must be a number between 1-5000 (bps, 5000 = 50%)');
          process.exit(1);
        }

        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;
        if (isNaN(priorityFee) || priorityFee < 0) {
          error('--priority-fee must be a non-negative number');
          process.exit(1);
        }

        const maxRounds = Number(options.rounds);
        if (isNaN(maxRounds) || maxRounds < 0) {
          error('--rounds must be a non-negative integer');
          process.exit(1);
        }

        // Slippage conversion: bps -> decimal (SDK expects 0.03 for 3%, i.e. 300bps / 10000)
        const slippage = slippageBps / 10000;

        info(`Fetching trade context for token ${options.token}...`);
        const context = await fetchTradeContext(options.token);
        info(`DEX: ${context.exchangeName}, price: ${context.priceInSol} SOL`);

        if (options.dryRun) {
          const estimatedFee = 0;
          output({
            dryRun: true,
            exchangeName: context.exchangeName,
            priceInSol: context.priceInSol,
            fromWallets: fromGroup.wallets.length,
            toWallets: toGroup.wallets.length,
            estimatedFee,
            message: 'Simulation successful',
          });
          return;
        }

        // DataSource for balance queries
        const ds = getDataSource();
        let currentRound = 0;

        const executeOneRound = async () => {
          currentRound++;
          info(`Executing round ${currentRound} turnover...`);

          // Suppress SDK console.log in JSON mode
          if (getOutputFormat() === 'json') suppressConsole();

          // Build turnover pairs
          // Support 1-to-many: if from wallets < to wallets, split tokens proportionally to multiple targets
          const turnoverItems: { fromWallet: string; toWallet: string; tokenAmount: number }[] = [];
          const fromWalletAddresses: string[] = [];

          if (fromGroup.wallets.length >= toGroup.wallets.length) {
            // from >= to: 1:1 pairing (original logic)
            const pairCount = Math.min(fromGroup.wallets.length, toGroup.wallets.length);
            for (let i = 0; i < pairCount; i++) {
              const fromWallet = fromGroup.wallets[i];
              const toWallet = toGroup.wallets[i];

              const tokenBalance = await ds.getTokenBalance(fromWallet.walletAddress, options.token);
              let amount = tokenBalance;
              if (options.amount !== 'all') {
                if (options.amount.endsWith('%')) {
                  amount = tokenBalance * Number(options.amount.replace('%', '')) / 100;
                } else {
                  amount = Number(options.amount);
                }
              }

              if (amount > 0) {
                turnoverItems.push({
                  fromWallet: getDecryptedPrivateKey(fromWallet),
                  toWallet: getDecryptedPrivateKey(toWallet),
                  tokenAmount: amount,
                });
                fromWalletAddresses.push(fromWallet.walletAddress);
              }
            }
          } else {
            // from < to: 1-to-many split mode
            // Each from wallet's tokens are evenly distributed to multiple to wallets
            const toPerFrom = Math.ceil(toGroup.wallets.length / fromGroup.wallets.length);
            let toIndex = 0;

            for (let i = 0; i < fromGroup.wallets.length; i++) {
              const fromWallet = fromGroup.wallets[i];
              const tokenBalance = await ds.getTokenBalance(fromWallet.walletAddress, options.token);

              let totalAmount = tokenBalance;
              if (options.amount !== 'all') {
                if (options.amount.endsWith('%')) {
                  totalAmount = tokenBalance * Number(options.amount.replace('%', '')) / 100;
                } else {
                  totalAmount = Math.min(Number(options.amount), tokenBalance);
                }
              }

              if (totalAmount <= 0) continue;

              // Calculate how many to wallets this from wallet should distribute to
              const remainingTo = toGroup.wallets.length - toIndex;
              const remainingFrom = fromGroup.wallets.length - i;
              const allocCount = Math.min(Math.ceil(remainingTo / remainingFrom), remainingTo);
              const amountPerTo = totalAmount / allocCount;

              for (let j = 0; j < allocCount && toIndex < toGroup.wallets.length; j++) {
                const toWallet = toGroup.wallets[toIndex];
                turnoverItems.push({
                  fromWallet: getDecryptedPrivateKey(fromWallet),
                  toWallet: getDecryptedPrivateKey(toWallet),
                  tokenAmount: amountPerTo,
                });
                fromWalletAddresses.push(fromWallet.walletAddress);
                toIndex++;
              }
            }
          }

          if (turnoverItems.length === 0) {
            restoreConsole();
            info('No available turnover pairs (balance is 0)');
            output({ round: currentRound, total: 0, success: 0, failed: 0, message: 'No available turnover pairs (balance is 0)' });
            return;
          }

          const results = await executeBatchTurnoverTrade({
            context,
            turnoverItems,
            priorityFee,
            slippage,
            fallbackSendTx: Boolean(options.fallbackSendTx),
            intervalMs: Number(options.interval),
          });

          restoreConsole();

          const successCount = results.filter(r => r.success).length;
          output({
            round: currentRound,
            total: results.length,
            success: successCount,
            failed: results.length - successCount,
            results: results.map(r => ({
              success: r.success,
              bundleId: r.bundleId,
              buyTxHash: r.buyTxHash,
              sellTxHash: r.sellTxHash,
              error: r.error,
            })),
          });
        };

        await executeOneRound();

        if (options.daemon && (maxRounds === 0 || currentRound < maxRounds)) {
          const scheduleNext = () => {
            setTimeout(async () => {
              try {
                // Refresh trade context (price may have changed)
                const newContext = await fetchTradeContext(options.token);
                Object.assign(context, newContext);
                await executeOneRound();
              } catch (e: any) {
                restoreConsole();
                error(`Round ${currentRound + 1} execution error: ${e.message}`);
              }
              if (maxRounds === 0 || currentRound < maxRounds) {
                scheduleNext();
              } else {
                info(`Turnover completed ${maxRounds} rounds`);
                process.exit(0);
              }
            }, Number(options.interval));
          };

          scheduleNext();

          process.on('SIGINT', () => {
            restoreConsole();
            info(`Turnover stopped, executed ${currentRound} rounds total`);
            process.exit(0);
          });
        }
      } catch (e: any) {
        restoreConsole();
        error('Turnover failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex tools volume - real volume trading
  // ============================================================
  toolsCmd
    .command('volume')
    .description('Volume tool (zero-loss volume boost)')
    .requiredOption('--group <groupId>', 'Wallet group ID')
    .requiredOption('--token <ca>', 'Token contract address')
    .option('--mode <mode>', 'Volume mode: 1b1s | 1b2s | 1b3s | 2b1s | 3b1s', '1b1s')
    .option('--amount <sol>', 'Trade amount (SOL)', '0.01')
    .option('--count <n>', 'Number of wallets to use (default: all)')
    .option('--interval <ms>', 'Trade interval (ms)', '5000')
    .option('--rounds <n>', 'Number of rounds (0=infinite)', '1')
    .option('--slippage <bps>', 'Slippage (bps)', '300')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--dry-run', 'Simulate only, do not execute', false)
    .option('--daemon', 'Daemon mode', false)
    .action(async (options) => {
      try {
        // Password verification
        await ensurePasswordAndValidate();

        const config = loadConfig();
        const groupId = Number(options.group);
        const amount = Number(options.amount);
        const slippageBps = Number(options.slippage);
        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;

        // Parameter validation
        if (isNaN(groupId)) {
          error('--group must be a valid number');
          process.exit(1);
        }
        if (isNaN(amount) || amount <= 0) {
          error('--amount must be a number greater than 0');
          process.exit(1);
        }
        if (isNaN(slippageBps) || slippageBps <= 0 || slippageBps > 5000) {
          error('--slippage must be a number between 1-5000 (bps, 5000 = 50%)');
          process.exit(1);
        }
        if (isNaN(priorityFee) || priorityFee < 0) {
          error('--priority-fee must be a non-negative number');
          process.exit(1);
        }

        // --mode validation
        const validModes = ['1b1s', '1b2s', '1b3s', '2b1s', '3b1s'];
        if (!validModes.includes(options.mode)) {
          error(`--mode invalid: "${options.mode}", must be 1b1s | 1b2s | 1b3s | 2b1s | 3b1s`);
          process.exit(1);
        }

        const maxRounds = Number(options.rounds);
        if (isNaN(maxRounds) || maxRounds < 0) {
          error('--rounds must be a non-negative integer');
          process.exit(1);
        }

        const group = getGroup(groupId);
        if (!group) { error(`Wallet group ${groupId} does not exist`); process.exit(1); }
        if (group.wallets.length === 0) { error('Wallet group has no wallets'); process.exit(1); }

        // Slippage conversion: bps -> percentage
        const slippage = slippageBps / 10;

        info(`Fetching trade context for token ${options.token}...`);
        let context = await fetchTradeContext(options.token);
        info(`DEX: ${context.exchangeName}, price: ${context.priceInSol} SOL`);

        if (options.dryRun) {
          output({
            dryRun: true,
            exchangeName: context.exchangeName,
            priceInSol: context.priceInSol,
            wallets: group.wallets.length,
            mode: options.mode,
            estimatedFeePerRound: 0,
            message: 'Simulation successful',
          });
          return;
        }

        const allWallets = buildWalletList(group);
        const amountSOL = options.amount;
        let currentRound = 0;

        const executeOneRound = async () => {
          currentRound++;
          info(`Executing round ${currentRound} volume (mode: ${options.mode})...`);

          try {
            // Refresh context each round for latest price
            if (currentRound > 1) {
              context = await fetchTradeContext(options.token);
            }

            // Filter wallets with sufficient SOL balance (amount + 0.002 SOL for fees)
            const minRequired = Number(amountSOL) + 0.002;
            const walletBalances = await Promise.all(
              allWallets.map(async (w) => {
                try {
                  const bal = await context.connection.getBalance(
                    new (await import('@solana/web3.js')).PublicKey(w.address)
                  );
                  return { wallet: w, balance: bal / 1e9 };
                } catch {
                  return { wallet: w, balance: 0 };
                }
              })
            );
            let wallets = walletBalances
              .filter(wb => wb.balance >= minRequired)
              .map(wb => wb.wallet);

            // Limit wallet count if --count is specified
            const walletCount = options.count ? Number(options.count) : 0;
            if (walletCount > 0 && wallets.length > walletCount) {
              wallets = wallets.slice(0, walletCount);
            }

            if (wallets.length === 0) {
              info(`Round ${currentRound}: no wallets with sufficient balance (need >= ${minRequired} SOL), skipping`);
              output({ round: currentRound, total: 0, success: 0, failed: 0, message: `No wallets with sufficient balance (need >= ${minRequired} SOL)` });
              return;
            }

            info(`Round ${currentRound}: using ${wallets.length}/${allWallets.length} wallets`);

            // Suppress SDK console.log in JSON mode
            if (getOutputFormat() === 'json') suppressConsole();

            const result = await executeTrades({
              context,
              wallets,
              tradeType: 'buyWithSell',
              amountPerWallet: amountSOL,
              slippage,
              priorityFee,
              volumeType: options.mode,
              intervalMs: Number(options.interval),
            });

            restoreConsole();

            output({
              round: currentRound,
              ...result,
              timestamp: new Date().toISOString(),
            });
          } catch (e: any) {
            restoreConsole();
            error(`Round ${currentRound} failed: ${e.message}`);
          }
        };

        await executeOneRound();

        if ((options.daemon || maxRounds > 1) && (maxRounds === 0 || currentRound < maxRounds)) {
          const scheduleNext = () => {
            setTimeout(async () => {
              await executeOneRound();
              if (maxRounds === 0 || currentRound < maxRounds) {
                scheduleNext();
              } else {
                info(`Volume completed ${maxRounds} rounds`);
                process.exit(0);
              }
            }, Number(options.interval));
          };

          scheduleNext();

          process.on('SIGINT', () => {
            restoreConsole();
            info(`Volume trading stopped, executed ${currentRound} rounds`);
            process.exit(0);
          });
        }
      } catch (e: any) {
        restoreConsole();
        error('Volume trading failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex tools robot-price - real price robot
  // ============================================================
  toolsCmd
    .command('robot-price')
    .description('Price robot (auto pump/dump to target price)')
    .requiredOption('--group <groupId>', 'Wallet group ID')
    .requiredOption('--token <ca>', 'Token contract address')
    .requiredOption('--direction <dir>', 'Direction: up (pump) | down (dump)')
    .requiredOption('--target-price <price>', 'Target price (SOL)')
    .option('--amount <sol>', 'Amount per trade (SOL)', '0.01')
    .option('--amount-type <type>', 'Amount type: fixed | random', 'fixed')
    .option('--amount-max <sol>', 'Max amount (random mode)')
    .option('--interval <ms>', 'Trade interval (ms)', '5000')
    .option('--max-cost <sol>', 'Max total cost (SOL)')
    .option('--slippage <bps>', 'Slippage (bps)', '300')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--dry-run', 'Dry run only, no actual execution', false)
    .option('--daemon', 'Daemon mode (enabled by default, price robot runs continuously)', true)
    .action(async (options) => {
      try {
        // Password verification
        await ensurePasswordAndValidate();

        const config = loadConfig();
        const groupId = Number(options.group);
        const amountVal = Number(options.amount);
        const slippageBps = Number(options.slippage);
        const targetPrice = Number(options.targetPrice);
        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;

        // Parameter validation
        if (isNaN(groupId)) {
          error('--group must be a valid number');
          process.exit(1);
        }
        if (isNaN(amountVal) || amountVal <= 0) {
          error('--amount must be a number greater than 0');
          process.exit(1);
        }
        if (isNaN(slippageBps) || slippageBps <= 0 || slippageBps > 5000) {
          error('--slippage must be a number between 1-5000 (bps, 5000 = 50%)');
          process.exit(1);
        }
        if (isNaN(priorityFee) || priorityFee < 0) {
          error('--priority-fee must be a non-negative number');
          process.exit(1);
        }
        if (isNaN(targetPrice) || targetPrice <= 0) {
          error('--target-price must be a number greater than 0');
          process.exit(1);
        }

        // --direction validation
        const validDirections = ['up', 'down'];
        if (!validDirections.includes(options.direction)) {
          error(`--direction invalid: "${options.direction}", must be up | down`);
          process.exit(1);
        }

        const group = getGroup(groupId);
        if (!group) { error(`Wallet group ${groupId} does not exist`); process.exit(1); }
        if (group.wallets.length === 0) { error('No wallets in wallet group'); process.exit(1); }

        // Slippage conversion: bps -> percentage
        const slippage = slippageBps / 10;

        info(`Fetching trade context for token ${options.token}...`);
        let context = await fetchTradeContext(options.token);
        info(`DEX: ${context.exchangeName}, Current price: ${context.priceInSol} SOL, Target: ${targetPrice} SOL`);

        if (options.dryRun) {
          output({
            dryRun: true,
            exchangeName: context.exchangeName,
            currentPrice: context.priceInSol,
            targetPrice,
            direction: options.direction,
            message: 'Simulation successful',
          });
          return;
        }

        const wallets = buildWalletList(group);
        const walletAddresses = wallets.map(w => w.address);
        let totalCost = 0;
        let executeCount = 0;
        let maxCost = Infinity;
        if (options.maxCost) {
          maxCost = Number(options.maxCost);
          if (isNaN(maxCost) || maxCost <= 0) {
            error('--max-cost must be a number greater than 0');
            process.exit(1);
          }
        }

        info(`Price robot started: ${options.direction === 'up' ? 'pump' : 'dump'} -> ${targetPrice} SOL`);

        const execute = async () => {
          executeCount++;

          // Refresh price
          context = await fetchTradeContext(options.token);
          const currentPrice = Number(context.priceInSol);

          // Check if target reached
          if (options.direction === 'up' && currentPrice >= targetPrice) {
            output({
              success: true, direction: options.direction,
              targetPrice, currentPrice, totalCost, executeCount,
              message: 'Target price reached',
            });
            process.exit(0);
          }
          if (options.direction === 'down' && currentPrice <= targetPrice) {
            output({
              success: true, direction: options.direction,
              targetPrice, currentPrice, totalCost, executeCount,
              message: 'Target price reached',
            });
            process.exit(0);
          }

          // Check cost limit
          if (totalCost >= maxCost) {
            output({
              success: false, direction: options.direction,
              targetPrice, currentPrice, totalCost, executeCount,
              message: `Cost limit ${maxCost} SOL reached`,
            });
            process.exit(0);
          }

          // Calculate trade amount
          let amount = Number(options.amount);
          if (options.amountType === 'random' && options.amountMax) {
            amount = Math.random() * (Number(options.amountMax) - amount) + amount;
          }

          const tradeType = options.direction === 'up' ? 'buy' : 'sell';
          const currentWallet = wallets[executeCount % wallets.length];

          // sell direction: amount is SOL value, convert to equivalent token amount
          // buy direction: pass SOL amount directly
          let amountForTrade: string;
          if (tradeType === 'sell') {
            // SOL -> token amount: amount(SOL) / pricePerToken(SOL)
            const tokenAmount = currentPrice > 0 ? amount / currentPrice : 0;
            amountForTrade = String(tokenAmount);
            info(`Trade #${executeCount} ${tradeType}, amount: ${amount.toFixed(6)} SOL ≈ ${tokenAmount.toFixed(2)} tokens, current price: ${currentPrice}`);
          } else {
            amountForTrade = String(amount);
            info(`Trade #${executeCount} ${tradeType}, amount: ${amount.toFixed(6)} SOL, current price: ${currentPrice}`);
          }

          // Suppress SDK console.log in JSON mode
          if (getOutputFormat() === 'json') suppressConsole();

          try {
            const result = await executeTrades({
              context,
              wallets: [currentWallet],
              tradeType: tradeType as any,
              amountPerWallet: amountForTrade,
              slippage,
              priorityFee,
            });

            restoreConsole();

            totalCost += amount;

            output({
              round: executeCount,
              direction: options.direction,
              currentPrice,
              targetPrice,
              amount,
              totalCost,
              ...result,
              timestamp: new Date().toISOString(),
            });
          } catch (e: any) {
            restoreConsole();
            error(`Execution error: ${e.message}`);
          }
        };

        await execute();

        // Continuous execution (daemon mode)
        const getInterval = () => {
          if (options.intervalType === 'random' && options.intervalMax) {
            const min = Number(options.interval);
            const max = Number(options.intervalMax);
            return Math.floor(Math.random() * (max - min + 1)) + min;
          }
          return Number(options.interval);
        };

        const scheduleNext = () => {
          setTimeout(async () => {
            await execute();
            scheduleNext();
          }, getInterval());
        };

        scheduleNext();

        process.on('SIGINT', () => {
          restoreConsole();
          info(`Price robot stopped, executed ${executeCount} times, total cost ${totalCost.toFixed(6)} SOL`);
          process.exit(0);
        });
      } catch (e: any) {
        restoreConsole();
        error('Price robot start failed', e.message);
        process.exit(1);
      }
    });
}
