import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { pumpCreateAndDevBuyInstruction, pumpCreateSPLInstruction } from '../pump';
import { launchlabCreateAndDevBuyInstruction, launchlabCreateInstruction } from '../launchlab';
import { PumpAmmCalc, LaunchlabAmmCalc } from '../calc';
import BigNumber from 'bignumber.js';
import { getWalletAddress, getWalletKeypair } from '@/utils';
import { createLutAccount, extendLutAccount } from '../account';
interface Provider {
  signTransaction<T extends import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction>(transaction: T): Promise<T>;
}
import { PUMP_FUN_PROGRAM } from '@/const';
import { getJitoAdapter } from '@/adapters/jito-adapter.js';
import { sleep } from '@/utils';
import { pumpBatchTrade, Sniper, launchlabBatchTrade } from './index';
import { transferSOLInstruction } from '@/sol-sdk/transfer';
import { getTransactionStatus } from '@/sol-sdk/rpc';
import { getBondingCurvePDA } from '../pump';
import { BundleBuyTime, CreateCoinResult, CreateStatusCallback, StepStatus } from '@/types';

let redis: ClientRedis = {
  pumpCache: {},
  pumpAtaCache: {},
  pumpSwapCache: {},
  pumpSwapAtaCache: {},
};

export const createCoin = async ({
  connection,
  snipers,
  devWallet,
  devBuyAmount,
  jitoTips,
  mint,
  name,
  symbol,
  uri,
  walletProvider,
  bundleBuyTime,
  onStatusUpdate,
  dex = 'launchlab',
  fixedAmount,
}: {
  connection: Connection;
  snipers?: Sniper[];
  devWallet: string | Keypair;
  devBuyAmount?: string;
  jitoTips: number;
  mint: Keypair;
  name: string;
  symbol: string;
  uri: string;
  walletProvider?: Provider;
  bundleBuyTime: BundleBuyTime;
  onStatusUpdate?: CreateStatusCallback;
  dex: 'pump' | 'launchlab';
  fixedAmount?: string;
}): Promise<CreateCoinResult> => {
  try {
    // Pool ID
    const bonding_curve_pda = getBondingCurvePDA(mint.publicKey);

    const jitoAdapter = getJitoAdapter();
    // Calculator instances
    const pumpCalc = new PumpAmmCalc({});
    const launchlabCalc = new LaunchlabAmmCalc({});

    const devPayer = walletProvider ? new PublicKey(devWallet) : (devWallet as Keypair).publicKey;
    // Developer buy
    const hasDevBuy =
      (devBuyAmount && new BigNumber(devBuyAmount).gt(0)) ||
      (fixedAmount && new BigNumber(fixedAmount).gt(0));

    // ========== Build transactions ==========
    const txs: string[] = [];

    if (bundleBuyTime === BundleBuyTime.T0 && hasDevBuy) {
      // T0 mode: combine create + devBuy into one tx (Jito Bundle simulation requires buy to see create state)
      let tokenAmount, pumpDevSolNeed;
      if (dex === 'pump') {
        if (fixedAmount) {
          tokenAmount = new BigNumber(fixedAmount).times(10 ** 6).toString(10);
          pumpDevSolNeed = pumpCalc.calculateBuyExactAmountOut(tokenAmount);
        } else {
          tokenAmount = pumpCalc.calculateBuyAmountOut(
            new BigNumber(devBuyAmount || '0').times(LAMPORTS_PER_SOL).toString(10)
          );
        }
      } else {
        tokenAmount = launchlabCalc.calculateBuyAmountOut(
          new BigNumber(devBuyAmount || '0').times(LAMPORTS_PER_SOL).toString(10)
        );
      }
      const actualBuyAmount = devBuyAmount || '0';

      // pumpCreateAndDevBuyInstruction returns a Transaction with all create + buy instructions
      const createAndBuyTx =
        dex === 'pump'
          ? await pumpCreateAndDevBuyInstruction({
              connection,
              payer: devPayer,
              mint,
              name,
              symbol,
              uri,
              buyAmount: actualBuyAmount,
              slippageDecimal: 0.3,
              tokenAmount: tokenAmount.toString(10),
            })
          : await launchlabCreateAndDevBuyInstruction({
              connection,
              payer: devPayer,
              mint,
              name,
              symbol,
              uri,
              buyAmount: actualBuyAmount,
            });

      // T0 Bundle does not need ComputeBudget (bidding via Jito tip), filter out ComputeBudget instructions to reduce tx size
      const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58();
      const filteredIx = createAndBuyTx.instructions.filter(
        ix => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID
      );
      const compactTx = new Transaction();
      filteredIx.forEach(ix => compactTx.add(ix));

      // Add Jito tip
      compactTx.add(jitoAdapter.getTipInstruction(devPayer, jitoTips));
      compactTx.feePayer = devPayer;

      // T0 uses VersionedTransaction(v0) for bundle comparison
      const { blockhash } = await connection.getLatestBlockhash('processed');
      const messageV0 = new TransactionMessage({
        payerKey: devPayer,
        recentBlockhash: blockhash,
        instructions: compactTx.instructions,
      }).compileToV0Message();
      const versionedTx = new VersionedTransaction(messageV0);

      if (walletProvider) {
        const signed = await walletProvider.signTransaction(versionedTx as any);
        if (!signed) {
          throw new Error('User rejected the create+buy versioned transaction');
        }
        if (mint) versionedTx.sign([mint]);
      } else {
        versionedTx.sign(mint ? [devWallet as Keypair, mint] : [devWallet as Keypair]);
      }

      const serialized = versionedTx.serialize();
      console.log(`[T0] create+devBuy+tip(v0) combined tx size: ${serialized.length} bytes`);
      txs.push(Buffer.from(serialized).toString('base64'));
    } else {
      // Non-T0: combine create + buy + tip into one transaction
      const devTx = new Transaction();

      const createOnlyTx =
        dex === 'pump'
          ? await pumpCreateSPLInstruction(connection, devPayer, mint, name, symbol, uri)
          : await launchlabCreateInstruction({
              connection,
              owner: devPayer,
              mint,
              tokenName: name,
              tokenSymbol: symbol,
              tokenUri: uri,
            });
      devTx.add(createOnlyTx);

      if (hasDevBuy) {
        let tokenAmount, pumpDevSolNeed;
        if (dex === 'pump') {
          if (fixedAmount) {
            tokenAmount = new BigNumber(fixedAmount).times(10 ** 6).toString(10);
            pumpDevSolNeed = pumpCalc.calculateBuyExactAmountOut(tokenAmount);
          } else {
            tokenAmount = pumpCalc.calculateBuyAmountOut(
              new BigNumber(devBuyAmount || '0').times(LAMPORTS_PER_SOL).toString(10)
            );
          }
        } else {
          tokenAmount = launchlabCalc.calculateBuyAmountOut(
            new BigNumber(devBuyAmount || '0').times(LAMPORTS_PER_SOL).toString(10)
          );
        }
        const actualBuyAmount =
          fixedAmount && new BigNumber(fixedAmount).gt(0)
            ? new BigNumber(pumpDevSolNeed?.toString() || '0').div(LAMPORTS_PER_SOL).toFixed(9)
            : devBuyAmount || '0';

        const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();
        const buyInstruction =
          dex === 'pump'
            ? (
                await pumpCreateAndDevBuyInstruction({
                  connection,
                  payer: devPayer,
                  mint,
                  name,
                  symbol,
                  uri,
                  buyAmount: actualBuyAmount,
                  slippageDecimal: 0.3,
                  tokenAmount: tokenAmount.toString(10),
                })
              ).instructions.filter((ix, index) => index > 0 && ix.programId.toBase58() !== COMPUTE_BUDGET_ID)
            : (
                await launchlabCreateAndDevBuyInstruction({
                  connection,
                  payer: devPayer,
                  mint,
                  name,
                  symbol,
                  uri,
                  buyAmount: actualBuyAmount,
                })
              ).instructions.filter((ix, index) => index > 0 && ix.programId.toBase58() !== COMPUTE_BUDGET_ID);

        buyInstruction.forEach(ix => devTx.add(ix));
      }

      devTx.add(jitoAdapter.getTipInstruction(devPayer, jitoTips));
      devTx.feePayer = devPayer;

      const signedDevTx = await devSignTx({
        connection,
        tx: devTx,
        devWallet: devWallet,
        mint,
        walletProvider,
      });
      if (!signedDevTx) {
        throw new Error('User rejected the transaction');
      }
      txs.push(Buffer.from(signedDevTx.serialize()).toString('base64'));
    }

    // ========== Simulate transaction ==========
    try {
      const txToSimulate = VersionedTransaction.deserialize(Buffer.from(txs[0], 'base64'));
      const createLog = await connection.simulateTransaction(txToSimulate);
      console.log('Create transaction simulation:', createLog);
    } catch (error) {
      console.log('Create transaction simulation error:', error);
      return {
        success: false,
        steps: [],
        bundleIds: {},
        error: 'Create transaction simulation failed',
      };
    }

    const currentReverse: any =
      dex === 'pump' ? pumpCalc.getReserves() : launchlabCalc.getReserves();
    const price = dex === 'pump' ? pumpCalc.getPrice() : launchlabCalc.getPrice();

    let devTxHash: string | undefined;
    let devCompleted = false;
    let snipersTxs: string[] = [];
    let sniperTxHash: string | undefined;

    // ========== T0 mode: bundle all transactions into one Jito Bundle for same-block execution ==========
    if (bundleBuyTime === BundleBuyTime.T0) {
      // Build sniper transactions (if any)
      if (snipers && snipers.length > 0) {
        // T0 mode does not support LUT (LUT creation needs confirmation first, cannot be same-block), limit sniper <= 16
        if (snipers.length > 16) {
          throw new Error('T0 mode: sniper wallet count cannot exceed 16 (LUT not available)');
        }
        const signResult =
          dex === 'pump'
            ? await pumpBatchTrade({
                connection,
                snipers,
                tokenAddress: mint.publicKey.toBase58(),
                poolId: bonding_curve_pda.toBase58(),
                tradeType: 'sniperBuy',
                slippage: 0.3,
                priorityFee: jitoTips,
                priceInSol: new BigNumber(price.toString()).toString(10),
                initialPoolData: {
                  virtualSolReserves: currentReverse.virtualSolReserves.toString(),
                  virtualTokenReserves: currentReverse.virtualTokenReserves.toString(),
                  realTokenReserves: currentReverse.realTokenReserves.toString(),
                  realSolReserves: currentReverse.realSolReserves.toString(),
                  tokenTotalSupply: currentReverse.tokenTotalSupply.toString(),
                  complete: false,
                },
                creator: devPayer,
                walletAmounts: [],
                bundleBuyTime,
              })
            : await launchlabBatchTrade({
                connection,
                snipers,
                tokenAddress: mint.publicKey.toBase58(),
                poolId: bonding_curve_pda.toBase58(),
                tradeType: 'sniperBuy',
                slippage: 0.05,
                priorityFee: jitoTips,
                decimals: 6,
                reverseInfo: currentReverse as LaunchlabReverseInfo,
                creator: devPayer,
                walletAmounts: [],
                bundleBuyTime,
              });
        if (signResult) {
          snipersTxs = signResult;
        }
      }

      // T0: Send each transaction via sendTransaction
      console.log(`[T0] Sending dev transaction + ${snipersTxs.length} sniper transactions, mode: sendTransaction`);

      try {
        onStatusUpdate?.('dev-create', StepStatus.PROCESSING);
        if (hasDevBuy) onStatusUpdate?.('dev-buy', StepStatus.PROCESSING);

        // Send dev transaction
        const devResult = await jitoAdapter.sendTransaction(txs[0]);
        devTxHash = devResult.txHash;
        console.log(`[T0] Dev transaction sent, txHash: ${devTxHash}`);

        devCompleted = true;
        onStatusUpdate?.('dev-create', StepStatus.COMPLETED);
        if (hasDevBuy) onStatusUpdate?.('dev-buy', StepStatus.COMPLETED);

        // Send sniper transactions (in T0 mode sniper follows dev immediately)
        if (snipersTxs.length > 0) {
          (snipers || []).forEach((_, index) => {
            onStatusUpdate?.(`sniper-${index}`, StepStatus.PROCESSING);
          });

          const sniperResults = await Promise.all(
            snipersTxs.map(tx => jitoAdapter.sendTransaction(tx))
          );
          sniperTxHash = sniperResults[0]?.txHash;
          console.log(`[T0] ${sniperResults.length} sniper transactions sent`);

          (snipers || []).forEach((_, index) => {
            onStatusUpdate?.(`sniper-${index}`, StepStatus.COMPLETED);
          });
        }
      } catch (err: any) {
        if (!devCompleted) {
          onStatusUpdate?.('dev-create', StepStatus.FAILED, err.message || 'error');
          if (hasDevBuy) onStatusUpdate?.('dev-buy', StepStatus.FAILED, err.message || 'error');
        }
        (snipers || []).forEach((_, index) => {
          onStatusUpdate?.(`sniper-${index}`, StepStatus.FAILED, err.message || 'error');
        });
        console.log(`[T0] Failed: ${err.message}`);
      }
    }
    // ========== T1_T5 mode: send dev and sniper Bundle in parallel ==========
    else {
      // Build sniper transactions first (do not wait for dev confirmation)
      if (snipers && snipers.length > 0) {
        if (snipers.length > 16) {
          const payer = getWalletKeypair(snipers[0].wallet);
          const lut = await createLutAccount(connection, payer);
          if (!lut) {
            throw new Error('Failed to create lookup table');
          }
          const createLutResult = await jitoAdapter.sendTransaction(lut.base64Tx);
          const createLutConfirm = await jitoAdapter.confirmTransactionByRpc(
            connection,
            createLutResult.txHash,
            30000
          );
          if (!createLutConfirm.success) {
            throw new Error(`Failed to create lookup table: ${createLutConfirm.error}`);
          }

          const extendLut = await extendLutAccount(
            connection,
            payer,
            lut.lutAddress,
            snipers.map(item => new PublicKey(getWalletAddress(item.wallet))),
            mint.publicKey
          );
          if (!extendLut) {
            throw new Error('Failed to extend lookup table');
          }

          for (const lutTx of extendLut) {
            const lutResult = await jitoAdapter.sendTransaction(lutTx);
            const lutConfirm = await jitoAdapter.confirmTransactionByRpc(
              connection,
              lutResult.txHash,
              30000
            );
            if (!lutConfirm.success) {
              throw new Error(`Failed to extend lookup table: ${lutConfirm.error}`);
            }
          }
          let lookupTableAccount;
          while (true) {
            lookupTableAccount = (await connection.getAddressLookupTable(lut.lutAddress)).value;
            if (lookupTableAccount) {
              break;
            }
            await sleep(1000);
          }
          const signResult =
            dex === 'pump'
              ? await pumpBatchTrade({
                  connection,
                  snipers,
                  tokenAddress: mint.publicKey.toBase58(),
                  poolId: bonding_curve_pda.toBase58(),
                  tradeType: 'sniperBuy',
                  slippage: 1,
                  priorityFee: jitoTips,
                  priceInSol: new BigNumber(price.toString()).toString(10),
                  initialPoolData: {
                    virtualSolReserves: currentReverse.virtualSolReserves.toString(),
                    virtualTokenReserves: currentReverse.virtualTokenReserves.toString(),
                    realTokenReserves: currentReverse.realTokenReserves.toString(),
                    realSolReserves: currentReverse.realSolReserves.toString(),
                    tokenTotalSupply: currentReverse.tokenTotalSupply.toString(),
                    complete: false,
                  } as any as PumpfunReverseInfo,
                  lutAccount: lookupTableAccount,
                  creator: devPayer,
                  walletAmounts: [],
                  bundleBuyTime,
                })
              : await launchlabBatchTrade({
                  connection,
                  snipers,
                  tokenAddress: mint.publicKey.toBase58(),
                  poolId: bonding_curve_pda.toBase58(),
                  tradeType: 'sniperBuy',
                  slippage: 1,
                  priorityFee: jitoTips,
                  decimals: 6,
                  reverseInfo: currentReverse as LaunchlabReverseInfo,
                  creator: devPayer,
                  walletAmounts: [],
                  bundleBuyTime,
                });
          if (signResult) {
            snipersTxs = signResult;
          }
        } else {
          const signResult =
            dex === 'pump'
              ? await pumpBatchTrade({
                  connection,
                  snipers,
                  tokenAddress: mint.publicKey.toBase58(),
                  poolId: bonding_curve_pda.toBase58(),
                  tradeType: 'sniperBuy',
                  slippage: 0.3,
                  priorityFee: jitoTips,
                  priceInSol: new BigNumber(price.toString()).toString(10),
                  initialPoolData: {
                    virtualSolReserves: currentReverse.virtualSolReserves.toString(),
                    virtualTokenReserves: currentReverse.virtualTokenReserves.toString(),
                    realTokenReserves: currentReverse.realTokenReserves.toString(),
                    realSolReserves: currentReverse.realSolReserves.toString(),
                    tokenTotalSupply: currentReverse.tokenTotalSupply.toString(),
                    complete: false,
                  },
                  creator: devPayer,
                  walletAmounts: [],
                  bundleBuyTime,
                })
              : await launchlabBatchTrade({
                  connection,
                  snipers,
                  tokenAddress: mint.publicKey.toBase58(),
                  poolId: bonding_curve_pda.toBase58(),
                  tradeType: 'sniperBuy',
                  slippage: 0.05,
                  priorityFee: jitoTips,
                  decimals: 6,
                  reverseInfo: currentReverse as LaunchlabReverseInfo,
                  creator: devPayer,
                  walletAmounts: [],
                  bundleBuyTime,
                });
          if (signResult) {
            snipersTxs = signResult;
          }
        }
      }

      // T1_T5: Send each transaction via sendTransaction
      onStatusUpdate?.('dev-create', StepStatus.PROCESSING);
      if (hasDevBuy) {
        onStatusUpdate?.('dev-buy', StepStatus.PROCESSING);
      }

      try {
        // Send dev transaction (already merged create + buy + tip)
        const devResult = await jitoAdapter.sendTransaction(txs[0]);
        devTxHash = devResult.txHash;
        console.log(`[T1_T5] Dev transaction sent, txHash: ${devTxHash}`);

        // Mark as sent without waiting for confirmation
        devCompleted = true;
        onStatusUpdate?.('dev-create', StepStatus.COMPLETED);
        if (hasDevBuy) {
          onStatusUpdate?.('dev-buy', StepStatus.COMPLETED);
        }
      } catch (err: any) {
        onStatusUpdate?.('dev-create', StepStatus.FAILED, err.message || 'Dev transaction error');
        if (hasDevBuy) {
          onStatusUpdate?.('dev-buy', StepStatus.FAILED, err.message || 'Dev transaction error');
        }
        console.log(`[T1_T5] Dev transaction failed: ${err.message}`);
      }

      // After dev is sent, wait 800ms then send sniper transactions (no need to wait for dev confirmation)
      if (snipersTxs.length > 0 && devCompleted) {
        await new Promise(resolve => setTimeout(resolve, 800));
        console.log(`[T1_T5] Waiting 800ms before sending sniper transactions`);

        (snipers || []).forEach((_, index) => {
          onStatusUpdate?.(`sniper-${index}`, StepStatus.PROCESSING);
        });

        try {
          const sniperResults = await Promise.all(
            snipersTxs.map(tx => jitoAdapter.sendTransaction(tx))
          );
          sniperTxHash = sniperResults[0]?.txHash;
          console.log(`[T1_T5] ${sniperResults.length} sniper transactions sent`);

          (snipers || []).forEach((_, index) => {
            onStatusUpdate?.(`sniper-${index}`, StepStatus.COMPLETED);
          });
        } catch (sniperErr: any) {
          (snipers || []).forEach((_, index) => {
            onStatusUpdate?.(
              `sniper-${index}`,
              StepStatus.FAILED,
              sniperErr.message || 'Sniper transaction error'
            );
          });
        }
      }
    }

    // ========== Build final result ==========
    const steps = [
      {
        id: 'dev-create',
        name: 'Dev wallet creates token',
        status: devCompleted ? StepStatus.COMPLETED : StepStatus.FAILED,
      },
    ];

    // Only add dev-buy step when dev has a purchase
    if (
      (devBuyAmount && new BigNumber(devBuyAmount).gt(0)) ||
      (fixedAmount && new BigNumber(fixedAmount).gt(0))
    ) {
      steps.push({
        id: 'dev-buy',
        name: 'Dev wallet buys token',
        status: devCompleted ? StepStatus.COMPLETED : StepStatus.FAILED,
      });
    }

    // Add sniper steps
    steps.push(
      ...(snipers || []).map((sniper, index) => ({
        id: `sniper-${index}`,
        name: `Wallet buys token`,
        status: sniperTxHash ? StepStatus.COMPLETED : StepStatus.FAILED,
        walletAddress: getWalletAddress(sniper.wallet),
      }))
    );

    return {
      success: devCompleted, // Overall success if dev succeeds; sniper failure does not block flow
      steps,
      bundleIds: {
        devBundle: devTxHash,
        sniperBundle: sniperTxHash,
      },
      mintAddress: mint.publicKey.toBase58(),
    };
  } catch (error) {
    throw error;
  }
};

const devSignTx = async ({
  connection,
  tx,
  devWallet,
  mint,
  walletProvider,
}: {
  connection: Connection;
  tx: Transaction;
  devWallet: string | Keypair;
  mint?: Keypair;
  walletProvider?: Provider;
}): Promise<VersionedTransaction | undefined> => {
  const devPayer = walletProvider ? new PublicKey(devWallet) : (devWallet as Keypair).publicKey;
  const messageV0 = new TransactionMessage({
    payerKey: devPayer,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: tx.instructions,
  }).compileToV0Message([]);
  const versionedTx = new VersionedTransaction(messageV0);
  let signedTx;
  if (walletProvider) {
    try {
      if (mint) {
        versionedTx.sign([mint]);
      }
      signedTx = await walletProvider.signTransaction(versionedTx);
      return signedTx;
    } catch (error) {
      throw error;
    }
  } else {
    const signs = [];
    signs.push(devWallet as Keypair);
    if (mint) {
      signs.push(mint);
    }
    versionedTx.sign(signs);
  }
  return versionedTx;
};
