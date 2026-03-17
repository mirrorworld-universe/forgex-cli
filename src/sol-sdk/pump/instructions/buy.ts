import { Provider } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

import { PUMP_FEE_RECEIPENT, PUMP_FUN_GLOBAL_ACCOUNT, PUMP_FUN_PROGRAM, PUMP_FEE_PROGRAM } from '../../../const';

import {
  getBondingCurvePDA,
  getBondingCurveV2PDA,
  getPumpCurveState,
  getCreatorVaultPDA,
  getGlobalVolumeAccmulatorPDA,
  getUserVolumeAccumulatorPDA,
  pumpFunFeeConfigPda,
} from '../index';

import { BN } from 'bn.js';
import BigNumber from 'bignumber.js';

// Buy instruction discriminator (from Pump.fun IDL)
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

// Event authority PDA (cached)
let _eventAuthority: PublicKey | null = null;
function getEventAuthority(): PublicKey {
  if (!_eventAuthority) {
    _eventAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PUMP_FUN_PROGRAM
    )[0];
  }
  return _eventAuthority;
}

/**
 * Buy SPL token
 * @param provider  anchor provider
 * @param buyer  payer
 * @param mint  CA Keypair
 * @param feeRecipient  fee recipient
 * @param amount  purchase amount
 * @param maxSolCost  max SOL cost
 */
export async function buyInstructions(
  provider: Provider,
  buyer: PublicKey,
  mint: PublicKey,
  feeRecipient: PublicKey,
  amount: bigint,
  maxSolCost: bigint,
  creator: PublicKey,
  jitoTip: number = 100000 // 0.0001 SOL = 100000 lamports (already in English)
): Promise<Transaction> {
  const bondingCurve = getBondingCurvePDA(mint);
  const [associatedBondingCurve, associatedUser] = await Promise.all([
    getAssociatedTokenAddress(mint, bondingCurve, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddress(mint, buyer, false, TOKEN_2022_PROGRAM_ID),
  ]);

  let transaction = new Transaction();

  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 500000,
    })
  );

  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(buyer, associatedUser, buyer, mint, TOKEN_2022_PROGRAM_ID)
  );

  // Manually build buy instruction (compatible with 2026-02 Pump.fun V2 cashback upgrade, 17 accounts total)
  const creatorVault = getCreatorVaultPDA(creator);
  const globalVolumeAccumulator = getGlobalVolumeAccmulatorPDA();
  const userVolumeAccumulator = getUserVolumeAccumulatorPDA(buyer);
  const eventAuthority = getEventAuthority();
  const feeConfig = pumpFunFeeConfigPda();
  const bondingCurveV2 = getBondingCurveV2PDA(mint);

  // Serialize instruction data: discriminator(8) + amount(u64 LE) + maxSolCost(u64 LE) + trackVolume(OptionBool)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const maxSolCostBuf = Buffer.alloc(8);
  maxSolCostBuf.writeBigUInt64LE(maxSolCost);
  // OptionBool (Borsh): Some(true) = [1, 1], Some(false) = [1, 0], None = [0]
  const trackVolumeBuf = Buffer.from([0]); // None
  const data = Buffer.concat([BUY_DISCRIMINATOR, amountBuf, maxSolCostBuf, trackVolumeBuf]);

  // 17 accounts, including bonding_curve_v2 added in 2026-02 cashback upgrade (must be last)
  const keys = [
    { pubkey: PUMP_FUN_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },  // 0: global
    { pubkey: feeRecipient, isSigner: false, isWritable: true },              // 1: fee_recipient
    { pubkey: mint, isSigner: false, isWritable: false },                     // 2: mint
    { pubkey: bondingCurve, isSigner: false, isWritable: true },              // 3: bonding_curve
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },    // 4: associated_bonding_curve
    { pubkey: associatedUser, isSigner: false, isWritable: true },            // 5: associated_user
    { pubkey: buyer, isSigner: true, isWritable: true },                      // 6: user
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // 7: system_program
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },    // 8: token_program
    { pubkey: creatorVault, isSigner: false, isWritable: true },              // 9: creator_vault
    { pubkey: eventAuthority, isSigner: false, isWritable: false },           // 10: event_authority
    { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },         // 11: program
    { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },  // 12: global_volume_accumulator
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },     // 13: user_volume_accumulator
    { pubkey: feeConfig, isSigner: false, isWritable: false },                // 14: fee_config
    { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },         // 15: fee_program
    { pubkey: bondingCurveV2, isSigner: false, isWritable: false },           // 16: bonding_curve_v2 (required for cashback upgrade)
  ];

  const ix = new TransactionInstruction({
    keys,
    programId: PUMP_FUN_PROGRAM,
    data,
  });

  transaction.add(ix);

  return transaction;
}

/**
 * Buy SPL token
 * @param connection
 * @param provider
 * @param payer  payer
 * @param caAddr  CA address
 * @param buyAmount  SOL amount Float String
 * @param slippageDecimal  slippage
 * @param caPrice  CA price
 * @returns
 */
export const buySPLInstructions = async (
  provider: Provider,
  payer: PublicKey,
  caAddr: string,
  buyAmount: string, // decimal → lamports
  slippageDecimal: number,
  caPrice: string,
  creator: PublicKey,
  tokenAmount?: string,
  reserveInfo?: { virtual_sol_reserves?: bigint | number; virtual_token_reserves?: bigint | number; virtualSolReserves?: bigint | number; virtualTokenReserves?: bigint | number }
): Promise<[string, Transaction]> => {
  let receiveAmount: string;
  const mint = new PublicKey(caAddr);
  const bondingCurve = getBondingCurvePDA(mint);

  if (tokenAmount) {
    receiveAmount = tokenAmount;
  } else if (reserveInfo) {
    // AMM constant product formula: k = vSol * vToken; newSol = vSol + buyAmount(lamports); receiveAmount = vToken - k/newSol
    // Compatible with camelCase (Anchor fetch) and snake_case
    const vSol = Number(reserveInfo.virtualSolReserves ?? reserveInfo.virtual_sol_reserves);   // lamports
    const vToken = Number(reserveInfo.virtualTokenReserves ?? reserveInfo.virtual_token_reserves); // token units (1e6)
    const k = new BigNumber(vSol).times(vToken);
    const newSol = new BigNumber(vSol).plus(buyAmount); // buyAmount is already in lamports
    const newToken = k.div(newSol);
    receiveAmount = new BigNumber(vToken).minus(newToken).toFixed(0);
  } else {
    receiveAmount = new BigNumber(buyAmount).div(caPrice).times(1000000).toFixed(0);
  }
  const solInWithSlippage = Number(buyAmount) * (1 + slippageDecimal);
  const maxSolCost = new BigNumber(solInWithSlippage).toFixed(0);

  const buyTx = await buyInstructions(
    provider,
    payer,
    mint,
    PUMP_FEE_RECEIPENT,
    BigInt(receiveAmount),
    BigInt(maxSolCost),
    creator
  );

  return [receiveAmount, buyTx];
};

export const buySPLFromAmountInstructions = async (
  provider: Provider,
  payer: PublicKey,
  caAddr: string,
  receiveAmount: string,
  maxSolCost: string,
  creator: PublicKey,
  redis: ClientRedis
): Promise<Transaction> => {
  const solCost = Number(maxSolCost) * LAMPORTS_PER_SOL;

  const buyTx = await buyInstructions(
    provider,
    payer,
    new PublicKey(caAddr),
    PUMP_FEE_RECEIPENT,
    BigInt(receiveAmount),
    BigInt(Number(solCost).toFixed(0)),
    creator
  );

  return buyTx;
};

export const calcSPLOutAmount = async (
  connection: Connection,
  token: string,
  amount: string,
  slippageDecimal: number
) => {
  try {
    const poolInfo = await getPumpTokenInfo(connection, token);

    // Calculate SOL price
    const solPrice = new BigNumber(
      new BigNumber(poolInfo.virtual_sol_reserves).div(LAMPORTS_PER_SOL)
    )
      .div(new BigNumber(poolInfo.virtual_token_reserves).div('1000000'))
      .toString(10);

    // Calculate constant k
    const k = new BigNumber(poolInfo.virtual_sol_reserves)
      .times(new BigNumber(poolInfo.virtual_token_reserves))
      .toString(10);

    // Calculate new SOL and TOKEN reserves
    const R_SOL_new = new BigNumber(poolInfo.virtual_sol_reserves)
      .plus(new BigNumber(amount).times(LAMPORTS_PER_SOL))
      .toString(10);
    const R_TOKEN_new = new BigNumber(k).div(new BigNumber(R_SOL_new)).toString(10);

    // Calculate amount of TOKEN obtained
    const tokenObtained = new BigNumber(poolInfo.virtual_token_reserves)
      .minus(new BigNumber(R_TOKEN_new))
      .toString(10);

    // Calculate actual TOKEN amount obtained, considering slippage
    // const actualTokens = new BigNumber(tokenObtained).times(new BigNumber(1 - slippageDecimal)).toFixed(0);
    const actualTokens = new BigNumber(tokenObtained).toFixed(0);

    console.log('solPrice', solPrice);
    console.log('actualTokens', actualTokens);

    return [solPrice, actualTokens];
  } catch (e) {
    return Promise.reject(new Error('Failed to calculate SPL output amount')); // Consider more detailed error handling
  }
};

export const calcCAPrice = async (connection: Connection, token: string) => {
  const poolInfo = await getPumpTokenInfo(connection, token);
  if (!poolInfo.virtual_sol_reserves || !poolInfo.virtual_token_reserves) {
    return Promise.reject(new Error('poolInfo is empty'));
  }
  const solPrice = new BigNumber(new BigNumber(poolInfo.virtual_sol_reserves).div(LAMPORTS_PER_SOL))
    .div(new BigNumber(poolInfo.virtual_token_reserves).div('1000000'))
    .toString(10);
  console.log('solPrice', solPrice);
  return solPrice;
};

async function getPumpTokenInfo(connection: Connection, token: string) {
  const mint = new PublicKey(token);
  const bondingCurve = getBondingCurvePDA(mint);
  const data = await getPumpCurveState(connection, bondingCurve.toBase58());
  return {
    virtual_sol_reserves: Number(data.virtual_sol_reserves),
    virtual_token_reserves: Number(data.virtual_token_reserves),
    real_sol_reserves: Number(data.real_sol_reserves),
    real_token_reserves: Number(data.real_token_reserves),
    token_total_supply: Number(data.token_total_supply),
    complete: data.complete,
  };
}
