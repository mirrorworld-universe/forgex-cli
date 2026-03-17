/**
 * ForgeX CLI TxTracker -- Transaction tracking system
 *
 * After each transaction is initiated:
 * 1. Poll RPC or Jito API to check transaction status
 * 2. After confirmation, fetch full transaction details
 * 3. Map raw on-chain data to CLI data structures via TxDetailAdapter
 * 4. Auto-write to DataStore (transaction records, positions, balance)
 *
 * Supports:
 * - Single transaction tracking (trackTransaction)
 * - Jito Bundle tracking (trackBundle)
 * - Batch transaction tracking (trackBatch)
 * - Progress callback (onProgress)
 * - Configurable poll interval and timeout
 *
 * Design reference: ARCH-DESIGN-v2.md Section 3.2 ~ 3.6
 */

import { RpcAdapter, getRpcAdapter } from '../adapters/rpc-adapter.js';
import { JitoAdapter, getJitoAdapter, BundleStatusEnum } from '../adapters/jito-adapter.js';
import { DataStore, getDataStore } from '../data-store/index.js';
import { TxDetailAdapter } from './detail-adapter.js';
import type { TrackingContext } from './detail-adapter.js';
import type { TransactionRecord, WalletHolding } from '../data-store/types.js';

// Re-export types for consumers
export { TxDetailAdapter } from './detail-adapter.js';
export type { TrackingContext } from './detail-adapter.js';

// ============================================================
// Type Definitions
// ============================================================

/** Tracking options */
export interface TrackingOptions {
  /** Poll interval (ms), default 2000 */
  pollIntervalMs?: number;
  /** Timeout (ms), default 60000 */
  timeoutMs?: number;
  /** Max retries (when RPC request fails), default 3 */
  maxRetries?: number;
  /** Progress callback */
  onProgress?: (status: string, txHash: string) => void;
}

/** Single transaction tracking result */
export interface TrackingResult {
  /** Transaction signature */
  txHash: string;
  /** Final status */
  status: 'confirmed' | 'failed' | 'timeout';
  /** Transaction record when successful */
  record?: TransactionRecord;
  /** Failure reason */
  error?: string;
}

/** Internal options with defaults applied */
interface ResolvedTrackingOptions {
  pollIntervalMs: number;
  timeoutMs: number;
  maxRetries: number;
  onProgress?: (status: string, txHash: string) => void;
}

// ============================================================
// Default Configuration
// ============================================================

const DEFAULT_OPTIONS: ResolvedTrackingOptions = {
  pollIntervalMs: 2000,
  timeoutMs: 60000,
  maxRetries: 3,
};

// ============================================================
// TxTracker implementation
// ============================================================

export class TxTracker {
  private rpc: RpcAdapter;
  private jito: JitoAdapter;
  private store: DataStore;
  private adapter: TxDetailAdapter;

  constructor(rpc?: RpcAdapter, jito?: JitoAdapter, store?: DataStore) {
    this.rpc = rpc || getRpcAdapter();
    this.jito = jito || getJitoAdapter();
    this.store = store || getDataStore();
    this.adapter = new TxDetailAdapter();
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Track a single regular transaction.
   *
   * Flow:
   * 1. Poll RPC until transaction confirmed / failed / timeout
   * 2. After confirmation, fetch transaction details
   * 3. Adapt to TransactionRecord via TxDetailAdapter
   * 4. Write to DataStore (transaction record + position + balance)
   *
   * @param txHash Transaction signature
   * @param context Tracking context
   * @param options Tracking options (optional)
   * @returns Tracking result
   */
  async trackTransaction(
    txHash: string,
    context: TrackingContext,
    options?: TrackingOptions,
  ): Promise<TrackingResult> {
    const opts = this.resolveOptions(options);

    opts.onProgress?.('polling', txHash);

    // Step 1: Poll for confirmation status
    const confirmStatus = await this.pollUntilConfirmed(txHash, opts);

    if (confirmStatus === 'timeout') {
      opts.onProgress?.('timeout', txHash);

      // Also record timeout as pending transaction
      const pendingRecord = this.createPendingRecord(txHash, context);
      await this.persistTransaction(pendingRecord, context);

      return {
        txHash,
        status: 'timeout',
        error: `Transaction confirmation timeout (${opts.timeoutMs}ms)`,
      };
    }

    if (confirmStatus === 'failed') {
      opts.onProgress?.('failed', txHash);

      // Also record failed transactions
      const failedRecord = this.createFailedRecord(txHash, context);
      await this.persistTransaction(failedRecord, context);

      return {
        txHash,
        status: 'failed',
        record: failedRecord,
        error: 'Transaction execution failed',
      };
    }

    // Step 2: Confirmed, fetch transaction details
    opts.onProgress?.('fetching_detail', txHash);

    const detail = await this.fetchDetailWithRetry(txHash, opts.maxRetries);
    if (!detail) {
      // Edge case: confirmed but cannot fetch details
      const partialRecord = this.createConfirmedPartialRecord(txHash, context);
      await this.persistTransaction(partialRecord, context);

      return {
        txHash,
        status: 'confirmed',
        record: partialRecord,
        error: 'Transaction confirmed but details unavailable',
      };
    }

    // Step 3: Adapt to TransactionRecord
    const record = this.adapter.adaptToTransactionRecord(txHash, detail, context);

    // Step 4: Write to DataStore
    opts.onProgress?.('persisting', txHash);
    await this.persistTransaction(record, context);
    await this.updateHoldingFromRecord(record, context);
    await this.updateBalanceFromRecord(record, context);

    opts.onProgress?.('done', txHash);

    return {
      txHash,
      status: record.status === 'failed' ? 'failed' : 'confirmed',
      record,
    };
  }

  /**
   * Track a Jito Bundle.
   *
   * Flow:
   * 1. Wait for Bundle confirmation via JitoAdapter
   * 2. After Bundle confirmation, fetch internal transaction details one by one
   * 3. Adapt and write to DataStore
   *
   * @param bundleId Jito Bundle ID
   * @param txHashes Transaction signature list in the Bundle
   * @param context Tracking context
   * @param options Tracking options (optional)
   * @returns Tracking result for each transaction
   */
  async trackBundle(
    bundleId: string,
    txHashes: string[],
    context: TrackingContext,
    options?: TrackingOptions,
  ): Promise<TrackingResult[]> {
    const opts = this.resolveOptions(options);

    // Inject bundleId into context
    const bundleContext: TrackingContext = {
      ...context,
      jitoBundle: bundleId,
    };

    opts.onProgress?.('waiting_bundle', bundleId);

    // Step 1: Wait for Bundle confirmation
    const bundleResult = await this.jito.waitForBundleConfirmation(bundleId, {
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.pollIntervalMs,
    });

    if (!bundleResult.success) {
      opts.onProgress?.('bundle_failed', bundleId);

      // Bundle failed: generate failure record for each transaction
      const results: TrackingResult[] = txHashes.map((txHash) => {
        const failedRecord = this.createFailedRecord(txHash, bundleContext);
        // fire-and-forget persistence
        this.persistTransaction(failedRecord, bundleContext).catch(() => {});
        return {
          txHash,
          status: 'failed' as const,
          record: failedRecord,
          error: bundleResult.error || `Bundle ${bundleResult.status}`,
        };
      });

      return results;
    }

    // Step 2: Bundle confirmed, use Bundle's returned transaction list (if available)
    const actualTxHashes = bundleResult.transactions?.length
      ? bundleResult.transactions
      : txHashes;

    opts.onProgress?.('bundle_confirmed', bundleId);

    // Step 3: Fetch and process transaction details one by one
    const results: TrackingResult[] = [];

    for (const txHash of actualTxHashes) {
      // Determine corresponding wallet for each transaction in bundle
      // If txHashes and context.wallets have 1:1 mapping, use corresponding wallet
      const txIndex = txHashes.indexOf(txHash);
      const txContext: TrackingContext = {
        ...bundleContext,
        wallets:
          txIndex >= 0 && txIndex < context.wallets.length
            ? [context.wallets[txIndex]]
            : context.wallets,
      };

      const result = await this.processConfirmedTransaction(txHash, txContext, opts);
      results.push(result);
    }

    return results;
  }

  /**
   * Batch track multiple independent transactions.
   * Concurrently track all transactions, each processed independently.
   *
   * @param entries Transaction list (txHash + context)
   * @param options Tracking options (optional)
   * @returns Tracking result for each transaction
   */
  async trackBatch(
    entries: Array<{ txHash: string; context: TrackingContext }>,
    options?: TrackingOptions,
  ): Promise<TrackingResult[]> {
    if (entries.length === 0) return [];

    const opts = this.resolveOptions(options);

    // Concurrently track all transactions
    const promises = entries.map(({ txHash, context }) =>
      this.trackTransaction(txHash, context, opts).catch((err) => ({
        txHash,
        status: 'failed' as const,
        error: err?.message || 'Unknown error during tracking',
      })),
    );

    return Promise.all(promises);
  }

  // ============================================================
  // Internal methods -- Polling
  // ============================================================

  /**
   * Poll RPC until transaction is confirmed, failed, or timed out.
   *
   * Strategy:
   * - Query transaction status every pollIntervalMs
   * - confirmed / finalized -> return 'confirmed'
   * - failed -> return 'failed'
   * - not_found -> keep waiting
   * - RPC request error -> count retries, throw after limit
   * - timeout -> return 'timeout'
   */
  private async pollUntilConfirmed(
    txHash: string,
    opts: ResolvedTrackingOptions,
  ): Promise<'confirmed' | 'failed' | 'timeout'> {
    const start = Date.now();
    let consecutiveErrors = 0;

    while (Date.now() - start < opts.timeoutMs) {
      try {
        const status = await this.rpc.getTransactionStatus(txHash);

        if (status === 'confirmed' || status === 'finalized') {
          return 'confirmed';
        }

        if (status === 'failed') {
          return 'failed';
        }

        // not_found: keep waiting
        consecutiveErrors = 0; // Successful RPC request resets error count
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= opts.maxRetries) {
          // Multiple consecutive RPC request failures, treat as timeout
          return 'timeout';
        }
      }

      await sleep(opts.pollIntervalMs);
    }

    return 'timeout';
  }

  // ============================================================
  // Internal methods -- Transaction detail fetching
  // ============================================================

  /**
   * Fetch transaction details with retry.
   * Details may not be indexed immediately after confirmation, requiring multiple attempts.
   */
  private async fetchDetailWithRetry(
    txHash: string,
    maxRetries: number,
  ): Promise<import('../adapters/rpc-adapter.js').ParsedTransactionDetail | null> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const detail = await this.rpc.getTransactionDetail(txHash);
        if (detail) return detail;
      } catch {
        // Continue retrying
      }

      // Wait then retry (exponential backoff)
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1));
      }
    }
    return null;
  }

  // ============================================================
  // Internal methods -- Process confirmed transactions
  // ============================================================

  /**
   * Process a confirmed transaction: fetch details -> adapt -> persist
   */
  private async processConfirmedTransaction(
    txHash: string,
    context: TrackingContext,
    opts: ResolvedTrackingOptions,
  ): Promise<TrackingResult> {
    opts.onProgress?.('fetching_detail', txHash);

    const detail = await this.fetchDetailWithRetry(txHash, opts.maxRetries);

    if (!detail) {
      const partialRecord = this.createConfirmedPartialRecord(txHash, context);
      await this.persistTransaction(partialRecord, context);
      return {
        txHash,
        status: 'confirmed',
        record: partialRecord,
        error: 'Transaction confirmed but details unavailable',
      };
    }

    const record = this.adapter.adaptToTransactionRecord(txHash, detail, context);

    opts.onProgress?.('persisting', txHash);
    await this.persistTransaction(record, context);
    await this.updateHoldingFromRecord(record, context);
    await this.updateBalanceFromRecord(record, context);

    opts.onProgress?.('done', txHash);

    return {
      txHash,
      status: record.status === 'failed' ? 'failed' : 'confirmed',
      record,
    };
  }

  // ============================================================
  // Internal methods -- DataStore persistence
  // ============================================================

  /**
   * Write transaction record to DataStore
   */
  private async persistTransaction(record: TransactionRecord, context: TrackingContext): Promise<void> {
    try {
      await this.store.appendTransaction(context.ca, context.groupId, record);
    } catch (err) {
      console.error(`TxTracker: Failed to write trade records [${record.txHash}]:`, err);
    }
  }

  /**
   * Update holding data based on transaction record
   */
  private async updateHoldingFromRecord(record: TransactionRecord, context: TrackingContext): Promise<void> {
    // Only update holdings for confirmed transactions
    if (record.status !== 'confirmed') return;

    try {
      // Read current holdings
      const holdingsFile = this.store.getHoldings(context.ca, context.groupId);
      const currentHolding =
        holdingsFile?.wallets.find((w) => w.walletAddress === record.walletAddress) ||
        this.adapter.createEmptyHolding(record.walletAddress);

      // Calculate updated holdings
      const updatedHolding = this.adapter.updateHoldingFromTx(currentHolding, record);

      // Write
      await this.store.updateHolding(context.ca, context.groupId, record.walletAddress, updatedHolding);
    } catch (err) {
      console.error(`TxTracker: Failed to update positions [${record.walletAddress}]:`, err);
    }
  }

  /**
   * Update balance snapshot based on transaction record
   */
  private async updateBalanceFromRecord(record: TransactionRecord, context: TrackingContext): Promise<void> {
    // Only update balances for confirmed transactions
    if (record.status !== 'confirmed') return;

    try {
      // Fetch latest actual balance from RPC
      const [solBalance, tokenBalance] = await Promise.all([
        this.rpc.getSolBalance(record.walletAddress).catch(() => 0),
        this.rpc.getTokenBalance(record.walletAddress, context.ca).catch(() => 0),
      ]);

      await this.store.updateBalance(context.ca, context.groupId, record.walletAddress, {
        walletAddress: record.walletAddress,
        solBalance,
        tokenBalance,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error(`TxTracker: Failed to update balance [${record.walletAddress}]:`, err);
    }
  }

  // ============================================================
  // Internal methods -- Record factory
  // ============================================================

  /** Create a pending (timeout) transaction record */
  private createPendingRecord(txHash: string, context: TrackingContext): TransactionRecord {
    return {
      txHash,
      txType: context.txType,
      walletAddress: context.wallets[0] || '',
      tokenCA: context.ca,
      amountSol: 0,
      amountToken: 0,
      pricePerToken: 0,
      fee: 0,
      slot: 0,
      blockTime: Math.floor(Date.now() / 1000),
      status: 'pending',
      jitoBundle: context.jitoBundle,
    };
  }

  /** Create a failed transaction record */
  private createFailedRecord(txHash: string, context: TrackingContext): TransactionRecord {
    return {
      txHash,
      txType: context.txType,
      walletAddress: context.wallets[0] || '',
      tokenCA: context.ca,
      amountSol: 0,
      amountToken: 0,
      pricePerToken: 0,
      fee: 0,
      slot: 0,
      blockTime: Math.floor(Date.now() / 1000),
      status: 'failed',
      jitoBundle: context.jitoBundle,
    };
  }

  /** Create a confirmed transaction record without details */
  private createConfirmedPartialRecord(txHash: string, context: TrackingContext): TransactionRecord {
    return {
      txHash,
      txType: context.txType,
      walletAddress: context.wallets[0] || '',
      tokenCA: context.ca,
      amountSol: context.expectedAmountSol ? -context.expectedAmountSol : 0,
      amountToken: 0,
      pricePerToken: 0,
      fee: 0,
      slot: 0,
      blockTime: Math.floor(Date.now() / 1000),
      status: 'confirmed',
      jitoBundle: context.jitoBundle,
    };
  }

  // ============================================================
  // Internal methods -- Option resolution
  // ============================================================

  /** Merge user options with defaults */
  private resolveOptions(options?: TrackingOptions): ResolvedTrackingOptions {
    return {
      pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_OPTIONS.pollIntervalMs,
      timeoutMs: options?.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
      maxRetries: options?.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
      onProgress: options?.onProgress,
    };
  }
}

// ============================================================
// Singleton Management
// ============================================================

let _instance: TxTracker | null = null;

/** Get the global TxTracker singleton */
export function getTxTracker(): TxTracker {
  if (!_instance) {
    _instance = new TxTracker();
  }
  return _instance;
}

/** Reset the singleton (for testing or config changes) */
export function resetTxTracker(): void {
  _instance = null;
}

// ============================================================
// Utility Functions
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
