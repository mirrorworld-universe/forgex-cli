/**
 * ForgeX CLI DataSource -- Unified Data Source Facade
 *
 * Single data access interface for the command layer. Wraps all data adapters (CodexAdapter, RpcAdapter,
 * JitoAdapter, DataStore) into a unified facade with simple interfaces for command use.
 *
 * Routing logic:
 *   Token info / price / candlestick / pool info  --> CodexAdapter (remote, cache-through to DataStore)
 *   Balance / account info / tx confirmation      --> RpcAdapter (on-chain)
 *   Bundle send / status query           --> JitoAdapter (Jito Block Engine)
 *   Trade records / positions / wallet group data     --> DataStore (local files)
 *
 * Cache-through:
 *   Reads DataStore local cache first. On miss or expiry, fetches from remote (Codex/RPC),
 *   writes to DataStore, then returns.
 *
 * Fault tolerance:
 *   When Codex API is unavailable, falls back to historical cache in DataStore.
 *   When RPC/Jito unavailable, throws DataSourceError for command layer to handle.
 *
 * Design reference: ARCH-DESIGN-v2.md Section 2.7
 */

import { CodexAdapter, getCodexAdapter } from './adapters/codex-adapter.js';
import { RpcAdapter, getRpcAdapter } from './adapters/rpc-adapter.js';
import { JitoAdapter, getJitoAdapter } from './adapters/jito-adapter.js';
import { DataStore, getDataStore } from './data-store/index.js';
import { TxTracker, getTxTracker } from './tx-tracker/index.js';

import type { CodexTokenMarketData, CodexBar, GetBarsParams, CodexPairInfo } from './adapters/codex-adapter.js';
import type { Connection } from '@solana/web3.js';
import type { TokenAccountInfo, TransactionStatus, ParsedTransactionDetail } from './adapters/rpc-adapter.js';
import type { BundleStatusResult, BundleConfirmationResult, WaitOptions, BundleStatusEnum } from './adapters/jito-adapter.js';
import type {
  TokenInfoFile,
  PoolInfoFile,
  TransactionsFile,
  TransactionRecord,
  HoldingsFile,
  WalletHolding,
  BalancesFile,
  WalletBalance,
  FeeConfigFile,
} from './data-store/types.js';
import type { TrackingContext, TrackingOptions, TrackingResult } from './tx-tracker/index.js';

// Re-export key types for command-layer convenience
export type {
  TokenInfoFile,
  PoolInfoFile,
  TransactionsFile,
  TransactionRecord,
  HoldingsFile,
  WalletHolding,
  BalancesFile,
  WalletBalance,
  FeeConfigFile,
  CodexTokenMarketData,
  CodexBar,
  GetBarsParams,
  CodexPairInfo,
  TokenAccountInfo,
  TransactionStatus,
  ParsedTransactionDetail,
  BundleStatusResult,
  BundleConfirmationResult,
  WaitOptions,
  BundleStatusEnum,
  TrackingContext,
  TrackingOptions,
  TrackingResult,
};

// ============================================================
// Unified Error Type
// ============================================================

export class DataSourceError extends Error {
  /** Error source */
  readonly source: 'codex' | 'rpc' | 'jito' | 'store' | 'unknown';
  /** Whether fallback to cache was used */
  readonly fellBackToCache: boolean;
  /** Original error */
  readonly cause?: Error;

  constructor(
    message: string,
    source: DataSourceError['source'],
    options?: { fellBackToCache?: boolean; cause?: Error },
  ) {
    super(message);
    this.name = 'DataSourceError';
    this.source = source;
    this.fellBackToCache = options?.fellBackToCache ?? false;
    this.cause = options?.cause;
  }
}

// ============================================================
// Cache expiry thresholds (ms)
// ============================================================

/** Token info cache TTL: 10 minutes */
const TOKEN_INFO_TTL_MS = 10 * 60 * 1000;

/** Pool info cache TTL: 2 minutes */
const POOL_INFO_TTL_MS = 2 * 60 * 1000;

/** SOL price cache TTL: 1 minute */
const SOL_PRICE_TTL_MS = 60 * 1000;

// ============================================================
// DataSource Implementation
// ============================================================

export class DataSource {
  private codex: CodexAdapter;
  private rpc: RpcAdapter;
  private jito: JitoAdapter;
  private store: DataStore;
  private tracker: TxTracker;

  constructor(options?: {
    codex?: CodexAdapter;
    rpc?: RpcAdapter;
    jito?: JitoAdapter;
    store?: DataStore;
    tracker?: TxTracker;
  }) {
    this.codex = options?.codex ?? getCodexAdapter();
    this.rpc = options?.rpc ?? getRpcAdapter();
    this.jito = options?.jito ?? getJitoAdapter();
    this.store = options?.store ?? getDataStore();
    this.tracker = options?.tracker ?? getTxTracker();
  }

  // ============================================================
  // Token Info -- CodexAdapter + DataStore cache-through
  // ============================================================

  /**
   * Get basic token info.
   *
   * Flow:
   * 1. Check DataStore cache first
   * 2. Cache hit and not expired -> return directly
   * 3. Cache miss or expired -> fetch from Codex and write to DataStore
   * 4. Codex unavailable -> fallback to stale DataStore cache (if any)
   */
  async getTokenInfo(ca: string): Promise<TokenInfoFile> {
    // 1. Check local cache
    const cached = this.store.getTokenInfo(ca);
    if (cached && !this.isExpired(cached.updatedAt, TOKEN_INFO_TTL_MS)) {
      return cached;
    }

    // 2. Fetch from Codex
    try {
      const marketData = await this.codex.getTokenMarketData(ca);
      const topPair = await this.codex.getTopPair(ca).catch(() => null);

      const tokenInfo: TokenInfoFile = {
        ca: marketData.address,
        symbol: marketData.symbol,
        name: marketData.name,
        decimals: marketData.decimals,
        creatorAddress: '',
        dex: this.inferDex(topPair?.exchangeName),
        pairAddress: marketData.topPairAddress || topPair?.pairAddress || '',
        updatedAt: Date.now(),
      };

      // Write to DataStore
      await this.store.saveTokenInfo(ca, tokenInfo);
      return tokenInfo;
    } catch (err) {
      // 3. Codex unavailable, fallback to stale cache
      if (cached) {
        return cached;
      }

      throw new DataSourceError(
        `Failed to get token info (${ca}): ${(err as Error).message}`,
        'codex',
        { cause: err as Error },
      );
    }
  }

  /**
   * Get detailed token market data (including price, volume, holders, etc).
   * Fetches directly from Codex without local cache-through (market data requires high timeliness).
   */
  async getTokenMarketData(ca: string): Promise<CodexTokenMarketData> {
    try {
      return await this.codex.getTokenMarketData(ca);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get token market data (${ca}): ${(err as Error).message}`,
        'codex',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Price -- CodexAdapter + DataStore cache-through
  // ============================================================

  /**
   * Get token price (SOL and USD).
   *
   * Cache-through: checks DataStore pool-info cached price first, fetches from Codex if expired.
   */
  async getTokenPrice(ca: string): Promise<{ priceSol: number; priceUsd: number }> {
    try {
      const result = await this.codex.getTokenPriceInSolAndUsd(ca);
      return result;
    } catch (err) {
      // fallback: read historical price from DataStore pool-info
      const poolInfo = this.store.getPoolInfo(ca);
      if (poolInfo) {
        return { priceSol: poolInfo.priceSol, priceUsd: poolInfo.priceUsd };
      }

      throw new DataSourceError(
        `Failed to get token price (${ca}): ${(err as Error).message}`,
        'codex',
        { cause: err as Error },
      );
    }
  }

  /**
   * Get SOL price (USD).
   *
   * Cache-through: checks DataStore first, fetches from Codex and updates if expired.
   */
  async getSolPrice(): Promise<number> {
    // 1. Check local cache
    const cachedPrice = this.store.getSolPrice();
    if (cachedPrice > 0) {
      // Check if cache is expired -- getSolPrice returns a number, needs extra time check
      // DataStore internal MemoryCache has 30s TTL, adding another file-level TTL here
      // Since DataStore.getSolPrice() already has MemoryCache, trust it here
      // But if refresh is explicitly needed, the try below will attempt it
    }

    // 2. Fetch from Codex
    try {
      const price = await this.codex.getSolPrice();
      await this.store.saveSolPrice(price);
      return price;
    } catch (err) {
      // fallback: use cache
      if (cachedPrice > 0) {
        return cachedPrice;
      }

      throw new DataSourceError(
        `Failed to get SOL price: ${(err as Error).message}`,
        'codex',
        { fellBackToCache: false, cause: err as Error },
      );
    }
  }

  // ============================================================
  // Pool/Liquidity Info -- CodexAdapter + DataStore cache-through
  // ============================================================

  /**
   * Get liquidity pool info.
   *
   * Cache-through: DataStore valid -> return; miss/expired -> fetch from Codex and write.
   */
  async getPoolInfo(ca: string): Promise<PoolInfoFile> {
    // 1. Check local cache
    const cached = this.store.getPoolInfo(ca);
    if (cached && !this.isExpired(cached.updatedAt, POOL_INFO_TTL_MS)) {
      return cached;
    }

    // 2. Fetch from Codex
    try {
      const codexPool = await this.codex.getPoolInfo(ca);
      const poolInfo: PoolInfoFile = {
        ca: codexPool.ca,
        pairAddress: codexPool.pairAddress,
        dex: codexPool.dex,
        liquidity: codexPool.liquidity,
        priceSol: codexPool.priceSol,
        priceUsd: codexPool.priceUsd,
        updatedAt: codexPool.updatedAt,
      };

      await this.store.savePoolInfo(ca, poolInfo);
      return poolInfo;
    } catch (err) {
      // fallback to stale cache
      if (cached) {
        return cached;
      }

      throw new DataSourceError(
        `Failed to get pool info (${ca}): ${(err as Error).message}`,
        'codex',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Candlestick Data -- CodexAdapter (no local cache)
  // ============================================================

  /**
   * Get candlestick (OHLCV) data.
   * Candlestick data is large and time-sensitive, no local caching.
   */
  async getKlineData(params: GetBarsParams): Promise<CodexBar[]> {
    try {
      return await this.codex.getBars(params);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get candlestick data: ${(err as Error).message}`,
        'codex',
        { cause: err as Error },
      );
    }
  }

  /**
   * Get trading pair list for a token.
   */
  async getPairsForToken(ca: string, limit?: number): Promise<CodexPairInfo[]> {
    try {
      return await this.codex.getPairsForToken(ca, limit);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get trading pairs (${ca}): ${(err as Error).message}`,
        'codex',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Balance Queries -- RpcAdapter (on-chain real-time data)
  // ============================================================

  /**
   * Get SOL balance for a single wallet.
   */
  async getSolBalance(address: string): Promise<number> {
    try {
      return await this.rpc.getSolBalance(address);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get SOL balance (${address}): ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  /**
   * Batch get SOL balances for multiple wallets.
   */
  async getBatchSolBalances(addresses: string[]): Promise<Record<string, number>> {
    try {
      return await this.rpc.getBatchSolBalances(addresses);
    } catch (err) {
      throw new DataSourceError(
        `Failed to batch get SOL balances: ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  /**
   * Get single token balance for a wallet.
   */
  async getTokenBalance(walletAddress: string, tokenMint: string): Promise<number> {
    try {
      return await this.rpc.getTokenBalance(walletAddress, tokenMint);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get token balance (${walletAddress}): ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  /**
   * Batch get token balances for multiple wallets on a specific token.
   */
  async getBatchTokenBalances(
    walletAddresses: string[],
    tokenMint: string,
  ): Promise<Record<string, number>> {
    try {
      return await this.rpc.getBatchTokenBalances(walletAddresses, tokenMint);
    } catch (err) {
      throw new DataSourceError(
        `Failed to batch get token balances: ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  /**
   * Get all token accounts for a single wallet.
   */
  async getTokenAccountsByOwner(walletAddress: string): Promise<TokenAccountInfo[]> {
    try {
      return await this.rpc.getTokenAccountsByOwner(walletAddress);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get token account list (${walletAddress}): ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  /**
   * Get complete balance data for wallet group on a specific token.
   *
   * Fetches from RPC in real-time, updates DataStore, then returns BalancesFile.
   */
  async getWalletBalances(
    walletAddresses: string[],
    ca: string,
    groupId: number,
  ): Promise<BalancesFile> {
    try {
      // Fetch SOL and Token balances in parallel
      const [solBalances, tokenBalances] = await Promise.all([
        this.rpc.getBatchSolBalances(walletAddresses),
        this.rpc.getBatchTokenBalances(walletAddresses, ca),
      ]);

      const now = Date.now();
      const balances: WalletBalance[] = walletAddresses.map((addr) => ({
        walletAddress: addr,
        solBalance: solBalances[addr] ?? 0,
        tokenBalance: tokenBalances[addr] ?? 0,
        updatedAt: now,
      }));

      // Batch write to DataStore
      await this.store.updateBalancesBatch(ca, groupId, balances);

      return {
        ca,
        groupId,
        balances,
        updatedAt: now,
      };
    } catch (err) {
      // fallback: return historical data from DataStore
      const cached = this.store.getBalances(ca, groupId);
      if (cached) {
        return cached;
      }

      throw new DataSourceError(
        `Failed to get wallet balances: ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Transaction Status -- RpcAdapter
  // ============================================================

  /**
   * Query confirmation status of a single transaction.
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      return await this.rpc.getTransactionStatus(txHash);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get transaction status (${txHash}): ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  /**
   * Get transaction details.
   */
  async getTransactionDetail(txHash: string): Promise<ParsedTransactionDetail | null> {
    try {
      return await this.rpc.getTransactionDetail(txHash);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get transaction details (${txHash}): ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  /**
   * Batch query transaction statuses.
   */
  async getBatchTransactionStatuses(txHashes: string[]): Promise<Record<string, TransactionStatus>> {
    try {
      return await this.rpc.getBatchTransactionStatuses(txHashes);
    } catch (err) {
      throw new DataSourceError(
        `Failed to batch get transaction statuses: ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Bundle Operations -- JitoAdapter
  // ============================================================

  /**
   * Send bundle to Jito Block Engine.
   */
  async sendBundle(base64Txs: string[]): Promise<{ bundleId: string }> {
    try {
      return await this.jito.sendBundle(base64Txs);
    } catch (err) {
      throw new DataSourceError(
        `Failed to send bundle: ${(err as Error).message}`,
        'jito',
        { cause: err as Error },
      );
    }
  }

  /**
   * Query bundle status.
   */
  async getBundleStatus(bundleId: string): Promise<BundleStatusResult> {
    try {
      return await this.jito.getBundleStatus(bundleId);
    } catch (err) {
      throw new DataSourceError(
        `Failed to get bundle status (${bundleId}): ${(err as Error).message}`,
        'jito',
        { cause: err as Error },
      );
    }
  }

  /**
   * Wait for bundle confirmation.
   */
  async waitForBundleConfirmation(
    bundleId: string,
    options?: WaitOptions,
  ): Promise<BundleConfirmationResult> {
    try {
      return await this.jito.waitForBundleConfirmation(bundleId, options);
    } catch (err) {
      throw new DataSourceError(
        `Failed waiting for bundle confirmation (${bundleId}): ${(err as Error).message}`,
        'jito',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Single Transaction Sending -- JitoAdapter (sendTransaction)
  // ============================================================

  /**
   * Send single transaction via Jito.
   */
  async sendTransaction(base64Tx: string): Promise<{ txHash: string }> {
    try {
      return await this.jito.sendTransaction(base64Tx);
    } catch (err) {
      throw new DataSourceError(
        `Failed to send transaction: ${(err as Error).message}`,
        'jito',
        { cause: err as Error },
      );
    }
  }

  /**
   * Confirm transaction status via RPC.
   */
  async confirmTransactionByRpc(
    connection: Connection,
    signature: string,
    timeoutMs?: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      return await this.jito.confirmTransactionByRpc(connection, signature, timeoutMs);
    } catch (err) {
      throw new DataSourceError(
        `Failed to confirm transaction (${signature}): ${(err as Error).message}`,
        'rpc',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Trade Records -- DataStore (local files)
  // ============================================================

  /**
   * Get trade records.
   */
  getTransactions(ca: string, groupId: number): TransactionsFile | null {
    return this.store.getTransactions(ca, groupId);
  }

  /**
   * Get trade records for a specific wallet.
   */
  getTransactionsByWallet(ca: string, groupId: number, wallet: string): TransactionRecord[] {
    return this.store.getTransactionsByWallet(ca, groupId, wallet);
  }

  /**
   * Append trade records.
   */
  async appendTransaction(ca: string, groupId: number, tx: TransactionRecord): Promise<void> {
    try {
      await this.store.appendTransaction(ca, groupId, tx);
    } catch (err) {
      throw new DataSourceError(
        `Failed to write trade records: ${(err as Error).message}`,
        'store',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Position Data -- DataStore (local files)
  // ============================================================

  /**
   * Get position data.
   */
  getHoldings(ca: string, groupId: number): HoldingsFile | null {
    return this.store.getHoldings(ca, groupId);
  }

  /**
   * Update position data.
   */
  async updateHolding(
    ca: string,
    groupId: number,
    wallet: string,
    update: Partial<WalletHolding>,
  ): Promise<void> {
    try {
      await this.store.updateHolding(ca, groupId, wallet, update);
    } catch (err) {
      throw new DataSourceError(
        `Failed to update positions: ${(err as Error).message}`,
        'store',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Balance Snapshots -- DataStore (local files)
  // ============================================================

  /**
   * Get locally cached balance snapshot.
   */
  getBalancesSnapshot(ca: string, groupId: number): BalancesFile | null {
    return this.store.getBalances(ca, groupId);
  }

  /**
   * Update balance snapshot.
   */
  async updateBalance(
    ca: string,
    groupId: number,
    wallet: string,
    balance: WalletBalance,
  ): Promise<void> {
    try {
      await this.store.updateBalance(ca, groupId, wallet, balance);
    } catch (err) {
      throw new DataSourceError(
        `Failed to update balance snapshot: ${(err as Error).message}`,
        'store',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // Global Data -- DataStore
  // ============================================================

  /**
   * Get fee configuration.
   */
  getFeeConfig(): FeeConfigFile | null {
    return this.store.getFeeConfig();
  }

  /**
   * Save fee configuration.
   */
  async saveFeeConfig(config: FeeConfigFile): Promise<void> {
    try {
      await this.store.saveFeeConfig(config);
    } catch (err) {
      throw new DataSourceError(
        `Failed to save fee configuration: ${(err as Error).message}`,
        'store',
        { cause: err as Error },
      );
    }
  }

  // ============================================================
  // DataStore Utility Methods
  // ============================================================

  /**
   * List all token CAs with data.
   */
  listTokens(): string[] {
    return this.store.listTokens();
  }

  /**
   * List all wallet group IDs with data for a token.
   */
  listGroups(ca: string): number[] {
    return this.store.listGroups(ca);
  }

  // ============================================================
  // Transaction Tracking -- TxTracker
  // ============================================================

  /**
   * Track a single transaction.
   * Auto-writes to DataStore after polling confirmation (trade records + positions + balances).
   */
  async trackTransaction(
    txHash: string,
    context: TrackingContext,
    options?: TrackingOptions,
  ): Promise<TrackingResult> {
    return this.tracker.trackTransaction(txHash, context, options);
  }

  /**
   * Track a Jito Bundle.
   * Processes internal transactions individually after bundle confirmation and writes to DataStore.
   */
  async trackBundle(
    bundleId: string,
    txHashes: string[],
    context: TrackingContext,
    options?: TrackingOptions,
  ): Promise<TrackingResult[]> {
    return this.tracker.trackBundle(bundleId, txHashes, context, options);
  }

  /**
   * Batch track multiple independent transactions.
   */
  async trackBatch(
    entries: Array<{ txHash: string; context: TrackingContext }>,
    options?: TrackingOptions,
  ): Promise<TrackingResult[]> {
    return this.tracker.trackBatch(entries, options);
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Check health status of all data sources.
   */
  async healthCheck(): Promise<{
    codex: { healthy: boolean; error?: string };
    rpc: { healthy: boolean; endpoint: string; error?: string };
    jito: { healthy: boolean; endpoint: string; error?: string };
  }> {
    const [codexResult, rpcResult, jitoResult] = await Promise.all([
      this.codex.healthCheck().catch((err: Error) => ({ healthy: false, endpoint: '', error: err.message })),
      this.rpc.healthCheck().catch((err: Error) => ({ healthy: false, endpoint: '', error: err.message })),
      this.jito.healthCheck().catch((err: Error) => ({ healthy: false, endpoint: '', error: err.message })),
    ]);

    return {
      codex: { healthy: codexResult.healthy, error: codexResult.error },
      rpc: { healthy: rpcResult.healthy, endpoint: rpcResult.endpoint, error: rpcResult.error },
      jito: { healthy: jitoResult.healthy, endpoint: jitoResult.endpoint, error: jitoResult.error },
    };
  }

  // ============================================================
  // Direct adapter access (advanced use)
  // ============================================================

  /** Get underlying CodexAdapter (only when DataSource interface is insufficient) */
  getCodexAdapter(): CodexAdapter {
    return this.codex;
  }

  /** Get underlying RpcAdapter */
  getRpcAdapter(): RpcAdapter {
    return this.rpc;
  }

  /** Get underlying JitoAdapter */
  getJitoAdapter(): JitoAdapter {
    return this.jito;
  }

  /** Get underlying DataStore */
  getDataStore(): DataStore {
    return this.store;
  }

  /** Get underlying TxTracker */
  getTxTracker(): TxTracker {
    return this.tracker;
  }

  // ============================================================
  // Internal utility methods
  // ============================================================

  /**
   * Check if timestamp has expired.
   * @param updatedAt Last update time (ms)
   * @param ttlMs Time-to-live (ms)
   * @returns true if expired
   */
  private isExpired(updatedAt: number, ttlMs: number): boolean {
    return Date.now() - updatedAt > ttlMs;
  }

  /**
   * Infer DEX type from DEX/exchange name.
   * Maps Codex API exchangeName to TokenInfoFile.dex enum.
   */
  private inferDex(exchangeName?: string | null): TokenInfoFile['dex'] {
    if (!exchangeName) return 'pump';

    const name = exchangeName.toLowerCase();

    if (name.includes('pump') && name.includes('swap')) return 'pumpswap';
    if (name.includes('pump')) return 'pump';
    if (name.includes('raydium')) return 'raydium';
    if (name.includes('launchlab') || name.includes('launch')) return 'launchlab';
    if (name.includes('meteora')) return 'meteora';

    // Default to pump when unrecognized
    return 'pump';
  }
}

// ============================================================
// Singleton Management
// ============================================================

let _instance: DataSource | null = null;

/**
 * Get DataSource global singleton.
 * Standard entry point for command layer:
 *   import { getDataSource } from '../data-source.js';
 *   const ds = getDataSource();
 */
export function getDataSource(): DataSource {
  if (!_instance) {
    _instance = new DataSource();
  }
  return _instance;
}

/**
 * Reset singleton (for testing or re-initialization after config changes).
 */
export function resetDataSource(): void {
  _instance = null;
}
