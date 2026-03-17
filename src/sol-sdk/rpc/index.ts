import {
  Connection,
  Commitment,
  PublicKey,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { store } from '@/store';
import { BN } from 'bn.js';
import { sleep } from '@/utils';
import BigNumber from 'bignumber.js';

const NATIVE_COIN = 'SOL';

export const getConnection = (url: string, commitment: Commitment = 'processed') => {
  return new Connection(url, commitment);
};

export const getNativeBalance = async (
  connection: Connection,
  address: string
): Promise<number> => {
  const balance = await connection.getBalance(new PublicKey(address));
  const amount = new BigNumber(balance).div(new BigNumber(LAMPORTS_PER_SOL)).toNumber();
  if (Number(amount) <= 0) {
    return 0;
  }
  return amount;
};

export const getTokenAccountBalance = async (
  connection: Connection,
  mint: string,
  address: string
): Promise<number> => {
  // Try SPL Token first, then Token-2022
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ataAccount = await getAssociatedTokenAddress(
        new PublicKey(mint),
        new PublicKey(address),
        false,
        programId
      );
      const tokenAccountBalance = await connection.getTokenAccountBalance(ataAccount);
      if (tokenAccountBalance.value.uiAmount) return tokenAccountBalance.value.uiAmount;
    } catch (err) {
      // continue to next program
    }
  }
  return 0;
};

export const getMultipleTokenAccountBalanceByOwners = async (
  connection: Connection,
  wallets: string[],
  tokenAddresses: string
) => {
  const tokenAccountBalances = await Promise.all(
    wallets.map(wallet => getTokenAccountBalance(connection, tokenAddresses, wallet))
  );
  return tokenAccountBalances;
};

export const getTokenAccountsByOwner = async (
  connection: Connection,
  address: string,
  tokenAddress: string
) => {
  const tokenAccount = await connection.getTokenAccountsByOwner(new PublicKey(address), {
    mint: new PublicKey(tokenAddress),
  });
  return tokenAccount;
};

/**
 * Get balance or token balance after deducting gas fee and priority fee
 * @param address Address
 * @param tokenAddress Token address
 * @param leftFee Whether to deduct gas fee and priority fee
 * @param priorityFee Priority fee
 * @param solBalance Known balance
 * @returns Balance or token balance (uiAmount)
 */
export const getAccountBalanceLeftFee = async (
  address: string,
  tokenAddress: string,
  leftFee: boolean, // Whether to deduct gas fee and priority fee
  priorityFee?: number, // Priority fee
  solBalance?: number, // Balance
  fromTransfer?: boolean // Whether called from transfer/aggregation page
): Promise<number> => {
  // try {
  const {
    gasSettings: { priorityFee: systemPriorityFee },
    rpcUrl,
  } = store.getState().settings;
  // For transactions, deduct double the priority fee
  const fee =
    (Number(priorityFee == undefined ? systemPriorityFee : priorityFee) *
      (fromTransfer ? 1 : 2) *
      LAMPORTS_PER_SOL +
      5000) /
    LAMPORTS_PER_SOL;
  if (solBalance) {
    return new BigNumber(solBalance).minus(new BigNumber(fee)).toNumber();
  }
  const connection = new Connection(rpcUrl, 'processed');
  if (tokenAddress === NATIVE_MINT.toBase58() || tokenAddress === NATIVE_COIN) {
    const balance = await getNativeBalance(connection, address);
    if (leftFee) {
      const amount = new BigNumber(balance).minus(new BigNumber(fee)).toNumber();
      if (Number(amount) <= 0 || isNaN(Number(amount))) {
        return 0;
      }
      return amount;
    } else {
      return balance;
    }
  } else {
    return await getTokenAccountBalance(connection, tokenAddress, address);
  }
  // } catch (error) {
  //   console.log('error', error);
  //   return 0;
  // }
};

export const getMultipleAccountBalanceLeftFee = async (
  wallets: string[],
  tokenAddress: string,
  leftFee: boolean,
  priorityFee?: number,
  solBalance?: number, // Balance
  fromTransfer?: boolean // Whether called from transfer/aggregation page
) => {
  const tokenAccountBalances = await Promise.all(
    wallets.map(wallet =>
      getAccountBalanceLeftFee(wallet, tokenAddress, leftFee, priorityFee, solBalance, fromTransfer)
    )
  );
  return tokenAccountBalances;
};

/**
 * Get CU and price
 * @param priorityFee Priority fee (uiAmount)
 * @param estimateCU Estimated CU
 * @returns { limitIx: TransactionInstruction; priceIx: TransactionInstruction }
 */
export const getCU = (
  priorityFee: number,
  estimateCU?: number
): { limitIx: TransactionInstruction; priceIx: TransactionInstruction } => {
  let cuLimit = estimateCU || 200_000;
  const totalPriorityFeeSOL = priorityFee;
  const totalPriorityFeeLamports = totalPriorityFeeSOL * LAMPORTS_PER_SOL;
  const microLamports = Math.floor((totalPriorityFeeLamports / cuLimit) * 1_000_000);
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit });
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  return { limitIx, priceIx };
};

export const getTransactionStatus = async (
  connection: Connection,
  txHash: string,
  attempts: number = 0,
  interval: number = 3000
): Promise<boolean> => {
  const signatureStatuses = await connection.getSignatureStatuses([txHash]);
  const status = signatureStatuses.value[0];
  if (status) {
    if (status && status.err) {
      return false;
    } else {
      return true;
    }
  }
  if (status == null) {
    return false;
  }

  await sleep(interval);
  if (attempts < 5) {
    return await getTransactionStatus(connection, txHash, attempts + 1, interval);
  }
  return false;
};
