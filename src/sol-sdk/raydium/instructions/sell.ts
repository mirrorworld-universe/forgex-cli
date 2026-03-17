import { AmmV4Keys, makeSwapFixedInInstruction } from '@raydium-io/raydium-sdk-v2';
import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Transaction,
  Keypair,
  PublicKey,
  Connection,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { initSdk } from '../index';

export const beforeSell = async (connection: Connection, poolId: string) => {
  const raydium = await initSdk(connection);
  const [data, poolKeys, rpcData] = await Promise.all([
    raydium.api.fetchPoolById({ ids: poolId }),
    raydium.liquidity.getAmmPoolKeys(poolId),
    raydium.liquidity.getRpcPoolInfo(poolId),
  ]);
  return [data[0], poolKeys, rpcData];
};

export const sellInstruction = async ({
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
  const inputMint = NATIVE_MINT.toBase58();
  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  if (mintA !== inputMint && mintB !== inputMint)
    return Promise.reject(new Error('input mint does not match pool'));

  const transaction = new Transaction();
  const baseLamports = 2039280;

  // If initial wsolAccount provided, use it; otherwise create new
  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID));

  // Only create new account if needed and no pre-create instruction provided
  if (needCreateAtaAccount && !createWsolAccountInstruction) {
    const createWsolAccount = SystemProgram.createAccountWithSeed({
      fromPubkey: owner,
      newAccountPubkey: wsolAccount,
      basePubkey: owner,
      lamports: new BN(baseLamports).toNumber(),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

    transaction.add(
      createWsolAccount,
      createInitializeAccountInstruction(wsolAccount, NATIVE_MINT, owner)
    );
  } else if (createWsolAccountInstruction) {
    // If pre-create instruction is provided, use it
    transaction.add(createWsolAccountInstruction);
  }

  const tokenMint = mintA == NATIVE_MINT.toBase58() ? mintB : mintA;
  const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), owner);

  // Only create Token Account when needed
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
        tokenAccountIn: tokenAccount,
        tokenAccountOut: wsolAccount,
        owner,
      },
      amountIn: new BN(amount),
      minAmountOut: new BN(minAmountOut),
    },
    4
  );
  transaction.add(swapInstruction);

  // Only add close instruction when WSOL account needs to be closed
  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner, owner));
  }

  // Only add close instruction when Token account needs to be closed
  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(tokenAccount, owner, owner));
  }

  transaction.feePayer = owner;

  return transaction;
};
