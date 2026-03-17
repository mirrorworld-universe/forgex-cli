import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { buySPLInstructions } from './buy';

import { PumpFun } from '../../../const/IDL';
import { IDL } from '../../../const/IDL/pump-fun';
import { getBondingCurvePDA } from '../index';
import BigNumber from 'bignumber.js';

// Mayhem program constants
const MAYHEM_PROGRAM_ID = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function getMayhemGlobalParamsPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global-params')],
    MAYHEM_PROGRAM_ID
  )[0];
}

function getMayhemSolVaultPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('sol-vault')],
    MAYHEM_PROGRAM_ID
  )[0];
}

function getMayhemStatePDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('mayhem-state'), mint.toBuffer()],
    MAYHEM_PROGRAM_ID
  )[0];
}

async function getMayhemTokenVaultATA(mint: PublicKey): Promise<PublicKey> {
  const mayhemState = getMayhemStatePDA(mint);
  return await getAssociatedTokenAddress(mint, mayhemState, true, TOKEN_2022_PROGRAM_ID);
}

/**
 *
 * @param payer Payer Keypair
 * @param mint  CA Keypair
 * @param name  Token name
 * @param symbol  Token symbol
 * @param uri    Token metadata uri
 * @param buyAmount Buy amount Float String
 * @param slippageDecimal Slippage
 * @returns
 */
export const createAndDevBuyInstruction = async ({
  connection,
  payer,
  mint,
  name,
  symbol,
  uri,
  buyAmount,
  slippageDecimal,
  tokenAmount,
}: {
  connection: Connection;
  payer: PublicKey;
  mint: Keypair;
  name: string;
  symbol: string;
  uri: string;
  buyAmount: string;
  slippageDecimal: number;
  tokenAmount?: string;
}): Promise<Transaction> => {
  const provider = new AnchorProvider(connection as any, {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async () => {
      throw new Error('Signing not supported');
    },
    signAllTransactions: async () => {
      throw new Error('Signing not supported');
    },
  });
  const caPrice = '0.000000028';
  const createTx = await createSPLInstruction(connection, payer, mint, name, symbol, uri);

  const buyTx = await buySPLInstructions(
    provider,
    payer,
    mint.publicKey.toBase58(),
    new BigNumber(buyAmount).times(1e9).toFixed(0),
    slippageDecimal,
    caPrice,
    payer,
    tokenAmount
  );

  const transaction = new Transaction();
  transaction.add(createTx);
  transaction.add(buyTx[1]);

  return transaction;
};

/**
 * Create SPL token (using createV2 + Token-2022)
 * @param connection  RPC connection
 * @param payer Payer
 * @param mint  Token mint address
 * @param memename  Token name
 * @param symbol    Token symbol
 * @param uri       Token metadata uri
 */
export const createSPLInstruction = async (
  connection: Connection,
  payer: PublicKey,
  mint: Keypair,
  memename: string,
  symbol: string,
  uri: string
) => {
  const provider = new AnchorProvider(connection as any, {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async () => {
      throw new Error('Signing not supported');
    },
    signAllTransactions: async () => {
      throw new Error('Signing not supported');
    },
  });

  let program = new Program<PumpFun>(IDL as PumpFun, provider);
  const bonding_curve_pda = getBondingCurvePDA(mint.publicKey);

  const associatedBondingCurve = await getAssociatedTokenAddress(
    mint.publicKey,
    bonding_curve_pda,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  const globalParams = getMayhemGlobalParamsPDA();
  const solVault = getMayhemSolVaultPDA();
  const mayhemState = getMayhemStatePDA(mint.publicKey);
  const mayhemTokenVault = await getMayhemTokenVaultATA(mint.publicKey);

  return await (program.methods as any)
    .createV2(memename, symbol, uri, payer, false)
    .accounts({
      mint: mint.publicKey,
      // @ts-ignore
      associatedBondingCurve: associatedBondingCurve,
      user: payer,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
      mayhemProgramId: MAYHEM_PROGRAM_ID,
      globalParams: globalParams,
      solVault: solVault,
      mayhemState: mayhemState,
      mayhemTokenVault: mayhemTokenVault,
    })
    .signers([mint])
    .instruction();
};
