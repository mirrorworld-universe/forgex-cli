import {
  CpmmKeys,
  ApiV3PoolInfoStandardItemCpmm,
  makeSwapCpmmBaseInInstruction,
  makeSwapCpmmBaseOutInstruction,
} from '@raydium-io/raydium-sdk-v2';
import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
} from '@solana/spl-token';
import {
  Transaction,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import BigNumber from 'bignumber.js';

const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const RAYDIUM_AUTHORITY = new PublicKey('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');

export const cpmmSwapBaseOutBuyInstruction = async ({
  amountInMax,
  owner,
  poolKeys,
  poolId,
  mintA,
  mintB,
  amountOut,
  needCreateAtaAccount,
  needCloseTokenAccount,
  initialWsolAccount,
  createWsolAccountInstruction,
}: {
  amountInMax: string;
  owner: PublicKey;
  poolKeys: CpmmKeys;
  poolId: string;
  mintA: string;
  mintB: string;
  amountOut: string;
  needCreateAtaAccount: boolean;
  needCloseTokenAccount: boolean;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
}): Promise<Transaction> => {
  const buyAmount = new BigNumber(amountInMax).toString(10);

  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  const lamports = new BN(baseLamports).add(new BN(buyAmount)).toNumber();

  const createWsolAccount =
    createWsolAccountInstruction ||
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner,
      newAccountPubkey: wsolAccount,
      basePubkey: owner,
      lamports,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

  const tokenMint = mintA == NATIVE_MINT.toBase58() ? mintB : mintA;

  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner);

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

  const swapInstruction = makeSwapCpmmBaseOutInstruction(
    RAYDIUM_CPMM_PROGRAM_ID,
    owner,
    RAYDIUM_AUTHORITY,
    new PublicKey(poolKeys.config.id),
    new PublicKey(poolId),
    wsolAccount,
    tokenAccount,
    mintA == NATIVE_MINT.toBase58()
      ? new PublicKey(poolKeys.vault.A)
      : new PublicKey(poolKeys.vault.B),
    mintA == NATIVE_MINT.toBase58()
      ? new PublicKey(poolKeys.vault.B)
      : new PublicKey(poolKeys.vault.A),
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    new PublicKey(tokenMint),
    new PublicKey(poolKeys.observationId),
    new BN(buyAmount),
    new BN(amountOut)
  );

  transaction.add(swapInstruction);

  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};

export const cpmmSwapBaseInBuyInstruction = async ({
  amountInMax,
  owner,
  poolKeys,
  poolId,
  mintA,
  mintB,
  amountOutMin,
  needCreateAtaAccount,
  needCloseTokenAccount,
  initialWsolAccount,
  createWsolAccountInstruction,
}: {
  amountInMax: string;
  owner: PublicKey;
  poolKeys: CpmmKeys;
  poolId: string;
  mintA: string;
  mintB: string;
  amountOutMin: string;
  needCreateAtaAccount: boolean;
  needCloseTokenAccount: boolean;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
}): Promise<Transaction> => {
  const buyAmount = new BigNumber(amountInMax).toString(10);

  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  const lamports = new BN(baseLamports).add(new BN(buyAmount)).toNumber();

  const createWsolAccount =
    createWsolAccountInstruction ||
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner,
      newAccountPubkey: wsolAccount,
      basePubkey: owner,
      lamports,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

  const tokenMint = mintA == NATIVE_MINT.toBase58() ? mintB : mintA;

  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner);

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
    wsolAccount,
    tokenAccount,
    mintA == NATIVE_MINT.toBase58()
      ? new PublicKey(poolKeys.vault.A)
      : new PublicKey(poolKeys.vault.B),
    mintA == NATIVE_MINT.toBase58()
      ? new PublicKey(poolKeys.vault.B)
      : new PublicKey(poolKeys.vault.A),
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    new PublicKey(tokenMint),
    new PublicKey(poolKeys.observationId),
    new BN(buyAmount),
    new BN(amountOutMin)
  );

  transaction.add(swapInstruction);

  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};
