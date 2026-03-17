import { PublicKey, TransactionInstruction, SystemProgram, Connection } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM, PUMP_SWAP_PROGRAM, PUMP_SWAP_EVENT_AUTHORITY } from '../../const';
import { NATIVE_MINT } from '@solana/spl-token';

export { sellSPLInstructions as pumpSwapSellInstruction } from './instructions/sell';
export {
  getPoolInfo as pumpSwapGetPoolInfo,
  calcCAPrice as pumpSwapCalcCAPrice,
  buyInstruction as pumpSwapBuyInstruction,
  calcOutAmountByNewPool as pumpSwapCalcOutAmountByNewPool,
} from './instructions/buy';
export { migrate as pumpSwapMigrate } from './instructions/migrate';
export {
  pumpSwapSearchPoolByMint,
  getPoolVault as pumpSwapGetPoolVault,
  getPumpSwapPoolId,
} from './rpc';

const getPoolAuthority = (mint: string): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool-authority'), new PublicKey(mint).toBuffer()],
    PUMP_FUN_PROGRAM
  )[0];
};

export const getPumpSwapPoolByMint = (mint: string): PublicKey => {
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

/**
 * Pool v2 PDA - After PumpFun upgrade, buy/sell instructions must be appended at the end
 * Seeds: ["pool-v2", base_mint]
 */
export const getPoolV2PDA = (baseMint: PublicKey): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool-v2'), baseMint.toBuffer()],
    PUMP_SWAP_PROGRAM
  )[0];
};

export const getGlobalVolumeAccumulatorPDA = () => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_SWAP_PROGRAM
  )[0];
};

export const getUserVolumeAccumulatorPDA = (user: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_SWAP_PROGRAM
  )[0];
};

const INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR = new Uint8Array([94, 6, 202, 115, 255, 96, 232, 183]);

/**
 * Build init_user_volume_accumulator instruction
 * If the user's volume accumulator PDA does not exist, it needs to be initialized first
 */
export const buildInitUserVolumeAccumulatorInstruction = (
  payer: PublicKey,
  user: PublicKey,
): TransactionInstruction => {
  const userVolumeAccumulator = getUserVolumeAccumulatorPDA(user);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },        // payer
      { pubkey: user, isSigner: false, isWritable: false },        // user
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true }, // user_volume_accumulator
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: PUMP_SWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // event_authority
      { pubkey: PUMP_SWAP_PROGRAM, isSigner: false, isWritable: false },       // program
    ],
    programId: PUMP_SWAP_PROGRAM,
    data: Buffer.from(INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR),
  });
};

/**
 * Check and return init_user_volume_accumulator instruction (if needed)
 */
export const getInitUserVolumeAccumulatorIxIfNeeded = async (
  connection: Connection,
  payer: PublicKey,
  user: PublicKey,
): Promise<TransactionInstruction | null> => {
  const pda = getUserVolumeAccumulatorPDA(user);
  const accInfo = await connection.getAccountInfo(pda);
  if (accInfo) return null; // Already exists, no initialization needed
  return buildInitUserVolumeAccumulatorInstruction(payer, user);
};
