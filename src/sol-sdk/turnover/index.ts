import { AnchorProvider } from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { pumpBuySPLInstructions, pumpSellSPLInstructions, getPumpCurveState } from '../pump';
import {
  raydiumBuyInstruction,
  raydiumSellInstruction,
  raydiumGetPoolInfo,
  raydiumGetCpmmPoolInfo,
  raydiumCpmmSwapBaseOutBuyInstruction,
  raydiumCpmmSellInstruction,
  raydiumBuyExactOutInstruction,
} from '../raydium';
import { pumpSwapBuyInstruction, pumpSwapSellInstruction, pumpSwapGetPoolInfo, getInitUserVolumeAccumulatorIxIfNeeded } from '../pumpswap';
import {
  getLaunchlabReverseInfo,
  launchlabBuyExactOutInstruction,
  launchlabSellExactInInstruction,
} from '../launchlab';
import { meteoraDlmmBuyExactOutInstructions, meteoraDlmmSellInstructions } from '../meteora';
import AmmCalc, { PumpAmmCalc, LaunchlabAmmCalc } from '../calc';
import type { AmmV4Keys, CpmmKeys } from '@raydium-io/raydium-sdk-v2';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import BigNumber from 'bignumber.js';
import { getCU } from '../rpc';
import { getWalletKeypair } from '@/utils';
import { getJitoAdapter } from '@/adapters/jito-adapter.js';
// @meteora-ag/dlmm is an optional peer dependency — loaded lazily
type MeteoraDLMMType = typeof import('@meteora-ag/dlmm').default;
let _MeteoraDLMM: MeteoraDLMMType | null = null;
async function getMeteoraDLMM(): Promise<MeteoraDLMMType> {
  if (!_MeteoraDLMM) {
    try {
      const mod = await import('@meteora-ag/dlmm');
      _MeteoraDLMM = mod.default;
    } catch {
      throw new Error(
        '@meteora-ag/dlmm is not installed. Please run: npm install @meteora-ag/dlmm'
      );
    }
  }
  return _MeteoraDLMM;
}
import { getBinArray } from '../meteora';

// Turnover trade parameters
export interface TurnoverTradeParams {
  connection: Connection;
  fromWallet: string; // Sender wallet (sell side)
  toWallet: string; // Receiver wallet (buy side)
  tokenAddress: string; // Token address
  tokenAmount: number; // Token amount
  decimals: number; // Token decimals
  exchangeName: string; // DEX name: 'Pump', 'PumpSwap', 'Raydium', 'Raydium CPMM'
  poolInfo: {
    exchange: { name: string };
    pairAddress: string;
    tokenA?: string;
    tokenB?: string;
  };
  priceInSol: number; // Token price in SOL
  creatorAddress: string; // Creator address
  priorityFee: number; // Priority fee
  slippage?: number; // Slippage, default 1%
  fallbackSendTx?: boolean; // Whether to fall back to sendTransaction when Bundle fails
  // DEX-specific parameters
  pumpfunReverseInfo?: PumpfunReverseInfo;
  ammReverseInfo?: AmmReverseInfo;
  raydiumV4Keys?: AmmV4Keys;
  raydiumCpmmKeys?: CpmmKeys;
  pumpswapReverseInfo?: AmmReverseInfo;
  launchlabReverseInfo?: LaunchlabReverseInfo;
  meteoraDLMMReverseInfo?: MeteoraDLMMReverseInfo;
}

// Turnover trade result
export interface TurnoverTradeResult {
  success: boolean;
  bundleId?: string;
  buyTxHash?: string;
  sellTxHash?: string;
  error?: string;
}

// Batch turnover parameters
export interface BatchTurnoverParams {
  connection: Connection;
  turnoverItems: {
    fromWallet: string;
    toWallet: string;
    tokenAmount: number;
  }[];
  tokenAddress: string;
  decimals: number;
  exchangeName: string; // DEX name
  poolInfo: {
    exchange: { name: string };
    pairAddress: string;
    tokenA?: string;
    tokenB?: string;
  };
  priceInSol: number;
  creatorAddress: string;
  priorityFee: number;
  slippage?: number;
  fallbackSendTx?: boolean; // Whether to fall back to sendTransaction when Bundle fails
  intervalMs?: number; // Trade interval, default 1000ms
  // DEX-specific parameters
  pumpfunReverseInfo?: PumpfunReverseInfo;
  ammReverseInfo?: AmmReverseInfo;
  raydiumV4Keys?: AmmV4Keys;
  raydiumCpmmKeys?: CpmmKeys;
  launchlabReverseInfo?: LaunchlabReverseInfo;
  meteoraDLMMReverseInfo?: MeteoraDLMMReverseInfo;
}

/**
 * Execute a single turnover trade (bundled buy + sell transaction)
 */
export const executeSingleTurnover = async (
  params: TurnoverTradeParams
): Promise<TurnoverTradeResult> => {
  const {
    connection,
    fromWallet,
    toWallet,
    tokenAddress,
    tokenAmount,
    decimals,
    exchangeName,
    poolInfo,
    priceInSol,
    creatorAddress,
    priorityFee,
    slippage = 1,
    fallbackSendTx = false,
    pumpfunReverseInfo,
    ammReverseInfo,
    raydiumV4Keys,
    raydiumCpmmKeys,
    pumpswapReverseInfo,
    launchlabReverseInfo,
    meteoraDLMMReverseInfo,
  } = params;

  try {
    const jitoAdapter = getJitoAdapter();
    const blockhash = (await connection.getLatestBlockhash()).blockhash;

    const fromKeypair = getWalletKeypair(fromWallet);
    const toKeypair = getWalletKeypair(toWallet);

    let binArray = [];
    if (meteoraDLMMReverseInfo) {
      binArray = await getBinArray({
        connection,
        poolId: poolInfo.pairAddress,
      });
    }

    // 1. Build buy transaction (receiver wallet buys tokens)
    const buyTx = await buildBuyTransaction({
      connection,
      buyerKeypair: toKeypair,
      tokenAddress,
      tokenAmount,
      decimals,
      exchangeName,
      poolInfo,
      priceInSol,
      creatorAddress,
      priorityFee,
      slippage,
      blockhash,
      pumpfunReverseInfo,
      ammReverseInfo,
      raydiumV4Keys,
      raydiumCpmmKeys,
      pumpswapReverseInfo,
      launchlabReverseInfo,
      meteoraDLMMReverseInfo,
      binArray,
    });

    // 2. Build sell transaction (sender wallet sells tokens)
    const sellTx = await buildSellTransaction({
      connection,
      sellerKeypair: fromKeypair,
      tokenAddress,
      tokenAmount,
      decimals,
      exchangeName,
      poolInfo,
      priceInSol,
      creatorAddress,
      priorityFee,
      slippage,
      blockhash,
      pumpfunReverseInfo,
      ammReverseInfo,
      raydiumV4Keys,
      raydiumCpmmKeys,
      pumpswapReverseInfo,
      launchlabReverseInfo,
      meteoraDLMMReverseInfo,
      binArray,
    });
    const tipTx = jitoAdapter.getTipInstruction(fromKeypair.publicKey, priorityFee);
    sellTx.add(tipTx);

    buyTx.sign(toKeypair);
    sellTx.sign(fromKeypair);

    // Extract transaction signatures (for result display and RPC confirmation)
    const buyTxSig = bs58.encode(buyTx.signature!);
    const sellTxSig = bs58.encode(sellTx.signature!);

    const simulation1 = await connection.simulateTransaction(buyTx);
    console.log('simulation1', JSON.stringify(simulation1.value.err), simulation1.value.logs?.slice(-3));
    if (simulation1.value.err) {
      return {
        success: false,
        error: `Buy transaction simulation failed: ${JSON.stringify(simulation1.value.err)} | ${simulation1.value.logs?.slice(-3)?.join(' | ')}`,
      };
    }
    const simulation2 = await connection.simulateTransaction(sellTx);
    console.log('simulation2', JSON.stringify(simulation2.value.err), simulation2.value.logs?.slice(-3));
    if (simulation2.value.err) {
      return {
        success: false,
        error: `Sell transaction simulation failed: ${JSON.stringify(simulation2.value.err)} | ${simulation2.value.logs?.slice(-3)?.join(' | ')}`,
      };
    }

    // 3. Merge buy + sell instructions into a single transaction (same signature / same block)
    const combinedTx = new Transaction();
    combinedTx.recentBlockhash = blockhash;
    combinedTx.feePayer = fromKeypair.publicKey;

    // Order must be buy first then sell; filter duplicate ComputeBudget instructions during merge
    const seenComputeBudgetTypes = new Set<number>();
    const appendInstruction = (ix: TransactionInstruction) => {
      if (ix.programId.equals(ComputeBudgetProgram.programId)) {
        const type = ix.data?.[0];
        if (typeof type === 'number') {
          if (seenComputeBudgetTypes.has(type)) return;
          seenComputeBudgetTypes.add(type);
        }
      }
      combinedTx.add(ix);
    };

    for (const ix of buyTx.instructions) appendInstruction(ix);
    for (const ix of sellTx.instructions) appendInstruction(ix);

    // Both wallets need to sign
    combinedTx.sign(toKeypair, fromKeypair);

    const simCombined = await connection.simulateTransaction(combinedTx);
    if (simCombined.value.err) {
      return {
        success: false,
        error: `Combined transaction simulation failed: ${JSON.stringify(simCombined.value.err)} | ${simCombined.value.logs?.slice(-3)?.join(' | ')}`,
      };
    }

    const combinedTxBase64 = Buffer.from(combinedTx.serialize()).toString('base64');
    const sendResult = await jitoAdapter.sendTransaction(combinedTxBase64);
    console.log(`[Turnover] Combined transaction sent, txHash: ${sendResult.txHash}`);

    const confirm = await jitoAdapter.confirmTransactionByRpc(connection, sendResult.txHash, 90000);

    return {
      success: confirm.success,
      bundleId: undefined,
      buyTxHash: sendResult.txHash,
      sellTxHash: sendResult.txHash,
      error: confirm.success ? undefined : `Combined transaction not confirmed: ${confirm.error}`,
    };
  } catch (error) {
    console.error('Turnover trade execution failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Execute batch turnover trades
 */
export const executeBatchTurnover = async (
  params: BatchTurnoverParams
): Promise<TurnoverTradeResult[]> => {
  const { turnoverItems, intervalMs = 1000 } = params;
  const results: TurnoverTradeResult[] = [];

  for (let i = 0; i < turnoverItems.length; i++) {
    const item = turnoverItems[i];

    const result = await executeSingleTurnover({
      ...params,
      fromWallet: item.fromWallet,
      toWallet: item.toWallet,
      tokenAmount: item.tokenAmount,
    });

    results.push(result);

    // Add trade interval (no interval needed after last trade)
    if (i < turnoverItems.length - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  return results;
};

/**
 * Build buy transaction
 */
async function buildBuyTransaction(params: {
  connection: Connection;
  buyerKeypair: Keypair;
  tokenAddress: string;
  tokenAmount: number;
  decimals: number;
  exchangeName: string;
  poolInfo: { exchange: { name: string }; pairAddress: string; tokenA?: string; tokenB?: string };
  priceInSol: number;
  creatorAddress: string;
  priorityFee: number;
  slippage: number;
  blockhash: string;
  pumpfunReverseInfo?: PumpfunReverseInfo;
  ammReverseInfo?: AmmReverseInfo;
  raydiumV4Keys?: AmmV4Keys;
  raydiumCpmmKeys?: CpmmKeys;
  pumpswapReverseInfo?: AmmReverseInfo;
  launchlabReverseInfo?: LaunchlabReverseInfo;
  meteoraDLMMReverseInfo?: MeteoraDLMMReverseInfo;
  binArray?: any[];
}): Promise<Transaction> {
  const {
    connection,
    buyerKeypair,
    tokenAddress,
    tokenAmount,
    decimals,
    exchangeName,
    poolInfo,
    priceInSol,
    creatorAddress,
    priorityFee,
    slippage,
    blockhash,
    pumpfunReverseInfo,
    ammReverseInfo,
    raydiumV4Keys,
    raydiumCpmmKeys,
    pumpswapReverseInfo,
    launchlabReverseInfo,
    meteoraDLMMReverseInfo,
    binArray,
  } = params;

  const buyTx = new Transaction();
  buyTx.recentBlockhash = blockhash;
  const provider = new AnchorProvider(connection as any, {
    publicKey: buyerKeypair.publicKey,
    signTransaction: async () => {
      throw new Error('Signing not supported');
    },
    signAllTransactions: async () => {
      throw new Error('Signing not supported');
    },
  });

  if (exchangeName === 'Pump') {
    // Pump.fun buy
    const solAmount = new BigNumber(tokenAmount)
      .times(priceInSol)
      .times(LAMPORTS_PER_SOL)
      .toFixed(0);
    console.log('solAmount', solAmount);
    console.log('tokenAmount', tokenAmount);
    const [_, buyInstruction] = await pumpBuySPLInstructions(
      provider,
      buyerKeypair.publicKey,
      tokenAddress,
      solAmount,
      slippage,
      priceInSol.toString(),
      new PublicKey(creatorAddress),
      new BigNumber(tokenAmount).times(10 ** decimals).toFixed(0)
    );
    buyTx.add(buyInstruction);
  } else if (exchangeName === 'PumpSwap') {
    // PumpSwap buy
    let info = ammReverseInfo;
    if (!info) {
      const rawInfo = await pumpSwapGetPoolInfo(connection, poolInfo.pairAddress);
      info = {
        mintA: rawInfo.mintA,
        mintB: rawInfo.mintB,
        poolBaseTokenInfo: { amount: rawInfo.poolBaseTokenInfo.amount.toString() },
        poolQuoteTokenInfo: { amount: rawInfo.poolQuoteTokenInfo.amount.toString() },
        baseTokenProgram: rawInfo.baseTokenProgram,
        quoteTokenProgram: rawInfo.quoteTokenProgram,
      };
    }

    const mintA = new PublicKey(info.mintA);
    const mintB = new PublicKey(info.mintB);

    const solAmount = new BigNumber(tokenAmount)
      .times(priceInSol)
      .times(LAMPORTS_PER_SOL)
      .toFixed(0);

    const buyInstruction = await pumpSwapBuyInstruction({
      owner: buyerKeypair,
      poolInfo: {
        poolId: poolInfo.pairAddress,
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        baseTokenProgram: info.baseTokenProgram,
        quoteTokenProgram: info.quoteTokenProgram,
      },
      wsolAmount: new BN(solAmount),
      tokenAmount: new BN(new BigNumber(tokenAmount).times(10 ** decimals).toFixed(0)),
      slippage,
      creator: new PublicKey(creatorAddress),
    });
    // Check if buyer wallet needs user_volume_accumulator initialization
    const initVolumeIx = await getInitUserVolumeAccumulatorIxIfNeeded(
      connection,
      buyerKeypair.publicKey,
      buyerKeypair.publicKey,
    );
    if (initVolumeIx) {
      buyTx.add(initVolumeIx);
    }
    buyTx.add(buyInstruction);
  } else if (exchangeName === 'Raydium') {
    // Raydium V4 buy
    if (!raydiumV4Keys) {
      throw new Error('Raydium V4 Keys not provided');
    }

    let info = ammReverseInfo;
    let raydiumPoolInfo: any;
    if (!info) {
      raydiumPoolInfo = await raydiumGetPoolInfo(connection, poolInfo.pairAddress);
      info = {
        mintA: poolInfo.tokenA!,
        mintB: poolInfo.tokenB!,
        poolBaseTokenInfo: { amount: raydiumPoolInfo.poolBaseTokenInfo.amount.toString() },
        poolQuoteTokenInfo: { amount: raydiumPoolInfo.poolQuoteTokenInfo.amount.toString() },
      };
    }

    const mintA = new PublicKey(info.mintA);
    const mintB = new PublicKey(info.mintB);

    const solAmount = new BigNumber(tokenAmount)
      .times(priceInSol)
      .times(LAMPORTS_PER_SOL)
      .toFixed(0);

    const buyInstruction = await raydiumBuyExactOutInstruction({
      tokenAmount: new BigNumber(tokenAmount).times(10 ** decimals).toFixed(0),
      owner: buyerKeypair.publicKey,
      poolKeys: raydiumV4Keys,
      mintA: mintA.toBase58(),
      mintB: mintB.toBase58(),
      maxAmountIn: new BigNumber(solAmount).times(1 + slippage).toFixed(0),
    });
    buyTx.add(buyInstruction);
  } else if (exchangeName === 'Raydium CPMM') {
    // Raydium CPMM buy
    if (!raydiumCpmmKeys) {
      throw new Error('Raydium CPMM Keys not provided');
    }

    let info = ammReverseInfo;
    if (!info) {
      const { poolBaseTokenInfo, poolQuoteTokenInfo } = await raydiumGetCpmmPoolInfo(
        connection,
        poolInfo.pairAddress
      );
      info = {
        mintA: poolInfo.tokenA!,
        mintB: poolInfo.tokenB!,
        poolBaseTokenInfo: { amount: poolBaseTokenInfo.amount.toString() },
        poolQuoteTokenInfo: { amount: poolQuoteTokenInfo.amount.toString() },
      };
    }

    const mintA = new PublicKey(info.mintA);
    const mintB = new PublicKey(info.mintB);

    const solAmount = new BigNumber(tokenAmount)
      .times(priceInSol)
      .times(LAMPORTS_PER_SOL)
      .toFixed(0);

    const buyInstruction = await raydiumCpmmSwapBaseOutBuyInstruction({
      amountInMax: new BigNumber(solAmount).times(1 + slippage).toFixed(0),
      owner: buyerKeypair.publicKey,
      poolKeys: raydiumCpmmKeys,
      poolId: poolInfo.pairAddress,
      mintA: mintA.toBase58(),
      mintB: mintB.toBase58(),
      amountOut: new BigNumber(tokenAmount).times(10 ** decimals).toFixed(0),
      needCreateAtaAccount: true,
      needCloseTokenAccount: true,
    });
    buyTx.add(buyInstruction);
  } else if (exchangeName === 'LaunchLab') {
    // Launchlab buy
    const provider = new AnchorProvider(connection as any, {
      publicKey: buyerKeypair.publicKey,
      signTransaction: async () => {
        throw new Error('Signing not supported');
      },
      signAllTransactions: async () => {
        throw new Error('Signing not supported');
      },
    });

    const solAmount = new BigNumber(tokenAmount)
      .times(priceInSol)
      .times(LAMPORTS_PER_SOL)
      .toFixed(0);

    const buyInstruction = await launchlabBuyExactOutInstruction({
      provider,
      owner: buyerKeypair.publicKey,
      baseMint: new PublicKey(tokenAddress),
      quoteMint: NATIVE_MINT,
      amount: BigInt(new BigNumber(tokenAmount).times(10 ** decimals).toFixed(0)),
      maxSolCost: BigInt(new BigNumber(solAmount).times(1 + slippage).toFixed(0)),
      needCreateAtaAccount: true,
      needCloseTokenAccount: true,
    });
    buyTx.add(buyInstruction);
  } else if (exchangeName === 'Meteora') {
    const MeteoraDLMM = await getMeteoraDLMM();
    const dlmmPool = await MeteoraDLMM.create(connection, new PublicKey(poolInfo.pairAddress));
    const swapQuote = dlmmPool.swapQuote(
      new BN(new BigNumber(tokenAmount).times(10 ** decimals).toFixed(0)),
      poolInfo.tokenB == NATIVE_MINT.toBase58(),
      new BN(slippage),
      binArray || []
    );
    if (!meteoraDLMMReverseInfo) {
      throw new Error('Meteora DLMM Reverse Info not provided');
    }
    // Meteora buy
    const buyInstruction = await meteoraDlmmBuyExactOutInstructions({
      provider,
      owner: buyerKeypair,
      mint: new PublicKey(tokenAddress),
      poolInfo: {
        poolId: poolInfo.pairAddress,
        mintA: meteoraDLMMReverseInfo.mintA,
        mintB: meteoraDLMMReverseInfo.mintB,
        reverseX: meteoraDLMMReverseInfo.reserveX,
        reverseY: meteoraDLMMReverseInfo.reserveY,
        oracle: meteoraDLMMReverseInfo?.oracle,
      },
      amountInMax: BigInt(swapQuote.minOutAmount.toString()),
      tokenAmount: BigInt(tokenAmount),
      needCreateAtaAccount: true,
      needCloseTokenAccount: true,
      binArraysPubkey: swapQuote.binArraysPubkey,
    });
    buyTx.add(buyInstruction);
  } else {
    throw new Error(`Unsupported exchange: ${exchangeName}`);
  }

  // Add priority fee
  // if (priorityFee > 0) {
  //   const { limitIx, priceIx } = getCU(priorityFee);
  //   buyTx.add(limitIx);
  //   buyTx.add(priceIx);
  // }

  buyTx.feePayer = buyerKeypair.publicKey;

  return buyTx;
}

/**
 * Build sell transaction
 */
async function buildSellTransaction(params: {
  connection: Connection;
  sellerKeypair: Keypair;
  tokenAddress: string;
  tokenAmount: number;
  decimals: number;
  exchangeName: string;
  poolInfo: { exchange: { name: string }; pairAddress: string; tokenA?: string; tokenB?: string };
  priceInSol: number;
  creatorAddress: string;
  priorityFee: number;
  slippage: number;
  blockhash: string;
  pumpfunReverseInfo?: PumpfunReverseInfo;
  ammReverseInfo?: AmmReverseInfo;
  raydiumV4Keys?: AmmV4Keys;
  raydiumCpmmKeys?: CpmmKeys;
  pumpswapReverseInfo?: AmmReverseInfo;
  launchlabReverseInfo?: LaunchlabReverseInfo;
  meteoraDLMMReverseInfo?: MeteoraDLMMReverseInfo;
  binArray?: any[];
}): Promise<Transaction> {
  const {
    connection,
    sellerKeypair,
    tokenAddress,
    tokenAmount,
    decimals,
    exchangeName,
    poolInfo,
    priceInSol,
    creatorAddress,
    priorityFee,
    slippage,
    blockhash,
    pumpfunReverseInfo,
    ammReverseInfo,
    raydiumV4Keys,
    raydiumCpmmKeys,
    pumpswapReverseInfo,
    launchlabReverseInfo,
    meteoraDLMMReverseInfo,
    binArray,
  } = params;

  const sellTx = new Transaction();
  sellTx.recentBlockhash = blockhash;

  const tokenAmountInDecimals = new BigNumber(tokenAmount).times(Math.pow(10, decimals)).toFixed(0);
  const provider = new AnchorProvider(connection as any, {
    publicKey: sellerKeypair.publicKey,
    signTransaction: async () => {
      throw new Error('Signing not supported');
    },
    signAllTransactions: async () => {
      throw new Error('Signing not supported');
    },
  });
  if (exchangeName === 'Pump') {
    // Pump.fun sell
    const expectedSolOutput = new BigNumber(tokenAmount)
      .times(priceInSol)
      .times(1 - slippage)
      .times(LAMPORTS_PER_SOL)
      .toFixed(0);

    const sellInstruction = await pumpSellSPLInstructions(
      provider,
      sellerKeypair,
      tokenAddress,
      tokenAmountInDecimals,
      slippage,
      expectedSolOutput,
      new PublicKey(creatorAddress)
    );
    sellTx.add(sellInstruction);
  } else if (exchangeName === 'PumpSwap') {
    // PumpSwap sell
    let poolData = ammReverseInfo;
    if (!poolData) {
      const rawPoolData = await pumpSwapGetPoolInfo(connection, poolInfo.pairAddress);
      poolData = {
        mintA: rawPoolData.mintA,
        mintB: rawPoolData.mintB,
        poolBaseTokenInfo: { amount: rawPoolData.poolBaseTokenInfo.amount.toString() },
        poolQuoteTokenInfo: { amount: rawPoolData.poolQuoteTokenInfo.amount.toString() },
        baseTokenProgram: rawPoolData.baseTokenProgram,
        quoteTokenProgram: rawPoolData.quoteTokenProgram,
      };
    }

    const mintA = new PublicKey(poolData.mintA);
    const mintB = new PublicKey(poolData.mintB);
    const pumpswapCalc = new AmmCalc({
      baseReserve: poolData.poolBaseTokenInfo.amount,
      quoteReserve: poolData.poolQuoteTokenInfo.amount,
      baseDecimals: mintA.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
      quoteDecimals: mintB.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
    });

    const receiveAmount = pumpswapCalc.swap(
      tokenAmountInDecimals,
      mintA.toBase58() === NATIVE_MINT.toBase58() ? false : true
    );

    const sellInstruction = await pumpSwapSellInstruction({
      owner: sellerKeypair,
      poolInfo: {
        poolId: poolInfo.pairAddress,
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        baseTokenProgram: poolData.baseTokenProgram,
        quoteTokenProgram: poolData.quoteTokenProgram,
      },
      tokenAmount: new BN(tokenAmountInDecimals),
      wsolAmount: new BN(receiveAmount),
      slippage,
      creator: new PublicKey(creatorAddress),
    });
    sellTx.add(sellInstruction);
  } else if (exchangeName === 'Raydium') {
    // Raydium V4 sell
    if (!raydiumV4Keys) {
      throw new Error('Raydium V4 Keys not provided');
    }

    // Get pool info
    let baseReserve: string, quoteReserve: string, mintA: string, mintB: string;
    if (ammReverseInfo) {
      baseReserve = ammReverseInfo.poolBaseTokenInfo.amount;
      quoteReserve = ammReverseInfo.poolQuoteTokenInfo.amount;
      mintA = ammReverseInfo.mintA;
      mintB = ammReverseInfo.mintB;
    } else {
      const poolData = await raydiumGetPoolInfo(connection, poolInfo.pairAddress);
      baseReserve = poolData.poolBaseTokenInfo.amount.toString();
      quoteReserve = poolData.poolQuoteTokenInfo.amount.toString();
      mintA = poolInfo.tokenA!;
      mintB = poolInfo.tokenB!;
    }

    const raydiumCalc = new AmmCalc({
      baseReserve,
      quoteReserve,
      baseDecimals: new PublicKey(mintA).toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
      quoteDecimals: new PublicKey(mintB).toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
    });

    const receiveAmount = raydiumCalc.swap(
      tokenAmountInDecimals,
      new PublicKey(mintA).toBase58() === NATIVE_MINT.toBase58() ? false : true
    );

    const sellInstruction = await raydiumSellInstruction({
      amount: tokenAmountInDecimals,
      owner: sellerKeypair.publicKey,
      poolKeys: raydiumV4Keys,
      mintA,
      mintB,
      minAmountOut: '0',
    });
    sellTx.add(sellInstruction);
  } else if (exchangeName === 'Raydium CPMM') {
    // Raydium CPMM sell
    if (!raydiumCpmmKeys) {
      throw new Error('Raydium CPMM Keys not provided');
    }

    // Get pool info
    let baseReserve: string, quoteReserve: string, mintA: string, mintB: string;
    if (ammReverseInfo) {
      baseReserve = ammReverseInfo.poolBaseTokenInfo.amount;
      quoteReserve = ammReverseInfo.poolQuoteTokenInfo.amount;
      mintA = ammReverseInfo.mintA;
      mintB = ammReverseInfo.mintB;
    } else {
      const poolData = await raydiumGetCpmmPoolInfo(connection, poolInfo.pairAddress);
      baseReserve = poolData.poolBaseTokenInfo.amount.toString();
      quoteReserve = poolData.poolQuoteTokenInfo.amount.toString();
      mintA = poolInfo.tokenA!;
      mintB = poolInfo.tokenB!;
    }

    const raydiumCalc = new AmmCalc({
      baseReserve,
      quoteReserve,
      baseDecimals: new PublicKey(mintA).toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
      quoteDecimals: new PublicKey(mintB).toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
    });

    const receiveAmount = raydiumCalc.swap(
      tokenAmountInDecimals,
      new PublicKey(mintA).toBase58() === NATIVE_MINT.toBase58() ? false : true
    );

    const sellInstruction = await raydiumCpmmSellInstruction({
      amount: tokenAmountInDecimals,
      owner: sellerKeypair.publicKey,
      poolKeys: raydiumCpmmKeys,
      poolId: poolInfo.pairAddress,
      mintA,
      mintB,
      minAmountOut: '0',
      connection,
      needCreateAtaAccount: true,
      needCloseTokenAccount: false,
      needCloseWsolAccount: true,
    });
    sellTx.add(sellInstruction);
  } else if (exchangeName === 'LaunchLab') {
    // Launchlab sell
    const provider = new AnchorProvider(connection as any, {
      publicKey: sellerKeypair.publicKey,
      signTransaction: async () => {
        throw new Error('Signing not supported');
      },
      signAllTransactions: async () => {
        throw new Error('Signing not supported');
      },
    });

    // Get pool info
    let poolData = launchlabReverseInfo;
    if (!poolData) {
      poolData = await getLaunchlabReverseInfo({ connection, poolId: poolInfo.pairAddress });
    }

    // Create calculator instance
    const launchlabCalc = new LaunchlabAmmCalc({
      baseDecimals: poolData.baseDecimals,
      quoteDecimals: poolData.quoteDecimals,
      migrateType: poolData.migrateType,
      supply: new BN(poolData.supply),
      totalBaseSell: new BN(poolData.totalBaseSell),
      virtualBase: new BN(poolData.virtualBase),
      virtualQuote: new BN(poolData.virtualQuote),
      realBase: new BN(poolData.realBase),
      realQuote: new BN(poolData.realQuote),
    });

    const receiveAmount = launchlabCalc.calculateSellAmountOut(tokenAmountInDecimals);

    const sellInstruction = await launchlabSellExactInInstruction({
      provider,
      owner: sellerKeypair.publicKey,
      baseMint: new PublicKey(tokenAddress),
      quoteMint: NATIVE_MINT,
      amountIn: BigInt(tokenAmountInDecimals),
      minAmountOut: BigInt(new BigNumber(receiveAmount).times(1 - slippage).toFixed(0)),
      needCreateAtaAccount: true,
      needCloseTokenAccount: true,
    });
    sellTx.add(sellInstruction);
  } else if (exchangeName === 'Meteora') {
    // Meteora sell
    const MeteoraDLMM = await getMeteoraDLMM();
    const dlmmPool = await MeteoraDLMM.create(connection, new PublicKey(poolInfo.pairAddress));
    const swapQuote = dlmmPool.swapQuote(
      new BN(tokenAmountInDecimals),
      poolInfo.tokenB == NATIVE_MINT.toBase58(),
      new BN(slippage),
      binArray || []
    );
    if (!meteoraDLMMReverseInfo) {
      throw new Error('Meteora DLMM Reverse Info not provided');
    }
    const sellInstruction = await meteoraDlmmSellInstructions({
      provider,
      owner: sellerKeypair,
      mint: new PublicKey(tokenAddress),
      poolInfo: {
        poolId: poolInfo.pairAddress,
        mintA: meteoraDLMMReverseInfo.mintA,
        mintB: meteoraDLMMReverseInfo.mintB,
        reverseX: meteoraDLMMReverseInfo.reserveX,
        reverseY: meteoraDLMMReverseInfo.reserveY,
        oracle: meteoraDLMMReverseInfo.oracle,
      },
      amount: BigInt(tokenAmountInDecimals),
      minAmountOut: BigInt(0),
      needCreateAtaAccount: true,
      needCloseTokenAccount: true,
      binArraysPubkey: swapQuote.binArraysPubkey,
    });
    sellTx.add(sellInstruction);
  } else {
    throw new Error(`Unsupported exchange: ${exchangeName}`);
  }

  // Add priority fee
  // if (priorityFee > 0) {
  //   const { limitIx, priceIx } = getCU(priorityFee);
  //   sellTx.add(limitIx);
  //   sellTx.add(priceIx);
  // }

  sellTx.feePayer = sellerKeypair.publicKey;

  return sellTx;
}

/**
 * Calculate SOL transfer amount for turnover trades
 */
export const calculateTurnoverProfit = (
  tokenAmount: number,
  priceInSol: number,
  slippage: number = 0.01,
  fees: number = 0.02 // 2% fees (slippage + transaction fees)
): number => {
  return new BigNumber(tokenAmount)
    .times(priceInSol)
    .times(1 - fees)
    .toNumber();
};
