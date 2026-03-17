import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
} from '@solana/spl-token';
import {
  Transaction,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import BigNumber from 'bignumber.js';
import {
  PUMP_SWAP_GLOBAL_CONFIG,
  PUMP_FEE_RECEIPENT,
  PUMP_SWAP_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_SWAP_EVENT_AUTHORITY,
  PUMP_SWAP_FEE_CONFIG,
  PUMP_SWAP_FEE_PROGRAM,
} from '../../../const';
import { getCoinCreatorVaultAuthorityPda, getCoinCreatorVaultAtaPda } from '../rpc';
import { getPoolV2PDA } from '..';

const SELL_DISCRIMINATOR: Uint8Array = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);

export const sellSPLInstructions = async ({
  owner,
  slippage = 0.01,
  poolInfo,
  wsolAmount,
  tokenAmount,
  creator,
  needCreateAtaAccount = true,
  needCloseTokenAccount = false,
  needCloseWsolAccount = true,
  initialWsolAccount,
  createWsolAccountInstruction,
}: {
  owner: Keypair;
  slippage: number;
  poolInfo: {
    poolId: string;
    mintA: string;
    mintB: string;
    baseTokenProgram?: PublicKey;
    quoteTokenProgram?: PublicKey;
  };
  wsolAmount: BN;
  tokenAmount: BN;
  creator: PublicKey;
  needCreateAtaAccount?: boolean;
  needCloseTokenAccount?: boolean;
  needCloseWsolAccount?: boolean;
  initialWsolAccount?: PublicKey;
  createWsolAccountInstruction?: TransactionInstruction;
}): Promise<Transaction> => {
  const inputMint = NATIVE_MINT.toBase58();
  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);

  const baseAmountIn = tokenAmount.toString();
  const minQuoteAmountOut = new BigNumber(wsolAmount.toString()).times(1 - slippage).toFixed(0);

  if (poolInfo?.mintA !== inputMint && poolInfo?.mintB !== inputMint)
    return Promise.reject(new Error('input mint does not match pool'));

  // Determine base/quote token program (supports Token-2022)
  const tokenMint = poolInfo.mintA == NATIVE_MINT.toBase58() ? poolInfo.mintB : poolInfo.mintA;
  const baseTokenProgramId = poolInfo.baseTokenProgram || TOKEN_PROGRAM_ID;
  const quoteTokenProgramId = poolInfo.quoteTokenProgram || TOKEN_PROGRAM_ID;
  const mintATokenProgram = poolInfo.mintA === inputMint ? quoteTokenProgramId : baseTokenProgramId;
  const mintBTokenProgram = poolInfo.mintB === inputMint ? quoteTokenProgramId : baseTokenProgramId;

  const transaction = new Transaction();
  const baseLamports = 2039280;

  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner.publicKey, seed, TOKEN_PROGRAM_ID));

  const createWsolAccount =
    createWsolAccountInstruction ||
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner.publicKey,
      newAccountPubkey: wsolAccount,
      basePubkey: owner.publicKey,
      lamports: new BN(baseLamports).toNumber(),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
      seed,
    });

  // Use correct token program to get ATA (supports Token-2022)
  const tokenProgramForMint = poolInfo.mintA === inputMint ? mintBTokenProgram : mintATokenProgram;
  const tokenAccount = await getAssociatedTokenAddress(
    new PublicKey(tokenMint),
    owner.publicKey,
    false,
    tokenProgramForMint
  );

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
        new PublicKey(tokenMint),
        tokenProgramForMint
      )
    );
  }

  const [poolBaseTokenAccount, poolQuoteTokenAccount] = await Promise.all([
    getAssociatedTokenAddress(new PublicKey(poolInfo.mintA), new PublicKey(poolInfo.poolId), true, mintATokenProgram),
    getAssociatedTokenAddress(new PublicKey(poolInfo.mintB), new PublicKey(poolInfo.poolId), true, mintBTokenProgram),
  ]);

  const coin_creator_vault_authority_data = getCoinCreatorVaultAuthorityPda(
    creator,
    PUMP_SWAP_PROGRAM
  );
  const coin_creator_vault_authority = coin_creator_vault_authority_data[0];
  const coin_creator_vault_ata_data = getCoinCreatorVaultAtaPda(
    coin_creator_vault_authority,
    quoteTokenProgramId,
    NATIVE_MINT
  );
  const coin_creator_vault_ata = coin_creator_vault_ata_data[0];

  // protocol_fee_recipient_token_account PDA (using quote token program)
  const protocolFeeRecipientAta = getCoinCreatorVaultAtaPda(
    PUMP_FEE_RECEIPENT,
    quoteTokenProgramId,
    new PublicKey(poolInfo.mintA === inputMint ? poolInfo.mintA : poolInfo.mintB)
  )[0];

  const accounts = [
    { pubkey: new PublicKey(poolInfo.poolId), isSigner: false, isWritable: true }, // pool (writable)
    { pubkey: owner.publicKey, isSigner: true, isWritable: true }, // user (signer)
    { pubkey: PUMP_SWAP_GLOBAL_CONFIG, isSigner: false, isWritable: false }, // global_config
    { pubkey: new PublicKey(poolInfo.mintA), isSigner: false, isWritable: false }, // base_mint
    { pubkey: new PublicKey(poolInfo.mintB), isSigner: false, isWritable: false }, // quote_mint
    {
      pubkey: poolInfo.mintA === NATIVE_MINT.toBase58() ? wsolAccount : tokenAccount,
      isSigner: false,
      isWritable: true,
    }, // user_base_token_account
    {
      pubkey: poolInfo.mintA === NATIVE_MINT.toBase58() ? tokenAccount : wsolAccount,
      isSigner: false,
      isWritable: true,
    }, // user_quote_token_account
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true }, // pool_base_token_account
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true }, // pool_quote_token_account
    { pubkey: PUMP_FEE_RECEIPENT, isSigner: false, isWritable: false }, // protocol_fee_recipient
    { pubkey: protocolFeeRecipientAta, isSigner: false, isWritable: true }, // protocol_fee_recipient_token_account
    { pubkey: mintATokenProgram, isSigner: false, isWritable: false }, // base_token_program
    { pubkey: mintBTokenProgram, isSigner: false, isWritable: false }, // quote_token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associated_token_program
    { pubkey: PUMP_SWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // event_authority
    { pubkey: PUMP_SWAP_PROGRAM, isSigner: false, isWritable: false }, // program
    { pubkey: coin_creator_vault_ata, isSigner: false, isWritable: true }, // coin_creator_vault_ata
    { pubkey: coin_creator_vault_authority, isSigner: false, isWritable: false }, // coin_creator_vault_authority
    { pubkey: PUMP_SWAP_FEE_CONFIG, isSigner: false, isWritable: false }, // fee_config
    { pubkey: PUMP_SWAP_FEE_PROGRAM, isSigner: false, isWritable: false }, // fee_program
    // PumpFun upgrade: append pool_v2 PDA (readonly)
    { pubkey: getPoolV2PDA(new PublicKey(poolInfo.mintA === inputMint ? poolInfo.mintB : poolInfo.mintA)), isSigner: false, isWritable: false },
  ];

  // 8 (discriminator) + 8 (base_amount_in) + 8 (min_quote_amount_out)
  const data = Buffer.alloc(8 + 8 + 8);
  data.set(SELL_DISCRIMINATOR, 0);

  const writeBigUInt64LE = (buffer: Buffer, value: bigint, offset: number) => {
    const uint8Array = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      uint8Array[i] = Number((value >> BigInt(i * 8)) & BigInt(0xff));
    }
    buffer.set(uint8Array, offset);
  };

  writeBigUInt64LE(data, BigInt(baseAmountIn.toString()), 8);
  writeBigUInt64LE(data, BigInt(minQuoteAmountOut), 16);

  transaction.add(
    new TransactionInstruction({
      keys: accounts,
      programId: PUMP_SWAP_PROGRAM,
      data: data,
    })
  );

  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner.publicKey, owner.publicKey));
  }

  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(tokenAccount, owner.publicKey, owner.publicKey));
  }

  transaction.feePayer = owner.publicKey;

  return transaction;
};
