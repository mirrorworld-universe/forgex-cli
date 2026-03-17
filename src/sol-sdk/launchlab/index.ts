import { AnchorProvider, Program, BorshAccountsCoder } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createAndDevBuyInstruction, createInstruction } from './instructions/create';
import { buyExactInInstruction, buyExactOutInstruction } from './instructions/buy';
import { sellExactInInstruction } from './instructions/sell';

import { IDL, type RaydiumLaunchlabIDL } from '@/const/IDL/raydium-launchlab-IDL';
import { RAYDIUM_CPMM_PROGRAM, RAYDIUM_CPMM_CONFIG, RAYDIUM_LAUNCHLAB_PROGRAM } from '../../const';
import { NATIVE_MINT } from '@solana/spl-token';

export const getLaunchlabReverseInfo = async ({
  connection,
  poolId,
}: {
  connection: Connection;
  poolId: string;
}): Promise<LaunchlabReverseInfo> => {
  const poolAccountInfo = await connection.getAccountInfo(new PublicKey(poolId));
  if (!poolAccountInfo) {
    throw new Error('Pool account not found');
  }
  const poolAccount = new BorshAccountsCoder(IDL as RaydiumLaunchlabIDL).decode(
    'PoolState',
    poolAccountInfo.data
  );
  console.log('poolAccount', poolAccount);
  if (!poolAccount) {
    throw new Error('Pool state not found');
  }

  return {
    totalVirtualBase: poolAccount.virtual_base.toString(),
    totalVirtualQuote: poolAccount.virtual_quote.toString(),
    totalRealQuote: poolAccount.real_quote.toString(),
    totalRealBase: poolAccount.real_base.toString(),
    supply: poolAccount.supply.toString(),
    baseDecimals: poolAccount.base_decimals,
    quoteDecimals: poolAccount.quote_decimals,
    migrateType: poolAccount.migrate_type,
    totalBaseSell: poolAccount.total_base_sell.toString(),
    virtualBase: poolAccount.virtual_base.toString(),
    virtualQuote: poolAccount.virtual_quote.toString(),
    realBase: poolAccount.real_base.toString(),
    realQuote: poolAccount.real_quote.toString(),
    fundRaising: poolAccount.total_quote_fund_raising.toString(),
  };
};

export const getCpmmPoolByTokenInfo = ({
  mintA,
  mintB,
}: {
  mintA: string;
  mintB: string;
}): PublicKey => {
  const poolAccount = PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool'),
      new PublicKey(RAYDIUM_CPMM_CONFIG).toBuffer(),
      new PublicKey(mintA === NATIVE_MINT.toBase58() ? mintB : mintA).toBuffer(),
      new PublicKey(mintA === NATIVE_MINT.toBase58() ? mintA : mintB).toBuffer(),
    ],
    RAYDIUM_CPMM_PROGRAM
  );
  return poolAccount[0];
};

export const getRaydiumCpmmKeysByTokenInfo = async ({ tokenAddress }: { tokenAddress: string }) => {
  const token_0_mint =
    NATIVE_MINT.toBase58() < tokenAddress ? NATIVE_MINT.toBase58() : tokenAddress;
  const token_1_mint =
    NATIVE_MINT.toBase58() < tokenAddress ? tokenAddress : NATIVE_MINT.toBase58();

  const poolId = getCpmmPoolByTokenInfo({
    mintA: token_0_mint,
    mintB: token_1_mint,
  });

  const observation_state = PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), new PublicKey(poolId).toBuffer()],
    RAYDIUM_CPMM_PROGRAM
  );

  const vault_0 = PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool_vault'),
      new PublicKey(poolId).toBuffer(),
      new PublicKey(token_0_mint).toBuffer(),
    ],
    RAYDIUM_CPMM_PROGRAM
  );
  const vault_1 = PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool_vault'),
      new PublicKey(poolId).toBuffer(),
      new PublicKey(token_1_mint).toBuffer(),
    ],
    RAYDIUM_CPMM_PROGRAM
  );

  return {
    config: {
      id: poolId.toBase58(),
    },
    observationId: observation_state[0].toBase58(),
    vault: {
      A: vault_0[0].toBase58(),
      B: vault_1[0].toBase58(),
    },
    mintA: token_0_mint,
    mintB: token_1_mint,
  };
};

export const getRaydiumPoolByTokenInfo = ({ mintA, mintB }: { mintA: string; mintB: string }) => {};

export {
  createInstruction as launchlabCreateInstruction,
  createAndDevBuyInstruction as launchlabCreateAndDevBuyInstruction,
  buyExactInInstruction as launchlabBuyExactInInstruction,
  buyExactOutInstruction as launchlabBuyExactOutInstruction,
  sellExactInInstruction as launchlabSellExactInInstruction,
};
