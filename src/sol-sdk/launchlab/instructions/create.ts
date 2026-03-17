import { Program, Provider, AnchorProvider } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';

import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { NATIVE_MINT } from '@solana/spl-token';

import { RaydiumLaunchlabIDL } from '../../../const/IDL/raydium-launchlab-IDL';
import { IDL } from '../../../const/IDL/raydium-launchlab-IDL';

import {
  RAYDIUM_LAUNCHLAB_GLOBAL_CONFIG,
  RAYDIUM_LAUNCHLAB_PLATFORM_CONFIG,
  RAYDIUM_LAUNCHLAB_PROGRAM,
} from '../../../const';
import BN from 'bn.js';
import { LaunchlabAmmCalc } from '../../calc';
import { buyExactInInstruction, buyExactOutInstruction } from './buy';
import BigNumber from 'bignumber.js';

export const createAndDevBuyInstruction = async ({
  connection,
  payer,
  mint,
  name,
  symbol,
  uri,
  buyAmount,
}: {
  connection: Connection;
  payer: PublicKey;
  mint: Keypair;
  name: string;
  symbol: string;
  uri: string;
  buyAmount: string;
}) => {
  const provider = new AnchorProvider(connection as any, {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async () => {
      throw new Error('Signing not supported');
    },
    signAllTransactions: async () => {
      throw new Error('Signing not supported');
    },
  });

  const transaction = new Transaction();

  transaction.add(
    await createInstruction({
      connection,
      owner: payer,
      mint,
      tokenName: name,
      tokenSymbol: symbol,
      tokenUri: uri,
    })
  );

  const calc = new LaunchlabAmmCalc({});

  transaction.add(
    await buyExactInInstruction({
      provider,
      owner: payer,
      baseMint: mint.publicKey,
      quoteMint: NATIVE_MINT,
      amountIn: BigInt(new BigNumber(buyAmount).times(LAMPORTS_PER_SOL).toFixed(0)),
      minAmountOut: BigInt(0),
      needCreateAtaAccount: true,
      needCloseTokenAccount: true,
    })
  );

  return transaction;
};

export const createInstruction = async ({
  connection,
  owner,
  mint,
  // Add token creation parameters
  tokenName,
  tokenSymbol,
  tokenUri,
  tokenDecimals = 6,
  // Add curve parameters
  supply = new BN(1000000000000000), // 1B tokens with 6 decimals
  totalQuoteFundRaising = new BN(85000000000), // 85 SOL in lamports
  // Add vesting parameters
  totalLockedAmount = new BN(0),
  cliffPeriod = new BN(0),
  unlockPeriod = new BN(0),
}: {
  connection: Connection;
  owner: PublicKey;
  mint: Keypair;
  // New parameter type definitions
  tokenName?: string;
  tokenSymbol?: string;
  tokenUri?: string;
  tokenDecimals?: number;
  supply?: BN;
  totalQuoteFundRaising?: BN;
  migrateType?: number;
  totalLockedAmount?: BN;
  cliffPeriod?: BN;
  unlockPeriod?: BN;
}) => {
  const provider = new AnchorProvider(connection as any, {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async () => {
      throw new Error('Signing not supported');
    },
    signAllTransactions: async () => {
      throw new Error('Signing not supported');
    },
  });

  let program = new Program<RaydiumLaunchlabIDL>(IDL as RaydiumLaunchlabIDL, provider);

  const transaction = new Transaction();

  const pool_state = PublicKey.findProgramAddressSync(
    [Buffer.from([112, 111, 111, 108]), mint.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  const baseVault = PublicKey.findProgramAddressSync(
    [
      Buffer.from([112, 111, 111, 108, 95, 118, 97, 117, 108, 116]),
      pool_state.toBuffer(),
      mint.publicKey.toBuffer(),
    ],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  const quoteVault = PublicKey.findProgramAddressSync(
    [
      Buffer.from([112, 111, 111, 108, 95, 118, 97, 117, 108, 116]),
      pool_state.toBuffer(),
      NATIVE_MINT.toBuffer(),
    ],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  // Calculate metadata account address
  const metadataAccount = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(), // Metaplex program ID
      mint.publicKey.toBuffer(),
    ],
    new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
  )[0];

  // Calculate event_authority address
  const eventAuthority = PublicKey.findProgramAddressSync(
    [
      Buffer.from([
        95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121,
      ]),
    ],
    RAYDIUM_LAUNCHLAB_PROGRAM
  )[0];

  // Build correct parameters
  const baseMintParam = {
    decimals: tokenDecimals,
    name: tokenName,
    symbol: tokenSymbol,
    uri: tokenUri,
  };

  const curveParam = {
    constant: {
      data: {
        supply,
        totalBaseSell: new BN(793100000000000),
        totalQuoteFundRaising: totalQuoteFundRaising,
        migrateType: 1,
      },
    },
  };

  const vestingParam = {
    totalLockedAmount: totalLockedAmount,
    cliffPeriod: cliffPeriod,
    unlockPeriod: unlockPeriod,
  };

  transaction.add(
    await program.methods
      .initialize(baseMintParam as any, curveParam as any, vestingParam as any)
      .accounts({
        payer: owner,
        creator: owner,
        globalConfig: RAYDIUM_LAUNCHLAB_GLOBAL_CONFIG,
        platformConfig: RAYDIUM_LAUNCHLAB_PLATFORM_CONFIG,
        baseMint: mint.publicKey,
        quoteMint: NATIVE_MINT,
        metadataAccount: metadataAccount,
        systemProgram: SystemProgram.programId,
        eventAuthority: eventAuthority,
        program: RAYDIUM_LAUNCHLAB_PROGRAM,
      } as any)
      .signers([mint])
      .instruction()
  );

  transaction.feePayer = owner;

  return transaction;
};
