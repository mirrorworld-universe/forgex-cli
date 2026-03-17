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
import { pumpBuySPLInstructions, pumpSellSPLInstructions, getPumpCurveState } from '../pump';
import {
  raydiumBuyInstruction,
  raydiumSellInstruction,
  raydiumGetPoolInfo,
  raydiumGetCpmmPoolInfo,
  raydiumCpmmSwapBaseOutBuyInstruction,
  raydiumCpmmSwapBaseInBuyInstruction,
  raydiumCpmmSellInstruction,
} from '../raydium';
import {
  meteoraDlmmBuyInstructions,
  meteoraDlmmBuyExactOutInstructions,
  meteoraDlmmSellInstructions,
  getBinArray,
} from '../meteora';
import { pumpSwapBuyInstruction, pumpSwapSellInstruction, pumpSwapGetPoolInfo, getInitUserVolumeAccumulatorIxIfNeeded } from '../pumpswap';
import {
  getLaunchlabReverseInfo,
  launchlabBuyExactInInstruction,
  launchlabBuyExactOutInstruction,
  launchlabSellExactInInstruction,
} from '../launchlab';
import { getNewWsolAccount } from '../account';
import AmmCalc, { PumpAmmCalc, LaunchlabAmmCalc, MeteoraDLMMCalc } from '../calc';
import BigNumber from 'bignumber.js';
import BN from 'bn.js';
import { getCU } from '../rpc';
import { getJitoAdapter } from '@/adapters/jito-adapter.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { getWalletAddress, getWalletKeypair } from '@/utils';
import type { AmmV4Keys, CpmmKeys } from '@raydium-io/raydium-sdk-v2';
import { BundleBuyTime, VolumeType } from '@/types';
import { METEORA_DLMM_PROGRAM } from '@/const';
// @meteora-ag/dlmm is an optional peer dependency — loaded lazily to avoid
// startup crashes when the package is not installed.
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

let redis: ClientRedis = {
  pumpCache: {},
  pumpAtaCache: {},
  pumpSwapCache: {},
  pumpSwapAtaCache: {},
};

export interface Sniper {
  wallet: string;
  amount: string;
}

interface WalletAmount {
  privateKey: string;
  amount: string;
}

export const batchTrade = async ({
  connection,
  exchangeName, // DEX name
  tokenAddress, // Token address
  poolId, // Pool ID
  tradeType, // Trade type
  slippage, // Slippage
  priorityFee, // Priority fee
  priceInSol, // Price
  decimals, // Decimals
  poolInfo, // Pool info
  ammReverseInfo = undefined, // Depth info
  launchlabReverseInfo = undefined, // Depth info
  meteoraDLMMReverseInfo = undefined, // Meteora pool info
  creatorAddress, // Creator address
  walletAmounts,
  pumpfunReverseInfo,
  raydiumV4Keys = undefined,
  raydiumCpmmKeys = undefined,
  volumeType = VolumeType.ONE_BUY_ONE_SELL, // Volume trading mode
  simulate = false, // Simulate transaction
}: {
  connection: Connection;
  exchangeName: string;
  tokenAddress: string;
  poolId: string;
  tradeType: 'buy' | 'sell' | 'sniperBuy' | 'buyWithSell';
  slippage: number;
  priorityFee: number;
  priceInSol?: string;
  decimals: number;
  poolInfo: Pair;
  ammReverseInfo?: AmmReverseInfo;
  pumpfunReverseInfo?: PumpfunReverseInfo;
  launchlabReverseInfo?: LaunchlabReverseInfo;
  meteoraDLMMReverseInfo?: MeteoraDLMMReverseInfo;
  creatorAddress: string;
  walletAmounts: WalletAmount[];
  raydiumV4Keys?: AmmV4Keys;
  raydiumCpmmKeys?: CpmmKeys;
  volumeType?: VolumeType;
  simulate?: boolean;
}): Promise<string[] | undefined> => {
  slippage = slippage / 100;
  if (!poolId || !tokenAddress || !priceInSol || !walletAmounts.length) {
    console.log('Parameter error', {
      poolId,
      tokenAddress,
      priceInSol,
      walletAmounts,
    });
    return undefined;
  }
  if (exchangeName === 'PumpSwap') {
    return pumpswapBatchTrade({
      connection,
      poolInfo,
      tradeType,
      slippage,
      priorityFee,
      decimals,
      reverseInfo: ammReverseInfo,
      creator: new PublicKey(creatorAddress),
      walletAmounts,
      volumeType,
      simulate,
    });
  } else if (exchangeName === 'Pump') {
    return pumpBatchTrade({
      connection,
      tokenAddress,
      poolId: poolInfo.pairAddress,
      tradeType,
      slippage,
      priorityFee,
      priceInSol,
      creator: new PublicKey(creatorAddress),
      walletAmounts,
      initialPoolData: pumpfunReverseInfo,
      volumeType,
      simulate,
    });
  } else if (exchangeName === 'Raydium') {
    if (!raydiumV4Keys) return [];
    return raydiumBatchTrade({
      connection,
      tokenAddress,
      poolId,
      tradeType: tradeType as 'buy' | 'sell' | 'buyWithSell',
      slippage,
      priorityFee,
      priceInSol,
      walletAmounts,
      decimals,
      reverseInfo: ammReverseInfo,
      raydiumV4Keys,
      poolInfo,
      volumeType,
      simulate,
    });
  } else if (exchangeName === 'Raydium CPMM') {
    console.log('ammReverseInfo', ammReverseInfo);
    console.log('raydiumCpmmKeys', raydiumCpmmKeys);
    if (!raydiumCpmmKeys) return [];
    return raydiumCpmmBatchTrade({
      connection,
      tokenAddress,
      poolId,
      tradeType: tradeType as 'buy' | 'sell' | 'buyWithSell',
      slippage,
      priorityFee,
      priceInSol,
      walletAmounts,
      decimals,
      raydiumCpmmKeys,
      poolInfo,
      volumeType,
      simulate,
      reverseInfo: ammReverseInfo,
    });
  } else if (exchangeName === 'LaunchLab') {
    return launchlabBatchTrade({
      connection,
      tokenAddress,
      poolId,
      tradeType,
      slippage,
      priorityFee,
      decimals,
      reverseInfo: launchlabReverseInfo,
      creator: new PublicKey(creatorAddress),
      walletAmounts,
      volumeType,
      simulate,
    });
  } else if (exchangeName === 'Meteora') {
    return meteoraDlmmBatchTrade({
      connection,
      tokenAddress,
      poolId,
      tradeType,
      slippage,
      priorityFee,
      decimals,
      reverseInfo: meteoraDLMMReverseInfo,
      creator: new PublicKey(creatorAddress),
      walletAmounts,
      volumeType,
      simulate,
    });
  }
  console.log('exchangeName', exchangeName);

  return [];
};

export const launchlabBatchTrade = async ({
  connection,
  snipers,
  tokenAddress,
  poolId,
  tradeType,
  slippage,
  priorityFee,
  decimals,
  reverseInfo,
  lutAccount,
  creator,
  walletAmounts,
  bundleBuyTime,
  volumeType = VolumeType.ONE_BUY_ONE_SELL,
  simulate = false,
}: {
  connection: Connection;
  snipers?: Sniper[]; // Inner market snipers (bundle buy on launch)
  tokenAddress: string;
  poolId: string;
  tradeType: 'buy' | 'sell' | 'sniperBuy' | 'buyWithSell';
  slippage: number;
  priorityFee: number;
  decimals: number;
  reverseInfo?: LaunchlabReverseInfo;
  lutAccount?: AddressLookupTableAccount;
  creator: PublicKey;
  walletAmounts: WalletAmount[];
  bundleBuyTime?: BundleBuyTime;
  volumeType?: VolumeType;
  simulate?: boolean;
}): Promise<string[] | undefined> => {
  const provider = new AnchorProvider(
    connection as any,
    {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async () => {
        throw new Error('Signing not supported');
      },
      signAllTransactions: async () => {
        throw new Error('Signing not supported');
      },
    },
    {}
  );
  // Parse pool data using getPumpCurveState
  const poolData = reverseInfo || (await getLaunchlabReverseInfo({ connection, poolId }));
  console.log('poolData: ', poolData);
  const parsedPoolData = {
    supply: poolData.supply.toString(),
    baseDecimals: poolData.baseDecimals,
    quoteDecimals: poolData.quoteDecimals,
    migrateType: poolData.migrateType,
    totalBaseSell: poolData.totalBaseSell.toString(),
    virtualBase: poolData.virtualBase.toString(),
    virtualQuote: poolData.virtualQuote.toString(),
    realBase: poolData.realBase.toString(),
    realQuote: poolData.realQuote.toString(),
  };
  // Create calculator instance
  const launchlabCalc = new LaunchlabAmmCalc({
    baseDecimals: parsedPoolData.baseDecimals,
    quoteDecimals: parsedPoolData.quoteDecimals,
    migrateType: parsedPoolData.migrateType,
    supply: new BN(parsedPoolData.supply),
    totalBaseSell: new BN(parsedPoolData.totalBaseSell),
    virtualBase: new BN(parsedPoolData.virtualBase),
    virtualQuote: new BN(parsedPoolData.virtualQuote),
    realBase: new BN(parsedPoolData.realBase),
    realQuote: new BN(parsedPoolData.realQuote),
  });

  const payers = walletAmounts.map(item => getWalletKeypair(item.privateKey));
  const jito = getJitoAdapter();
  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  const base64Txs = [];

  // Process trade logic
  if (tradeType === 'buy') {
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(LAMPORTS_PER_SOL).toFixed(0);
        // let receiveAmount;
        // try {
        //   receiveAmount = launchlabCalc.calculateBuyAmountOut(currentAmount);
        // } catch (err) {
        //   console.log('err: ', err);
        //   break;
        // }
        const buyTx = await launchlabBuyExactInInstruction({
          provider,
          owner: currentPayer.publicKey,
          baseMint: new PublicKey(tokenAddress),
          quoteMint: NATIVE_MINT,
          amountIn: BigInt(currentAmount),
          minAmountOut: BigInt(0),
          needCreateAtaAccount: true,
          needCloseTokenAccount: true,
        });
        // launchlabBuyExactInInstruction already added compute budget and jito tip internally
        const tx = getTx(buyTx, currentPayer, priorityFee);
        // addPriorityFee(tx, cu);
        const base64Tx = await getBase64Tx({
          tx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          lutAccount,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      const _errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);
      throw new Error(`Failed to build transaction instructions: ${_errMsg}`);
    }
  } else if (tradeType === 'sell') {
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(10 ** decimals).toFixed(0);
        const receiveAmount = launchlabCalc.calculateSellAmountOut(currentAmount);
        const sellTx = await launchlabSellExactInInstruction({
          provider,
          owner: currentPayer.publicKey,
          baseMint: new PublicKey(tokenAddress),
          quoteMint: NATIVE_MINT,
          amountIn: BigInt(currentAmount),
          minAmountOut: BigInt(new BigNumber(receiveAmount).times(1 - slippage).toFixed(0)),
          needCreateAtaAccount: true,
          needCloseTokenAccount: true,
        });
        // launchlabSellExactInInstruction already added compute budget and jito tip internally
        const tx = getTx(sellTx, currentPayer, priorityFee);
        // addPriorityFee(tx, cu);
        const base64Tx = await getBase64Tx({
          tx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      const _errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);
      throw new Error(`Failed to build transaction instructions: ${_errMsg}`);
    }
  } else if (tradeType === 'buyWithSell') {
    // Implement Pump multi-buy multi-sell logic
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(LAMPORTS_PER_SOL).toFixed(0);

        // Pre-create wsolAccount
        const { wsolAccount, createWsolAccount } = await getNewWsolAccount(
          currentPayer.publicKey,
          new BigNumber(currentAmount).times(1 + slippage).toFixed(0)
        );

        // Create combined transaction
        const tx = new Transaction();
        let totalBuyReceiveAmount = new BN(0);

        // Determine buy and sell counts based on volumeType
        const { buyCount, sellCount } = getVolumeTypeConfig(volumeType);

        // Execute multiple buys
        let remainingAmount = new BigNumber(currentAmount);
        for (let i = 0; i < buyCount; i++) {
          let buyAmount: string;

          if (i === buyCount - 1) {
            // Use all remaining funds on the last buy
            buyAmount = remainingAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            buyAmount = new BigNumber(currentAmount).div(buyCount).toFixed(0);
            remainingAmount = remainingAmount.minus(buyAmount);
          }

          let buyReceiveAmount;
          try {
            buyReceiveAmount = launchlabCalc.calculateBuyAmountOut(buyAmount);
          } catch (err) {
            console.log('err: ', err);
            break;
          }

          totalBuyReceiveAmount = totalBuyReceiveAmount.add(new BN(buyReceiveAmount.toString()));

          // Add buy instruction
          const buyTx = await launchlabBuyExactOutInstruction({
            provider,
            owner: currentPayer.publicKey,
            baseMint: new PublicKey(tokenAddress),
            quoteMint: NATIVE_MINT,
            amount: BigInt(buyReceiveAmount.toString()),
            maxSolCost: BigInt(new BigNumber(currentAmount).times(1 + slippage).toFixed(0)),
            needCreateAtaAccount: i === 0,
            needCloseTokenAccount: false,
            initialWsolAccount: wsolAccount,
            createWsolAccountInstruction: createWsolAccount,
          });
          tx.add(buyTx);
        }

        // Execute multiple sells
        let remainingTokenAmount = totalBuyReceiveAmount;
        for (let i = 0; i < sellCount; i++) {
          let sellTokenAmount: string;

          if (i === sellCount - 1) {
            // On last sell, sell all remaining tokens
            sellTokenAmount = remainingTokenAmount.toString();
          } else {
            // Distribute evenly for earlier iterations
            sellTokenAmount = totalBuyReceiveAmount.div(new BN(sellCount)).toString();
            remainingTokenAmount = remainingTokenAmount.sub(new BN(sellTokenAmount));
          }

          const sellReceiveAmount = launchlabCalc.calculateSellAmountOut(sellTokenAmount);

          // Add sell instruction
          const sellTx = await launchlabSellExactInInstruction({
            provider,
            owner: currentPayer.publicKey,
            baseMint: new PublicKey(tokenAddress),
            quoteMint: NATIVE_MINT,
            amountIn: BigInt(sellTokenAmount),
            minAmountOut: BigInt(new BigNumber(sellReceiveAmount).times(1 - slippage).toFixed(0)),
            needCreateAtaAccount: false,
            needCloseTokenAccount: i === sellCount - 1,
            initialWsolAccount: wsolAccount,
            createWsolAccountInstruction: createWsolAccount,
          });
          tx.add(sellTx);
        }

        const finalTx = getTx(tx, currentPayer, priorityFee, jito);
        const base64Tx = await getBase64Tx({
          tx: finalTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          lutAccount,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      const _errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);
      throw new Error(`Failed to build transaction instructions: ${_errMsg}`);
    }
  } else if (tradeType === 'sniperBuy') {
    if (snipers) {
      let txs: Transaction[] = [];
      let signers: Keypair[][] = [];
      for (const [index, sniper] of snipers.entries()) {
        const currentPayer = getWalletKeypair(sniper.wallet);
        const currentAmount = new BigNumber(sniper.amount).times(10 ** 9).toString(10);
        console.log('currentAmount: ', currentAmount);
        let receiveAmount;
        try {
          receiveAmount = launchlabCalc.calculateBuyAmountOut(currentAmount);
          console.log('receiveAmount: ', receiveAmount.toString());
        } catch (err) {
          console.log('err: ', err);
          break;
        }
        const buyTx = await launchlabBuyExactOutInstruction({
          provider,
          owner: currentPayer.publicKey,
          baseMint: new PublicKey(tokenAddress),
          quoteMint: NATIVE_MINT,
          amount: BigInt(receiveAmount.toString()),
          maxSolCost: BigInt(new BigNumber(currentAmount).times(1 + slippage).toFixed(0)),
          initialWsolAccount: undefined,
          needCreateAtaAccount: true,
          needCloseTokenAccount: true,
        });
        if (index % (lutAccount ? 5 : 2) === 0) {
          txs.push(new Transaction());
          signers.push([]);
        }
        txs[txs.length - 1].add(buyTx);
        signers[signers.length - 1].push(currentPayer);
      }
      const tipTx = new Transaction();
      tipTx.add(
        jito.getTipInstruction(new PublicKey(getWalletAddress(snipers[0].wallet)), priorityFee)
      );
      txs.push(tipTx);
      signers.push([getWalletKeypair(snipers[0].wallet)]);
      for (const [index, tx] of txs.entries()) {
        const base64Tx = await getBase64Tx({
          tx,
          payer: signers[0][0], // First trader as fee payer
          signers: [...signers[index]], // All signers for the current transaction
          blockhash,
          connection,
          lutAccount,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } else {
      throw new Error('snipers cannot be empty');
    }
  }
};

export const pumpswapBatchTrade = async ({
  connection,
  poolInfo,
  tradeType,
  slippage,
  priorityFee,
  decimals,
  reverseInfo,
  creator,
  walletAmounts,
  volumeType = VolumeType.ONE_BUY_ONE_SELL,
  simulate = false,
}: {
  connection: Connection;
  poolInfo: Pair;
  tradeType: 'buy' | 'sell' | 'sniperBuy' | 'buyWithSell';
  slippage: number;
  priorityFee: number;
  decimals: number;
  reverseInfo?: AmmReverseInfo;
  creator: PublicKey;
  walletAmounts: WalletAmount[];
  volumeType?: VolumeType;
  simulate?: boolean;
}) => {
  let info: any = reverseInfo;
  if (!info) {
    info = await pumpSwapGetPoolInfo(connection, poolInfo.pairAddress);
  }
  const mintA = new PublicKey(info.mintA);
  const mintB = new PublicKey(info.mintB);
  const basereverse = info.poolBaseTokenInfo.amount.toString();
  const quoteReserve = info.poolQuoteTokenInfo.amount.toString();

  const pumpswapCalc = new AmmCalc({
    baseReserve: basereverse,
    quoteReserve: quoteReserve,
    baseDecimals: mintA.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
    quoteDecimals: mintB.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
  });

  const base64Txs = [];
  const jito = getJitoAdapter();
  const blockhash = (await connection.getLatestBlockhash()).blockhash;

  if (tradeType === 'buy' || tradeType === 'sniperBuy') {
    for (const [index, payer] of walletAmounts.entries()) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** 9).toFixed(0);
      if (Number(currentAmount) <= 0) {
        continue;
      }
      let receiveAmount;
      try {
        receiveAmount = pumpswapCalc.swap(
          currentAmount,
          mintA.toBase58() === NATIVE_MINT.toBase58() ? true : false
        );
      } catch (err) {
        console.log('err: ', err);
        break;
      }
      const buyTx = await pumpSwapBuyInstruction({
        owner: currentPayer,
        poolInfo: {
          poolId: poolInfo.pairAddress,
          mintA: mintA.toBase58(),
          mintB: mintB.toBase58(),
          baseTokenProgram: info.baseTokenProgram,
          quoteTokenProgram: info.quoteTokenProgram,
        },
        wsolAmount: new BN(currentAmount),
        tokenAmount: new BN(receiveAmount),
        slippage,
        creator,
      });

      // Check if user_volume_accumulator needs initialization
      const initVolumeIx = await getInitUserVolumeAccumulatorIxIfNeeded(
        connection,
        currentPayer.publicKey,
        currentPayer.publicKey,
      );
      if (initVolumeIx) {
        // Insert initialization instruction at the beginning of the buy transaction
        buyTx.instructions.unshift(initVolumeIx);
      }

      let tx = getTx(buyTx, currentPayer, priorityFee, jito);
      if (tradeType === 'sniperBuy' && index === 0) {
      } else {
      }
      // console.log('tx: ', tx);
      const base64Tx = await getBase64Tx({
        tx,
        payer: currentPayer,
        signers: [currentPayer],
        blockhash,
        connection,
        simulate,
      });
      base64Txs.push(base64Tx);
    }
  } else if (tradeType === 'sell') {
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** decimals).toFixed(0);
      let receiveAmount;
      if (Number(currentAmount) <= 0) {
        continue;
      }
      try {
        receiveAmount = pumpswapCalc.swap(
          currentAmount,
          mintA.toBase58() === NATIVE_MINT.toBase58() ? false : true
        );
      } catch (err) {
        console.log('err: ', err);
        break;
      }
      const sellTx = await pumpSwapSellInstruction({
        owner: currentPayer,
        poolInfo: {
          poolId: poolInfo.pairAddress,
          mintA: mintA.toBase58(),
          mintB: mintB.toBase58(),
          baseTokenProgram: info.baseTokenProgram,
          quoteTokenProgram: info.quoteTokenProgram,
        },
        tokenAmount: new BN(currentAmount),
        wsolAmount: new BN(receiveAmount),
        slippage,
        creator,
      });
      let tx = getTx(sellTx, currentPayer, priorityFee, jito);
      const base64Tx = await getBase64Tx({
        tx,
        payer: currentPayer,
        signers: [currentPayer],
        blockhash,
        connection,
        simulate,
      });
      base64Txs.push(base64Tx);
    }
  } else if (tradeType === 'buyWithSell') {
    // Implement multi-buy multi-sell logic
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** 9).toFixed(0);
      if (Number(currentAmount) <= 0) {
        continue;
      }

      // Pre-create wsolAccount
      const { wsolAccount, createWsolAccount } = await getNewWsolAccount(
        currentPayer.publicKey,
        new BigNumber(currentAmount).times(1 + slippage).toFixed(0)
      );

      try {
        // Create combined transaction
        const tx = new Transaction();
        let totalBuyReceiveAmount = new BN(0);

        // Determine buy and sell counts based on volumeType
        const { buyCount, sellCount } = getVolumeTypeConfig(volumeType);

        // Execute multiple buys
        let remainingAmount = new BigNumber(currentAmount);
        for (let i = 0; i < buyCount; i++) {
          let buyAmount: string;

          if (i === buyCount - 1) {
            // Use all remaining funds on the last buy
            buyAmount = remainingAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            buyAmount = new BigNumber(currentAmount).div(buyCount).toFixed(0);
            remainingAmount = remainingAmount.minus(buyAmount);
          }

          let buyReceiveAmount = pumpswapCalc.swap(
            buyAmount,
            mintA.toBase58() === NATIVE_MINT.toBase58() ? true : false
          );

          totalBuyReceiveAmount = totalBuyReceiveAmount.add(new BN(buyReceiveAmount.toString()));

          const buyTx = await pumpSwapBuyInstruction({
            owner: currentPayer,
            poolInfo: {
              poolId: poolInfo.pairAddress,
              mintA: mintA.toBase58(),
              mintB: mintB.toBase58(),
              baseTokenProgram: info.baseTokenProgram,
              quoteTokenProgram: info.quoteTokenProgram,
            },
            wsolAmount: new BN(buyAmount),
            tokenAmount: new BN(buyReceiveAmount),
            slippage,
            creator,
            needCreateAtaAccount: i === 0,
            needCloseTokenAccount: false,
            needCloseWsolAccount: false,
            initialWsolAccount: wsolAccount,
            createWsolAccountInstruction: createWsolAccount,
          });
          tx.add(buyTx);
        }

        // Execute multiple sells
        let remainingTokenAmount = totalBuyReceiveAmount;
        for (let i = 0; i < sellCount; i++) {
          let sellTokenAmount: BN;

          if (i === sellCount - 1) {
            // On last sell, sell all remaining tokens
            sellTokenAmount = remainingTokenAmount;
          } else {
            // Distribute evenly for earlier iterations
            sellTokenAmount = totalBuyReceiveAmount.div(new BN(sellCount));
            remainingTokenAmount = remainingTokenAmount.sub(sellTokenAmount);
          }

          let sellReceiveAmount = pumpswapCalc.swap(
            sellTokenAmount.toString(),
            mintA.toBase58() === NATIVE_MINT.toBase58() ? false : true
          );

          const sellTx = await pumpSwapSellInstruction({
            owner: currentPayer,
            poolInfo: {
              poolId: poolInfo.pairAddress,
              mintA: mintA.toBase58(),
              mintB: mintB.toBase58(),
              baseTokenProgram: info.baseTokenProgram,
              quoteTokenProgram: info.quoteTokenProgram,
            },
            tokenAmount: sellTokenAmount,
            wsolAmount: new BN(sellReceiveAmount),
            slippage,
            creator,
            needCreateAtaAccount: false,
            needCloseTokenAccount: i === sellCount - 1,
            needCloseWsolAccount: i === sellCount - 1,
            initialWsolAccount: wsolAccount,
          });
          tx.add(sellTx);
        }

        let finalTx = getTx(tx, currentPayer, priorityFee, jito, 400_000);

        const base64Tx = await getBase64Tx({
          tx: finalTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          simulate,
        });
        base64Txs.push(base64Tx);
      } catch (err) {
        console.log('buyWithSell err: ', err);
        break;
      }
    }
  }

  return base64Txs;
};

export const pumpBatchTrade = async ({
  connection,
  walletAmounts,
  snipers,
  tokenAddress,
  poolId,
  tradeType,
  slippage,
  priorityFee,
  priceInSol,
  initialPoolData,
  lutAccount,
  creator,
  bundleBuyTime,
  volumeType = VolumeType.ONE_BUY_ONE_SELL,
  simulate = false,
}: {
  connection: Connection;
  walletAmounts: WalletAmount[];
  snipers?: Sniper[]; // Inner market snipers (bundle buy on launch)
  tokenAddress: string;
  poolId: string;
  tradeType: 'buy' | 'sell' | 'sniperBuy' | 'buyWithSell';
  slippage: number;
  priorityFee: number;
  priceInSol: string;
  initialPoolData?: PumpfunReverseInfo;
  lutAccount?: AddressLookupTableAccount;
  creator: PublicKey;
  bundleBuyTime?: BundleBuyTime;
  volumeType?: VolumeType;
  simulate?: boolean;
}): Promise<string[] | undefined> => {
  const provider = new AnchorProvider(
    connection as any,
    {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async () => {
        throw new Error('Signing not supported');
      },
      signAllTransactions: async () => {
        throw new Error('Signing not supported');
      },
    },
    {}
  );

  // Parse pool data using getPumpCurveState
  const poolData = initialPoolData || (await getPumpCurveState(connection, poolId));
  const parsedPoolData = {
    virtual_sol_reserves: poolData.virtualSolReserves.toString(),
    virtual_token_reserves: poolData.virtualTokenReserves.toString(),
    real_token_reserves: poolData.realTokenReserves.toString(),
    real_sol_reserves: poolData.realSolReserves.toString(),
    token_total_supply: poolData.tokenTotalSupply.toString(),
    complete: poolData.complete,
  };
  console.log('parsedPoolData: ', parsedPoolData);
  // Create calculator instance
  const pumpCalc = new PumpAmmCalc({
    initialVirtualSolReserves: new BN(parsedPoolData.virtual_sol_reserves),
    tokenTotalSupply: new BN(parsedPoolData.token_total_supply),
    initialRealSolReserves: new BN(parsedPoolData.real_sol_reserves),
    initialVirtualTokenReserves: new BN(parsedPoolData.virtual_token_reserves),
    initialRealTokenReserves: new BN(parsedPoolData.real_token_reserves),
  });

  const payers = walletAmounts.map(item => getWalletKeypair(item.privateKey));
  const jito = getJitoAdapter();
  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  const base64Txs = [];

  // Process trade logic
  if (tradeType === 'buy') {
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(LAMPORTS_PER_SOL).toFixed(0);
        let receiveAmount;
        try {
          receiveAmount = pumpCalc.calculateBuyAmountOut(currentAmount);
        } catch (err) {
          console.log('err: ', err);
          continue;
        }
        const [_, buyTx] = await pumpBuySPLInstructions(
          provider,
          currentPayer.publicKey,
          tokenAddress,
          currentAmount,
          slippage,
          new BigNumber(priceInSol).toString(10),
          creator,
          receiveAmount.toString()
        );
        // Add Jito tip (required for Jito Bundle)
        buyTx.add(jito.getTipInstruction(currentPayer.publicKey, priorityFee));
        const base64Tx = await getBase64Tx({
          tx: buyTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          lutAccount,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      const _errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);
      throw new Error(`Failed to build transaction instructions: ${_errMsg}`);
    }
  } else if (tradeType === 'sell') {
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(10 ** 6).toFixed(0);
        let receiveAmount;
        try {
          receiveAmount = pumpCalc.calculateSellAmountOut(currentAmount);
        } catch (err) {
          console.log('err: ', err);
          continue;
        }
        const sellTx = await pumpSellSPLInstructions(
          provider,
          currentPayer,
          tokenAddress,
          new BigNumber(currentAmount).toString(10),
          slippage,
          receiveAmount,
          creator
        );
        // Add Jito tip (required for Jito Bundle)
        sellTx.add(jito.getTipInstruction(currentPayer.publicKey, priorityFee));
        const base64Tx = await getBase64Tx({
          tx: sellTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      const _errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);
      throw new Error(`Failed to build transaction instructions: ${_errMsg}`);
    }
  } else if (tradeType === 'buyWithSell') {
    // Implement Pump multi-buy multi-sell logic
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(LAMPORTS_PER_SOL).toFixed(0);

        // Create combined transaction
        const tx = new Transaction();
        let totalBuyReceiveAmount = new BN(0);

        // Determine buy and sell counts based on volumeType
        const { buyCount, sellCount } = getVolumeTypeConfig(volumeType);

        // Execute multiple buys
        let remainingAmount = new BigNumber(currentAmount);
        for (let i = 0; i < buyCount; i++) {
          let buyAmount: string;

          if (i === buyCount - 1) {
            // Use all remaining funds on the last buy
            buyAmount = remainingAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            buyAmount = new BigNumber(currentAmount).div(buyCount).toFixed(0);
            remainingAmount = remainingAmount.minus(buyAmount);
          }

          let buyReceiveAmount;
          try {
            buyReceiveAmount = pumpCalc.calculateBuyAmountOut(buyAmount);
          } catch (err) {
            console.log('err: ', err);
            break;
          }

          totalBuyReceiveAmount = totalBuyReceiveAmount.add(new BN(buyReceiveAmount.toString()));

          // Add buy instruction
          const [_, buyTx] = await pumpBuySPLInstructions(
            provider,
            currentPayer.publicKey,
            tokenAddress,
            buyAmount,
            slippage,
            new BigNumber(priceInSol).toString(10),
            creator,
            buyReceiveAmount.toString()
          );
          tx.add(buyTx);
        }

        // Execute multiple sells
        let remainingTokenAmount = totalBuyReceiveAmount;
        for (let i = 0; i < sellCount; i++) {
          let sellTokenAmount: string;

          if (i === sellCount - 1) {
            // On last sell, sell all remaining tokens
            sellTokenAmount = remainingTokenAmount.toString();
          } else {
            // Distribute evenly for earlier iterations
            sellTokenAmount = totalBuyReceiveAmount.div(new BN(sellCount)).toString();
            remainingTokenAmount = remainingTokenAmount.sub(new BN(sellTokenAmount));
          }

          let sellReceiveAmount;
          try {
            sellReceiveAmount = pumpCalc.calculateSellAmountOut(sellTokenAmount);
          } catch (err) {
            console.log('err: ', err);
            break;
          }

          // Add sell instruction
          const sellTx = await pumpSellSPLInstructions(
            provider,
            currentPayer,
            tokenAddress,
            sellTokenAmount,
            slippage,
            sellReceiveAmount,
            creator
          );
          tx.add(sellTx);
        }

        // All instructions already added compute budget and jito tip internally
        const finalTx = getTx(tx, currentPayer, priorityFee);
        const base64Tx = await getBase64Tx({
          tx: finalTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          lutAccount,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      const _errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);
      throw new Error(`Failed to build transaction instructions: ${_errMsg}`);
    }
  } else if (tradeType === 'sniperBuy') {
    if (snipers) {
      let txs: Transaction[] = [];
      let signers: Keypair[][] = [];
      for (const [index, sniper] of snipers.entries()) {
        const currentPayer = getWalletKeypair(sniper.wallet);
        const currentAmount = new BigNumber(sniper.amount).times(10 ** 9).toString(10);
        console.log('currentAmount: ', currentAmount);
        let receiveAmount;
        try {
          receiveAmount = pumpCalc.calculateBuyAmountOut(currentAmount);
          console.log('receiveAmount: ', receiveAmount.toString());
        } catch (err) {
          continue;
        }
        const [_, buyTx] = await pumpBuySPLInstructions(
          provider,
          currentPayer.publicKey,
          tokenAddress,
          currentAmount,
          slippage,
          new BigNumber(priceInSol).toString(10),
          creator,
          receiveAmount.toString()
        );
        // T0 mode: 2 snipers per transaction (reduces Bundle tx count, easier for Jito to pack)
        // Non-T0: 3 (or 4 with LUT) snipers merged into same transaction
        const groupSize = bundleBuyTime === BundleBuyTime.T0 ? 2 : (lutAccount ? 4 : 3);
        if (index % groupSize === 0) {
          txs.push(new Transaction());
          signers.push([]);
        }
        // T0 Bundle doesn't need ComputeBudget priority fee (bids via Jito tip),
        // remove all ComputeBudget instructions to save transaction space
        if (bundleBuyTime === BundleBuyTime.T0) {
          const filteredInstructions = buyTx.instructions.filter(
            ix => !ix.programId.equals(ComputeBudgetProgram.programId)
          );
          filteredInstructions.forEach(ix => txs[txs.length - 1].add(ix));
        } else {
          txs[txs.length - 1].add(buyTx);
        }
        if (bundleBuyTime === BundleBuyTime.T1_T5 && index === 0) {
          // pumpBuySPLInstructions already added jito tip internally, don't add again
        }
        signers[signers.length - 1].push(currentPayer);
      }
      // T0 mode: tip goes as a standalone transaction at end of Bundle, not added here
      for (const [index, tx] of txs.entries()) {
        const base64Tx = await getBase64Tx({
          tx,
          payer: signers[0][0], // First trader as fee payer
          signers: [...signers[index]], // All signers for the current transaction
          blockhash,
          connection,
          lutAccount,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } else {
      throw new Error('snipers cannot be empty');
    }
  }
};

export const raydiumBatchTrade = async ({
  connection,
  tokenAddress,
  poolId,
  tradeType,
  slippage,
  priorityFee,
  priceInSol,
  walletAmounts,
  reverseInfo,
  decimals,
  raydiumV4Keys,
  poolInfo,
  volumeType = VolumeType.ONE_BUY_ONE_SELL,
  simulate = false,
}: {
  connection: Connection;
  tokenAddress: string;
  poolId: string;
  tradeType: 'buy' | 'sell' | 'buyWithSell';
  slippage: number;
  priorityFee: number;
  priceInSol: string;
  walletAmounts: WalletAmount[];
  reverseInfo?: AmmReverseInfo;
  decimals: number;
  raydiumV4Keys: AmmV4Keys;
  poolInfo: Pair;
  volumeType?: VolumeType;
  simulate?: boolean;
}) => {
  let info: any = reverseInfo;
  if (!info) {
    const { poolBaseTokenInfo, poolQuoteTokenInfo } = await raydiumGetPoolInfo(connection, poolId);
    info = {
      mintA: poolInfo.tokenA,
      mintB: poolInfo.tokenB,
      poolBaseTokenInfo: {
        amount: poolBaseTokenInfo.amount.toString(),
      },
      poolQuoteTokenInfo: {
        amount: poolQuoteTokenInfo.amount.toString(),
      },
    };
  }
  const mintA = new PublicKey(info.mintA);
  const mintB = new PublicKey(info.mintB);
  const basereverse = info.poolBaseTokenInfo.amount.toString();
  const quoteReserve = info.poolQuoteTokenInfo.amount.toString();

  const raydiumCalc = new AmmCalc({
    baseReserve: basereverse,
    quoteReserve: quoteReserve,
    baseDecimals: mintA.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
    quoteDecimals: mintB.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
  });

  const base64Txs = [];
  const jito = getJitoAdapter();
  const blockhash = (await connection.getLatestBlockhash()).blockhash;

  if (tradeType === 'buy') {
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** 9).toFixed(0);
      if (Number(currentAmount) <= 0) {
        continue;
      }
      let receiveAmount;
      try {
        receiveAmount = raydiumCalc.swap(
          currentAmount,
          mintA.toBase58() === NATIVE_MINT.toBase58() ? true : false
        );
      } catch (err) {
        console.log('err: ', err);
        break;
      }
      const buyTx = await raydiumBuyInstruction({
        amount: currentAmount,
        owner: currentPayer.publicKey,
        poolKeys: raydiumV4Keys,
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        minAmountOut: new BigNumber(receiveAmount).times(1 - slippage).toFixed(0),
      });
      let tx = getTx(buyTx, currentPayer, priorityFee, jito);
      // console.log('tx: ', tx);
      const base64Tx = await getBase64Tx({
        tx,
        payer: currentPayer,
        signers: [currentPayer],
        blockhash,
        connection,
        simulate,
      });
      base64Txs.push(base64Tx);
    }
  } else if (tradeType === 'sell') {
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** decimals).toFixed(0);
      let receiveAmount;
      if (Number(currentAmount) <= 0) {
        continue;
      }
      try {
        receiveAmount = raydiumCalc.swap(
          currentAmount,
          mintA.toBase58() === NATIVE_MINT.toBase58() ? false : true
        );
      } catch (err) {
        console.log('err: ', err);
        break;
      }
      const sellTx = await raydiumSellInstruction({
        amount: currentAmount,
        owner: currentPayer.publicKey,
        poolKeys: raydiumV4Keys,
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        minAmountOut: new BigNumber(receiveAmount).times(1 - slippage).toFixed(0),
      });
      let tx = getTx(sellTx, currentPayer, priorityFee, jito);
      const base64Tx = await getBase64Tx({
        tx,
        payer: currentPayer,
        signers: [currentPayer],
        blockhash,
        connection,
        simulate,
      });
      base64Txs.push(base64Tx);
    }
  } else if (tradeType === 'buyWithSell') {
    // Implement Raydium multi-buy multi-sell logic
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** 9).toFixed(0);
      if (Number(currentAmount) <= 0) {
        continue;
      }

      // Pre-create wsolAccount
      const { wsolAccount, createWsolAccount } = await getNewWsolAccount(
        currentPayer.publicKey,
        new BigNumber(currentAmount).times(1 + slippage).toFixed(0)
      );

      try {
        // Create combined transaction
        const tx = new Transaction();
        let totalBuyReceiveAmount = new BigNumber(0);

        // Determine buy and sell counts based on volumeType
        const { buyCount, sellCount } = getVolumeTypeConfig(volumeType);

        // Execute multiple buys
        let remainingAmount = new BigNumber(currentAmount);
        for (let i = 0; i < buyCount; i++) {
          let buyAmount: string;

          if (i === buyCount - 1) {
            // Use all remaining funds on the last buy
            buyAmount = remainingAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            buyAmount = new BigNumber(currentAmount).div(buyCount).toFixed(0);
            remainingAmount = remainingAmount.minus(buyAmount);
          }

          let buyReceiveAmount = raydiumCalc.swap(
            buyAmount,
            mintA.toBase58() === NATIVE_MINT.toBase58() ? true : false
          );

          totalBuyReceiveAmount = totalBuyReceiveAmount.plus(buyReceiveAmount);

          // Add buy instruction
          const buyTx = await raydiumBuyInstruction({
            amount: buyAmount,
            owner: currentPayer.publicKey,
            poolKeys: raydiumV4Keys,
            mintA: mintA.toBase58(),
            mintB: mintB.toBase58(),
            minAmountOut: new BigNumber(buyReceiveAmount).times(1 - slippage).toFixed(0),
            needCreateAtaAccount: i === 0,
            needCloseTokenAccount: false,
            needCloseWsolAccount: false,
            initialWsolAccount: wsolAccount,
            createWsolAccountInstruction: createWsolAccount,
          });
          tx.add(buyTx);
        }

        // Execute multiple sells
        let remainingTokenAmount = totalBuyReceiveAmount;
        for (let i = 0; i < sellCount; i++) {
          let sellTokenAmount: string;

          if (i === sellCount - 1) {
            // On last sell, sell all remaining tokens
            sellTokenAmount = remainingTokenAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            sellTokenAmount = totalBuyReceiveAmount.div(sellCount).toFixed(0);
            remainingTokenAmount = remainingTokenAmount.minus(sellTokenAmount);
          }

          let sellReceiveAmount = raydiumCalc.swap(
            sellTokenAmount,
            mintA.toBase58() === NATIVE_MINT.toBase58() ? false : true
          );

          // Add sell instruction
          const sellTx = await raydiumSellInstruction({
            amount: sellTokenAmount,
            owner: currentPayer.publicKey,
            poolKeys: raydiumV4Keys,
            mintA: mintA.toBase58(),
            mintB: mintB.toBase58(),
            minAmountOut: new BigNumber(sellReceiveAmount).times(1 - slippage).toFixed(0),
            needCreateAtaAccount: false,
            needCloseTokenAccount: i === sellCount - 1,
            needCloseWsolAccount: i === sellCount - 1,
            initialWsolAccount: wsolAccount,
          });
          tx.add(sellTx);
        }

        let finalTx = getTx(tx, currentPayer, priorityFee, jito);

        const base64Tx = await getBase64Tx({
          tx: finalTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          simulate,
        });
        base64Txs.push(base64Tx);
      } catch (err) {
        console.log('raydium buyWithSell err: ', err);
        break;
      }
    }
  }

  return base64Txs;
};

export const raydiumCpmmBatchTrade = async ({
  connection,
  tokenAddress,
  poolId,
  tradeType,
  slippage,
  priorityFee,
  priceInSol,
  walletAmounts,
  reverseInfo,
  decimals,
  raydiumCpmmKeys,
  poolInfo,
  volumeType = VolumeType.ONE_BUY_ONE_SELL,
  simulate = false,
}: {
  connection: Connection;
  tokenAddress: string;
  poolId: string;
  tradeType: 'buy' | 'sell' | 'buyWithSell' | 'sniperBuy';
  slippage: number;
  priorityFee: number;
  priceInSol: string;
  walletAmounts: WalletAmount[];
  reverseInfo?: AmmReverseInfo;
  decimals: number;
  raydiumCpmmKeys: CpmmKeys;
  poolInfo: Pair;
  volumeType?: VolumeType;
  simulate?: boolean;
}) => {
  let info: any = reverseInfo;
  if (!info) {
    const { poolBaseTokenInfo, poolQuoteTokenInfo } = await raydiumGetCpmmPoolInfo(
      connection,
      poolId
    );
    info = {
      mintA: poolInfo.tokenA,
      mintB: poolInfo.tokenB,
      poolBaseTokenInfo: {
        amount: poolBaseTokenInfo.amount.toString(),
      },
      poolQuoteTokenInfo: {
        amount: poolQuoteTokenInfo.amount.toString(),
      },
    };
  }
  const mintA = new PublicKey(info.mintA);
  const mintB = new PublicKey(info.mintB);
  const basereverse = info.poolBaseTokenInfo.amount.toString();
  const quoteReserve = info.poolQuoteTokenInfo.amount.toString();

  const raydiumCalc = new AmmCalc({
    baseReserve: basereverse,
    quoteReserve: quoteReserve,
    baseDecimals: mintA.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
    quoteDecimals: mintB.toBase58() === NATIVE_MINT.toBase58() ? 9 : decimals,
  });

  const base64Txs = [];
  const jito = getJitoAdapter();
  const blockhash = (await connection.getLatestBlockhash()).blockhash;

  if (tradeType === 'buy' || tradeType === 'sniperBuy') {
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** 9).toFixed(0);
      if (Number(currentAmount) <= 0) {
        continue;
      }
      let receiveAmount;
      try {
        receiveAmount = raydiumCalc.swap(
          currentAmount,
          mintA.toBase58() === NATIVE_MINT.toBase58() ? true : false
        );
      } catch (err) {
        console.log('err: ', err);
        break;
      }
      const buyTx = await raydiumCpmmSwapBaseInBuyInstruction({
        amountInMax: currentAmount,
        owner: currentPayer.publicKey,
        poolKeys: raydiumCpmmKeys,
        poolId,
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        amountOutMin: new BigNumber(receiveAmount).times(1 - slippage).toFixed(0),
        needCreateAtaAccount: true,
        needCloseTokenAccount: true,
      });
      let tx = getTx(buyTx, currentPayer, priorityFee, jito);
      // console.log('tx: ', tx);
      const base64Tx = await getBase64Tx({
        tx,
        payer: currentPayer,
        signers: [currentPayer],
        blockhash,
        connection,
        simulate,
      });
      base64Txs.push(base64Tx);
    }
  } else if (tradeType === 'sell') {
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** decimals).toFixed(0);
      let receiveAmount;
      if (Number(currentAmount) <= 0) {
        continue;
      }
      try {
        receiveAmount = raydiumCalc.swap(
          currentAmount,
          mintA.toBase58() === NATIVE_MINT.toBase58() ? false : true
        );
      } catch (err) {
        console.log('err: ', err);
        break;
      }
      const sellTx = await raydiumCpmmSellInstruction({
        amount: currentAmount,
        owner: currentPayer.publicKey,
        poolKeys: raydiumCpmmKeys,
        poolId,
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        minAmountOut: new BigNumber(receiveAmount).times(1 - slippage).toFixed(0),
        connection,
        needCreateAtaAccount: true,
        needCloseTokenAccount: false,
        needCloseWsolAccount: true,
      });
      let tx = getTx(sellTx, currentPayer, priorityFee, jito);
      const base64Tx = await getBase64Tx({
        tx,
        payer: currentPayer,
        signers: [currentPayer],
        blockhash,
        connection,
        simulate,
      });
      base64Txs.push(base64Tx);
    }
  } else if (tradeType === 'buyWithSell') {
    // Implement Raydium multi-buy multi-sell logic
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(10 ** 9).toFixed(0);
      if (Number(currentAmount) <= 0) {
        continue;
      }

      // Pre-create wsolAccount
      const { wsolAccount, createWsolAccount } = await getNewWsolAccount(
        currentPayer.publicKey,
        new BigNumber(currentAmount).times(1 + slippage).toFixed(0)
      );

      try {
        // Create combined transaction
        const tx = new Transaction();
        let totalBuyReceiveAmount = new BigNumber(0);

        // Determine buy and sell counts based on volumeType
        const { buyCount, sellCount } = getVolumeTypeConfig(volumeType);

        // Execute multiple buys
        let remainingAmount = new BigNumber(currentAmount);
        for (let i = 0; i < buyCount; i++) {
          let buyAmount: string;

          if (i === buyCount - 1) {
            // Use all remaining funds on the last buy
            buyAmount = remainingAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            buyAmount = new BigNumber(currentAmount).div(buyCount).toFixed(0);
            remainingAmount = remainingAmount.minus(buyAmount);
          }

          let buyReceiveAmount = raydiumCalc.swap(
            buyAmount,
            mintA.toBase58() === NATIVE_MINT.toBase58() ? true : false
          );

          totalBuyReceiveAmount = totalBuyReceiveAmount.plus(buyReceiveAmount);

          // Add buy instruction
          const buyTx = await raydiumCpmmSwapBaseOutBuyInstruction({
            amountInMax: new BigNumber(buyAmount).times(1 + slippage).toFixed(0),
            owner: currentPayer.publicKey,
            poolKeys: raydiumCpmmKeys,
            poolId,
            mintA: mintA.toBase58(),
            mintB: mintB.toBase58(),
            amountOut: buyReceiveAmount,
            needCreateAtaAccount: i === 0,
            needCloseTokenAccount: false,
            initialWsolAccount: wsolAccount,
            createWsolAccountInstruction: createWsolAccount,
          });
          tx.add(buyTx);
        }

        // Execute multiple sells
        let remainingTokenAmount = totalBuyReceiveAmount;
        for (let i = 0; i < sellCount; i++) {
          let sellTokenAmount: string;

          if (i === sellCount - 1) {
            // On last sell, sell all remaining tokens
            sellTokenAmount = remainingTokenAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            sellTokenAmount = totalBuyReceiveAmount.div(sellCount).toFixed(0);
            remainingTokenAmount = remainingTokenAmount.minus(sellTokenAmount);
          }

          let sellReceiveAmount = raydiumCalc.swap(
            sellTokenAmount,
            mintA.toBase58() === NATIVE_MINT.toBase58() ? false : true
          );

          // Add sell instruction
          const sellTx = await raydiumCpmmSellInstruction({
            amount: sellTokenAmount,
            owner: currentPayer.publicKey,
            poolKeys: raydiumCpmmKeys,
            poolId,
            mintA: mintA.toBase58(),
            mintB: mintB.toBase58(),
            minAmountOut: new BigNumber(sellReceiveAmount).times(1 - slippage).toFixed(0),
            connection,
            needCreateAtaAccount: false,
            needCloseTokenAccount: i === sellCount - 1,
            needCloseWsolAccount: i === sellCount - 1,
            initialWsolAccount: wsolAccount,
          });
          tx.add(sellTx);
        }

        let finalTx = getTx(tx, currentPayer, priorityFee, jito);

        const base64Tx = await getBase64Tx({
          tx: finalTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          simulate,
        });
        base64Txs.push(base64Tx);
      } catch (err) {
        console.log('raydium buyWithSell err: ', err);
        break;
      }
    }
  }

  return base64Txs;
};

// Get volume type configuration
const getVolumeTypeConfig = (volumeType: VolumeType): { buyCount: number; sellCount: number } => {
  switch (volumeType) {
    case VolumeType.ONE_BUY_ONE_SELL:
      return { buyCount: 1, sellCount: 1 };
    case VolumeType.ONE_BUY_TWO_SELL:
      return { buyCount: 1, sellCount: 2 };
    case VolumeType.ONE_BUY_THREE_SELL:
      return { buyCount: 1, sellCount: 3 };
    case VolumeType.TWO_BUY_ONE_SELL:
      return { buyCount: 2, sellCount: 1 };
    case VolumeType.THREE_BUY_ONE_SELL:
      return { buyCount: 3, sellCount: 1 };
    default:
      return { buyCount: 1, sellCount: 1 };
  }
};

export const meteoraDlmmBatchTrade = async ({
  connection,
  tokenAddress,
  poolId,
  tradeType,
  slippage,
  priorityFee,
  decimals,
  reverseInfo,
  creator,
  walletAmounts,
  bundleBuyTime,
  volumeType = VolumeType.ONE_BUY_ONE_SELL,
  simulate = false,
}: {
  connection: Connection;
  snipers?: Sniper[]; // Inner market snipers (bundle buy on launch)
  tokenAddress: string;
  poolId: string;
  tradeType: 'buy' | 'sell' | 'sniperBuy' | 'buyWithSell';
  slippage: number;
  priorityFee: number;
  decimals: number;
  reverseInfo?: MeteoraDLMMReverseInfo;
  creator: PublicKey;
  walletAmounts: WalletAmount[];
  bundleBuyTime?: BundleBuyTime;
  volumeType?: VolumeType;
  simulate?: boolean;
}): Promise<string[] | undefined> => {
  const provider = new AnchorProvider(
    connection as any,
    {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async () => {
        throw new Error('Signing not supported');
      },
      signAllTransactions: async () => {
        throw new Error('Signing not supported');
      },
    },
    {}
  );

  const binArray = await getBinArray({
    connection,
    poolId,
  });

  const MeteoraDLMM = await getMeteoraDLMM();
  const dlmmPool = await MeteoraDLMM.create(connection, new PublicKey(poolId), {
    programId: METEORA_DLMM_PROGRAM,
  });

  // Use provided reverseInfo or fetch pool data
  if (!reverseInfo) {
    throw new Error('Missing Meteora DLMM pool info');
  }

  console.log('  binStep:', typeof reverseInfo.binStep, reverseInfo.binStep);
  console.log('  activeId:', typeof reverseInfo.activeId, reverseInfo.activeId);

  const payers = walletAmounts.map(item => getWalletKeypair(item.privateKey));
  const jito = getJitoAdapter();
  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  const base64Txs = [];

  // Process trade logic
  if (tradeType === 'buy') {
    // try {
    for (const payer of walletAmounts) {
      const currentPayer = getWalletKeypair(payer.privateKey);
      const currentAmount = new BigNumber(payer.amount).times(LAMPORTS_PER_SOL).toFixed(0);

      // Calculate expected token amount received
      const swapQuote = dlmmPool.swapQuote(
        new BN(currentAmount),
        reverseInfo.reserveY == NATIVE_MINT.toBase58(),
        new BN(slippage),
        binArray
      );

      const buyTx = await meteoraDlmmBuyInstructions({
        provider,
        owner: currentPayer,
        mint: new PublicKey(tokenAddress),
        poolInfo: {
          poolId: poolId,
          mintA: reverseInfo.mintA,
          mintB: reverseInfo.mintB,
          reverseX: reverseInfo.reserveX,
          reverseY: reverseInfo.reserveY,
          oracle: reverseInfo.oracle,
        },
        amount: BigInt(currentAmount),
        tokenAmount: BigInt(swapQuote.minOutAmount.toString()),
        slippage,
        needCreateAtaAccount: true,
        needCloseTokenAccount: false,
        binArraysPubkey: swapQuote.binArraysPubkey,
      });

      const tx = getTx(buyTx, currentPayer, priorityFee, jito);

      const base64Tx = await getBase64Tx({
        tx,
        payer: currentPayer,
        signers: [currentPayer],
        blockhash,
        connection,
        simulate,
      });
      base64Txs.push(base64Tx);
    }
    return base64Txs;
    // } catch (error: any) {
    //   throw new Error(`Failed to build buy transaction instructions: ${error.message}`);
    // }
  } else if (tradeType === 'sell') {
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(10 ** decimals).toFixed(0);

        // Calculate expected SOL amount received
        const swapQuote = dlmmPool.swapQuote(
          new BN(currentAmount),
          reverseInfo.mintA == NATIVE_MINT.toBase58(),
          new BN(slippage),
          binArray
        );
        const swapQuote2 = dlmmPool.swapQuote(
          new BN(currentAmount),
          reverseInfo.mintA == NATIVE_MINT.toBase58(),
          new BN(10),
          binArray
        );

        const sellTx = await meteoraDlmmSellInstructions({
          provider,
          owner: currentPayer,
          mint: new PublicKey(tokenAddress),
          poolInfo: {
            poolId: poolId,
            mintA: reverseInfo.mintA,
            mintB: reverseInfo.mintB,
            reverseX: reverseInfo.reserveX,
            reverseY: reverseInfo.reserveY,
            oracle: reverseInfo.oracle,
          },
          amount: BigInt(currentAmount),
          minAmountOut: BigInt(new BigNumber(swapQuote.minOutAmount.toString()).toFixed(0)),
          needCreateAtaAccount: true,
          needCloseTokenAccount: true,
          binArraysPubkey: swapQuote.binArraysPubkey,
        });

        const tx = getTx(sellTx, currentPayer, priorityFee, jito);

        const base64Tx = await getBase64Tx({
          tx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          simulate: true,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      throw new Error(`Failed to build sell transaction instructions: ${error.message}`);
    }
  } else if (tradeType === 'buyWithSell') {
    // Implement Meteora DLMM multi-buy multi-sell logic
    try {
      for (const payer of walletAmounts) {
        const currentPayer = getWalletKeypair(payer.privateKey);
        const currentAmount = new BigNumber(payer.amount).times(LAMPORTS_PER_SOL).toFixed(0);

        // Pre-create wsolAccount
        const { wsolAccount, createWsolAccount } = await getNewWsolAccount(
          currentPayer.publicKey,
          new BigNumber(currentAmount).times(1 + slippage).toFixed(0)
        );

        // Create combined transaction
        const tx = new Transaction();
        let totalBuyReceiveAmount = new BN(0);

        // Determine buy and sell counts based on volumeType
        const { buyCount, sellCount } = getVolumeTypeConfig(volumeType);

        // Execute multiple buys
        let remainingAmount = new BigNumber(currentAmount);
        for (let i = 0; i < buyCount; i++) {
          let buyAmount: string;

          if (i === buyCount - 1) {
            // Use all remaining funds on the last buy
            buyAmount = remainingAmount.toFixed(0);
          } else {
            // Distribute evenly for earlier iterations
            buyAmount = new BigNumber(currentAmount).div(buyCount).toFixed(0);
            remainingAmount = remainingAmount.minus(buyAmount);
          }

          const swapQuote = dlmmPool.swapQuote(
            new BN(buyAmount),
            reverseInfo.reserveY == NATIVE_MINT.toBase58(),
            new BN(slippage),
            binArray
          );

          totalBuyReceiveAmount = totalBuyReceiveAmount.add(
            new BN(swapQuote.minOutAmount.toString())
          );

          // Add buy instruction
          const buyTx = await meteoraDlmmBuyExactOutInstructions({
            provider,
            owner: currentPayer,
            mint: new PublicKey(tokenAddress),
            poolInfo: {
              poolId: poolId,
              mintA: reverseInfo.mintA,
              mintB: reverseInfo.mintB,
              reverseX: reverseInfo.reserveX,
              reverseY: reverseInfo.reserveY,
              oracle: reverseInfo.oracle,
            },
            amountInMax: BigInt(buyAmount),
            tokenAmount: BigInt(swapQuote.minOutAmount.toString()),
            needCreateAtaAccount: i === 0, // Only create ATA on the first iteration
            needCloseTokenAccount: false,
            needCloseWsolAccount: false,
            initialWsolAccount: wsolAccount,
            createWsolAccountInstruction: i === 0 ? createWsolAccount : undefined,
            binArraysPubkey: swapQuote.binArraysPubkey,
          });

          // Add buy transaction instructions
          tx.add(...buyTx.instructions);
        }

        // Execute multiple sells
        const avgSellAmount = totalBuyReceiveAmount.div(new BN(sellCount));
        for (let i = 0; i < sellCount; i++) {
          let sellAmount: BN;

          if (i === sellCount - 1) {
            // On last sell, sell all remaining tokens
            sellAmount = totalBuyReceiveAmount;
          } else {
            sellAmount = avgSellAmount;
            totalBuyReceiveAmount = totalBuyReceiveAmount.sub(avgSellAmount);
          }

          const swapQuote = dlmmPool.swapQuote(
            new BN(sellAmount),
            reverseInfo.mintA == NATIVE_MINT.toBase58(),
            new BN(10),
            binArray
          );

          // Add sell instruction
          const sellTx = await meteoraDlmmSellInstructions({
            provider,
            owner: currentPayer,
            mint: new PublicKey(tokenAddress),
            poolInfo: {
              poolId: poolId,
              mintA: reverseInfo.mintA,
              mintB: reverseInfo.mintB,
              reverseX: reverseInfo.reserveX,
              reverseY: reverseInfo.reserveY,
              oracle: reverseInfo.oracle,
            },
            amount: BigInt(sellAmount.toString()),
            minAmountOut: BigInt(0),
            needCreateAtaAccount: false,
            needCloseTokenAccount: i === sellCount - 1, // Only close Token account on the last iteration
            needCloseWsolAccount: i === sellCount - 1, // Only close WSOL account on the last iteration
            initialWsolAccount: wsolAccount,
            binArraysPubkey: swapQuote.binArraysPubkey,
          });

          // Add sell transaction instructions
          tx.add(...sellTx.instructions);
        }

        const finalTx = getTx(tx, currentPayer, priorityFee, jito);

        const base64Tx = await getBase64Tx({
          tx: finalTx,
          payer: currentPayer,
          signers: [currentPayer],
          blockhash,
          connection,
          simulate,
        });
        base64Txs.push(base64Tx);
      }
      return base64Txs;
    } catch (error: any) {
      throw new Error(`Failed to build buy+sell combo transaction instructions: ${error.message}`);
    }
  }

  throw new Error(`Unsupported trade type: ${tradeType}`);
};

const getBase64Tx = async ({
  tx,
  payer,
  signers,
  blockhash,
  connection,
  lutAccount,
  simulate = false,
}: {
  tx: Transaction;
  payer: Keypair;
  signers: Keypair[];
  blockhash: string;
  connection: Connection;
  lutAccount?: AddressLookupTableAccount;
  simulate?: boolean;
}) => {
  // Use VersionedTransaction when LUT is available, otherwise use legacy Transaction (more stable format)
  if (lutAccount) {
    const messageV0 = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions: tx.instructions,
    }).compileToV0Message([lutAccount]);
    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign(signers);
    if (simulate) {
      const log = await connection.simulateTransaction(versionedTx);
      console.log('simulate log: ', log);
      if (log.value.err) throw new Error(JSON.stringify(log.value.err));
    }
    const serializedTx = versionedTx.serialize();
    return Buffer.from(serializedTx).toString('base64');
  }

  // Legacy transaction (no LUT)
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  if (simulate) {
    const log = await connection.simulateTransaction(tx);
    if (log.value.err) throw new Error(JSON.stringify({ err: log.value.err, logs: log.value.logs }));
  }
  const serialized = tx.serialize();
  return Buffer.from(serialized).toString('base64');
};

const getTx = (
  tx: Transaction,
  payer: Keypair,
  priorityFee: number,
  jito?: { getTipInstruction: (payer: PublicKey, tipAmountSol: number) => any },
  cuLimit?: number,
  addComputeBudget: boolean = true
) => {
  const transaction = new Transaction();
  transaction.add(tx);

  if (addComputeBudget) {
    const cu = getCU(priorityFee, cuLimit);
    transaction.add(cu.limitIx);
    transaction.add(cu.priceIx);
  }
  if (jito) {
    transaction.add(jito.getTipInstruction(payer.publicKey, priorityFee));
  }
  return transaction;
};
