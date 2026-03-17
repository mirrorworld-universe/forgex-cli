/**
 * Query command group
 *
 * forgex query balance | price | kline | transactions | monitor
 *
 * Data source: DataSource unified facade (3.0g migration)
 */

import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { getDataSource } from '../../data-source.js';
import { output, error, warn } from '../../output.js';

// ============================================================
// Input validation helper functions
// ============================================================

/** Validate Solana public key address format */
function validatePublicKey(address: string, label: string): void {
  try {
    new PublicKey(address);
  } catch {
    error(`Invalid ${label} format: ${address}`);
    process.exit(1);
  }
}

/** Validate positive integer */
function validatePositiveInt(value: string, label: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    error(`${label} must be a positive integer, received: ${value}`);
    process.exit(1);
  }
  return num;
}

export function registerQueryCommands(program: Command): void {
  const queryCmd = program
    .command('query')
    .description('Query operations');

  // ============================================================
  // forgex query balance
  // ============================================================
  queryCmd
    .command('balance')
    .description('Query wallet balance')
    .requiredOption('--address <addr>', 'Wallet address')
    .option('--token <ca>', 'Token contract address (queries SOL if omitted)')
    .action(async (options) => {
      try {
        // P1 fix #5: validate --address is a valid Solana public key
        validatePublicKey(options.address, 'Wallet address');

        // P1 fix #6: validate --token address (when provided)
        if (options.token) {
          validatePublicKey(options.token, 'Token contract address');
        }

        const ds = getDataSource();

        if (!options.token) {
          // Query SOL balance -- via DataSource -> RpcAdapter
          const balance = await ds.getSolBalance(options.address);
          output({
            address: options.address,
            token: 'SOL',
            balance,
            lamports: Math.round(balance * 1e9),
          });
        } else {
          // Query token balance -- via DataSource -> RpcAdapter
          const tokenBalance = await ds.getTokenBalance(options.address, options.token);

          // Try to get token symbol info
          let symbol: string | undefined;
          let decimals: number | undefined;
          try {
            const tokenInfo = await ds.getTokenInfo(options.token);
            symbol = tokenInfo.symbol;
            decimals = tokenInfo.decimals;
          } catch {
            // Token info fetch failure does not affect balance display
          }

          if (tokenBalance > 0) {
            output({
              address: options.address,
              token: options.token,
              symbol,
              balance: tokenBalance,
              decimals,
            });
          } else {
            output({
              address: options.address,
              token: options.token,
              balance: 0,
              message: 'Token not held',
            });
          }
        }
      } catch (e: any) {
        error('Balance query failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex query price
  // ============================================================
  queryCmd
    .command('price')
    .description('Query token price')
    .requiredOption('--token <ca>', 'Token contract address')
    .action(async (options) => {
      try {
        // P2 fix: validate --token is a valid Solana public key
        validatePublicKey(options.token, 'Token contract address');

        const ds = getDataSource();

        // Fetch token info and price in parallel -- via DataSource -> CodexAdapter
        const [tokenInfo, priceData, pairsData] = await Promise.all([
          ds.getTokenInfo(options.token),
          ds.getTokenPrice(options.token),
          ds.getPairsForToken(options.token, 5).catch(() => []),
        ]);

        // Format trading pair info
        const formattedPairs = pairsData.map((p) => ({
          exchange: p.exchangeName,
          pairAddress: p.pairAddress,
          liquidity: p.liquidity,
          volume: p.volume24h,
        }));

        output({
          token: options.token,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          priceSol: priceData.priceSol,
          priceUsd: priceData.priceUsd,
          pairs: formattedPairs,
        });
      } catch (e: any) {
        error('Price query failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex query kline
  // ============================================================
  queryCmd
    .command('kline')
    .description('Query candlestick data')
    .requiredOption('--token <ca>', 'Token contract address')
    .option('--interval <interval>', 'Interval: 1m | 5m | 15m | 1h | 4h | 1d', '1h')
    .option('--count <n>', 'Data count', '100')
    .action(async (options) => {
      try {
        // P2 fix: validate --token is a valid Solana public key
        validatePublicKey(options.token, 'Token contract address');

        // P1 fix #1: validate --interval is a valid value
        const validIntervals = ['1m', '5m', '15m', '1h', '4h', '1d'];
        if (!validIntervals.includes(options.interval)) {
          error(`--interval must be one of: ${validIntervals.join(', ')}, received: ${options.interval}`);
          process.exit(1);
        }

        // P1 fix #2: validate --count is a positive integer, not NaN
        const count = Number(options.count);
        if (!Number.isInteger(count) || count <= 0) {
          error(`--count must be a positive integer, received: ${options.count}`);
          process.exit(1);
        }

        const ds = getDataSource();

        const now = Math.floor(Date.now() / 1000);
        const intervalSeconds: Record<string, number> = {
          '1m': 60,
          '5m': 300,
          '15m': 900,
          '1h': 3600,
          '4h': 14400,
          '1d': 86400,
        };

        // Codex API uses different resolution format
        const resolutionMap: Record<string, string> = {
          '1m': '1',
          '5m': '5',
          '15m': '15',
          '1h': '60',
          '4h': '240',
          '1d': '1D',
        };

        const seconds = intervalSeconds[options.interval];
        const from = now - seconds * count;
        const codexResolution = resolutionMap[options.interval] || '60';

        // Get token pairAddress first for candlestick query
        let pairAddress: string | undefined;
        try {
          const tokenInfo = await ds.getTokenInfo(options.token);
          pairAddress = tokenInfo.pairAddress;
        } catch {
          // If pairAddress unavailable, use token address
        }

        // Get candlestick data via DataSource -> CodexAdapter
        const klineData = await ds.getKlineData({
          tokenAddress: options.token,
          pairAddress: pairAddress || undefined,
          resolution: codexResolution as any,
          from,
          to: now,
          countback: count,
        });

        output(klineData);
      } catch (e: any) {
        error('Candlestick data query failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex query transactions
  // ============================================================
  queryCmd
    .command('transactions')
    .description('Query trade records')
    .requiredOption('--group <id>', 'Wallet group ID')
    .option('--token <ca>', 'Filter by token')
    .option('--page <n>', 'Page number', '1')
    .option('--page-size <n>', 'Page size', '20')
    .action(async (options) => {
      try {
        // P1 fix #3: validate --group, --page, --page-size are valid positive integers
        const groupId = validatePositiveInt(options.group, '--group');
        const page = validatePositiveInt(options.page, '--page');
        const pageSize = validatePositiveInt(options.pageSize, '--page-size');

        const ds = getDataSource();

        if (options.token) {
          // Filter by token: read local trade records from DataStore
          validatePublicKey(options.token, 'Token contract address');
          const txFile = ds.getTransactions(options.token, groupId);
          const allTxs = txFile?.transactions || [];

          // Manual pagination
          const start = (page - 1) * pageSize;
          const pagedTxs = allTxs.slice(start, start + pageSize);

          if (pagedTxs.length === 0) {
            warn('No trade records');
          }

          output(pagedTxs, {
            columns: [
              { key: 'txHash', header: 'Tx Hash' },
              { key: 'txType', header: 'Type' },
              { key: 'walletAddress', header: 'Wallet' },
              { key: 'amountSol', header: 'SOL Amount' },
              { key: 'amountToken', header: 'Token Amount' },
              { key: 'blockTime', header: 'Time' },
            ],
          });
        } else {
          // No token filter: aggregate all token trade records
          const allTokens = ds.listTokens();
          const allTxs: any[] = [];

          for (const ca of allTokens) {
            const txFile = ds.getTransactions(ca, groupId);
            if (txFile?.transactions) {
              allTxs.push(...txFile.transactions);
            }
          }

          // Sort by time descending
          allTxs.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));

          // Manual pagination
          const start = (page - 1) * pageSize;
          const pagedTxs = allTxs.slice(start, start + pageSize);

          if (pagedTxs.length === 0) {
            warn('No trade records');
          }

          output(pagedTxs, {
            columns: [
              { key: 'txHash', header: 'Tx Hash' },
              { key: 'txType', header: 'Type' },
              { key: 'walletAddress', header: 'Wallet' },
              { key: 'amountSol', header: 'SOL Amount' },
              { key: 'amountToken', header: 'Token Amount' },
              { key: 'blockTime', header: 'Time' },
            ],
          });
        }
      } catch (e: any) {
        error('Trade records query failed', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex query monitor
  // ============================================================
  queryCmd
    .command('monitor')
    .description('Query monitoring data')
    .requiredOption('--group <id>', 'Wallet group ID')
    .option('--token <ca>', 'Token contract address')
    .action(async (options) => {
      try {
        // P1 fix #4: validate --group is a valid positive integer
        const groupId = validatePositiveInt(options.group, '--group');

        // P2 fix: validate --token address (when provided)
        if (options.token) {
          validatePublicKey(options.token, 'Token contract address');
        }

        const ds = getDataSource();

        if (options.token) {
          // Specific token: read positions from DataStore + get real-time price
          const [holdings, priceData] = await Promise.all([
            Promise.resolve(ds.getHoldings(options.token, groupId)),
            ds.getTokenPrice(options.token).catch(() => ({ priceSol: 0, priceUsd: 0 })),
          ]);

          const walletHoldings = holdings?.wallets || [];

          // Calculate unrealized P&L
          const enrichedHoldings = walletHoldings.map((w) => ({
            walletAddress: w.walletAddress,
            tokenBalance: w.tokenBalance,
            avgBuyPrice: w.avgBuyPrice,
            totalCostSol: w.totalCostSol,
            totalRevenueSol: w.totalRevenueSol,
            realizedPnl: w.realizedPnl,
            unrealizedPnl: w.tokenBalance * priceData.priceSol - w.tokenBalance * w.avgBuyPrice,
            currentPriceSol: priceData.priceSol,
            currentPriceUsd: priceData.priceUsd,
          }));

          output({
            groupId,
            token: options.token,
            priceSol: priceData.priceSol,
            priceUsd: priceData.priceUsd,
            wallets: enrichedHoldings,
            totalRealizedPnl: enrichedHoldings.reduce((sum, w) => sum + w.realizedPnl, 0),
            totalUnrealizedPnl: enrichedHoldings.reduce((sum, w) => sum + w.unrealizedPnl, 0),
          });
        } else {
          // No specific token: aggregate all token positions
          const allTokens = ds.listTokens();
          const tokenSummaries: any[] = [];

          for (const ca of allTokens) {
            const holdings = ds.getHoldings(ca, groupId);
            if (!holdings || holdings.wallets.length === 0) continue;

            let priceData = { priceSol: 0, priceUsd: 0 };
            try {
              priceData = await ds.getTokenPrice(ca);
            } catch {
              // Price fetch failed, use default
            }

            const totalTokenBalance = holdings.wallets.reduce((sum, w) => sum + w.tokenBalance, 0);
            const totalRealizedPnl = holdings.wallets.reduce((sum, w) => sum + w.realizedPnl, 0);
            const totalUnrealizedPnl = holdings.wallets.reduce(
              (sum, w) => sum + (w.tokenBalance * priceData.priceSol - w.tokenBalance * w.avgBuyPrice),
              0,
            );

            tokenSummaries.push({
              token: ca,
              priceSol: priceData.priceSol,
              priceUsd: priceData.priceUsd,
              totalTokenBalance,
              walletCount: holdings.wallets.length,
              totalRealizedPnl,
              totalUnrealizedPnl,
            });
          }

          if (tokenSummaries.length === 0) {
            warn('No position data');
          }

          output({
            groupId,
            tokens: tokenSummaries,
          });
        }
      } catch (e: any) {
        error('Monitoring data query failed', e.message);
        process.exit(1);
      }
    });
}
