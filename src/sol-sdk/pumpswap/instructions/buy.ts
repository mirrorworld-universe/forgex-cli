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
  LAMPORTS_PER_SOL,
  Connection,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { struct, u32, blob, u8, bool, u64 } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import BigNumber from 'bignumber.js';
import { Program } from '@coral-xyz/anchor';
import { IDL } from '../../../const/IDL/pump-swap-IDL';
import { PumpSwapIDL } from '../../../const/IDL/pump-swap-IDL';
import { AnchorProvider } from '@coral-xyz/anchor';
import {
  PUMP_SWAP_GLOBAL_CONFIG,
  PUMP_FEE_RECEIPENT,
  PUMP_SWAP_PROGRAM,
  PUMP_FEE_RECEIPENT_ATA,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_SWAP_EVENT_AUTHORITY,
  PUMP_SWAP_FEE_CONFIG,
  PUMP_SWAP_FEE_PROGRAM,
} from '../../../const';
import { getCoinCreatorVaultAtaPda, getCoinCreatorVaultAuthorityPda } from '../rpc';
import { getGlobalVolumeAccumulatorPDA, getUserVolumeAccumulatorPDA, getPoolV2PDA } from '..';

const BUY_DISCRIMINATOR: Uint8Array = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);

export const calcOutAmountByNewPool = ({
  amount,
  slippageDecimal,
}: {
  amount: string;
  slippageDecimal: number;
}) => {
  const poolInfo = {
    baseReserve: new BN(206900000000000),
    quoteReserve: new BN(84990360919),
  };
  const tokenPrice = new BigNumber(
    new BigNumber(poolInfo.quoteReserve.toString()).div(LAMPORTS_PER_SOL)
  )
    .div(new BigNumber(poolInfo.baseReserve.toString()).div('1000000'))
    .toString(10);

  const amountIn = new BigNumber(amount)
    .times(1 + slippageDecimal)
    .times(LAMPORTS_PER_SOL)
    .toNumber();
  const amountOut = new BigNumber(amount).div(tokenPrice).times(1000000).toFixed(0);
  console.log('Sniper launch, ', {
    baseAmountOut: new BN(amountOut),
    maxQuoteAmountIn: new BN(amountIn),
  });
  return {
    baseAmountOut: new BN(amountOut),
    maxQuoteAmountIn: new BN(amountIn),
  };
};

export const getPoolInfo = async (connection: Connection, poolId: string) => {
  const wallet = Keypair.generate();
  const provider = new AnchorProvider(
    connection as any,
    {
      publicKey: wallet.publicKey,
      signTransaction: async () => {
        throw new Error('Signing not supported');
      },
      signAllTransactions: async () => {
        throw new Error('Signing not supported');
      },
    },
    {}
  );
  let program = new Program<PumpSwapIDL>(IDL as PumpSwapIDL, provider);
  // Compatible with old/new IDL: Pool (PascalCase) or pool (camelCase)
  const accountNs = (program.account as any).pool || (program.account as any).Pool;
  const account = await accountNs.fetch(new PublicKey(poolId));
  // Compatible with camelCase (old IDL) and snake_case (new IDL) field names
  const baseMint = account.baseMint ?? account.base_mint;
  const quoteMint = account.quoteMint ?? account.quote_mint;
  const poolBaseTokenAccount = account.poolBaseTokenAccount ?? account.pool_base_token_account;
  const poolQuoteTokenAccount = account.poolQuoteTokenAccount ?? account.pool_quote_token_account;
  const coinCreator = account.coinCreator ?? account.coin_creator;
  const { mintAProgram, mintBProgram } = await getMintTokenPrograms(
    connection,
    poolBaseTokenAccount,
    poolQuoteTokenAccount
  );
  const [poolBaseTokenInfo, poolQuoteTokenInfo] = await Promise.all([
    decodePoolInfo((mintAProgram as any).data),
    decodePoolInfo((mintBProgram as any).data),
  ]);

  // Detect base/quote mint token program (Token vs Token-2022)
  const [baseMintInfo, quoteMintInfo] = await Promise.all([
    connection.getAccountInfo(new PublicKey(baseMint)),
    connection.getAccountInfo(new PublicKey(quoteMint)),
  ]);
  const baseTokenProgram = baseMintInfo?.owner || TOKEN_PROGRAM_ID;
  const quoteTokenProgram = quoteMintInfo?.owner || TOKEN_PROGRAM_ID;

  return {
    poolId,
    poolBaseTokenInfo,
    poolQuoteTokenInfo,
    vaultA: poolBaseTokenAccount,
    vaultB: poolQuoteTokenAccount,
    mintA: new PublicKey(baseMint).toBase58(),
    mintB: new PublicKey(quoteMint).toBase58(),
    baseTokenProgram,
    quoteTokenProgram,
    coinCreator: new PublicKey(coinCreator),
  };
};

const decodePoolInfo = async (data: Buffer) => {
  // Conclusion: same as AccountLayout
  const info = struct([
    blob(32, 'mint'),
    blob(32, 'owner'),
    u64('amount'),
    u32('delegateOption'),
    blob(32, 'delegate'),
    u8('state'),
    u32('isNativeOption'),
    u64('isNative'),
    u64('delegatedAmount'),
    u32('closeAuthorityOption'),
    blob(32, 'closeAuthority'),
  ]);
  const decoded = info.decode(data);
  return decoded;
};

const getMintTokenPrograms = async (connection: Connection, mintA: PublicKey, mintB: PublicKey) => {
  const mintAProgram = await connection.getAccountInfo(mintA);
  const mintBProgram = await connection.getAccountInfo(mintB);
  return { mintAProgram, mintBProgram };
};

export const buyInstruction = async ({
  owner,
  poolInfo,
  wsolAmount,
  tokenAmount,
  slippage,
  creator,
  needCreateAtaAccount = true,
  needCloseTokenAccount = false,
  needCloseWsolAccount = true,
  initialWsolAccount,
  createWsolAccountInstruction,
}: {
  owner: Keypair;
  poolInfo?: {
    poolId: string;
    mintA: string;
    mintB: string;
    baseTokenProgram?: PublicKey;
    quoteTokenProgram?: PublicKey;
  };
  wsolAmount: BN;
  tokenAmount: BN;
  slippage: number;
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

  const baseAmountOut = tokenAmount.toString();
  const maxQuoteAmountIn = new BigNumber(wsolAmount.toString()).times(1 + slippage).toFixed(0);

  if (poolInfo?.mintA !== inputMint && poolInfo?.mintB !== inputMint)
    return Promise.reject(new Error('input mint does not match pool'));

  // Determine base/quote token program (supports Token-2022)
  const tokenMint = poolInfo.mintA == NATIVE_MINT.toBase58() ? poolInfo.mintB : poolInfo.mintA;
  const baseTokenProgramId = poolInfo.baseTokenProgram || TOKEN_PROGRAM_ID;
  const quoteTokenProgramId = poolInfo.quoteTokenProgram || TOKEN_PROGRAM_ID;
  // base/quote to mintA/mintB mapping
  const mintATokenProgram = poolInfo.mintA === inputMint ? quoteTokenProgramId : baseTokenProgramId;
  const mintBTokenProgram = poolInfo.mintB === inputMint ? quoteTokenProgramId : baseTokenProgramId;

  const transaction = new Transaction();
  const baseLamports = 2039280;

  // If initial wsolAccount is provided, use it; otherwise create new one
  const wsolAccount =
    initialWsolAccount || (await PublicKey.createWithSeed(owner.publicKey, seed, TOKEN_PROGRAM_ID));
  const createWsolAccount =
    createWsolAccountInstruction ||
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner.publicKey,
      newAccountPubkey: wsolAccount,
      basePubkey: owner.publicKey,
      lamports: new BN(baseLamports).add(new BN(maxQuoteAmountIn)).toNumber(),
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

  // Only create Token Account when needed
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

  // protocol_fee_recipient_token_account PDA (uses quote token program)
  const protocolFeeRecipientAta = getCoinCreatorVaultAtaPda(
    PUMP_FEE_RECEIPENT,
    quoteTokenProgramId,
    new PublicKey(poolInfo.mintA === inputMint ? poolInfo.mintA : poolInfo.mintB)
  )[0];

  const globalVolumeAccumulator = getGlobalVolumeAccumulatorPDA();
  const userVolumeAccumulator = getUserVolumeAccumulatorPDA(owner.publicKey);

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
    { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false }, // global_volume_accumulator
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true }, // user_volume_accumulator
    { pubkey: PUMP_SWAP_FEE_CONFIG, isSigner: false, isWritable: false }, // fee_config
    { pubkey: PUMP_SWAP_FEE_PROGRAM, isSigner: false, isWritable: false }, // fee_program
    // PumpFun upgrade: append pool_v2 PDA (readonly)
    { pubkey: getPoolV2PDA(new PublicKey(poolInfo.mintA === inputMint ? poolInfo.mintB : poolInfo.mintA)), isSigner: false, isWritable: false },
  ];

  // 8 (discriminator) + 8 (base_amount_out) + 8 (max_quote_amount_in) + 1 (track_volume: OptionBool)
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  data.set(BUY_DISCRIMINATOR, 0);

  // Browser-compatible BigInt write method
  const writeBigUInt64LE = (buffer: Buffer, value: bigint, offset: number) => {
    const uint8Array = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      uint8Array[i] = Number((value >> BigInt(i * 8)) & BigInt(0xff));
    }
    buffer.set(uint8Array, offset);
  };

  writeBigUInt64LE(data, BigInt(baseAmountOut.toString()), 8);
  writeBigUInt64LE(data, BigInt(maxQuoteAmountIn.toString()), 16);
  data.writeUInt8(0, 24); // track_volume = false (OptionBool)

  transaction.add(
    new TransactionInstruction({
      keys: accounts,
      programId: PUMP_SWAP_PROGRAM,
      data: data,
    })
  );

  // Only add close instruction when WSOL account needs to be closed
  if (needCloseWsolAccount) {
    transaction.add(createCloseAccountInstruction(wsolAccount, owner.publicKey, owner.publicKey));
  }

  // Only add close instruction when Token account needs to be closed
  if (needCloseTokenAccount) {
    transaction.add(createCloseAccountInstruction(tokenAccount, owner.publicKey, owner.publicKey));
  }

  transaction.feePayer = owner.publicKey;

  return transaction;
};

export const calcCAPrice = async (connection: Connection, poolId: string) => {
  const poolInfo = await getPoolInfo(connection, poolId);
  const { poolBaseTokenInfo, poolQuoteTokenInfo, mintA, mintB } = poolInfo;
  const baseReserve = poolBaseTokenInfo.amount.toString();
  const quoteReserve = poolQuoteTokenInfo.amount.toString();
  if (mintA === NATIVE_MINT.toBase58()) {
    const tokenPrice = new BigNumber(new BigNumber(baseReserve).div(LAMPORTS_PER_SOL)).div(
      new BigNumber(quoteReserve).div('1000000')
    );
    console.log(
      `pumpswap calculated CA price, time ${new Date().toISOString()}, price ${tokenPrice.toString(10)}`
    );
    return tokenPrice.toString(10);
  } else {
    const tokenPrice = new BigNumber(new BigNumber(quoteReserve).div(LAMPORTS_PER_SOL)).div(
      new BigNumber(baseReserve).div('1000000')
    );
    console.log(
      `pumpswap calculated CA price, time ${new Date().toISOString()}, price ${tokenPrice.toString(10)}`
    );
    return tokenPrice.toString(10);
  }
};
