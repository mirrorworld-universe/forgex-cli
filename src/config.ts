/**
 * ForgeX CLI Configuration Management
 *
 * Manages global CLI configuration, including RPC endpoint, API tokens, network settings, etc.
 * Configuration is stored in ~/.forgex/config.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import merge from 'lodash/merge.js';

// ============================================================
// Type Definitions
// ============================================================

export interface CliConfig {
  /** Solana RPC endpoint URL */
  rpcUrl: string;
  /** Codex API Key (for market data retrieval) */
  codexApiKey: string;
  /** Network type */
  network: 'mainnet' | 'devnet' | 'testnet';
  /** Default priority fee (SOL) */
  defaultPriorityFee: number;
  /** Default slippage (bps) */
  defaultSlippage: number;
  /** Output format */
  outputFormat: 'json' | 'table' | 'minimal';
  /** SOL price (USD) */
  solPrice: number;
  /** @deprecated feeConfig removed, commission logic no longer in use */
  feeConfig?: Record<string, unknown>;
}

// ============================================================
// Default Configuration
// ============================================================

const DEFAULT_CONFIG: CliConfig = {
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  codexApiKey: '',
  network: 'mainnet',
  defaultPriorityFee: 0.0001,
  defaultSlippage: 300,
  outputFormat: 'json',
  solPrice: 130,
};

// ============================================================
// Path Constants
// ============================================================

/** ForgeX configuration directory */
export const FORGEX_DIR = path.join(os.homedir(), '.forgex');

/** Configuration file path */
export const CONFIG_FILE = path.join(FORGEX_DIR, 'config.json');

/** Wallet storage directory */
export const WALLETS_DIR = path.join(FORGEX_DIR, 'wallets');

/** Logs directory */
export const LOGS_DIR = path.join(FORGEX_DIR, 'logs');

/** Vanity keypair storage directory */
export const VANITY_DIR = path.join(FORGEX_DIR, 'vanity');

// ============================================================
// Utility Functions
// ============================================================

/** Ensure .forgex directory and subdirectories exist */
export function ensureConfigDir(): void {
  for (const dir of [FORGEX_DIR, WALLETS_DIR, LOGS_DIR, VANITY_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/** Load configuration file */
export function loadConfig(): CliConfig {
  ensureConfigDir();

  // Environment variable overrides
  const envRpc = process.env.FORGEX_RPC_URL;
  const envCodexKey = process.env.FORGEX_CODEX_API_KEY;

  if (!fs.existsSync(CONFIG_FILE)) {
    const config = { ...DEFAULT_CONFIG };
    if (envRpc) config.rpcUrl = envRpc;
    if (envCodexKey) config.codexApiKey = envCodexKey;
    return config;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const fileConfig = JSON.parse(raw) as Partial<CliConfig>;
    const merged: CliConfig = {
      ...DEFAULT_CONFIG,
      ...fileConfig,
    };

    // Environment variables have the highest priority
    if (envRpc) merged.rpcUrl = envRpc;
    if (envCodexKey) merged.codexApiKey = envCodexKey;

    return merged;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Save configuration file */
export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/** Get a single configuration value */
export function getConfigValue(key: string): unknown {
  const config = loadConfig();
  const keys = key.split('.');
  let current: unknown = config;
  for (const k of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[k];
  }
  return current;
}

/** Set a single configuration value */
export function setConfigValue(key: string, value: string): void {
  const config = loadConfig();
  const keys = key.split('.');
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;

  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof current[k] !== 'object' || current[k] === null) {
      current[k] = {};
    }
    current = current[k] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];

  // Auto-infer type
  if (value === 'true') {
    current[lastKey] = true;
  } else if (value === 'false') {
    current[lastKey] = false;
  } else if (!isNaN(Number(value)) && value !== '') {
    current[lastKey] = Number(value);
  } else {
    current[lastKey] = value;
  }

  saveConfig(config);
}

/** Initialize default configuration file */
export function initConfig(overrides?: Partial<CliConfig>): CliConfig {
  ensureConfigDir();
  // Deep merge to ensure nested fields like feeConfig are not lost
  const config: CliConfig = merge({}, DEFAULT_CONFIG, overrides || {});
  saveConfig(config);
  return config;
}

/**
 * Get a local vanity address from ~/.forgex/vanity/ directory.
 *
 * Returns the first keypair file matching the dex suffix.
 * Throws if no matching file exists, prompting the user to run wallet grind to generate one.
 */
export function getVanityAddress(dex: 'pump' | 'bonk'): {
  publicKey: string;
  secretKey: Uint8Array;
} {
  ensureConfigDir();

  if (!fs.existsSync(VANITY_DIR)) {
    throw new Error(
      `Vanity directory does not exist. Please run forgex wallet grind --suffix ${dex} to generate a vanity address first`
    );
  }

  const files = fs.readdirSync(VANITY_DIR).filter(f => f.endsWith('.json'));
  const suffix = dex.toLowerCase();

  const matchedFile = files.find(f => {
    const address = path.basename(f, '.json');
    return address.toLowerCase().endsWith(suffix);
  });

  if (!matchedFile) {
    throw new Error(
      `No vanity address ending with "${dex}" found. Please run forgex wallet grind --suffix ${dex} to generate one first`
    );
  }

  const filePath = path.join(VANITY_DIR, matchedFile);
  const secretKeyData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const publicKey = path.basename(matchedFile, '.json');

  return {
    publicKey,
    secretKey: new Uint8Array(secretKeyData),
  };
}

/** Validate configuration completeness */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const config = loadConfig();
  const errors: string[] = [];

  if (!config.rpcUrl) {
    errors.push('Missing RPC URL. Please run: forgex config set rpcUrl <your-rpc-url>');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
