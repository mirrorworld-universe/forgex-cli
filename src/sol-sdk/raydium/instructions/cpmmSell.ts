import {
  CpmmKeys,
  ApiV3PoolInfoStandardItemCpmm,
  makeSwapCpmmBaseInInstruction,
} from '@raydium-io/raydium-sdk-v2';
import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
} from '@solana/spl-token';
import { Transaction, Keypair, PublicKey, SystemProgram, Connection } from '@solana/web3.js';
import BN from 'bn.js';
import BigNumber from 'bignumber.js';

const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const RAYDIUM_AUTHORITY = new PublicKey('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');

export const cpmmSellInstruction = async ({
  amount,
  owner,
  poolKeys,
  poolId,
  mintA,
  mintB,
  minAmountOut,
  connection,
  needCreateAtaAccount,
  needCloseTokenAccount,
  needCloseWsolAccount,
  initialWsolAccount,
}: {
  amount: string;
  owner: PublicKey;
  poolKeys: CpmmKeys;
  poolId: string;
  mintA: string;
  mintB: string;
  minAmountOut: string;
  connection: Connection;
  needCreateAtaAccount: boolean;
  needCloseTokenAccount: boolean;
  needCloseWsolAccount: boolean;
  initialWsolAccount?: PublicKey;
}): Promise<Transaction> => {
  const amountOut = new BigNumber(amount);
  const sellAmount = amountOut.toString(10);

  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  const createWsolAccount = SystemProgram.createAccountWithSeed({
    fromPubkey: owner,
    newAccountPubkey: wsolAccount,
    basePubkey: owner,
    lamports: new BN(baseLamports).toNumber(),
    space: 165,
    programId: TOKEN_PROGRAM_ID,
    seed,
  });

  const tokenMint = mintA == NATIVE_MINT.toBase58() ? mintB : mintA;

  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner);

  // Check token account balance
  // let shouldCloseTokenAccount = false;
  // try {
  //   const balance = await connection.getTokenAccountBalance(tokenAccount);
  //   shouldCloseTokenAccount = balance.value.amount === sellAmount;
  // } catch (error) {
  //   // If balance fetch fails, don't close account
  //   console.warn('Failed to get token account balance:', error);
  // }

  if (needCreateAtaAccount) {
    transaction.add(
      createWsolAccount,
      createInitializeAccountInstruction(wsolAccount, NATIVE_MINT, owner)
    );

    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        tokenAccount,
        owner,
        new PublicKey(tokenMint)
      )
    );
  }

  const swapInstruction = makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM_ID,
    owner,
    RAYDIUM_AUTHORITY,
    new PublicKey(poolKeys.config.id),
    new PublicKey(poolId),
    tokenAccount,
    wsolAccount,
    mintA == NATIVE_MINT.toBase58()
      ? new PublicKey(poolKeys.vault.B)
      : new PublicKey(poolKeys.vault.A),
    mintA == NATIVE_MINT.toBase58()
      ? new PublicKey(poolKeys.vault.A)
      : new PublicKey(poolKeys.vault.B),
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(tokenMint),
    NATIVE_MINT,
    new PublicKey(poolKeys.observationId),
    new BN(sellAmount),
    new BN(minAmountOut)
  );

  transaction.add(swapInstruction);

  // If selling entire balance, close token account
  // if (shouldCloseTokenAccount || needCloseTokenAccount) {
  //   transaction.add(createCloseAccountInstruction(tokenAccount, owner, owner));
  // }

  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};
