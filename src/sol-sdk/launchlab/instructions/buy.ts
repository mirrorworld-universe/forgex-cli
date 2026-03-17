import { Program, Provider } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';

import { TOKEN_PROGRAM_ID, createInitializeAccountInstruction } from '@solana/spl-token';

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  createCloseAccountInstruction,
} from '@solana/spl-token';

import { RaydiumLaunchlabIDL } from '../../../const/IDL/raydium-launchlab-IDL';
import { IDL } from '../../../const/IDL/raydium-launchlab-IDL';

import {
  RAYDIUM_LAUNCHLAB_GLOBAL_CONFIG,
  RAYDIUM_LAUNCHLAB_PLATFORM_CONFIG,
  RAYDIUM_LAUNCHLAB_AUTHORITY,
  RAYDIUM_LAUNCHLAB_PROGRAM,
} from '../../../const';
import BN from 'bn.js';

export const buyExactOutInstruction = async ({
  provider,
  owner,
  baseMint,
  quoteMint,
  amount,
  maxSolCost,
  initialWsolAccount,
  createWsolAccountInstruction,
  needCreateAtaAccount,
  needCloseTokenAccount,
}: {
  provider: Provider;
  owner: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  amount: bigint;
  maxSolCost: bigint;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
  needCreateAtaAccount: boolean;
  needCloseTokenAccount: boolean;
}) => {
  let program = new Program<RaydiumLaunchlabIDL>(IDL as RaydiumLaunchlabIDL, provider);

  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  const lamports = new BN(baseLamports).add(new BN(maxSolCost.toString())).toNumber();

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

  const tokenMint =
    baseMint.toBase58() == NATIVE_MINT.toBase58() ? quoteMint.toBase58() : baseMint.toBase58();

  const pool_state = PublicKey.findProgramAddressSync(
    [Buffer.from([112, 111, 111, 108]), baseMint.toBuffer(), quoteMint.toBuffer()],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  const baseVault = PublicKey.findProgramAddressSync(
    [
      Buffer.from([112, 111, 111, 108, 95, 118, 97, 117, 108, 116]),
      pool_state.toBuffer(),
      baseMint.toBuffer(),
    ],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  const quoteVault = PublicKey.findProgramAddressSync(
    [
      Buffer.from([112, 111, 111, 108, 95, 118, 97, 117, 108, 116]),
      pool_state.toBuffer(),
      quoteMint.toBuffer(),
    ],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

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

  transaction.add(
    await program.methods
      .buyExactOut(new BN(amount.toString()), new BN(maxSolCost.toString()), new BN(0))
      .accounts({
        payer: owner,
        baseTokenMint: baseMint,
        quoteTokenMint: quoteMint,
        globalConfig: RAYDIUM_LAUNCHLAB_GLOBAL_CONFIG,
        platformConfig: RAYDIUM_LAUNCHLAB_PLATFORM_CONFIG,
        poolState: pool_state,
        userBaseToken: tokenAccount,
        userQuoteToken: wsolAccount,
        baseVault: baseVault,
        quoteVault: quoteVault,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        program: RAYDIUM_LAUNCHLAB_PROGRAM,
      } as any)
      .instruction()
  );

  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};

export const buyExactInInstruction = async ({
  provider,
  owner,
  baseMint,
  quoteMint,
  amountIn,
  minAmountOut,
  initialWsolAccount,
  createWsolAccountInstruction,
  needCreateAtaAccount,
  needCloseTokenAccount,
}: {
  provider: Provider;
  owner: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
  needCreateAtaAccount: boolean;
  needCloseTokenAccount: boolean;
}) => {
  let program = new Program<RaydiumLaunchlabIDL>(IDL as RaydiumLaunchlabIDL, provider);

  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  const lamports = new BN(baseLamports).add(new BN(amountIn.toString())).toNumber();

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

  const tokenMint =
    baseMint.toBase58() == NATIVE_MINT.toBase58() ? quoteMint.toBase58() : baseMint.toBase58();

  const pool_state = PublicKey.findProgramAddressSync(
    [Buffer.from([112, 111, 111, 108]), baseMint.toBuffer(), quoteMint.toBuffer()],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  const baseVault = PublicKey.findProgramAddressSync(
    [
      Buffer.from([112, 111, 111, 108, 95, 118, 97, 117, 108, 116]),
      pool_state.toBuffer(),
      baseMint.toBuffer(),
    ],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  const quoteVault = PublicKey.findProgramAddressSync(
    [
      Buffer.from([112, 111, 111, 108, 95, 118, 97, 117, 108, 116]),
      pool_state.toBuffer(),
      quoteMint.toBuffer(),
    ],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

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

  transaction.add(
    await program.methods
      .buyExactIn(new BN(amountIn.toString()), new BN(minAmountOut.toString()), new BN(0))
      .accounts({
        payer: owner,
        baseTokenMint: baseMint,
        quoteTokenMint: quoteMint,
        globalConfig: RAYDIUM_LAUNCHLAB_GLOBAL_CONFIG,
        platformConfig: RAYDIUM_LAUNCHLAB_PLATFORM_CONFIG,
        poolState: pool_state,
        userBaseToken: tokenAccount,
        userQuoteToken: wsolAccount,
        baseVault: baseVault,
        quoteVault: quoteVault,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        program: RAYDIUM_LAUNCHLAB_PROGRAM,
      } as any)
      .instruction()
  );

  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};
