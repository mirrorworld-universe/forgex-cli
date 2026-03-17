import {
  AmmV4Keys,
  makeSwapFixedInInstruction,
  makeSwapFixedOutInstruction,
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
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import BigNumber from 'bignumber.js';

export const buyInstruction = async ({
  amount,
  owner,
  poolKeys,
  mintA,
  mintB,
  minAmountOut,
  needCreateAtaAccount = true,
  needCloseTokenAccount = false,
  needCloseWsolAccount = true,
  initialWsolAccount,
  createWsolAccountInstruction,
}: {
  amount: string;
  owner: PublicKey;
  poolKeys: AmmV4Keys;
  mintA: string;
  mintB: string;
  minAmountOut: string;
  needCreateAtaAccount?: boolean;
  needCloseTokenAccount?: boolean;
  needCloseWsolAccount?: boolean;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
}): Promise<Transaction> => {
  const amountOut = new BigNumber(amount);
  const inputMint = NATIVE_MINT.toBase58();
  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const baseAmountOut = amountOut.toString(10);

  if (mintA !== inputMint && mintB !== inputMint)
    return Promise.reject(new Error('input mint does not match pool'));

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  if (needCreateAtaAccount && !createWsolAccountInstruction) {
    const createWsolAccount = SystemProgram.createAccountWithSeed({
      fromPubkey: owner,
      newAccountPubkey: wsolAccount,
      basePubkey: owner,
      lamports: new BN(baseLamports).add(new BN(baseAmountOut)).toNumber(),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

    transaction.add(
      createWsolAccount,
      createInitializeAccountInstruction(wsolAccount, NATIVE_MINT, owner)
    );
  } else if (createWsolAccountInstruction) {
    transaction.add(createWsolAccountInstruction);
  }

  const tokenMint = mintA == NATIVE_MINT.toBase58() ? mintB : mintA;
  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner);

  if (needCreateAtaAccount) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        tokenAccount,
        owner,
        new PublicKey(tokenMint)
      )
    );
  }

  const swapInstruction = makeSwapFixedInInstruction(
    {
      poolKeys,
      userKeys: {
        tokenAccountIn: wsolAccount,
        tokenAccountOut: tokenAccount,
        owner,
      },
      amountIn: new BN(baseAmountOut),
      minAmountOut: new BN(minAmountOut),
    },
    4
  );
  transaction.add(swapInstruction);

  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(tokenAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};

export const buyExactOutInstruction = async ({
  maxAmountIn,
  owner,
  poolKeys,
  mintA,
  mintB,
  tokenAmount,
  needCreateAtaAccount = true,
  needCloseTokenAccount = false,
  needCloseWsolAccount = true,
  initialWsolAccount,
  createWsolAccountInstruction,
}: {
  maxAmountIn: string;
  owner: PublicKey;
  poolKeys: AmmV4Keys;
  mintA: string;
  mintB: string;
  tokenAmount: string;
  needCreateAtaAccount?: boolean;
  needCloseTokenAccount?: boolean;
  needCloseWsolAccount?: boolean;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
}): Promise<Transaction> => {
  const inputMint = NATIVE_MINT.toBase58();
  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  if (mintA !== inputMint && mintB !== inputMint)
    return Promise.reject(new Error('input mint does not match pool'));

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  if (needCreateAtaAccount && !createWsolAccountInstruction) {
    const createWsolAccount = SystemProgram.createAccountWithSeed({
      fromPubkey: owner,
      newAccountPubkey: wsolAccount,
      basePubkey: owner,
      lamports: new BN(baseLamports).add(new BN(maxAmountIn)).toNumber(),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

    transaction.add(
      createWsolAccount,
      createInitializeAccountInstruction(wsolAccount, NATIVE_MINT, owner)
    );
  } else if (createWsolAccountInstruction) {
    transaction.add(createWsolAccountInstruction);
  }

  const tokenMint = mintA == NATIVE_MINT.toBase58() ? mintB : mintA;
  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner);

  if (needCreateAtaAccount) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        tokenAccount,
        owner,
        new PublicKey(tokenMint)
      )
    );
  }

  const swapInstruction = makeSwapFixedOutInstruction(
    {
      poolKeys,
      userKeys: {
        tokenAccountIn: wsolAccount,
        tokenAccountOut: tokenAccount,
        owner,
      },
      amountOut: new BN(tokenAmount),
      maxAmountIn: new BN(maxAmountIn),
    },
    4
  );
  transaction.add(swapInstruction);

  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(tokenAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};
