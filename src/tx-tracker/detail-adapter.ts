/**
 * ForgeX CLI TxDetailAdapter -- Transaction detail field adapter
 *
 * Maps raw transaction data (ParsedTransactionDetail) returned by RPC
 * to the CLI DataStore TransactionRecord structure.
 *
 * Core responsibilities:
 * - Calculate SOL delta from preBalances / postBalances
 * - Calculate Token delta from preTokenBalances / postTokenBalances
 * - Compute execution price (pricePerToken = |solChange| / |tokenChange|)
 * - Extract fees
 * - Update position data from transaction records (avgBuyPrice, realizedPnl, etc.)
 *
 * Design reference: ARCH-DESIGN-v2.md Section 3.4
 */

import type { ParsedTransactionDetail } from '../adapters/rpc-adapter.js';
import type { TransactionRecord, WalletHolding } from '../data-store/types.js';

// ============================================================
// Type Definitions
// ============================================================

/** Tracking context (passed in by TxTracker) */
export interface TrackingContext {
  /** Token contract address */
  ca: string;
  /** Wallet group ID */
  groupId: number;
  /** Transaction type */
  txType: 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'turnover';
  /** List of wallet addresses involved in the transaction */
  wallets: string[];
  /** Expected SOL amount (for validation, optional) */
  expectedAmountSol?: number;
  /** Jito Bundle ID (if any) */
  jitoBundle?: string;
}

/** Token balance entry (single item from RPC preTokenBalances/postTokenBalances) */
interface TokenBalanceEntry {
  /** Account index (position in accountKeys) */
  accountIndex: number;
  /** Token mint address */
  mint: string;
  /** Token balance */
  uiTokenAmount: {
    /** UI-readable balance */
    uiAmount: number | null;
    /** Raw balance (string) */
    amount: string;
    /** Decimals */
    decimals: number;
    /** UI-readable balance (string) */
    uiAmountString?: string;
  };
  /** Owner address */
  owner?: string;
  /** Token Program ID */
  programId?: string;
}

// ============================================================
// TxDetailAdapter Implementation
// ============================================================

export class TxDetailAdapter {
  /**
   * Core adaptation method:
   * Extracts and maps raw RPC transaction data into a TransactionRecord.
   *
   * Parsing flow:
   * 1. Find target wallet index in accountKeys
   * 2. Compare preBalances vs postBalances via index to compute SOL delta
   * 3. Filter preTokenBalances / postTokenBalances by target token and wallet to compute Token delta
   * 4. Compute execution price: |SOL delta - fee| / |Token delta|
   * 5. Assemble TransactionRecord
   *
   * @param txHash Transaction signature
   * @param detail Parsed transaction detail from RPC
   * @param context Tracking context
   * @returns TransactionRecord
   */
  adaptToTransactionRecord(
    txHash: string,
    detail: ParsedTransactionDetail,
    context: TrackingContext,
  ): TransactionRecord {
    const { accountKeys, preBalances, postBalances, preTokenBalances, postTokenBalances, fee, err, slot, blockTime } =
      detail;

    // 1. Find target wallet index in accountKeys
    const walletIndex = this.findWalletIndex(accountKeys, context.wallets);

    // 2. Calculate SOL delta (lamports -> SOL)
    const solChangeLamports =
      walletIndex >= 0 ? (postBalances[walletIndex] ?? 0) - (preBalances[walletIndex] ?? 0) : 0;
    const solChange = solChangeLamports / 1e9;

    // 3. Calculate Token delta
    const tokenChange = this.calculateTokenChange(
      preTokenBalances,
      postTokenBalances,
      context.ca,
      context.wallets,
      accountKeys,
    );

    // 4. Calculate execution price
    // For buy: spend SOL to get Token, solChange is negative, tokenChange is positive
    // For sell: spend Token to get SOL, solChange is positive, tokenChange is negative
    // Price = |net SOL delta (minus fee)| / |Token delta|
    const feeInSol = (fee || 0) / 1e9;
    const netSolChange = Math.abs(solChange) - feeInSol;
    const pricePerToken = tokenChange !== 0 ? Math.max(0, netSolChange) / Math.abs(tokenChange) : 0;

    // 5. Assemble record
    return {
      txHash,
      txType: context.txType,
      walletAddress: this.resolveWalletAddress(accountKeys, context.wallets, walletIndex),
      tokenCA: context.ca,
      amountSol: solChange,
      amountToken: tokenChange,
      pricePerToken,
      fee: feeInSol,
      slot,
      blockTime: blockTime || Math.floor(Date.now() / 1000),
      status: err ? 'failed' : 'confirmed',
      jitoBundle: context.jitoBundle,
    };
  }

  /**
   * Update position data based on transaction record.
   *
   * Update logic:
   * - buy:  increase tokenBalance, totalBought, totalCostSol; recalculate avgBuyPrice
   * - sell: decrease tokenBalance, increase totalSold, totalRevenueSol; calculate realizedPnl
   * - transfer_in:  increase tokenBalance (no cost impact)
   * - transfer_out: decrease tokenBalance (no cost impact)
   * - turnover: no position update (turnover does not change net position)
   *
   * @param currentHolding Current position data
   * @param tx Transaction record
   * @returns Updated position data (new object, original not mutated)
   */
  updateHoldingFromTx(currentHolding: WalletHolding, tx: TransactionRecord): WalletHolding {
    const updated: WalletHolding = { ...currentHolding };

    switch (tx.txType) {
      case 'buy': {
        const boughtTokens = Math.abs(tx.amountToken);
        const costSol = Math.abs(tx.amountSol);

        updated.totalBought += boughtTokens;
        updated.totalCostSol += costSol;
        updated.tokenBalance += boughtTokens;

        // Recalculate average buy price (weighted average)
        if (updated.totalBought > 0) {
          updated.avgBuyPrice = updated.totalCostSol / updated.totalBought;
        }
        break;
      }

      case 'sell': {
        const soldTokens = Math.abs(tx.amountToken);
        const revenueSol = Math.abs(tx.amountSol);

        updated.totalSold += soldTokens;
        updated.totalRevenueSol += revenueSol;
        updated.tokenBalance = Math.max(0, updated.tokenBalance - soldTokens);

        // Calculate realized PnL for this sell
        // realizedPnl += sell revenue - sold quantity * average buy cost
        const soldCost = soldTokens * updated.avgBuyPrice;
        updated.realizedPnl += revenueSol - soldCost;
        break;
      }

      case 'transfer_in': {
        // Transfer in: increase balance, no cost impact
        const transferredIn = Math.abs(tx.amountToken);
        updated.tokenBalance += transferredIn;
        break;
      }

      case 'transfer_out': {
        // Transfer out: decrease balance, no cost impact
        const transferredOut = Math.abs(tx.amountToken);
        updated.tokenBalance = Math.max(0, updated.tokenBalance - transferredOut);
        break;
      }

      case 'turnover': {
        // Turnover: no net position change
        // Turnover is essentially a hedged buy+sell operation; net position remains unchanged
        break;
      }
    }

    return updated;
  }

  /**
   * Create an empty initial holding for the given wallet
   */
  createEmptyHolding(walletAddress: string): WalletHolding {
    return {
      walletAddress,
      tokenBalance: 0,
      avgBuyPrice: 0,
      totalBought: 0,
      totalSold: 0,
      totalCostSol: 0,
      totalRevenueSol: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
    };
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Find the target wallet index in accountKeys.
   * Prioritizes matching the first wallet address (primary wallet).
   */
  private findWalletIndex(accountKeys: string[], wallets: string[]): number {
    // Try exact match starting from the first wallet (primary wallet)
    for (const wallet of wallets) {
      const idx = accountKeys.indexOf(wallet);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  /**
   * Resolve the actual wallet address used.
   * If a matching wallet is found in accountKeys, return that address;
   * otherwise fall back to context.wallets[0].
   */
  private resolveWalletAddress(accountKeys: string[], wallets: string[], walletIndex: number): string {
    if (walletIndex >= 0 && walletIndex < accountKeys.length) {
      return accountKeys[walletIndex];
    }
    return wallets[0] || '';
  }

  /**
   * Calculate Token balance delta.
   *
   * Filters preTokenBalances and postTokenBalances where:
   * - mint === target token contract address
   * - owner is one of the participating wallets
   *
   * Then computes post - pre to get the delta.
   *
   * Note: the owner field in preTokenBalances/postTokenBalances may be absent;
   * in that case, owner is determined via accountIndex -> accountKeys mapping.
   */
  private calculateTokenChange(
    preTokenBalances: any[],
    postTokenBalances: any[],
    tokenMint: string,
    walletAddresses: string[],
    accountKeys: string[],
  ): number {
    const preBalance = this.sumTokenBalance(preTokenBalances, tokenMint, walletAddresses, accountKeys);
    const postBalance = this.sumTokenBalance(postTokenBalances, tokenMint, walletAddresses, accountKeys);
    return postBalance - preBalance;
  }

  /**
   * Sum token balance for the specified token and wallets from the tokenBalances array.
   * Supports direct matching via owner field, or indirect matching via accountIndex -> accountKeys.
   */
  private sumTokenBalance(
    tokenBalances: TokenBalanceEntry[],
    tokenMint: string,
    walletAddresses: string[],
    accountKeys: string[],
  ): number {
    if (!Array.isArray(tokenBalances)) return 0;

    let total = 0;

    for (const entry of tokenBalances) {
      // Only care about the target token
      if (entry.mint !== tokenMint) continue;

      // Determine owner: prefer entry.owner, otherwise look up via accountIndex
      const owner = entry.owner || (entry.accountIndex >= 0 ? accountKeys[entry.accountIndex] : undefined);

      if (!owner) continue;

      // Check if owner is one of the participating wallets
      if (!walletAddresses.includes(owner)) continue;

      // Get uiAmount
      const uiAmount = entry.uiTokenAmount?.uiAmount ?? 0;
      total += uiAmount;
    }

    return total;
  }
}
