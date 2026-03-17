/**
 * Transfer command group - real transaction execution
 *
 * forgex transfer in | out | many-to-many
 *
 * Phase 3 upgrade:
 * - Use DataSource facade for balance queries
 * - Integrate TxTracker for automatic transfer result tracking
 * - Add ensurePasswordAndValidate for password verification
 * - Add suppressConsole/restoreConsole to prevent JSON output pollution
 * - Improve input parameter validation
 * - Add balance pre-check
 */

import { Command } from 'commander';
import { getGroup, getAllGroups, getDecryptedPrivateKey, ensurePasswordAndValidate } from '../../wallet-store.js';
import { loadConfig } from '../../config.js';
import { output, error, info, suppressConsole, restoreConsole, getOutputFormat } from '../../output.js';
import {
  executeSOLTransfer,
  executeSOLTransferMultiHop,
  executeBatchSOLTransfer,
  executeCollectSOL,
  buildWalletList,
  sleep,
} from '../../adapters/sdk-adapter.js';
import { getDataSource } from '../../data-source.js';

export function registerTransferCommands(program: Command): void {
  const transferCmd = program
    .command('transfer')
    .description('Transfer operations');

  // ============================================================
  // forgex transfer in - real batch collect
  // ============================================================
  transferCmd
    .command('in')
    .description('Batch collect (multiple wallets to one address)')
    .requiredOption('--to <address>', 'Target address')
    .requiredOption('--from-group <id>', 'Source wallet group ID')
    .option('--token <token>', 'Token: SOL or contract address', 'SOL')
    .option('--amount <type>', 'Amount type: all | fixed | reserve', 'all')
    .option('--value <n>', 'Amount value (SOL or token count)')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--dry-run', 'Simulate only, do not execute', false)
    .action(async (options) => {
      try {
        // Password verification
        await ensurePasswordAndValidate();

        const config = loadConfig();
        const groupId = Number(options.fromGroup);

        // Parameter validation
        if (isNaN(groupId)) {
          error('--from-group must be a valid number');
          process.exit(1);
        }

        const group = getGroup(groupId);
        if (!group) { error(`Wallet group ${groupId} does not exist`); process.exit(1); }
        if (group.wallets.length === 0) { error('Wallet group has no wallets'); process.exit(1); }

        // --amount validation
        const validAmountTypes = ['all', 'fixed', 'reserve'];
        if (!validAmountTypes.includes(options.amount)) {
          error(`--amount invalid: "${options.amount}", must be all | fixed | reserve`);
          process.exit(1);
        }

        if ((options.amount === 'fixed' || options.amount === 'reserve') && !options.value) {
          error(`--amount ${options.amount} mode requires --value parameter`);
          process.exit(1);
        }

        if (options.value) {
          const val = Number(options.value);
          if (isNaN(val) || val < 0) {
            error('--value must be a non-negative number');
            process.exit(1);
          }
        }

        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;
        if (isNaN(priorityFee) || priorityFee < 0) {
          error('--priority-fee must be a non-negative number');
          process.exit(1);
        }

        const wallets = buildWalletList(group);
        const ds = getDataSource();

        if (options.dryRun) {
          // Query balance via DataSource
          const balances: { address: string; balance: number }[] = [];
          for (const w of wallets) {
            const bal = await ds.getSolBalance(w.address);
            balances.push({ address: w.address, balance: bal });
          }
          output({
            dryRun: true,
            to: options.to,
            walletCount: wallets.length,
            balances,
            totalBalance: balances.reduce((sum, b) => sum + b.balance, 0),
            message: 'Simulation successful',
          });
          return;
        }

        // Suppress SDK console.log in JSON mode
        if (getOutputFormat() === 'json') suppressConsole();

        if (options.token === 'SOL') {
          info(`Executing SOL collect: ${wallets.length} wallets -> ${options.to}`);
          const results = await executeCollectSOL({
            wallets: wallets.map(w => ({
              privateKey: w.privateKey,
              address: w.address,
            })),
            toAddress: options.to,
            amountType: options.amount as any,
            fixedAmount: options.amount === 'fixed' ? Number(options.value) : undefined,
            reserveAmount: options.amount === 'reserve' ? Number(options.value) : undefined,
            priorityFee,
          });

          restoreConsole();

          const successCount = results.filter(r => r.success).length;
          output({
            success: successCount > 0,
            total: results.length,
            successCount,
            failedCount: results.length - successCount,
            results,
          });
        } else {
          restoreConsole();
          // SPL Token collect - query token balance via DataSource
          info(`Executing token collect: ${options.token}`);
          output({
            success: false,
            error: 'Token collect feature is under development, please use SOL collect first',
          });
        }
      } catch (e: any) {
        restoreConsole();
        error('Batch collect failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex transfer out - real batch distribute
  // ============================================================
  transferCmd
    .command('out')
    .description('Batch distribute (one address to multiple wallets)')
    .requiredOption('--from <address>', 'Source address (must be in a wallet group with private key)')
    .requiredOption('--to-group <id>', 'Target wallet group ID')
    .option('--token <token>', 'Token: SOL or contract address', 'SOL')
    .option('--amount <type>', 'Amount type: fixed | random', 'fixed')
    .requiredOption('--value <n>', 'Amount value (SOL or token count)')
    .option('--max <n>', 'Max value (random mode)')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--batch-size <n>', 'Batch size', '20')
    .option('--multi-hop', 'Enable multi-hop transfer (via 6 temp relay wallets, SOL only)', false)
    .option('--hop-count <n>', 'Number of relay wallets (default 6)', '6')
    .option('--dry-run', 'Simulate only, do not execute', false)
    .action(async (options) => {
      try {
        // Password verification
        await ensurePasswordAndValidate();

        const config = loadConfig();
        const toGroupId = Number(options.toGroup);
        const valueNum = Number(options.value);
        const batchSize = Number(options.batchSize);

        // Parameter validation
        if (isNaN(toGroupId)) {
          error('--to-group must be a valid number');
          process.exit(1);
        }
        if (isNaN(valueNum) || valueNum <= 0) {
          error('--value must be a number greater than 0');
          process.exit(1);
        }
        if (isNaN(batchSize) || batchSize <= 0) {
          error('--batch-size must be an integer greater than 0');
          process.exit(1);
        }

        // --amount validation
        const validAmountTypes = ['fixed', 'random'];
        if (!validAmountTypes.includes(options.amount)) {
          error(`--amount invalid: "${options.amount}", must be fixed | random`);
          process.exit(1);
        }

        if (options.amount === 'random' && !options.max) {
          error('--amount random mode requires --max parameter');
          process.exit(1);
        }

        const toGroup = getGroup(toGroupId);
        if (!toGroup) { error(`Target wallet group ${toGroupId} does not exist`); process.exit(1); }
        if (toGroup.wallets.length === 0) { error('Target wallet group has no wallets'); process.exit(1); }

        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;
        if (isNaN(priorityFee) || priorityFee < 0) {
          error('--priority-fee must be a non-negative number');
          process.exit(1);
        }

        // Find sender's private key
        let fromPrivateKey: string | undefined;
        let fromGroupId: number | undefined;
        const allGroups = getAllGroups();
        for (const g of allGroups) {
          const wallet = g.wallets.find(w => w.walletAddress === options.from);
          if (wallet) {
            fromPrivateKey = getDecryptedPrivateKey(wallet);
            fromGroupId = g.groupId;
            break;
          }
        }

        if (!fromPrivateKey) {
          error(`Cannot find private key for address ${options.from}, ensure it is in a wallet group`);
          process.exit(1);
        }

        const ds = getDataSource();

        if (options.dryRun) {
          // Balance pre-check -- via DataSource
          const balance = await ds.getSolBalance(options.from);
          const totalNeeded = Number(options.value) * toGroup.wallets.length;
          output({
            dryRun: true,
            from: options.from,
            fromBalance: balance,
            toGroup: toGroupId,
            targetCount: toGroup.wallets.length,
            amountPerWallet: Number(options.value),
            totalNeeded,
            sufficient: balance >= totalNeeded,
            message: balance >= totalNeeded ? 'Simulation successful' : `Insufficient balance: need ${totalNeeded} SOL, current ${balance} SOL`,
          });
          return;
        }

        // Suppress SDK console.log in JSON mode
        if (getOutputFormat() === 'json') suppressConsole();

        if (options.token === 'SOL') {
          // Balance pre-check
          const balance = await ds.getSolBalance(options.from);
          const targets = toGroup.wallets.map(w => {
            let amount = Number(options.value);
            if (options.amount === 'random' && options.max) {
              amount = Math.random() * (Number(options.max) - amount) + amount;
            }
            return { address: w.walletAddress, amountSOL: amount };
          });
          const totalNeeded = targets.reduce((sum, t) => sum + t.amountSOL, 0) + priorityFee * targets.length;

          if (balance < totalNeeded) {
            restoreConsole();
            error(`Insufficient balance: need ~${totalNeeded.toFixed(4)} SOL, current ${balance.toFixed(4)} SOL`);
            process.exit(1);
          }

          info(`Executing SOL distribute: ${options.from} -> ${targets.length} wallets, ~${options.value} SOL each${options.multiHop ? ' (multi-hop mode)' : ''}`);

          const results = await executeBatchSOLTransfer({
            fromPrivateKey: fromPrivateKey!,
            targets,
            priorityFee,
            batchSize,
            multiHop: Boolean(options.multiHop),
            hopCount: Number(options.hopCount || 6),
          });

          restoreConsole();

          const successCount = results.filter(r => r.success).length;
          output({
            success: successCount > 0,
            total: results.length,
            successCount,
            failedCount: results.length - successCount,
            results,
          });
        } else {
          restoreConsole();
          output({
            success: false,
            error: 'Token distribute feature is under development, please use SOL distribute first',
          });
        }
      } catch (e: any) {
        restoreConsole();
        error('Batch distribute failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex transfer many-to-many - real many-to-many transfer
  // ============================================================
  transferCmd
    .command('many-to-many')
    .description('Many-to-many transfer')
    .requiredOption('--from-group <id>', 'Source wallet group ID')
    .requiredOption('--to-group <id>', 'Target wallet group ID')
    .option('--token <token>', 'Token: SOL or contract address', 'SOL')
    .option('--amount <type>', 'Amount type: all | fixed | reserve | random', 'all')
    .option('--value <n>', 'Amount value')
    .option('--max <n>', 'Max value (random mode)')
    .option('--interval <ms>', 'Transfer interval (ms)', '500')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--multi-hop', 'Enable multi-hop transfer (via 6 temp relay wallets, SOL only)', false)
    .option('--hop-count <n>', 'Number of relay wallets (default 6)', '6')
    .option('--dry-run', 'Simulate only, do not execute', false)
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

        // --amount validation
        const validAmountTypes = ['all', 'fixed', 'reserve', 'random'];
        if (!validAmountTypes.includes(options.amount)) {
          error(`--amount invalid: "${options.amount}", must be all | fixed | reserve | random`);
          process.exit(1);
        }

        if ((options.amount === 'fixed' || options.amount === 'reserve') && !options.value) {
          error(`--amount ${options.amount} mode requires --value parameter`);
          process.exit(1);
        }

        if (options.amount === 'random') {
          if (!options.value) {
            error('--amount random mode requires --value parameter (min value)');
            process.exit(1);
          }
          if (!options.max) {
            error('--amount random mode requires --max parameter (max value)');
            process.exit(1);
          }
        }

        if (options.value) {
          const val = Number(options.value);
          if (isNaN(val) || val < 0) {
            error('--value must be a non-negative number');
            process.exit(1);
          }
        }

        const fromGroup = getGroup(fromGroupId);
        const toGroup = getGroup(toGroupId);

        if (!fromGroup) { error(`Source wallet group ${fromGroupId} does not exist`); process.exit(1); }
        if (!toGroup) { error(`Target wallet group ${toGroupId} does not exist`); process.exit(1); }
        if (fromGroup.wallets.length === 0) { error('Source wallet group has no wallets'); process.exit(1); }
        if (toGroup.wallets.length === 0) { error('Target wallet group has no wallets'); process.exit(1); }

        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;
        if (isNaN(priorityFee) || priorityFee < 0) {
          error('--priority-fee must be a non-negative number');
          process.exit(1);
        }

        const ds = getDataSource();
        const pairCount = Math.min(fromGroup.wallets.length, toGroup.wallets.length);

        if (options.dryRun) {
          // Balance pre-check -- via DataSource
          const balances: { from: string; to: string; balance: number }[] = [];
          for (let i = 0; i < pairCount; i++) {
            const bal = await ds.getSolBalance(fromGroup.wallets[i].walletAddress);
            balances.push({
              from: fromGroup.wallets[i].walletAddress,
              to: toGroup.wallets[i].walletAddress,
              balance: bal,
            });
          }
          output({
            dryRun: true,
            fromGroup: fromGroupId,
            toGroup: toGroupId,
            fromWallets: fromGroup.wallets.length,
            toWallets: toGroup.wallets.length,
            pairs: pairCount,
            balances,
            message: 'Simulation successful',
          });
          return;
        }

        // Suppress SDK console.log in JSON mode
        if (getOutputFormat() === 'json') suppressConsole();

        if (options.token === 'SOL') {
          const results: any[] = [];

          info(`Executing many-to-many SOL transfer: ${pairCount} pairs${options.multiHop ? ' (multi-hop mode)' : ''}`);

          for (let i = 0; i < pairCount; i++) {
            const fromWallet = fromGroup.wallets[i];
            const toWallet = toGroup.wallets[i];

            // Calculate transfer amount - query balance via DataSource
            let amountSOL: number;
            if (options.amount === 'all') {
              const bal = await ds.getSolBalance(fromWallet.walletAddress);
              amountSOL = Math.max(0, bal - 0.005 - priorityFee);
            } else if (options.amount === 'fixed') {
              amountSOL = Number(options.value || 0);
            } else if (options.amount === 'reserve') {
              const bal = await ds.getSolBalance(fromWallet.walletAddress);
              amountSOL = Math.max(0, bal - Number(options.value || 0) - 0.005);
            } else if (options.amount === 'random') {
              const min = Number(options.value || 0);
              const max = Number(options.max || min);
              amountSOL = Math.random() * (max - min) + min;
            } else {
              amountSOL = 0;
            }

            if (amountSOL <= 0) {
              results.push({
                from: fromWallet.walletAddress,
                to: toWallet.walletAddress,
                amount: 0,
                success: false,
                error: 'Insufficient balance',
                token: 'SOL',
              });
              continue;
            }

            const transferFn = options.multiHop ? executeSOLTransferMultiHop : executeSOLTransfer;
            const result = await transferFn({
              fromPrivateKey: getDecryptedPrivateKey(fromWallet),
              toAddress: toWallet.walletAddress,
              amountSOL,
              priorityFee,
              ...(options.multiHop ? { hopCount: Number(options.hopCount || 6) } : {}),
            });
            results.push(result);

            if (i < pairCount - 1) {
              await sleep(Number(options.interval));
            }
          }

          restoreConsole();

          const successCount = results.filter((r: any) => r.success).length;
          output({
            success: successCount > 0,
            total: results.length,
            successCount,
            failedCount: results.length - successCount,
            results,
          });
        } else {
          restoreConsole();
          output({
            success: false,
            error: 'Token many-to-many transfer is under development, please use SOL first',
          });
        }
      } catch (e: any) {
        restoreConsole();
        error('Many-to-many transfer failed', e.message);
        process.exit(1);
      }
    });
}
