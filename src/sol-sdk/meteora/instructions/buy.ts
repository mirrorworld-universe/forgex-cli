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

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createInitializeAccountInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';

import { BN } from 'bn.js';
import BigNumber from 'bignumber.js';

import { MeteoraDLMM } from '../../../const/IDL/meteora-DLMM';
import { IDL } from '../../../const/IDL/meteora-DLMM';

import { METEORA_DLMM_PROGRAM, METEORA_DLMM_EVENT_AUTHORITY } from '../../../const/index';

export async function buyInstructions({
  provider,
  owner,
  mint,
  poolInfo,
  amount,
  tokenAmount,
  slippage,
  needCreateAtaAccount = true,
  needCloseTokenAccount = false,
  needCloseWsolAccount = true,
  initialWsolAccount,
  createWsolAccountInstruction,
  binArraysPubkey,
}: {
  provider: Provider;
  owner: Keypair;
  mint: PublicKey;
  poolInfo?: {
    poolId: string;
    mintA: string;
    mintB: string;
    reverseX: string;
    reverseY: string;
    oracle: string;
  };
  amount: bigint;
  tokenAmount: bigint;
  slippage: number;
  needCreateAtaAccount?: boolean;
  needCloseTokenAccount?: boolean;
  needCloseWsolAccount?: boolean;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
  binArraysPubkey: PublicKey[];
}): Promise<Transaction> {
  console.log('binArraysPubkey: ', binArraysPubkey);
  const inputMint = NATIVE_MINT.toBase58();
  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const minAmountOut = new BigNumber(tokenAmount.toString()).times(1 - slippage).toFixed(0);

  if (poolInfo?.mintA !== inputMint && poolInfo?.mintB !== inputMint)
    return Promise.reject(new Error('input mint does not match pool'));

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const tokenMint = poolInfo.mintA == NATIVE_MINT.toBase58() ? poolInfo.mintB : poolInfo.mintA;

  // If initial wsolAccount is provided, use it; otherwise create new one
  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner.publicKey, seed, TOKEN_PROGRAM_ID));

  const createWsolAccount =
    createWsolAccountInstruction ||
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner.publicKey,
      newAccountPubkey: wsolAccount,
      basePubkey: owner.publicKey,
      lamports: new BN(baseLamports).add(new BN(amount.toString())).toNumber(),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner.publicKey);

  // Only create Token Account when needed
  if (needCreateAtaAccount) {
    transaction.add(
      createWsolAccount,
      createInitializeAccountInstruction(wsolAccount, NATIVE_MINT, owner.publicKey)
    );
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        tokenAccount,
        owner.publicKey,
        new PublicKey(tokenMint)
      )
    );
  }

  const program = new Program<MeteoraDLMM>(IDL as MeteoraDLMM, provider);

  const binsPubkey = binArraysPubkey.map(item => ({
    pubkey: item,
    isWritable: true,
    isSigner: false,
  }));

  transaction.add(
    await program.methods
      .swap2(new BN(amount.toString()), new BN(minAmountOut.toString()), {
        slices: [
          {
            accountsType: {
              transferHookX: {},
            },
            length: 0,
          },
          {
            accountsType: {
              transferHookY: {},
            },
            length: 0,
          },
        ],
      } as any)
      .accounts({
        lbPair: new PublicKey(poolInfo.poolId),
        binArrayBitmapExtension: METEORA_DLMM_PROGRAM,
        reserveX: new PublicKey(poolInfo.reverseX),
        reserveY: new PublicKey(poolInfo.reverseY),
        tokenXMint: new PublicKey(poolInfo.mintA),
        tokenYMint: new PublicKey(poolInfo.mintB),
        tokenXProgram: TOKEN_PROGRAM_ID,
        tokenYProgram: TOKEN_PROGRAM_ID,
        userTokenIn: wsolAccount,
        userTokenOut: tokenAccount,
        user: owner.publicKey,
        oracle: new PublicKey(poolInfo.oracle),
        hostFeeIn: METEORA_DLMM_PROGRAM,
        eventAuthority: METEORA_DLMM_EVENT_AUTHORITY,
        program: METEORA_DLMM_PROGRAM,
      } as any)
      .remainingAccounts(binsPubkey)
      .instruction()
  );

  // Only add close instruction when WSOL account needs to be closed
  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner.publicKey, owner.publicKey));
  }

  // Only add close instruction when Token account needs to be closed
  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(tokenAccount, owner.publicKey, owner.publicKey));
  }

  // transaction.feePayer = owner.publicKey;

  return transaction;
}

export async function buyExactOutInstructions({
  provider,
  owner,
  mint,
  poolInfo,
  amountInMax,
  tokenAmount,
  needCreateAtaAccount = true,
  needCloseTokenAccount = false,
  needCloseWsolAccount = true,
  initialWsolAccount,
  createWsolAccountInstruction,
  binArraysPubkey,
}: {
  provider: Provider;
  owner: Keypair;
  mint: PublicKey;
  poolInfo?: {
    poolId: string;
    mintA: string;
    mintB: string;
    reverseX: string;
    reverseY: string;
    oracle: string;
  };
  amountInMax: bigint;
  tokenAmount: bigint;
  needCreateAtaAccount?: boolean;
  needCloseTokenAccount?: boolean;
  needCloseWsolAccount?: boolean;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
  binArraysPubkey: PublicKey[];
}): Promise<Transaction> {
  const inputMint = NATIVE_MINT.toBase58();
  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  if (poolInfo?.mintA !== inputMint && poolInfo?.mintB !== inputMint)
    return Promise.reject(new Error('input mint does not match pool'));

  const transaction = new Transaction();
  const baseLamports = 2039280;

  // If initial wsolAccount is provided, use it; otherwise create new one
  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner.publicKey, seed, TOKEN_PROGRAM_ID));
  const createWsolAccount =
    createWsolAccountInstruction ||
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner.publicKey,
      newAccountPubkey: wsolAccount,
      basePubkey: owner.publicKey,
      lamports: new BN(baseLamports).add(new BN(amountInMax.toString())).toNumber(),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

  const tokenMint = poolInfo.mintA == NATIVE_MINT.toBase58() ? poolInfo.mintB : poolInfo.mintA;
  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner.publicKey);

  // Only create Token Account when needed
  if (needCreateAtaAccount) {
    transaction.add(
      createWsolAccount,
      createInitializeAccountInstruction(wsolAccount, NATIVE_MINT, owner.publicKey)
    );
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        tokenAccount,
        owner.publicKey,
        new PublicKey(tokenMint)
      )
    );
  }

  const program = new Program<MeteoraDLMM>(IDL as MeteoraDLMM, provider);

  const binsPubkey = binArraysPubkey.map(item => ({
    pubkey: item,
    isWritable: true,
    isSigner: false,
  }));

  transaction.add(
    await program.methods
      .swapExactOut(new BN(amountInMax.toString()), new BN(tokenAmount.toString()))
      .accounts({
        lbPair: new PublicKey(poolInfo.poolId),
        binArrayBitmapExtension: METEORA_DLMM_PROGRAM,
        reserveX: new PublicKey(poolInfo.reverseX),
        reserveY: new PublicKey(poolInfo.reverseY),
        tokenXMint: new PublicKey(poolInfo.mintA),
        tokenYMint: new PublicKey(poolInfo.mintB),
        userTokenIn: wsolAccount,
        userTokenOut: tokenAccount,
        user: owner.publicKey,
        oracle: new PublicKey(poolInfo.oracle),
        hostFeeIn: METEORA_DLMM_PROGRAM,
        eventAuthority: METEORA_DLMM_EVENT_AUTHORITY,
        program: METEORA_DLMM_PROGRAM,
      } as any)
      .remainingAccounts(binsPubkey)
      .instruction()
  );

  // Only add close instruction when WSOL account needs to be closed
  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner.publicKey, owner.publicKey));
  }

  // Only add close instruction when Token account needs to be closed
  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(tokenAccount, owner.publicKey, owner.publicKey));
  }

  transaction.feePayer = owner.publicKey;

  return transaction;
}
