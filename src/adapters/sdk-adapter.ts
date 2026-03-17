/**
 * ForgeX CLI SDK Adapter
 *
 * Bridges CLI with frontend sol-sdk, providing a complete transaction execution pipeline.
 * Redirects @/store to CLI shim via tsconfig paths.
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import BigNumber from 'bignumber.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { getConnection } from './connection.js';
import { loadConfig } from '../config.js';
import { getDataSource } from '../data-source.js';
import type { GroupInfo } from '../wallet-store.js';
import { getDecryptedPrivateKey } from '../wallet-store.js';

// ============================================================
// Import local SDK modules (sol-sdk copied to cli/src/sol-sdk/)
// @/store → cli/src/shims/store.ts
// ============================================================

import { batchTrade, pumpBatchTrade, launchlabBatchTrade } from '../sol-sdk/batch/index.js';
import {
  executeSingleTurnover,
  executeBatchTurnover,
} from '../sol-sdk/turnover/index.js';
import type {
  TurnoverTradeParams,
  TurnoverTradeResult,
  BatchTurnoverParams,
} from '../sol-sdk/turnover/index.js';
import {
  transferSOL,
  transferToken,
  transferSOLInstruction,
} from '../sol-sdk/transfer/index.js';
import { getPumpCurveState, getBondingCurvePDA } from '../sol-sdk/pump/index.js';
import { pumpSwapGetPoolInfo, getPumpSwapPoolByMint } from '../sol-sdk/pumpswap/index.js';
import {
  raydiumGetPoolInfo,
  raydiumGetCpmmPoolInfo,
  raydiumGetPoolKeys,
  raydiumGetCpmmKeys,
} from '../sol-sdk/raydium/index.js';
import { getLaunchlabReverseInfo } from '../sol-sdk/launchlab/index.js';
import { getDLMMPoolInfo } from '../sol-sdk/meteora/index.js';
import { getCU, getNativeBalance, getTokenAccountBalance } from '../sol-sdk/rpc/index.js';
import { getJitoAdapter } from '../adapters/jito-adapter.js';
import type { Sniper } from '../sol-sdk/batch/index.js';

// Local VolumeType definition (avoids cross-project enum import issues)
const VolumeType = {
  ONE_BUY_ONE_SELL: 'one_buy_one_sell',
  ONE_BUY_TWO_SELL: 'one_buy_two_sell',
  ONE_BUY_THREE_SELL: 'one_buy_three_sell',
  TWO_BUY_ONE_SELL: 'two_buy_one_sell',
  THREE_BUY_ONE_SELL: 'three_buy_one_sell',
} as const;

// ============================================================
// Type Definitions
// ============================================================

export interface TradeContext {
  connection: Connection;
  tokenAddress: string;
  exchangeName: string;
  poolId: string;
  poolInfo: any;
  decimals: number;
  priceInSol: string;
  priceUsd: number;
  creatorAddress: string;
  pumpfunReverseInfo?: any;
  ammReverseInfo?: any;
  launchlabReverseInfo?: any;
  meteoraDLMMReverseInfo?: any;
  raydiumV4Keys?: any;
  raydiumCpmmKeys?: any;
}

export interface TradeResult {
  success: boolean;
  txHashes?: string[];
  bundleId?: string;
  error?: string;
  details?: any;
  /** Transaction tracking result (3.0h TxTracker integration) */
  tracking?: any;
}

export interface TransferResult {
  success: boolean;
  txHash?: string;
  error?: string;
  from: string;
  to: string;
  amount: number;
  token: string;
}

// ============================================================
// Trade Context Fetching
// ============================================================

/**
 * Fetch trade context (token info, pool data, DEX info, depth data)
 *
 * Data source: DataSource -> CodexAdapter (3.0h migration)
 */
export async function fetchTradeContext(tokenCA: string): Promise<TradeContext> {
  const config = loadConfig();
  const connection = getConnection();
  const ds = getDataSource();

  let exchangeName = '';
  let poolId = '';
  let decimals = 6;
  let creatorAddress = '';
  let poolInfo: any;
  let pumpfunReverseInfo: any;
  let ammReverseInfo: any;
  let launchlabReverseInfo: any;
  let meteoraDLMMReverseInfo: any;
  let raydiumV4Keys: any;
  let raydiumCpmmKeys: any;
  let priceInSol = '0';
  let priceUsd = 0;

  // ── Path A: First try to read Pump.fun data directly from on-chain BondingCurve ──
  // Zero dependency on Codex API, zero latency
  try {
    const bondingCurvePDA = getBondingCurvePDA(new PublicKey(tokenCA));
    // Note: Pass bondingCurvePDA address, not mint address
    const curveState = await getPumpCurveState(connection, bondingCurvePDA.toBase58());

    if (curveState && !curveState.complete) {
      // Use Pump.fun protocol when bonding curve is not complete
      exchangeName = 'Pump';
      poolId = bondingCurvePDA.toBase58();
      decimals = 6; // Pump.fun fixed 6 decimals
      // Anchor fetch returns camelCase fields
      const creator = curveState.creator ?? curveState.creator;
      creatorAddress = creator ? (creator.toBase58?.() ?? String(creator)) : '';
      pumpfunReverseInfo = curveState;

      // Compatible with camelCase (Anchor fetch) and snake_case (raw byte parsing)
      const vSol = Number(curveState.virtualSolReserves ?? curveState.virtual_sol_reserves);
      const vToken = Number(curveState.virtualTokenReserves ?? curveState.virtual_token_reserves);
      priceInSol = new BigNumber(vSol).div(1e9)
        .div(new BigNumber(vToken).div(1e6))
        .toString();

      poolInfo = {
        pairAddress: poolId,
        exchange: { name: 'Pump' },
        tokenA: tokenCA,
        tokenB: NATIVE_MINT.toBase58(),
      };

      // priceUsd fetched asynchronously, does not block transaction
      ds.getTokenPrice(tokenCA).then((p) => { priceUsd = p.priceUsd; }).catch(() => {});
    } else if (curveState && curveState.complete) {
      // Bonding curve completed, token graduated to PumpSwap, compute pool address directly using PDA
      const pumpSwapPoolId = getPumpSwapPoolByMint(tokenCA);
      try {
        const poolData = await pumpSwapGetPoolInfo(connection, pumpSwapPoolId.toBase58());
        exchangeName = 'PumpSwap';
        poolId = pumpSwapPoolId.toBase58();
        decimals = 6;
        const creator = curveState.creator ?? curveState.creator;
        creatorAddress = creator ? (creator.toBase58?.() ?? String(creator)) : '';
        ammReverseInfo = {
          mintA: poolData.mintA,
          mintB: poolData.mintB,
          poolBaseTokenInfo: poolData.poolBaseTokenInfo,
          poolQuoteTokenInfo: poolData.poolQuoteTokenInfo,
          baseTokenProgram: poolData.baseTokenProgram,
          quoteTokenProgram: poolData.quoteTokenProgram,
        };
        poolInfo = {
          pairAddress: poolId,
          exchange: { name: 'PumpSwap' },
          tokenA: tokenCA,
          tokenB: NATIVE_MINT.toBase58(),
        };

        // Use coinCreator instead of bonding curve creator
        creatorAddress = poolData.coinCreator?.toBase58?.() ?? creatorAddress;

        // Compute price from pool reserves
        const baseAmount = new BigNumber(poolData.poolBaseTokenInfo.amount.toString());
        const quoteAmount = new BigNumber(poolData.poolQuoteTokenInfo.amount.toString());
        if (!baseAmount.isZero()) {
          priceInSol = quoteAmount.div(1e9).div(baseAmount.div(1e6)).toString();
        }

        ds.getTokenPrice(tokenCA).then((p) => { priceUsd = p.priceUsd; }).catch(() => {});
      } catch (e: any) {
        // PumpSwap pool fetch failed, fallback to Path B (Codex API)
        console.error(`PumpSwap pool fetch failed, fallback to Codex: ${e.message}`);
      }
    }
  } catch {
    // bondingCurve read failed, not a Pump.fun token, use Codex path
  }

  // ── Path B: Non-Pump.fun or graduated, fetch pair info via Codex ──
  if (!exchangeName) {
    const [tokenInfo, pairs] = await Promise.all([
      ds.getTokenInfo(tokenCA),
      ds.getPairsForToken(tokenCA, 10),
    ]).catch((e) => {
      throw new Error(`Failed to fetch trading pairs (${tokenCA}): ${e.message}`);
    }) as any;

    if (!pairs || pairs.length === 0) {
      throw new Error(`No token trading pairs found: ${tokenCA}`);
    }

    const validExchanges = ['Pump', 'PumpSwap', 'Raydium', 'Raydium CPMM', 'LaunchLab', 'Meteora'];
    const solMint = NATIVE_MINT.toBase58();
    const solPairs = pairs.filter(
      (p: any) =>
        validExchanges.includes(p.exchangeName) &&
        (p.token0Address === solMint || p.token1Address === solMint)
    );

    if (solPairs.length === 0) {
      throw new Error('No valid SOL trading pairs found');
    }

    const topPair = solPairs[0];
    exchangeName = topPair.exchangeName;
    poolId = topPair.pairAddress;
    decimals = tokenInfo.decimals || 6;
    creatorAddress = tokenInfo.creatorAddress || '';
    poolInfo = {
      pairAddress: topPair.pairAddress,
      exchange: { name: exchangeName },
      tokenA: topPair.token0Address,
      tokenB: topPair.token1Address,
    };

    // Fetch depth data
    try {
      if (exchangeName === 'Pump') {
        pumpfunReverseInfo = await getPumpCurveState(connection, tokenCA);
      } else if (exchangeName === 'PumpSwap') {
        const poolData = await pumpSwapGetPoolInfo(connection, poolId);
        ammReverseInfo = {
          mintA: poolData.mintA,
          mintB: poolData.mintB,
          poolBaseTokenInfo: poolData.poolBaseTokenInfo,
          poolQuoteTokenInfo: poolData.poolQuoteTokenInfo,
          baseTokenProgram: poolData.baseTokenProgram,
          quoteTokenProgram: poolData.quoteTokenProgram,
        };
        // Use coinCreator from pool
        if (poolData.coinCreator) {
          creatorAddress = poolData.coinCreator.toBase58?.() ?? String(poolData.coinCreator);
        }
      } else if (exchangeName === 'Raydium') {
        const poolData = await raydiumGetPoolInfo(connection, poolId);
        ammReverseInfo = {
          mintA: '',
          mintB: '',
          poolBaseTokenInfo: poolData.poolBaseTokenInfo,
          poolQuoteTokenInfo: poolData.poolQuoteTokenInfo,
        };
        const keysData = await raydiumGetPoolKeys(connection, poolId);
        raydiumV4Keys = keysData.poolKeys;
      } else if (exchangeName === 'Raydium CPMM') {
        const poolData = await raydiumGetCpmmPoolInfo(connection, poolId);
        ammReverseInfo = {
          mintA: '',
          mintB: '',
          poolBaseTokenInfo: poolData.poolBaseTokenInfo,
          poolQuoteTokenInfo: poolData.poolQuoteTokenInfo,
        };
        const keysData = await raydiumGetCpmmKeys(connection, poolId);
        raydiumCpmmKeys = keysData.poolKeys;
      } else if (exchangeName === 'LaunchLab') {
        launchlabReverseInfo = await getLaunchlabReverseInfo({ connection, poolId });
      } else if (exchangeName === 'Meteora') {
        const dlmmInfo = await getDLMMPoolInfo({ connection, poolId });
        meteoraDLMMReverseInfo = {
          mintA: dlmmInfo.token_x_mint,
          mintB: dlmmInfo.token_y_mint,
          reserveX: dlmmInfo.reserve_x,
          reserveY: dlmmInfo.reserve_y,
          oracle: dlmmInfo.oracle,
          binStep: dlmmInfo.bin_step,
          activeId: dlmmInfo.active_id,
        };
      }
    } catch (e: any) {
      console.error(`Failed to fetch ${exchangeName} depth data:`, e.message);
    }

    // Price (Pump.fun computed in Path A, here handles other DEXes)
    if (exchangeName === 'Pump' && pumpfunReverseInfo) {
      const vSol = Number(pumpfunReverseInfo.virtualSolReserves ?? pumpfunReverseInfo.virtual_sol_reserves);
      const vToken = Number(pumpfunReverseInfo.virtualTokenReserves ?? pumpfunReverseInfo.virtual_token_reserves);
      priceInSol = new BigNumber(vSol).div(1e9)
        .div(new BigNumber(vToken).div(1e6))
        .toString();
      ds.getTokenPrice(tokenCA).then((p) => { priceUsd = p.priceUsd; }).catch(() => {});
    } else {
      try {
        const priceData = await ds.getTokenPrice(tokenCA);
        priceInSol = String(priceData.priceSol);
        priceUsd = priceData.priceUsd;
      } catch {
        // Price fetch failure does not block transaction
      }
    }
  }

  return {
    connection,
    tokenAddress: tokenCA,
    exchangeName,
    poolId,
    poolInfo,
    decimals,
    priceInSol,
    priceUsd,
    creatorAddress,
    pumpfunReverseInfo,
    ammReverseInfo,
    launchlabReverseInfo,
    meteoraDLMMReverseInfo,
    raydiumV4Keys,
    raydiumCpmmKeys,
  };
}

// ============================================================
// Trade Execution
// ============================================================

/**
 * Execute batch buy/sell trade
 */
export async function executeTrades(params: {
  context: TradeContext;
  wallets: { privateKey: string; address: string }[];
  tradeType: 'buy' | 'sell' | 'sniperBuy' | 'buyWithSell';
  amountPerWallet: string | string[];
  slippage: number;
  priorityFee: number;
  volumeType?: string;
  simulate?: boolean;
}): Promise<TradeResult> {
  const { context, wallets, tradeType, amountPerWallet, slippage, priorityFee, simulate } = params;

  try {
    // Build walletAmounts
    const walletAmounts = wallets.map((w, i) => ({
      privateKey: w.privateKey,
      amount: Array.isArray(amountPerWallet)
        ? amountPerWallet[i]
        : amountPerWallet,
    }));

    // Map volumeType
    const volumeTypeMap: Record<string, string> = {
      '1b1s': 'one_buy_one_sell',
      '1b2s': 'one_buy_two_sell',
      '1b3s': 'one_buy_three_sell',
      '2b1s': 'two_buy_one_sell',
      '3b1s': 'three_buy_one_sell',
    };
    const volumeType = params.volumeType
      ? (volumeTypeMap[params.volumeType] || params.volumeType)
      : VolumeType.ONE_BUY_ONE_SELL;

    // Bug 3 fix: For Pump/LaunchLab sniperBuy, directly call sub-function with snipers param
    // Top-level batchTrade does not accept snipers, but Pump/LaunchLab sniperBuy branch requires it
    let base64Txs: string[] | undefined;

    if (tradeType === 'sniperBuy' && (context.exchangeName === 'Pump' || context.exchangeName === 'LaunchLab')) {
      const snipers: Sniper[] = walletAmounts.map(wa => ({
        wallet: wa.privateKey,
        amount: wa.amount,
      }));

      // Preprocess slippage (batchTrade divides by 100 internally, do same here)
      const adjustedSlippage = slippage / 100;

      if (context.exchangeName === 'Pump') {
        base64Txs = await pumpBatchTrade({
          connection: context.connection,
          walletAmounts,
          snipers,
          tokenAddress: context.tokenAddress,
          poolId: context.poolId,
          tradeType: 'buy',
          slippage: adjustedSlippage,
          priorityFee,
          priceInSol: context.priceInSol,
          initialPoolData: context.pumpfunReverseInfo,
          creator: new PublicKey(context.creatorAddress),
          volumeType: volumeType as any,
          simulate: simulate || false,
        });
      } else {
        base64Txs = await launchlabBatchTrade({
          connection: context.connection,
          walletAmounts,
          snipers,
          tokenAddress: context.tokenAddress,
          poolId: context.poolId,
          tradeType: 'sniperBuy',
          slippage: adjustedSlippage,
          priorityFee,
          decimals: context.decimals,
          reverseInfo: context.launchlabReverseInfo,
          creator: new PublicKey(context.creatorAddress),
          volumeType: volumeType as any,
          simulate: simulate || false,
        });
      }
    } else {
      // Other DEX / trade types use standard batchTrade path
      base64Txs = await batchTrade({
        connection: context.connection,
        exchangeName: context.exchangeName,
        tokenAddress: context.tokenAddress,
        poolId: context.poolId,
        tradeType,
        slippage,
        priorityFee,
        priceInSol: context.priceInSol,
        decimals: context.decimals,
        poolInfo: context.poolInfo,
        ammReverseInfo: context.ammReverseInfo,
        pumpfunReverseInfo: context.pumpfunReverseInfo,
        launchlabReverseInfo: context.launchlabReverseInfo,
        meteoraDLMMReverseInfo: context.meteoraDLMMReverseInfo,
        creatorAddress: context.creatorAddress,
        walletAmounts,
        raydiumV4Keys: context.raydiumV4Keys,
        raydiumCpmmKeys: context.raydiumCpmmKeys,
        volumeType: volumeType as any,
        simulate: simulate || false,
      });
    }

    if (!base64Txs || base64Txs.length === 0) {
      return { success: false, error: 'Trade build failed, no valid transactions generated' };
    }

    if (simulate) {
      return {
        success: true,
        details: {
          simulate: true,
          transactionCount: base64Txs.length,
          message: 'Simulation successful, transaction is feasible',
        },
      };
    }

    // Send transaction
    const ds = getDataSource();
    const connection = context.connection;

    try {
      // buyWithSell (volume trading) requires same-block execution, use Jito Bundle
      if (tradeType === 'buyWithSell' && base64Txs.length > 1) {
        const bundleResult = await ds.sendBundle(base64Txs);
        return {
          success: true,
          bundleId: bundleResult.bundleId,
          txHashes: [],
        };
      }

      // Regular buy/sell -- send one by one (no waiting for confirmation, return txHash directly)
      const txResults: { txHash: string; success: boolean; error?: string }[] = [];
      for (const base64Tx of base64Txs) {
        const result = await ds.sendTransaction(base64Tx);
        txResults.push({ txHash: result.txHash, success: true });
      }
      return {
        success: true,
        txHashes: txResults.map(r => r.txHash),
        details: txResults,
      };
    } catch (sendError: any) {
      const jitoResponseData = sendError?.response?.data;
      return {
        success: false,
        error: `Transaction send failed: ${sendError.message}`,
        details: jitoResponseData ? JSON.stringify(jitoResponseData) : sendError.message,
      };
    }
  } catch (e: any) {
    return {
      success: false,
      error: e.message || 'Transaction execution failed',
    };
  }
}

// ============================================================
// Turnover Trade Execution
// ============================================================

/**
 * Execute turnover trade
 */
export async function executeTurnoverTrade(params: {
  context: TradeContext;
  fromWallet: string;
  toWallet: string;
  tokenAmount: number;
  priorityFee: number;
  slippage?: number;
  fallbackSendTx?: boolean;
}): Promise<TurnoverTradeResult> {
  const { context, fromWallet, toWallet, tokenAmount, priorityFee, slippage, fallbackSendTx } = params;
  const config = loadConfig();

  return executeSingleTurnover({
    connection: context.connection,
    fromWallet,
    toWallet,
    tokenAddress: context.tokenAddress,
    tokenAmount,
    decimals: context.decimals,
    exchangeName: context.exchangeName,
    poolInfo: context.poolInfo,
    priceInSol: Number(context.priceInSol),
    creatorAddress: context.creatorAddress,
    priorityFee,
    slippage: slippage || 1,
    fallbackSendTx: fallbackSendTx || false,
    pumpfunReverseInfo: context.pumpfunReverseInfo,
    ammReverseInfo: context.ammReverseInfo,
    raydiumV4Keys: context.raydiumV4Keys,
    raydiumCpmmKeys: context.raydiumCpmmKeys,
    launchlabReverseInfo: context.launchlabReverseInfo,
    meteoraDLMMReverseInfo: context.meteoraDLMMReverseInfo,
  });
}

/**
 * Execute batch turnover trade
 */
export async function executeBatchTurnoverTrade(params: {
  context: TradeContext;
  turnoverItems: { fromWallet: string; toWallet: string; tokenAmount: number }[];
  priorityFee: number;
  slippage?: number;
  fallbackSendTx?: boolean;
  intervalMs?: number;
}): Promise<TurnoverTradeResult[]> {
  const { context, turnoverItems, priorityFee, slippage, fallbackSendTx, intervalMs } = params;
  const config = loadConfig();

  return executeBatchTurnover({
    connection: context.connection,
    turnoverItems,
    tokenAddress: context.tokenAddress,
    decimals: context.decimals,
    exchangeName: context.exchangeName,
    poolInfo: context.poolInfo,
    priceInSol: Number(context.priceInSol),
    creatorAddress: context.creatorAddress,
    priorityFee,
    slippage: slippage || 1,
    fallbackSendTx: fallbackSendTx || false,
    intervalMs: intervalMs || 1000,
    pumpfunReverseInfo: context.pumpfunReverseInfo,
    ammReverseInfo: context.ammReverseInfo,
    raydiumV4Keys: context.raydiumV4Keys,
    raydiumCpmmKeys: context.raydiumCpmmKeys,
    launchlabReverseInfo: context.launchlabReverseInfo,
    meteoraDLMMReverseInfo: context.meteoraDLMMReverseInfo,
  });
}

// ============================================================
// SOL / Token Transfer Execution
// ============================================================

/**
 * Execute SOL transfer
 */
export async function executeSOLTransfer(params: {
  fromPrivateKey: string;
  toAddress: string;
  amountSOL: number;
  priorityFee: number;
}): Promise<TransferResult> {
  const { fromPrivateKey, toAddress, amountSOL, priorityFee } = params;
  const connection = getConnection();

  try {
    const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromPrivateKey));
    const fromAddress = fromKeypair.publicKey.toBase58();
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

    // Build transaction
    const tx = new Transaction();
    const { limitIx, priceIx } = getCU(priorityFee);
    tx.add(limitIx);
    tx.add(priceIx);
    tx.add(transferSOLInstruction(fromKeypair.publicKey, toPubkey, lamports));

    // Jito tip
    const jitoAdapter = getJitoAdapter();
    tx.add(jitoAdapter.getTipInstruction(fromKeypair.publicKey, priorityFee));

    const blockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromKeypair.publicKey;
    tx.sign(fromKeypair);

    const base64Tx = Buffer.from(tx.serialize()).toString('base64');

    // Send transaction -- via DataSource -> JitoAdapter.sendTransaction
    const ds = getDataSource();
    const txResult = await ds.sendTransaction(base64Tx);

    return {
      success: true,
      txHash: txResult.txHash,
      from: fromAddress,
      to: toAddress,
      amount: amountSOL,
      token: 'SOL',
    };
  } catch (e: any) {
    return {
      success: false,
      error: e.message,
      from: '',
      to: toAddress,
      amount: amountSOL,
      token: 'SOL',
    };
  }
}

/**
 * SOL multi-hop transfer (via 6 temporary relay wallets, chain transfer in a single transaction)
 *
 * Transfer path: sender wallet → G1 → G2 → G3 → G4 → G5 → G6 → receiver wallet
 * All relay wallets are temporarily generated and discarded after use.
 */
export async function executeSOLTransferMultiHop(params: {
  fromPrivateKey: string;
  toAddress: string;
  amountSOL: number;
  priorityFee: number;
  hopCount?: number;
}): Promise<TransferResult> {
  const { fromPrivateKey, toAddress, amountSOL, priorityFee, hopCount = 6 } = params;
  const connection = getConnection();

  try {
    const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromPrivateKey));
    const fromAddress = fromKeypair.publicKey.toBase58();
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

    // Generate temporary relay wallets
    const relayWallets: Keypair[] = [];
    for (let i = 0; i < hopCount; i++) {
      relayWallets.push(Keypair.generate());
    }

    // Build transaction
    const tx = new Transaction();
    const { limitIx, priceIx } = getCU(priorityFee);
    tx.add(limitIx);
    tx.add(priceIx);

    // Build transfer chain: sender wallet → G1 → G2 → ... → G6 → receiver wallet
    const transferChain = [
      fromKeypair.publicKey,
      ...relayWallets.map(kp => kp.publicKey),
      toPubkey,
    ];

    for (let i = 0; i < transferChain.length - 1; i++) {
      tx.add(transferSOLInstruction(transferChain[i], transferChain[i + 1], lamports));
    }

    // Jito tip
    const jitoAdapter = getJitoAdapter();
    tx.add(jitoAdapter.getTipInstruction(fromKeypair.publicKey, priorityFee));

    const blockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromKeypair.publicKey;

    // Sign: sender wallet + all relay wallets
    tx.sign(fromKeypair, ...relayWallets);

    const base64Tx = Buffer.from(tx.serialize()).toString('base64');

    // Send transaction
    const ds = getDataSource();
    const txResult = await ds.sendTransaction(base64Tx);

    return {
      success: true,
      txHash: txResult.txHash,
      from: fromAddress,
      to: toAddress,
      amount: amountSOL,
      token: 'SOL',
    };
  } catch (e: any) {
    return {
      success: false,
      error: e.message,
      from: '',
      to: toAddress,
      amount: amountSOL,
      token: 'SOL',
    };
  }
}

/**
 * Batch SOL transfer (one-to-many)
 * Non-multi-hop mode: pack multiple transfer instructions into one transaction (max 20 per batch)
 * Multi-hop mode: send multi-hop transaction independently for each target
 */
export async function executeBatchSOLTransfer(params: {
  fromPrivateKey: string;
  targets: { address: string; amountSOL: number }[];
  priorityFee: number;
  batchSize?: number;
  multiHop?: boolean;
  hopCount?: number;
}): Promise<TransferResult[]> {
  const { fromPrivateKey, targets, priorityFee, batchSize = 20, multiHop = false, hopCount = 6 } = params;
  const results: TransferResult[] = [];

  if (multiHop) {
    // Multi-hop mode: send independently for each target (each requires relay wallet signatures)
    for (const target of targets) {
      const result = await executeSOLTransferMultiHop({
        fromPrivateKey,
        toAddress: target.address,
        amountSOL: target.amountSOL,
        priorityFee,
        hopCount,
      });
      results.push(result);
    }
    return results;
  }

  // Non-multi-hop mode: pack into same transaction
  const connection = getConnection();
  const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromPrivateKey));
  const fromAddress = fromKeypair.publicKey.toBase58();

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);

    try {
      const tx = new Transaction();
      const { limitIx, priceIx } = getCU(priorityFee);
      tx.add(limitIx);
      tx.add(priceIx);

      // Pack all transfer instructions in this batch into one transaction
      for (const target of batch) {
        const lamports = Math.floor(target.amountSOL * LAMPORTS_PER_SOL);
        tx.add(transferSOLInstruction(fromKeypair.publicKey, new PublicKey(target.address), lamports));
      }

      // Jito tip
      const jitoAdapter = getJitoAdapter();
      tx.add(jitoAdapter.getTipInstruction(fromKeypair.publicKey, priorityFee));

      const blockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.recentBlockhash = blockhash;
      tx.feePayer = fromKeypair.publicKey;
      tx.sign(fromKeypair);

      const base64Tx = Buffer.from(tx.serialize()).toString('base64');

      const ds = getDataSource();
      const txResult = await ds.sendTransaction(base64Tx);

      // Generate results for all targets in this batch
      for (const target of batch) {
        results.push({
          success: true,
          txHash: txResult.txHash,
          from: fromAddress,
          to: target.address,
          amount: target.amountSOL,
          token: 'SOL',
        });
      }
    } catch (e: any) {
      // Entire batch failed
      for (const target of batch) {
        results.push({
          success: false,
          error: e.message,
          from: fromAddress,
          to: target.address,
          amount: target.amountSOL,
          token: 'SOL',
        });
      }
    }

    // Wait between batches
    if (i + batchSize < targets.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

/**
 * Batch SOL collection (many-to-one)
 */
export async function executeCollectSOL(params: {
  wallets: { privateKey: string; address: string }[];
  toAddress: string;
  amountType: 'all' | 'fixed' | 'reserve';
  fixedAmount?: number;
  reserveAmount?: number;
  priorityFee: number;
}): Promise<TransferResult[]> {
  const { wallets, toAddress, amountType, fixedAmount, reserveAmount, priorityFee } = params;
  const connection = getConnection();
  const results: TransferResult[] = [];

  for (const wallet of wallets) {
    try {
      const balance = await connection.getBalance(new PublicKey(wallet.address));
      const balanceSOL = balance / LAMPORTS_PER_SOL;

      let amountSOL: number;
      if (amountType === 'all') {
        // Reserve enough for fees
        amountSOL = Math.max(0, balanceSOL - 0.005 - priorityFee);
      } else if (amountType === 'fixed') {
        amountSOL = Math.min(fixedAmount || 0, balanceSOL - 0.005);
      } else if (amountType === 'reserve') {
        amountSOL = Math.max(0, balanceSOL - (reserveAmount || 0) - 0.005);
      } else {
        amountSOL = 0;
      }

      if (amountSOL <= 0) {
        results.push({
          success: false,
          error: 'Insufficient balance',
          from: wallet.address,
          to: toAddress,
          amount: 0,
          token: 'SOL',
        });
        continue;
      }

      const result = await executeSOLTransfer({
        fromPrivateKey: wallet.privateKey,
        toAddress,
        amountSOL,
        priorityFee,
      });
      results.push(result);
    } catch (e: any) {
      results.push({
        success: false,
        error: e.message,
        from: wallet.address,
        to: toAddress,
        amount: 0,
        token: 'SOL',
      });
    }
  }

  return results;
}

// ============================================================
// Balance Queries
// ============================================================

/**
 * Get wallet SOL balance
 */
export async function getSOLBalance(address: string): Promise<number> {
  const connection = getConnection();
  return getNativeBalance(connection, address);
}

/**
 * Get wallet token balance
 */
export async function getTokenBalance(address: string, tokenMint: string): Promise<number> {
  const connection = getConnection();
  return getTokenAccountBalance(connection, tokenMint, address);
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Build wallet list from wallet group
 */
export function buildWalletList(group: GroupInfo): { privateKey: string; address: string }[] {
  return group.wallets.map(w => ({
    privateKey: getDecryptedPrivateKey(w),
    address: w.walletAddress,
  }));
}

/**
 * Wait for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
