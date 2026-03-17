/**
 * DataStore type definitions
 *
 * File format as defined in ARCH-DESIGN-v2.md Section 1.3.
 * Each type corresponds to one JSON file under ~/.forgex/data/.
 */

// ============================================================
// token-info.json
// ============================================================

export interface TokenInfoFile {
  ca: string;
  symbol: string;
  name: string;
  decimals: number;
  creatorAddress: string;
  dex: 'pump' | 'raydium' | 'pumpswap' | 'launchlab' | 'meteora';
  pairAddress: string;
  updatedAt: number; // Unix timestamp (ms)
}

// ============================================================
// pool-info.json
// ============================================================

export interface PoolInfoFile {
  ca: string;
  pairAddress: string;
  dex: string;
  liquidity: {
    sol: number;
    token: number;
  };
  priceSol: number;
  priceUsd: number;
  updatedAt: number;
}

// ============================================================
// transactions.json
// ============================================================

export interface TransactionRecord {
  txHash: string;
  txType: 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'turnover';
  walletAddress: string;
  tokenCA: string;
  amountSol: number;
  amountToken: number;
  pricePerToken: number;
  fee: number;
  slot: number;
  blockTime: number;
  status: 'confirmed' | 'failed' | 'pending';
  jitoBundle?: string;
}

export interface TransactionsFile {
  ca: string;
  groupId: number;
  transactions: TransactionRecord[];
  updatedAt: number;
}

// ============================================================
// holdings.json
// ============================================================

export interface WalletHolding {
  walletAddress: string;
  tokenBalance: number;
  avgBuyPrice: number;
  totalBought: number;
  totalSold: number;
  totalCostSol: number;
  totalRevenueSol: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface HoldingsFile {
  ca: string;
  groupId: number;
  wallets: WalletHolding[];
  updatedAt: number;
}

// ============================================================
// balances.json
// ============================================================

export interface WalletBalance {
  walletAddress: string;
  solBalance: number;
  tokenBalance: number;
  updatedAt: number;
}

export interface BalancesFile {
  ca: string;
  groupId: number;
  balances: WalletBalance[];
  updatedAt: number;
}

// ============================================================
// global/sol-price.json
// ============================================================

export interface SolPriceFile {
  priceUsd: number;
  updatedAt: number;
}

// ============================================================
// global/fee-config.json
// ============================================================

export interface FeeConfigFile {
  tradeFee: number;
  tipAddress: string;
  referralFee: number;
  batchTransferFee: number;
  batchCollectionFee: number;
  multiToMultiFee: number;
  updatedAt: number;
}
