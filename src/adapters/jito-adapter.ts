/**
 * ForgeX CLI Jito Bundle Direct Adapter
 *
 * Replaces the existing bundle status query and sending via forgex.online/api proxy.
 * Directly calls Jito Block Engine JSON-RPC API.
 *
 * Design reference: ARCH-DESIGN-v2.md Section 2.5
 *
 * Reuses endpoint config and tip account list from sol-sdk/jito/index.ts.
 */

import axios, { AxiosInstance } from 'axios';
import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadConfig } from '../config.js';

// ============================================================
// Constants (reuses sol-sdk/jito config)
// ============================================================

/** Jito Block Engine API endpoint list (multi-region fault tolerance) */
export const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1',
];

/** Jito Tip account list */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

// ============================================================
// Type Definitions
// ============================================================

/** JSON-RPC response */
interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

/** Bundle confirmation status enum */
export enum BundleStatusEnum {
  /** Sent, not yet processed */
  SENT = 'sent',
  /** Processed (included in block) */
  PROCESSED = 'processed',
  /** Confirmed (supermajority validation) */
  CONFIRMED = 'confirmed',
  /** Finalized (irreversible) */
  FINALIZED = 'finalized',
  /** Execution failed */
  FAILED = 'failed',
  /** Query timeout */
  TIMEOUT = 'timeout',
  /** In landing (inflight) */
  INFLIGHT = 'inflight',
  /** Unknown status */
  UNKNOWN = 'unknown',
}

/** Bundle status query result (getBundleStatuses API) */
export interface BundleStatusResult {
  /** Bundle ID */
  bundleId: string;
  /** Confirmation status */
  status: BundleStatusEnum;
  /** Slot containing the bundle */
  slot?: number;
  /** List of transaction signatures in the bundle */
  transactions?: string[];
  /** Confirmation time (Unix ms) */
  confirmationTime?: number;
  /** Error info (if failed) */
  err?: any;
}

/** Inflight bundle status */
export interface InflightBundleStatus {
  bundleId: string;
  status: string;
  landedSlot?: number;
}

/** Bundle confirmation wait result */
export interface BundleConfirmationResult {
  /** Bundle ID */
  bundleId: string;
  /** Final status */
  status: BundleStatusEnum;
  /** Whether successful (processed/confirmed/finalized) */
  success: boolean;
  /** Slot containing the bundle */
  slot?: number;
  /** Transaction list in the bundle */
  transactions?: string[];
  /** Error info */
  error?: string;
}

/** Wait for confirmation options */
export interface WaitOptions {
  /** Timeout (ms), default 60000 */
  timeoutMs?: number;
  /** Poll interval (ms), default 2000 */
  intervalMs?: number;
}

// ============================================================
// Defaults
// ============================================================

const DEFAULT_MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

// ============================================================
// JitoAdapter Implementation
// ============================================================

export class JitoAdapter {
  private endpoints: string[];
  private currentEndpointIndex: number;
  private client: AxiosInstance;
  private maxRetries: number;

  constructor(options?: { endpoints?: string[]; maxRetries?: number }) {
    // Endpoint list: user config > default Jito endpoints
    if (options?.endpoints && options.endpoints.length > 0) {
      this.endpoints = [...options.endpoints];
    } else {
      // Try reading custom Jito endpoints from config
      try {
        const config = loadConfig();
        const configEndpoints = (config as any).jitoEndpoints;
        const configEndpoint = (config as any).jitoEndpoint;
        if (Array.isArray(configEndpoints) && configEndpoints.length > 0) {
          this.endpoints = configEndpoints;
        } else if (typeof configEndpoint === 'string' && configEndpoint) {
          this.endpoints = [configEndpoint];
        } else {
          this.endpoints = [...JITO_ENDPOINTS];
        }
      } catch {
        this.endpoints = [...JITO_ENDPOINTS];
      }
    }

    this.currentEndpointIndex = 0;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

    this.client = axios.create({
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  }

  // ============================================================
  // Low-level JSON-RPC Communication
  // ============================================================

  /**
   * Send JSON-RPC request to Jito Block Engine
   * @param path API path (e.g. /bundles)
   * @param method JSON-RPC method name
   * @param params JSON-RPC params
   */
  private async sendRequest(
    path: string,
    method: string,
    params?: any[]
  ): Promise<JsonRpcResponse> {
    const baseUrl = this.endpoints[this.currentEndpointIndex];
    const config = loadConfig() as any;
    const uuid = process.env.JITO_UUID || config?.jitoUuid || config?.uuid;
    const sep = path.includes('?') ? '&' : '?';
    const pathWithUuid = uuid && !path.includes('uuid=') ? `${path}${sep}uuid=${uuid}` : path;
    const url = `${baseUrl}${pathWithUuid}`;

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: params || [],
    };

    console.log(`[Jito] RPC ${method} -> ${url}`);
    const response = await this.client.post<JsonRpcResponse>(url, payload);
    return response.data;
  }

  // ============================================================
  // Retry and Fault Tolerance (same pattern as RpcAdapter)
  // ============================================================

  /**
   * Executor with exponential backoff retry + endpoint rotation
   * 1. Retry maxRetries times on current endpoint (exponential backoff)
   * 2. If current endpoint fails all retries, switch to next endpoint
   * 3. Throw last error after all endpoints fail
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    const triedEndpoints = new Set<number>();
    let lastError: Error | null = null;

    while (triedEndpoints.size < this.endpoints.length) {
      triedEndpoints.add(this.currentEndpointIndex);

      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          return await operation();
        } catch (err: any) {
          // Enhance error message with Jito response body details
          if (err?.response?.data) {
            const data = err.response.data;
            const detail =
              data?.error?.message ||
              data?.message ||
              (typeof data === 'string' ? data : JSON.stringify(data));
            lastError = new Error(`${err.message}: ${detail}`);
          } else {
            lastError = err;
          }

          if (!this.isRetryableError(err)) {
            throw lastError;
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

    throw lastError || new Error(`${operationName}: All Jito endpoints unavailable`);
  }

  /** Check if error is retryable */
  private isRetryableError(err: any): boolean {
    const message = (err?.message || '').toLowerCase();
    const status = err?.response?.status;

    // HTTP status code check
    if (status === 429 || status === 502 || status === 503 || status === 500) {
      return true;
    }

    // Network error
    if (
      message.includes('fetch failed') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('network error')
    ) {
      return true;
    }

    // Timeout
    if (message.includes('timeout') || message.includes('timed out') || err?.code === 'ECONNABORTED') {
      return true;
    }

    // Rate limit
    if (message.includes('rate limit') || message.includes('too many requests')) {
      return true;
    }

    return false;
  }

  /** Switch to next endpoint */
  private switchEndpoint(): boolean {
    if (this.endpoints.length <= 1) return false;

    const oldIndex = this.currentEndpointIndex;
    this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.endpoints.length;

    return this.currentEndpointIndex !== oldIndex;
  }

  /** Get current endpoint URL (for debugging) */
  getCurrentEndpoint(): string {
    return this.endpoints[this.currentEndpointIndex];
  }

  // ============================================================
  // Bundle Status Queries
  // ============================================================

  /**
   * Query bundle statuses
   * Calls Jito getBundleStatuses JSON-RPC method
   *
   * @param bundleIds Bundle IDs to query
   * @returns Status for each bundle
   */
  async getBundleStatuses(bundleIds: string[]): Promise<BundleStatusResult[]> {
    if (bundleIds.length === 0) return [];

    return this.executeWithRetry(async () => {
      const response = await this.sendRequest('/bundles', 'getBundleStatuses', [bundleIds]);

      if (response.error) {
        throw new Error(`Jito getBundleStatuses error: ${response.error.message}`);
      }

      const value = response.result?.value;
      if (!Array.isArray(value)) {
        // No bundle statuses found
        return bundleIds.map((id) => ({
          bundleId: id,
          status: BundleStatusEnum.UNKNOWN,
        }));
      }

      return bundleIds.map((id, index) => {
        const entry = value[index];
        if (!entry) {
          return { bundleId: id, status: BundleStatusEnum.UNKNOWN };
        }

        return {
          bundleId: entry.bundle_id || id,
          status: this.mapBundleStatus(entry.confirmation_status),
          slot: entry.slot ?? undefined,
          transactions: entry.transactions ?? undefined,
          err: entry.err ?? undefined,
        };
      });
    }, 'getBundleStatuses');
  }

  /**
   * Query single bundle status (convenience method)
   */
  async getBundleStatus(bundleId: string): Promise<BundleStatusResult> {
    const results = await this.getBundleStatuses([bundleId]);
    return results[0];
  }

  /**
   * Query inflight bundle statuses
   * For querying bundles that have been sent but not yet landed
   */
  async getInflightBundleStatuses(bundleIds: string[]): Promise<InflightBundleStatus[]> {
    if (bundleIds.length === 0) return [];

    return this.executeWithRetry(async () => {
      const response = await this.sendRequest(
        '/bundles',
        'getInflightBundleStatuses',
        [bundleIds]
      );

      if (response.error) {
        throw new Error(`Jito getInflightBundleStatuses error: ${response.error.message}`);
      }

      const value = response.result?.value;
      if (!Array.isArray(value)) {
        return bundleIds.map((id) => ({
          bundleId: id,
          status: 'unknown',
        }));
      }

      return value.map((entry: any, index: number) => ({
        bundleId: entry?.bundle_id || bundleIds[index],
        status: entry?.status || 'unknown',
        landedSlot: entry?.landed_slot ?? undefined,
      }));
    }, 'getInflightBundleStatuses');
  }

  // ============================================================
  // Bundle Confirmation Wait (polling)
  // ============================================================

  /**
   * Wait for bundle confirmation
   * Polls getBundleStatuses until terminal state or timeout
   *
   * @param bundleId Bundle ID
   * @param options Timeout and poll interval config
   * @returns Bundle confirmation result
   */
  async waitForBundleConfirmation(
    bundleId: string,
    options?: WaitOptions
  ): Promise<BundleConfirmationResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const [status, inflight] = await Promise.all([
          this.getBundleStatus(bundleId).catch(() => ({ bundleId, status: BundleStatusEnum.UNKNOWN } as BundleStatusResult)),
          this.getInflightBundleStatuses([bundleId]).catch(() => [{ bundleId, status: 'unknown' } as InflightBundleStatus]),
        ]);

        const inflightStatus = inflight?.[0];
        console.log(`[Jito] bundle ${bundleId} poll => final=${status.status} slot=${status.slot ?? 'n/a'} inflight=${inflightStatus?.status ?? 'n/a'} landedSlot=${inflightStatus?.landedSlot ?? 'n/a'} txs=${status.transactions?.length ?? 0}`);

        // If inflight has landed but final status not yet updated, treat as success and return observable info
        if (
          inflightStatus?.status &&
          ['landed', 'processed', 'confirmed', 'finalized'].includes(String(inflightStatus.status).toLowerCase())
        ) {
          return {
            bundleId,
            status: status.status !== BundleStatusEnum.UNKNOWN ? status.status : BundleStatusEnum.PROCESSED,
            success: true,
            slot: status.slot ?? inflightStatus.landedSlot,
            transactions: status.transactions,
          };
        }

        if (this.isTerminalStatus(status.status)) {
          const success = this.isSuccessStatus(status.status);
          return {
            bundleId,
            status: status.status,
            success,
            slot: status.slot,
            transactions: status.transactions,
            error: success ? undefined : `Bundle status: ${status.status}`,
          };
        }
      } catch (err: any) {
        console.log(`[Jito] bundle ${bundleId} poll error: ${err?.message || err}`);
        await sleep(Math.max(intervalMs, 5000));
        continue;
      }

      await sleep(intervalMs);
    }

    return {
      bundleId,
      status: BundleStatusEnum.TIMEOUT,
      success: false,
      error: `Bundle confirmation timeout (${timeoutMs}ms)`,
    };
  }

  // ============================================================
  // Bundle Sending
  // ============================================================

  /**
   * Send bundle to Jito Block Engine
   * Direct connection to Jito, not through forgex.online/api proxy
   *
   * @param base64Txs Base64 encoded transaction list
   * @returns Bundle ID
   */
  async sendBundle(base64Txs: string[]): Promise<{ bundleId: string }> {
    if (base64Txs.length === 0) {
      throw new Error('sendBundle: transaction list cannot be empty');
    }

    console.log(`[Jito] Sending bundle: ${base64Txs.length} transactions, endpoint: ${this.getCurrentEndpoint()}`);

    return this.executeWithRetry(async () => {
      const response = await this.sendRequest('/bundles', 'sendBundle', [base64Txs, { encoding: 'base64' }]);

      if (response.error) {
        throw new Error(`Jito sendBundle error: ${response.error.message}`);
      }

      const bundleId = response.result;
      if (!bundleId || typeof bundleId !== 'string') {
        throw new Error('Jito sendBundle: no valid Bundle ID returned');
      }

      return { bundleId };
    }, 'sendBundle');
  }


  async sendBundleBase58(base64Txs: string[]): Promise<{ bundleId: string }> {
    if (base64Txs.length === 0) {
      throw new Error('sendBundleBase58: transaction list cannot be empty');
    }

    const base58Txs = base64Txs.map(b64 => bs58.encode(Buffer.from(b64, 'base64')));
    console.log(`[Jito] Sending bundle (base58): ${base58Txs.length} transactions, endpoint: ${this.getCurrentEndpoint()}`);

    return this.executeWithRetry(async () => {
      const response = await this.sendRequest('/bundles', 'sendBundle', [base58Txs]);
      if (response.error) {
        throw new Error(`Jito sendBundle(base58) error: ${response.error.message}`);
      }
      const bundleId = response.result;
      if (!bundleId || typeof bundleId !== 'string') {
        throw new Error('Jito sendBundle(base58): no valid Bundle ID returned');
      }
      return { bundleId };
    }, 'sendBundleBase58');
  }

  // ============================================================
  // Single Transaction Sending (sendTransaction)
  // ============================================================

  /**
   * Send single transaction via Jito
   * Uses /transactions endpoint + base64 encoding
   *
   * @param base64Tx Base64 encoded transaction
   * @returns Transaction signature (txHash)
   */
  async sendTransaction(base64Tx: string, options?: { bundleOnly?: boolean }): Promise<{ txHash: string }> {
    return this.executeWithRetry(async () => {
      const path = options?.bundleOnly ? '/transactions?bundleOnly=true' : '/transactions';
      const response = await this.sendRequest(
        path,
        'sendTransaction',
        [base64Tx, { encoding: 'base64' }]
      );
      if (response.error) {
        throw new Error(`Jito sendTransaction error: ${response.error.message}`);
      }
      return { txHash: response.result };
    }, 'sendTransaction');
  }

  // ============================================================
  // RPC Transaction Confirmation
  // ============================================================

  /**
   * Confirm transaction status via standard Solana RPC
   * Polls getSignatureStatuses until confirmed or timeout
   *
   * @param connection Solana Connection
   * @param signature Transaction signature
   * @param timeoutMs Timeout (ms), default 30000
   * @param intervalMs Poll interval (ms), default 2000
   * @returns Confirmation result
   */
  async confirmTransactionByRpc(
    connection: Connection,
    signature: string,
    timeoutMs = 30000,
    intervalMs = 2000,
  ): Promise<{ success: boolean; error?: string }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const statuses = await connection.getSignatureStatuses([signature]);
      const status = statuses.value[0];
      if (status) {
        return {
          success: !status.err,
          error: status.err ? JSON.stringify(status.err) : undefined,
        };
      }
      await sleep(intervalMs);
    }
    return { success: false, error: 'Transaction confirmation timeout' };
  }

  // ============================================================
  // Tip Queries
  // ============================================================

  /**
   * Fetch latest tip account list from Jito API
   * Normally the local hardcoded JITO_TIP_ACCOUNTS suffice,
   * this method is for scenarios requiring dynamic tip account retrieval
   */
  async getTipAccounts(): Promise<string[]> {
    return this.executeWithRetry(async () => {
      const response = await this.sendRequest('/bundles', 'getTipAccounts');

      if (response.error) {
        throw new Error(`Jito getTipAccounts error: ${response.error.message}`);
      }

      const accounts = response.result;
      if (Array.isArray(accounts) && accounts.length > 0) {
        return accounts;
      }

      // Fallback to local hardcoded list
      return [...JITO_TIP_ACCOUNTS];
    }, 'getTipAccounts');
  }

  /**
   * Get a random tip account address
   * Uses local hardcoded list, no network overhead
   */
  getRandomTipAccount(): string {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return JITO_TIP_ACCOUNTS[index];
  }

  /**
   * Build Jito tip transfer instruction
   * Reuses logic from sol-sdk/jito
   *
   * @param payer Payer PublicKey
   * @param tipAmountSol Tip amount (SOL units)
   * @returns SystemProgram.transfer instruction
   */
  getTipInstruction(payer: PublicKey, tipAmountSol: number) {
    const tipAccount = new PublicKey(this.getRandomTipAccount());
    const lamports = Math.floor(tipAmountSol * LAMPORTS_PER_SOL);

    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tipAccount,
      lamports,
    });
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Check if bundle status is a success state
   * (processed / confirmed / finalized are all considered successful)
   */
  isSuccessStatus(status: BundleStatusEnum): boolean {
    return (
      status === BundleStatusEnum.PROCESSED ||
      status === BundleStatusEnum.CONFIRMED ||
      status === BundleStatusEnum.FINALIZED
    );
  }

  /**
   * Check if bundle status is a terminal state (will not change)
   */
  isTerminalStatus(status: BundleStatusEnum): boolean {
    return (
      status === BundleStatusEnum.PROCESSED ||
      status === BundleStatusEnum.CONFIRMED ||
      status === BundleStatusEnum.FINALIZED ||
      status === BundleStatusEnum.FAILED
    );
  }

  /**
   * Map Jito API status string to BundleStatusEnum
   */
  private mapBundleStatus(rawStatus: string | undefined): BundleStatusEnum {
    if (!rawStatus) return BundleStatusEnum.UNKNOWN;

    const normalized = rawStatus.toLowerCase();
    switch (normalized) {
      case 'sent':
        return BundleStatusEnum.SENT;
      case 'processed':
        return BundleStatusEnum.PROCESSED;
      case 'confirmed':
        return BundleStatusEnum.CONFIRMED;
      case 'finalized':
        return BundleStatusEnum.FINALIZED;
      case 'failed':
        return BundleStatusEnum.FAILED;
      default:
        return BundleStatusEnum.UNKNOWN;
    }
  }

  /**
   * Health check: verify current Jito endpoint availability
   */
  async healthCheck(): Promise<{ healthy: boolean; endpoint: string; error?: string }> {
    const endpoint = this.getCurrentEndpoint();
    try {
      // getTipAccounts is the lightest Jito API call, suitable for health checks
      await this.getTipAccounts();
      return { healthy: true, endpoint };
    } catch (err: any) {
      return { healthy: false, endpoint, error: err.message };
    }
  }
}

// ============================================================
// Singleton Management (same pattern as RpcAdapter)
// ============================================================

let _instance: JitoAdapter | null = null;

/**
 * Get JitoAdapter singleton
 * Creates instance on first call
 */
export function getJitoAdapter(): JitoAdapter {
  if (!_instance) {
    _instance = new JitoAdapter();
  }
  return _instance;
}

/**
 * Reset singleton (for re-initialization after config changes)
 */
export function resetJitoAdapter(): void {
  _instance = null;
}

// ============================================================
// Utility Functions
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
