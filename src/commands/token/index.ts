/**
 * Token command group
 *
 * forgex token create | info | pool
 *
 * Phase 3 upgrade:
 * - Use DataSource facade instead of direct API calls (info/pool)
 * - Integrate TxTracker for automatic token creation tx result tracking
 * - Add ensurePasswordAndValidate for password verification
 * - Add suppressConsole/restoreConsole to prevent JSON output pollution
 * - Improve input parameter validation
 * - All api functions connect directly (Jito / pump.fun / local vanity dir), no remote proxy
 */

import { Command } from 'commander';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import { getGroup, getDecryptedPrivateKey, ensurePasswordAndValidate } from '../../wallet-store.js';
import { loadConfig, getVanityAddress } from '../../config.js';
import { uploadToIpfs } from '../../adapters/ipfs.js';
import { getDataSource } from '../../data-source.js';
import { output, error, info, suppressConsole, restoreConsole, getOutputFormat } from '../../output.js';
import { createCoin } from '../../sol-sdk/batch/create.js';
import { getConnection } from '../../adapters/connection.js';
import { BundleBuyTime } from '../../types/index.js';
import type { Sniper } from '../../sol-sdk/batch/index.js';
import { getWalletKeypair } from '../../utils/index.js';

export function registerTokenCommands(program: Command): void {
  const tokenCmd = program
    .command('token')
    .description('Token operations');

  // ============================================================
  // forgex token create
  // ============================================================
  tokenCmd
    .command('create')
    .description('Create token')
    .requiredOption('--dex <dex>', 'DEX platform: pump | launchlab')
    .requiredOption('--name <name>', 'Token name')
    .requiredOption('--symbol <symbol>', 'Token symbol')
    .option('--image <path>', 'Token image path')
    .option('--description <desc>', 'Token description', '')
    .option('--twitter <url>', 'Twitter link')
    .option('--website <url>', 'Website link')
    .option('--telegram <url>', 'Telegram link')
    .option('--dev-wallet <groupId>', 'Developer wallet group ID')
    .option('--dev-buy <sol>', 'Developer buy amount (SOL)', '0')
    .option('--snipers <groupId>', 'Sniper wallet group ID')
    .option('--sniper-amounts <amounts>', 'Sniper buy amounts (comma-separated)')
    .option('--bundle-time <time>', 'Bundle time: T0 | T1_T5', 'T0')
    .option('--priority-fee <sol>', 'Priority fee (SOL)')
    .option('--metadata-uri <uri>', 'Specify metadata URI directly (skip IPFS upload)')
    .option('--use-suffix', 'Use custom suffix address', false)
    .option('--dry-run', 'Simulate only, do not execute', false)
    .action(async (options) => {
      try {
        const config = loadConfig();

        // --dex validation
        const validDexes = ['pump', 'launchlab'];
        if (!validDexes.includes(options.dex)) {
          error(`--dex invalid: "${options.dex}", must be pump | launchlab`);
          process.exit(1);
        }

        // --bundle-time validation
        const validBundleTimes = ['T0', 'T1_T5'];
        if (!validBundleTimes.includes(options.bundleTime)) {
          error(`--bundle-time invalid: "${options.bundleTime}", must be T0 | T1_T5`);
          process.exit(1);
        }

        // --dev-buy numeric validation
        const devBuy = Number(options.devBuy);
        if (isNaN(devBuy) || devBuy < 0) {
          error('--dev-buy must be a non-negative number');
          process.exit(1);
        }

        // --priority-fee numeric validation
        const priorityFee = options.priorityFee
          ? Number(options.priorityFee)
          : config.defaultPriorityFee;
        if (isNaN(priorityFee) || priorityFee < 0) {
          error('--priority-fee must be a non-negative number');
          process.exit(1);
        }

        // --dev-wallet validation
        let devGroup;
        if (options.devWallet) {
          const devGroupId = Number(options.devWallet);
          if (isNaN(devGroupId)) {
            error('--dev-wallet must be a valid number');
            process.exit(1);
          }
          devGroup = getGroup(devGroupId);
          if (!devGroup) {
            error(`Developer wallet group ${devGroupId} does not exist`);
            process.exit(1);
          }
        }

        // --snipers validation
        let sniperGroup;
        if (options.snipers) {
          const sniperGroupId = Number(options.snipers);
          if (isNaN(sniperGroupId)) {
            error('--snipers must be a valid number');
            process.exit(1);
          }
          sniperGroup = getGroup(sniperGroupId);
          if (!sniperGroup) {
            error(`Sniper wallet group ${sniperGroupId} does not exist`);
            process.exit(1);
          }
        }

        // --sniper-amounts validation
        let sniperAmounts: number[] = [];
        if (options.sniperAmounts) {
          sniperAmounts = options.sniperAmounts.split(',').map(Number);
          if (sniperAmounts.some(isNaN)) {
            error('--sniper-amounts contains invalid numbers');
            process.exit(1);
          }
          if (sniperAmounts.some(a => a <= 0)) {
            error('Each amount in --sniper-amounts must be greater than 0');
            process.exit(1);
          }
        }

        // Validate password if using wallet groups
        if (options.devWallet || options.snipers) {
          await ensurePasswordAndValidate();
        }

        // At least one of --image or --metadata-uri is required
        if (!options.image && !options.metadataUri) {
          error('Must specify --image or --metadata-uri');
          process.exit(1);
        }

        let metadataUri: string;

        if (options.metadataUri) {
          // Use specified metadata URI directly, skip IPFS upload
          metadataUri = options.metadataUri;
          info(`Using specified metadata URI: ${metadataUri}`);
        } else {
          // Validate image file exists
          if (!fs.existsSync(options.image)) {
            error(`Image file does not exist: ${options.image}`);
            process.exit(1);
          }

          // Upload to IPFS
          info('Uploading token metadata to IPFS...');

          // Suppress SDK console.log in JSON mode
          if (getOutputFormat() === 'json') suppressConsole();

          const ipfsResult = await uploadToIpfs(options.image, {
            name: options.name,
            symbol: options.symbol,
            description: options.description,
            twitter: options.twitter,
            telegram: options.telegram,
            website: options.website,
          });

          restoreConsole();
          metadataUri = (ipfsResult as any)?.metadataUri || '';
        }

        const createParams = {
          dex: options.dex,
          name: options.name,
          symbol: options.symbol,
          description: options.description,
          metadataUri,
          twitter: options.twitter,
          website: options.website,
          telegram: options.telegram,
          devWalletGroup: options.devWallet ? Number(options.devWallet) : undefined,
          devBuyAmount: devBuy,
          sniperGroup: options.snipers ? Number(options.snipers) : undefined,
          sniperAmounts,
          bundleTime: options.bundleTime,
          priorityFee,
          useSuffix: options.useSuffix,
          dryRun: options.dryRun,
        };

        if (options.dryRun) {
          output({
            dryRun: true,
            params: createParams,
            message: 'Simulation mode, token not actually created',
          });
          return;
        }

        // Get suffix address if needed
        let suffixAddress;
        if (options.useSuffix) {
          info('Getting custom suffix address...');
          if (getOutputFormat() === 'json') suppressConsole();
          suffixAddress = getVanityAddress(options.dex === 'pump' ? 'pump' : 'bonk');
          restoreConsole();
        }

        // dev wallet is required for actual execution
        if (!devGroup) {
          error('Creating token requires --dev-wallet parameter');
          process.exit(1);
        }

        // Get Solana connection
        const connection = getConnection();

        // Build dev wallet keypair (first wallet in group)
        const devWalletInfo = devGroup.wallets[0];
        const devPrivateKey = getDecryptedPrivateKey(devWalletInfo);
        const devKeypair = getWalletKeypair(devPrivateKey);

        // Build sniper wallets from group
        let snipers: Sniper[] | undefined;
        if (sniperGroup && sniperGroup.wallets.length > 0) {
          const walletCount = sniperAmounts.length > 0 ? sniperAmounts.length : sniperGroup.wallets.length;
          const wallets = sniperGroup.wallets.slice(0, walletCount);
          snipers = wallets.map((w, i) => ({
            wallet: getDecryptedPrivateKey(w),
            amount: (sniperAmounts[i] || 0.01).toString(),
          }));
        }

        // Use vanity address as mint keypair, or generate a new one
        const mint = suffixAddress
          ? Keypair.fromSecretKey(suffixAddress.secretKey)
          : Keypair.generate();

        info(`Starting token creation ${options.name} (${options.symbol})`);
        info(`Mint address: ${mint.publicKey.toBase58()}`);

        const bundleBuyTime = options.bundleTime === 'T1_T5' ? BundleBuyTime.T1_T5 : BundleBuyTime.T0;

        const result = await createCoin({
          connection,
          devWallet: devKeypair,
          devBuyAmount: devBuy > 0 ? devBuy.toString() : undefined,
          snipers,
          jitoTips: priorityFee,
          mint,
          name: options.name,
          symbol: options.symbol,
          uri: metadataUri,
          bundleBuyTime,
          dex: options.dex as 'pump' | 'launchlab',
          onStatusUpdate: (stepId, status, err) => {
            info(`Step ${stepId}: ${status}${err ? ' - ' + err : ''}`);
          },
        });

        const mintAddress = result.mintAddress || mint.publicKey.toBase58();
        const walletAddresses = [
          devWalletInfo.walletAddress,
          ...(sniperGroup?.wallets.map(w => w.walletAddress) || []),
        ];

        output({
          success: result.success,
          mintAddress,
          steps: result.steps,
          bundleIds: result.bundleIds,
          name: options.name,
          symbol: options.symbol,
          dex: options.dex,
          metadataUri,
          message: result.success ? 'Token created successfully' : 'Token creation failed',
          error: result.error,
        });
      } catch (e: any) {
        restoreConsole();
        error('Token creation failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex token info
  // ============================================================
  tokenCmd
    .command('info')
    .description('Query token info')
    .requiredOption('--ca <address>', 'Token contract address')
    .action(async (options) => {
      try {
        if (!options.ca || options.ca.trim().length === 0) {
          error('--ca cannot be empty');
          process.exit(1);
        }

        const ds = getDataSource();

        // Get token info via DataSource -> CodexAdapter
        const [tokenInfo, priceData, pairs] = await Promise.all([
          ds.getTokenInfo(options.ca),
          ds.getTokenPrice(options.ca).catch(() => ({ priceSol: 0, priceUsd: 0 })),
          ds.getPairsForToken(options.ca, 10).catch(() => []),
        ]);

        output({
          address: options.ca,
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
          creator: tokenInfo.creatorAddress,
          dex: tokenInfo.dex,
          priceSol: priceData.priceSol,
          priceUsd: priceData.priceUsd,
          pairs: pairs.map((p) => ({
            exchange: p.exchangeName,
            pairAddress: p.pairAddress,
            liquidity: p.liquidity,
            volume: p.volume24h,
            tokenA: p.token0Address,
            tokenB: p.token1Address,
          })),
        });
      } catch (e: any) {
        error('Query token info failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex token pool
  // ============================================================
  tokenCmd
    .command('pool')
    .description('Query token pool info')
    .requiredOption('--ca <address>', 'Token contract address')
    .action(async (options) => {
      try {
        if (!options.ca || options.ca.trim().length === 0) {
          error('--ca cannot be empty');
          process.exit(1);
        }

        const ds = getDataSource();

        // Get pool info via DataSource -> CodexAdapter
        const poolInfo = await ds.getPoolInfo(options.ca);
        output(poolInfo);
      } catch (e: any) {
        error('Query pool info failed', e.message);
        process.exit(1);
      }
    });
}
