import axios from 'axios';
import { getPoolInfo } from '../instructions/buy';
import { getAssociatedTokenAddress, NATIVE_MINT } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM, PUMP_SWAP_PROGRAM } from '@/const';

export const pumpSwapSearchPoolByMint = async (ca: string): Promise<string> => {
  const res = await axios.get(
    `https://swap-api.pump.fun/v1/pools/pair?mintA=So11111111111111111111111111111111111111112&mintB=${ca}&sort=liquidity`
  );
  if (res.data.length > 0) {
    return res.data[0].address;
  }
  throw new Error('PumpSwap pool not found');
};

export const getPoolVault = async (poolInfo: {
  poolId: string;
  mintA: string;
  mintB: string;
}): Promise<{ A: string; B: string; mintA: string; mintB: string }> => {
  const [poolBaseTokenAccount, poolQuoteTokenAccount] = await Promise.all([
    getAssociatedTokenAddress(new PublicKey(poolInfo.mintA), new PublicKey(poolInfo.poolId), true),
    getAssociatedTokenAddress(NATIVE_MINT, new PublicKey(poolInfo.poolId), true),
  ]);
  // const res = await getPoolInfo(poolId);
  return {
    A: poolBaseTokenAccount.toBase58(),
    B: poolQuoteTokenAccount.toBase58(),
    mintA: poolInfo.mintA,
    mintB: poolInfo.mintB,
  };
};

/**
 * Returns the PDA for coin_creator_vault_authority.
 * @param coinCreator The pool.coin_creator PublicKey.
 * @param programId The program ID for the PDA (default to your program).
 */
export function getCoinCreatorVaultAuthorityPda(
  coinCreator: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('creator_vault'), // constant seed
      coinCreator.toBuffer(), // pool.coin_creator
    ],
    programId
  );
}
/**
 * Returns the PDA for coin_creator_vault_ata.
 * @param coinCreatorVaultAuthority The coin_creator_vault_authority PDA.
 * @param quoteTokenProgram The quote token program PublicKey.
 * @param quoteMint The quote mint PublicKey.
 */
export function getCoinCreatorVaultAtaPda(
  coinCreatorVaultAuthority: PublicKey,
  quoteTokenProgram: PublicKey,
  quoteMint: PublicKey
): [PublicKey, number] {
  // The program ID for this PDA (from the IDL)
  const programId = new PublicKey([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218,
    255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
  ]);

  return PublicKey.findProgramAddressSync(
    [coinCreatorVaultAuthority.toBuffer(), quoteTokenProgram.toBuffer(), quoteMint.toBuffer()],
    programId
  );
}

export const getPoolAuthority = (mint: string): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool-authority'), new PublicKey(mint).toBuffer()],
    PUMP_FUN_PROGRAM
  )[0];
};

export const getPumpSwapPoolId = (mint: string): PublicKey => {
  const poolAuthority = getPoolAuthority(mint);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool'),
      Buffer.from([0, 0]),
      poolAuthority.toBuffer(),
      new PublicKey(mint).toBuffer(),
      NATIVE_MINT.toBuffer(),
    ],
    PUMP_SWAP_PROGRAM
  )[0];
};
