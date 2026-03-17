import { Provider } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';

import {
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

import { PUMP_FEE_RECEIPENT, PUMP_FUN_GLOBAL_ACCOUNT, PUMP_FUN_PROGRAM, PUMP_FEE_PROGRAM } from '../../../const';

import {
  getBondingCurvePDA,
  getBondingCurveV2PDA,
  getCreatorVaultPDA,
  pumpFunFeeConfigPda,
} from '../index';

import BigNumber from 'bignumber.js';

// Sell instruction discriminator (from Pump.fun IDL)
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

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

export const sellSPLInstructions = async (
  provider: Provider,
  payer: Keypair,
  caAddr: string, // Contract address to sell
  sellAmount: string, // Amount to sell, unit: 6 decimals
  maxSlippage: number = 0.01,
  minSolOutput: string,
  creator: PublicKey
): Promise<Transaction> => {
  const sellTx = await sellInstructions(
    provider,
    payer,
    new PublicKey(caAddr),
    PUMP_FEE_RECEIPENT,
    BigInt(new BigNumber(sellAmount).toFixed(0)),
    minSolOutput,
    maxSlippage,
    creator
  );

  return sellTx;
};

export async function sellInstructions(
  provider: Provider,
  seller: Keypair,
  mint: PublicKey,
  feeRecipient: PublicKey,
  amount: bigint,
  minSolOutput: string,
  maxSlippage: number,
  creator: PublicKey,
  jitoTip: number = 0.0001
): Promise<Transaction> {
  const bondingCurve = getBondingCurvePDA(mint);
  const [associatedBondingCurve, associatedUser] = await Promise.all([
    getAssociatedTokenAddress(mint, bondingCurve, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddress(mint, seller.publicKey, false, TOKEN_2022_PROGRAM_ID),
  ]);

  const creatorVault = getCreatorVaultPDA(creator);
  const connection = provider.connection;
  const balance = await connection.getTokenAccountBalance(associatedUser);

  let transaction = new Transaction();

  // Add compute budget limit
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1000000,
    })
  );

  const minSolOutputRaw = new BigNumber(minSolOutput).times(1 - maxSlippage);
  const minSolOutputWithSlippage = minSolOutputRaw.isNegative() ? '0' : minSolOutputRaw.toFixed(0);

  // Manually build sell instruction (compatible with 2026-02 Pump.fun V2 cashback upgrade)
  const eventAuthority = getEventAuthority();
  const feeConfig = pumpFunFeeConfigPda();
  const bondingCurveV2 = getBondingCurveV2PDA(mint);

  // Serialize instruction data: discriminator(8) + amount(u64 LE) + minSolOutput(u64 LE)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const minSolOutputBuf = Buffer.alloc(8);
  minSolOutputBuf.writeBigUInt64LE(BigInt(minSolOutputWithSlippage));
  const data = Buffer.concat([SELL_DISCRIMINATOR, amountBuf, minSolOutputBuf]);

  // 15 accounts (non-cashback sell), bonding_curve_v2 is the last
  // Note: account order for sell differs from buy (creator_vault is before token_program)
  const keys = [
    { pubkey: PUMP_FUN_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },  // 0: global
    { pubkey: feeRecipient, isSigner: false, isWritable: true },              // 1: fee_recipient
    { pubkey: mint, isSigner: false, isWritable: false },                     // 2: mint
    { pubkey: bondingCurve, isSigner: false, isWritable: true },              // 3: bonding_curve
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },    // 4: associated_bonding_curve
    { pubkey: associatedUser, isSigner: false, isWritable: true },            // 5: associated_user
    { pubkey: seller.publicKey, isSigner: true, isWritable: true },           // 6: user
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // 7: system_program
    { pubkey: creatorVault, isSigner: false, isWritable: true },              // 8: creator_vault
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },    // 9: token_program
    { pubkey: eventAuthority, isSigner: false, isWritable: false },           // 10: event_authority
    { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },         // 11: program
    { pubkey: feeConfig, isSigner: false, isWritable: false },                // 12: fee_config
    { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },         // 13: fee_program
    { pubkey: bondingCurveV2, isSigner: false, isWritable: false },           // 14: bonding_curve_v2 (required for cashback upgrade)
  ];

  const ix = new TransactionInstruction({
    keys,
    programId: PUMP_FUN_PROGRAM,
    data,
  });

  transaction.add(ix);

  // Close ATA if selling all tokens
  if (balance.value && BigInt(balance.value.amount) === amount) {
    transaction.add(
      createCloseAccountInstruction(
        associatedUser,
        seller.publicKey,
        seller.publicKey,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  return transaction;
}
