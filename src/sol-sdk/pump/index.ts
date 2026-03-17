import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM, PUMP_FEE_PROGRAM, PUMP_SWAP_PROGRAM } from '../../const';
import { sellSPLInstructions } from './instructions/sell';
import { buySPLInstructions, calcCAPrice, buySPLFromAmountInstructions } from './instructions/buy';
import { createSPLInstruction, createAndDevBuyInstruction } from './instructions/createAndBuy';
import { Connection } from '@solana/web3.js';
import { IDL as PumpFunIDL } from '../../const/IDL/pump-fun';
import { PumpFun as PumpFunIDLType } from '../../const/IDL/pump-fun';

export function getBondingCurvePDA(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  )[0];
}

export const getCreatorVaultPDA = (creator: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_FUN_PROGRAM
  )[0];
};

export const getGlobalVolumeAccmulatorPDA = () => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_FUN_PROGRAM
  )[0];
};

export const getUserVolumeAccumulatorPDA = (user: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_FUN_PROGRAM
  )[0];
};

const PUMP_CURVE_STATE_OFFSETS = {
  VIRTUAL_TOKEN_RESERVES: 0x08,
  VIRTUAL_SOL_RESERVES: 0x10,
  REAL_TOKEN_RESERVES: 0x18,
  REAL_SOL_RESERVES: 0x20,
  TOKEN_TOTAL_SUPPLY: 0x28,
  COMPLETE: 0x30,
};

function readBytes(buf: Buffer, offset: number, length: number): Buffer {
  const end = offset + length;
  if (buf.byteLength < end) throw new RangeError('range out of bounds');
  return buf.subarray(offset, end);
}

function readBigUintLE(buf: Buffer, offset: number, length: number): bigint {
  switch (length) {
    case 1:
      return BigInt(buf.readUint8(offset));
    case 2:
      return BigInt(buf.readUint16LE(offset));
    case 4:
      return BigInt(buf.readUint32LE(offset));
    case 8:
      return buf.readBigUint64LE(offset);
  }
  throw new Error(`unsupported data size (${length} bytes)`);
}

function readBoolean(buf: Buffer, offset: number, length: number): boolean {
  const data = readBytes(buf, offset, length);
  for (const b of data) {
    if (b) return true;
  }
  return false;
}

export const getPumpCurveState = async (
  connection: Connection,
  poolId: string,
  times = 0
): Promise<any> => {
  try {
    const provider = new AnchorProvider(
      connection as any,
      {
        publicKey: Keypair.generate().publicKey,
        signTransaction: async () => {
          throw new Error('Signing not supported');
        },
        signAllTransactions: async () => {
          throw new Error('Signing not supported');
        },
      },
      {}
    );
    const program = new Program<PumpFunIDLType>(PumpFunIDL as any, provider);
    const bondingCurveInfo = await program.account.bondingCurve.fetch(new PublicKey(poolId));
    if (!bondingCurveInfo) {
      throw new Error('Bonding curve account not found');
    }

    return bondingCurveInfo as any;
  } catch (error: any) {
    if (times < 3) {
      await new Promise(resolve => setTimeout(resolve, 500));
      return getPumpCurveState(connection, poolId, times + 1);
    }
    throw new Error(`Failed to fetch pool data: ${error.message}`);
  }
};

/**
bondingCurveProgress = ((1_073_000_000* 10**6) - virtual_token_reserves) * 100 / (793_100_000 * 10**6)
 */
export const getPumpProgress = async (connection: Connection, poolId: string) => {
  const data = await getPumpCurveState(connection, poolId);
  const progress =
    ((1_073_000_000 * 10 ** 6 - Number(data.virtual_token_reserves)) * 100) /
    (793_100_000 * 10 ** 6);
  return {
    bondingCurve: poolId,
    progress,
    complete: data.complete,
  };
};

export function getBondingCurveV2PDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  )[0];
}

export function pumpFunFeeConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_FUN_PROGRAM.toBuffer()],
    PUMP_FEE_PROGRAM
  )[0];
}

export const pumpSwapFeeConfigPda = (): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_SWAP_PROGRAM.toBuffer()],
    PUMP_FEE_PROGRAM
  )[0];
};

export {
  sellSPLInstructions as pumpSellSPLInstructions,
  buySPLInstructions as pumpBuySPLInstructions,
  calcCAPrice as pumpCalcCAPrice,
  createSPLInstruction as pumpCreateSPLInstruction,
  createAndDevBuyInstruction as pumpCreateAndDevBuyInstruction,
  buySPLFromAmountInstructions as pumpBuySPLFromAmountInstructions,
};
