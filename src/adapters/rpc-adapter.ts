/**
 * ForgeX CLI RPC Data Fetch Layer
 *
 * Provides on-chain data queries: balance, account info, transaction confirmation, etc.
 * Reuses sol-sdk/rpc/ infrastructure with multi-endpoint fault tolerance and retry mechanism.
 *
 * Design reference: ARCH-DESIGN-v2.md Section 2.4
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
  Commitment,
  AccountInfo,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import BigNumber from 'bignumber.js';
import { loadConfig } from '../config.js';

// ============================================================
// Type Definitions
// ============================================================

/** Single Token account info */
export interface TokenAccountInfo {
  /** Token mint address */
  mint: string;
  /** Owner wallet address */
  owner: string;
  /** UI-readable balance (divided by decimals) */
  uiAmount: number;
  /** Raw balance (lamports/minimum unit) */
  amount: string;
  /** Token decimals */
  decimals: number;
}

/** Transaction status */
export type TransactionStatus = 'confirmed' | 'finalized' | 'failed' | 'not_found';

/** Parsed transaction detail */
export interface ParsedTransactionDetail {
  /** Transaction signature */
  txHash: string;
  /** Slot height */
  slot: number;
  /** Block time (Unix seconds) */
  blockTime: number | null;
  /** Transaction fee (lamports) */
  fee: number;
  /** Whether transaction failed */
  err: any;
  /** Pre-transaction SOL balances array (lamports) */
  preBalances: number[];
  /** Post-transaction SOL balances array (lamports) */
  postBalances: number[];
  /** Pre-transaction Token balances array */
  preTokenBalances: any[];
  /** Post-transaction Token balances array */
  postTokenBalances: any[];
  /** Account address list */
  accountKeys: string[];
  /** Raw ParsedTransactionWithMeta (for TxDetailAdapter use) */
  raw: ParsedTransactionWithMeta;
}

// ============================================================
// Constants
// ============================================================

/** Default retry count */
const DEFAULT_MAX_RETRIES = 3;

/** Initial retry delay (ms) */
const INITIAL_RETRY_DELAY_MS = 500;

/** Batch query chunk size (getMultipleAccountsInfo limit 100) */
const BATCH_CHUNK_SIZE = 100;

// ============================================================
// RpcAdapter Implementation
// ============================================================

export class RpcAdapter {
  private endpoints: string[];
  private currentEndpointIndex: number;
  private connections: Map<string, Connection>;
  private maxRetries: number;

  constructor(options?: { endpoints?: string[]; maxRetries?: number }) {
    const config = loadConfig();

    // Build endpoint list: primary endpoint + optional fallback endpoints
    this.endpoints = [];

    if (options?.endpoints && options.endpoints.length > 0) {
      this.endpoints = [...options.endpoints];
    } else {
      // Read primary endpoint from config
      if (config.rpcUrl) {
        this.endpoints.push(config.rpcUrl);
      }
    }

    if (this.endpoints.length === 0) {
      // Fallback: Solana public endpoint
      this.endpoints.push('https://api.mainnet-beta.solana.com');
    }

    this.currentEndpointIndex = 0;
    this.connections = new Map();
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  // ============================================================
  // Connection Management
  // ============================================================

  /** Get Connection for current active endpoint */
  private getConnection(commitment: Commitment = 'processed'): Connection {
    const url = this.endpoints[this.currentEndpointIndex];
    const key = `${url}_${commitment}`;

    if (!this.connections.has(key)) {
      this.connections.set(key, new Connection(url, commitment));
    }

    return this.connections.get(key)!;
  }

  /** Switch to next endpoint */
  private switchEndpoint(): boolean {
    if (this.endpoints.length <= 1) return false;

    const oldIndex = this.currentEndpointIndex;
    this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.endpoints.length;

    // If cycled back to start, all endpoints have been tried
    return this.currentEndpointIndex !== oldIndex;
  }

  /** Get current endpoint URL (for debugging) */
  getCurrentEndpoint(): string {
    return this.endpoints[this.currentEndpointIndex];
  }

  // ============================================================
  // Retry and Fault Tolerance
  // ============================================================

  /**
   * Executor with exponential backoff retry + endpoint rotation
   * 1. Retry maxRetries times on current endpoint (exponential backoff)
   * 2. If current endpoint fails all retries, switch to next endpoint
   * 3. Throw last error after all endpoints fail
   */
  private async executeWithRetry<T>(
    operation: (connection: Connection) => Promise<T>,
    operationName: string
  ): Promise<T> {
    const triedEndpoints = new Set<number>();
    let lastError: Error | null = null;

    while (triedEndpoints.size < this.endpoints.length) {
      triedEndpoints.add(this.currentEndpointIndex);
      const connection = this.getConnection();

      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          return await operation(connection);
        } catch (err: any) {
          lastError = err;

          // Check if error is retryable
          const isRetryable = this.isRetryableError(err);

          if (!isRetryable) {
            throw err; // Non-retryable errors throw immediately (e.g. invalid params)
          }

          // Exponential backoff wait
          if (attempt < this.maxRetries - 1) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
            await sleep(delay);
          }
        }
      }

      // All retries failed on current endpoint, try switching
      const switched = this.switchEndpoint();
      if (!switched) break;
    }

    throw lastError || new Error(`${operationName}: All RPC endpoints unavailable`);
  }

  /** Check if error is retryable */
  private isRetryableError(err: any): boolean {
    const message = (err?.message || '').toLowerCase();

    // Network error
    if (message.includes('fetch failed') || message.includes('econnrefused') || message.includes('econnreset')) {
      return true;
    }
    // Rate limit
    if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
      return true;
    }
    // Server error
    if (message.includes('503') || message.includes('502') || message.includes('500')) {
      return true;
    }
    // RPC timeout
    if (message.includes('timeout') || message.includes('timed out')) {
      return true;
    }
    // Solana RPC specific transient errors
    if (message.includes('blockhash not found') || message.includes('slot skipped')) {
      return true;
    }

    return false;
  }

  // ============================================================
  // SOL Balance Queries
  // ============================================================

  /**
   * Get single wallet SOL balance
   * @returns SOL balance (UI units, e.g. 1.5 SOL)
   */
  async getSolBalance(address: string): Promise<number> {
    return this.executeWithRetry(async (connection) => {
      const pubkey = new PublicKey(address);
      const balance = await connection.getBalance(pubkey);
      return new BigNumber(balance).div(LAMPORTS_PER_SOL).toNumber();
    }, 'getSolBalance');
  }

  /**
   * Batch get SOL balances for multiple wallets
   * Uses getMultipleAccountsInfo for batch queries, reducing RPC call count
   * @returns Record<address, SOL balance>
   */
  async getBatchSolBalances(addresses: string[]): Promise<Record<string, number>> {
    if (addresses.length === 0) return {};

    const result: Record<string, number> = {};

    // Batch query (getMultipleAccountsInfo limit 100 accounts)
    for (let i = 0; i < addresses.length; i += BATCH_CHUNK_SIZE) {
      const chunk = addresses.slice(i, i + BATCH_CHUNK_SIZE);
      const pubkeys = chunk.map(addr => new PublicKey(addr));

      const accountInfos = await this.executeWithRetry(async (connection) => {
        return connection.getMultipleAccountsInfo(pubkeys);
      }, 'getBatchSolBalances');

      for (let j = 0; j < chunk.length; j++) {
        const info = accountInfos[j];
        result[chunk[j]] = info
          ? new BigNumber(info.lamports).div(LAMPORTS_PER_SOL).toNumber()
          : 0;
      }
    }

    return result;
  }

  // ============================================================
  // SPL Token Queries
  // ============================================================

  /**
   * Get single token balance for a wallet
   * @returns Token balance (UI units)
   */
  async getTokenBalance(walletAddress: string, tokenMint: string): Promise<number> {
    return this.executeWithRetry(async (connection) => {
      try {
        const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
        const mintPubkey = new PublicKey(tokenMint);
        const ownerPubkey = new PublicKey(walletAddress);

        // First try standard TOKEN_PROGRAM_ID
        try {
          const ataAddress = await getAssociatedTokenAddress(mintPubkey, ownerPubkey);
          const balanceResp = await connection.getTokenAccountBalance(ataAddress);
          const balance = balanceResp.value.uiAmount ?? 0;
          if (balance > 0) return balance;
        } catch {
          // Standard ATA does not exist, try Token-2022
        }

        // Try TOKEN_2022_PROGRAM_ID (used by Pump.fun etc.)
        try {
          const ata2022 = await getAssociatedTokenAddress(mintPubkey, ownerPubkey, false, TOKEN_2022_PROGRAM_ID);
          const balanceResp = await connection.getTokenAccountBalance(ata2022);
          return balanceResp.value.uiAmount ?? 0;
        } catch {
          return 0;
        }
      } catch {
        // ATA does not exist = balance is 0
        return 0;
      }
    }, 'getTokenBalance');
  }

  /**
   * Get all token accounts for a wallet
   * Queries directly via RPC, replacing forgex.online/api getTokenListFromAddress
   */
  async getTokenAccountsByOwner(walletAddress: string): Promise<TokenAccountInfo[]> {
    return this.executeWithRetry(async (connection) => {
      const ownerPubkey = new PublicKey(walletAddress);

      const response = await connection.getParsedTokenAccountsByOwner(ownerPubkey, {
        programId: TOKEN_PROGRAM_ID,
      });

      return response.value
        .map((item) => {
          const parsed = item.account.data.parsed;
          const info = parsed?.info;
          if (!info) return null;

          return {
            mint: info.mint as string,
            owner: info.owner as string,
            uiAmount: info.tokenAmount?.uiAmount ?? 0,
            amount: info.tokenAmount?.amount ?? '0',
            decimals: info.tokenAmount?.decimals ?? 0,
          };
        })
        .filter((item): item is TokenAccountInfo => item !== null && item.uiAmount > 0);
    }, 'getTokenAccountsByOwner');
  }

  /**
   * Batch get token balances for multiple wallets on a specific token
   * @returns Record<wallet address, Token balance>
   */
  async getBatchTokenBalances(
    walletAddresses: string[],
    tokenMint: string
  ): Promise<Record<string, number>> {
    if (walletAddresses.length === 0) return {};

    const result: Record<string, number> = {};

    // Concurrent queries with rate limiting (max 10 concurrent per batch)
    const CONCURRENCY = 10;
    for (let i = 0; i < walletAddresses.length; i += CONCURRENCY) {
      const batch = walletAddresses.slice(i, i + CONCURRENCY);
      const balances = await Promise.all(
        batch.map(async (addr) => {
          try {
            const balance = await this.getTokenBalance(addr, tokenMint);
            return { addr, balance };
          } catch {
            return { addr, balance: 0 };
          }
        })
      );

      for (const { addr, balance } of balances) {
        result[addr] = balance;
      }
    }

    return result;
  }

  // ============================================================
  // Transaction Status Queries
  // ============================================================

  /**
   * Query confirmation status of a single transaction
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    return this.executeWithRetry(async (connection) => {
      const result = await connection.getSignatureStatuses([txHash]);
      const status = result.value[0];

      if (!status) {
        return 'not_found';
      }

      if (status.err) {
        return 'failed';
      }

      if (status.confirmationStatus === 'finalized') {
        return 'finalized';
      }

      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'processed') {
        return 'confirmed';
      }

      return 'not_found';
    }, 'getTransactionStatus');
  }

  /**
   * Get transaction details
   * Returns parsed transaction data including balance changes, token changes, etc.
   */
  async getTransactionDetail(txHash: string): Promise<ParsedTransactionDetail | null> {
    return this.executeWithRetry(async (connection) => {
      const tx = await connection.getParsedTransaction(txHash, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.meta) {
        return null;
      }

      // Extract accountKeys
      const accountKeys = tx.transaction.message.accountKeys.map((key) =>
        typeof key === 'string' ? key : key.pubkey.toBase58()
      );

      return {
        txHash,
        slot: tx.slot,
        blockTime: tx.blockTime,
        fee: tx.meta.fee,
        err: tx.meta.err,
        preBalances: tx.meta.preBalances,
        postBalances: tx.meta.postBalances,
        preTokenBalances: tx.meta.preTokenBalances ?? [],
        postTokenBalances: tx.meta.postTokenBalances ?? [],
        accountKeys,
        raw: tx,
      };
    }, 'getTransactionDetail');
  }

  /**
   * Batch query transaction statuses
   * @returns Record<txHash, TransactionStatus>
   */
  async getBatchTransactionStatuses(txHashes: string[]): Promise<Record<string, TransactionStatus>> {
    if (txHashes.length === 0) return {};

    const result: Record<string, TransactionStatus> = {};

    // getSignatureStatuses supports max 256 signatures per call
    const SIGNATURE_BATCH_SIZE = 256;
    for (let i = 0; i < txHashes.length; i += SIGNATURE_BATCH_SIZE) {
      const batch = txHashes.slice(i, i + SIGNATURE_BATCH_SIZE);

      const statuses = await this.executeWithRetry(async (connection) => {
        return connection.getSignatureStatuses(batch);
      }, 'getBatchTransactionStatuses');

      for (let j = 0; j < batch.length; j++) {
        const status = statuses.value[j];
        if (!status) {
          result[batch[j]] = 'not_found';
        } else if (status.err) {
          result[batch[j]] = 'failed';
        } else if (status.confirmationStatus === 'finalized') {
          result[batch[j]] = 'finalized';
        } else {
          result[batch[j]] = 'confirmed';
        }
      }
    }

    return result;
  }

  // ============================================================
  // General RPC Queries
  // ============================================================

  /**
   * Get account info (raw)
   */
  async getAccountInfo(address: string): Promise<AccountInfo<Buffer> | null> {
    return this.executeWithRetry(async (connection) => {
      return connection.getAccountInfo(new PublicKey(address));
    }, 'getAccountInfo');
  }

  /**
   * Get latest blockhash
   */
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.executeWithRetry(async (connection) => {
      return connection.getLatestBlockhash('processed');
    }, 'getLatestBlockhash');
  }

  /**
   * Get current slot
   */
  async getSlot(): Promise<number> {
    return this.executeWithRetry(async (connection) => {
      return connection.getSlot();
    }, 'getSlot');
  }

  /**
   * Health check: verify current endpoint availability
   */
  async healthCheck(): Promise<{ healthy: boolean; endpoint: string; slot?: number; error?: string }> {
    const endpoint = this.getCurrentEndpoint();
    try {
      const slot = await this.getSlot();
      return { healthy: true, endpoint, slot };
    } catch (err: any) {
      return { healthy: false, endpoint, error: err.message };
    }
  }
}

// ============================================================
// Singleton Management
// ============================================================

let _instance: RpcAdapter | null = null;

/**
 * Get RpcAdapter singleton
 * Creates instance from config RPC settings on first call
 */
export function getRpcAdapter(): RpcAdapter {
  if (!_instance) {
    _instance = new RpcAdapter();
  }
  return _instance;
}

/**
 * Reset singleton (for re-initialization after config changes)
 */
export function resetRpcAdapter(): void {
  _instance = null;
}

// ============================================================
// Utility Functions
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
