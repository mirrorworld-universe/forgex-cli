/**
 * ForgeX CLI DataStore -- file-based storage system
 *
 * Implemented per ARCH-DESIGN-v2.md Section 1.
 * All CLI data is stored in local JSON files for OpenClaw Agent unified read/write context.
 *
 * Directory structure:
 *   ~/.forgex/data/
 *   ├── tokens/<CA>/
 *   │   ├── token-info.json
 *   │   ├── pool-info.json
 *   │   └── groups/<groupId>/
 *   │       ├── transactions.json
 *   │       ├── holdings.json
 *   │       └── balances.json
 *   └── global/
 *       ├── sol-price.json
 *       └── fee-config.json
 *
 * Features:
 * - Atomic writes (write to .tmp first, then rename)
 * - In-process file lock (prevent concurrent write conflicts within same process)
 * - Memory cache (reduce disk IO)
 * - JSON format, human-readable
 */

import fs from 'fs';
import path from 'path';
import { FORGEX_DIR } from '../config.js';

import type {
  TokenInfoFile,
  PoolInfoFile,
  TransactionsFile,
  TransactionRecord,
  HoldingsFile,
  WalletHolding,
  BalancesFile,
  WalletBalance,
  SolPriceFile,
  FeeConfigFile,
} from './types.js';

// Re-export types for consumers
export type {
  TokenInfoFile,
  PoolInfoFile,
  TransactionsFile,
  TransactionRecord,
  HoldingsFile,
  WalletHolding,
  BalancesFile,
  WalletBalance,
  SolPriceFile,
  FeeConfigFile,
} from './types.js';

// ============================================================
// Atomic writes
// ============================================================

/**
 * Atomically write JSON file.
 * Write to .tmp temp file first, then rename to overwrite target.
 * Prevents file corruption from interrupted writes.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Safely read JSON file.
 * Returns null if file does not exist; returns null and logs warning on parse failure.
 */
function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`DataStore: failed to read file ${filePath}:`, err);
    return null;
  }
}

// ============================================================
// In-process file lock
// ============================================================

/**
 * Simple in-process lock to prevent concurrent writes to the same file within one process.
 * CLI is single-process, no cross-process lock needed.
 */
class FileLock {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire lock for given file path, auto-release after operation.
   */
  async withLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
    // Wait for existing lock on this file to release
    while (this.locks.has(filePath)) {
      await this.locks.get(filePath);
    }

    let resolve: () => void;
    const lockPromise = new Promise<void>(r => {
      resolve = r;
    });
    this.locks.set(filePath, lockPromise);

    try {
      return await fn();
    } finally {
      this.locks.delete(filePath);
      resolve!();
    }
  }
}

// ============================================================
// Memory cache
// ============================================================

interface CacheEntry<T> {
  data: T;
  /** Last load time from disk (ms) */
  loadedAt: number;
}

class MemoryCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  /** Cache TTL (ms), default 30 seconds */
  private ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Expiry check
    if (Date.now() - entry.loadedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, { data, loadedAt: Date.now() });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Clear all cache entries with given prefix */
  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

// ============================================================
// DataStore
// ============================================================

export class DataStore {
  private basePath: string;
  private lock: FileLock;
  private cache: MemoryCache;

  constructor(basePath?: string) {
    this.basePath = basePath || path.join(FORGEX_DIR, 'data');
    this.lock = new FileLock();
    this.cache = new MemoryCache();
  }

  // ----------------------------------------------------------
  // Input validation
  // ----------------------------------------------------------

  /** Validate CA: must not be empty and must not contain path traversal chars */
  private validateCA(ca: string): void {
    if (!ca || ca.trim() === '') {
      throw new Error('DataStore: CA (contract address) cannot be empty');
    }
    if (ca.includes('/') || ca.includes('\\') || ca.includes('..') || ca.includes('\0')) {
      throw new Error('DataStore: CA contains invalid characters');
    }
  }

  // ----------------------------------------------------------
  // Path building
  // ----------------------------------------------------------

  private tokensDir(): string {
    return path.join(this.basePath, 'tokens');
  }

  private tokenDir(ca: string): string {
    return path.join(this.tokensDir(), ca);
  }

  private groupDir(ca: string, groupId: number): string {
    return path.join(this.tokenDir(ca), 'groups', String(groupId));
  }

  private globalDir(): string {
    return path.join(this.basePath, 'global');
  }

  private tokenInfoPath(ca: string): string {
    return path.join(this.tokenDir(ca), 'token-info.json');
  }

  private poolInfoPath(ca: string): string {
    return path.join(this.tokenDir(ca), 'pool-info.json');
  }

  private transactionsPath(ca: string, groupId: number): string {
    return path.join(this.groupDir(ca, groupId), 'transactions.json');
  }

  private holdingsPath(ca: string, groupId: number): string {
    return path.join(this.groupDir(ca, groupId), 'holdings.json');
  }

  private balancesPath(ca: string, groupId: number): string {
    return path.join(this.groupDir(ca, groupId), 'balances.json');
  }

  private solPricePath(): string {
    return path.join(this.globalDir(), 'sol-price.json');
  }

  private feeConfigPath(): string {
    return path.join(this.globalDir(), 'fee-config.json');
  }

  // ----------------------------------------------------------
  // Directory management
  // ----------------------------------------------------------

  /** Ensure token directory exists */
  ensureTokenDir(ca: string): void {
    this.validateCA(ca);
    const dir = this.tokenDir(ca);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Ensure wallet group directory exists */
  ensureGroupDir(ca: string, groupId: number): void {
    this.validateCA(ca);
    const dir = this.groupDir(ca, groupId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Ensure global data directory exists */
  private ensureGlobalDir(): void {
    const dir = this.globalDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  // ----------------------------------------------------------
  // Token Info
  // ----------------------------------------------------------

  getTokenInfo(ca: string): TokenInfoFile | null {
    this.validateCA(ca);
    const cacheKey = `token-info:${ca}`;
    const cached = this.cache.get<TokenInfoFile>(cacheKey);
    if (cached) return cached;

    const data = readJson<TokenInfoFile>(this.tokenInfoPath(ca));
    if (data) {
      this.cache.set(cacheKey, data);
    }
    return data;
  }

  async saveTokenInfo(ca: string, info: TokenInfoFile): Promise<void> {
    this.validateCA(ca);
    const filePath = this.tokenInfoPath(ca);
    await this.lock.withLock(filePath, () => {
      this.ensureTokenDir(ca);
      atomicWriteJson(filePath, info);
      this.cache.set(`token-info:${ca}`, info);
    });
  }

  // ----------------------------------------------------------
  // Pool Info
  // ----------------------------------------------------------

  getPoolInfo(ca: string): PoolInfoFile | null {
    this.validateCA(ca);
    const cacheKey = `pool-info:${ca}`;
    const cached = this.cache.get<PoolInfoFile>(cacheKey);
    if (cached) return cached;

    const data = readJson<PoolInfoFile>(this.poolInfoPath(ca));
    if (data) {
      this.cache.set(cacheKey, data);
    }
    return data;
  }

  async savePoolInfo(ca: string, info: PoolInfoFile): Promise<void> {
    this.validateCA(ca);
    const filePath = this.poolInfoPath(ca);
    await this.lock.withLock(filePath, () => {
      this.ensureTokenDir(ca);
      atomicWriteJson(filePath, info);
      this.cache.set(`pool-info:${ca}`, info);
    });
  }

  // ----------------------------------------------------------
  // Transactions
  // ----------------------------------------------------------

  getTransactions(ca: string, groupId: number): TransactionsFile | null {
    this.validateCA(ca);
    const cacheKey = `transactions:${ca}:${groupId}`;
    const cached = this.cache.get<TransactionsFile>(cacheKey);
    if (cached) return cached;

    const data = readJson<TransactionsFile>(this.transactionsPath(ca, groupId));
    if (data) {
      this.cache.set(cacheKey, data);
    }
    return data;
  }

  async appendTransaction(
    ca: string,
    groupId: number,
    tx: TransactionRecord
  ): Promise<void> {
    this.validateCA(ca);
    const filePath = this.transactionsPath(ca, groupId);
    await this.lock.withLock(filePath, () => {
      this.ensureGroupDir(ca, groupId);

      // Read latest from disk (bypass cache to ensure no data loss)
      let file = readJson<TransactionsFile>(filePath);
      if (!file) {
        file = {
          ca,
          groupId,
          transactions: [],
          updatedAt: Date.now(),
        };
      }

      // Deduplicate: do not append same txHash twice
      const exists = file.transactions.some(t => t.txHash === tx.txHash);
      if (!exists) {
        file.transactions.push(tx);
      }

      file.updatedAt = Date.now();
      atomicWriteJson(filePath, file);

      // Update cache
      this.cache.set(`transactions:${ca}:${groupId}`, file);
    });
  }

  getTransactionsByWallet(
    ca: string,
    groupId: number,
    wallet: string
  ): TransactionRecord[] {
    // Note: validateCA is called inside getTransactions
    const file = this.getTransactions(ca, groupId);
    if (!file) return [];
    return file.transactions.filter(tx => tx.walletAddress === wallet);
  }

  // ----------------------------------------------------------
  // Holdings
  // ----------------------------------------------------------

  getHoldings(ca: string, groupId: number): HoldingsFile | null {
    this.validateCA(ca);
    const cacheKey = `holdings:${ca}:${groupId}`;
    const cached = this.cache.get<HoldingsFile>(cacheKey);
    if (cached) return cached;

    const data = readJson<HoldingsFile>(this.holdingsPath(ca, groupId));
    if (data) {
      this.cache.set(cacheKey, data);
    }
    return data;
  }

  async updateHolding(
    ca: string,
    groupId: number,
    wallet: string,
    update: Partial<WalletHolding>
  ): Promise<void> {
    this.validateCA(ca);
    const filePath = this.holdingsPath(ca, groupId);
    await this.lock.withLock(filePath, () => {
      this.ensureGroupDir(ca, groupId);

      let file = readJson<HoldingsFile>(filePath);
      if (!file) {
        file = {
          ca,
          groupId,
          wallets: [],
          updatedAt: Date.now(),
        };
      }

      const idx = file.wallets.findIndex(w => w.walletAddress === wallet);
      if (idx >= 0) {
        // Merge update
        file.wallets[idx] = { ...file.wallets[idx], ...update };
      } else {
        // Add new wallet holding
        const newHolding: WalletHolding = {
          walletAddress: wallet,
          tokenBalance: 0,
          avgBuyPrice: 0,
          totalBought: 0,
          totalSold: 0,
          totalCostSol: 0,
          totalRevenueSol: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          ...update,
        };
        file.wallets.push(newHolding);
      }

      file.updatedAt = Date.now();
      atomicWriteJson(filePath, file);
      this.cache.set(`holdings:${ca}:${groupId}`, file);
    });
  }

  // ----------------------------------------------------------
  // Balances
  // ----------------------------------------------------------

  getBalances(ca: string, groupId: number): BalancesFile | null {
    this.validateCA(ca);
    const cacheKey = `balances:${ca}:${groupId}`;
    const cached = this.cache.get<BalancesFile>(cacheKey);
    if (cached) return cached;

    const data = readJson<BalancesFile>(this.balancesPath(ca, groupId));
    if (data) {
      this.cache.set(cacheKey, data);
    }
    return data;
  }

  async updateBalance(
    ca: string,
    groupId: number,
    wallet: string,
    balance: WalletBalance
  ): Promise<void> {
    this.validateCA(ca);
    const filePath = this.balancesPath(ca, groupId);
    await this.lock.withLock(filePath, () => {
      this.ensureGroupDir(ca, groupId);

      let file = readJson<BalancesFile>(filePath);
      if (!file) {
        file = {
          ca,
          groupId,
          balances: [],
          updatedAt: Date.now(),
        };
      }

      const idx = file.balances.findIndex(b => b.walletAddress === wallet);
      if (idx >= 0) {
        file.balances[idx] = balance;
      } else {
        file.balances.push(balance);
      }

      file.updatedAt = Date.now();
      atomicWriteJson(filePath, file);
      this.cache.set(`balances:${ca}:${groupId}`, file);
    });
  }

  /**
   * Batch update balances.
   * Update multiple wallet balances at once to reduce file IO.
   */
  async updateBalancesBatch(
    ca: string,
    groupId: number,
    balances: WalletBalance[]
  ): Promise<void> {
    this.validateCA(ca);
    const filePath = this.balancesPath(ca, groupId);
    await this.lock.withLock(filePath, () => {
      this.ensureGroupDir(ca, groupId);

      let file = readJson<BalancesFile>(filePath);
      if (!file) {
        file = {
          ca,
          groupId,
          balances: [],
          updatedAt: Date.now(),
        };
      }

      for (const balance of balances) {
        const idx = file.balances.findIndex(
          b => b.walletAddress === balance.walletAddress
        );
        if (idx >= 0) {
          file.balances[idx] = balance;
        } else {
          file.balances.push(balance);
        }
      }

      file.updatedAt = Date.now();
      atomicWriteJson(filePath, file);
      this.cache.set(`balances:${ca}:${groupId}`, file);
    });
  }

  // ----------------------------------------------------------
  // Global -- SOL Price
  // ----------------------------------------------------------

  getSolPrice(): number {
    const cacheKey = 'global:sol-price';
    const cached = this.cache.get<SolPriceFile>(cacheKey);
    if (cached) return cached.priceUsd;

    const data = readJson<SolPriceFile>(this.solPricePath());
    if (data) {
      this.cache.set(cacheKey, data);
      return data.priceUsd;
    }

    return 0;
  }

  async saveSolPrice(price: number): Promise<void> {
    const filePath = this.solPricePath();
    await this.lock.withLock(filePath, () => {
      this.ensureGlobalDir();
      const data: SolPriceFile = {
        priceUsd: price,
        updatedAt: Date.now(),
      };
      atomicWriteJson(filePath, data);
      this.cache.set('global:sol-price', data);
    });
  }

  // ----------------------------------------------------------
  // Global -- Fee Config
  // ----------------------------------------------------------

  getFeeConfig(): FeeConfigFile | null {
    const cacheKey = 'global:fee-config';
    const cached = this.cache.get<FeeConfigFile>(cacheKey);
    if (cached) return cached;

    const data = readJson<FeeConfigFile>(this.feeConfigPath());
    if (data) {
      this.cache.set(cacheKey, data);
    }
    return data;
  }

  async saveFeeConfig(config: FeeConfigFile): Promise<void> {
    const filePath = this.feeConfigPath();
    await this.lock.withLock(filePath, () => {
      this.ensureGlobalDir();
      atomicWriteJson(filePath, config);
      this.cache.set('global:fee-config', config);
    });
  }

  // ----------------------------------------------------------
  // Utility
  // ----------------------------------------------------------

  /** List all token CAs that have data */
  listTokens(): string[] {
    const dir = this.tokensDir();
    if (!fs.existsSync(dir)) return [];

    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  }

  /** List all groupIds with data for a token */
  listGroups(ca: string): number[] {
    this.validateCA(ca);
    const groupsDir = path.join(this.tokenDir(ca), 'groups');
    if (!fs.existsSync(groupsDir)) return [];

    try {
      return fs
        .readdirSync(groupsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => parseInt(entry.name, 10))
        .filter(id => !isNaN(id))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /** Clear all memory cache */
  clearCache(): void {
    this.cache.clear();
  }

  /** Clear cache for a token */
  clearTokenCache(ca: string): void {
    this.validateCA(ca);
    this.cache.invalidatePrefix(`token-info:${ca}`);
    this.cache.invalidatePrefix(`pool-info:${ca}`);
    this.cache.invalidatePrefix(`transactions:${ca}`);
    this.cache.invalidatePrefix(`holdings:${ca}`);
    this.cache.invalidatePrefix(`balances:${ca}`);
  }

  /** Get data root directory path */
  getBasePath(): string {
    return this.basePath;
  }
}

// ============================================================
// Singleton
// ============================================================

let _instance: DataStore | null = null;

/** Get global DataStore singleton */
export function getDataStore(): DataStore {
  if (!_instance) {
    _instance = new DataStore();
  }
  return _instance;
}

/** Create DataStore with custom path (mainly for testing) */
export function createDataStore(basePath: string): DataStore {
  return new DataStore(basePath);
}
