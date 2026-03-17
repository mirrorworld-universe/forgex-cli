import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import {
  PublicKey,
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  Blockhash,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from '@solana/web3.js';
import JitoJsonRpcClient from '../jito';
import { lookupTableProvider } from './lookupTable';
import { sleep } from '@/utils';
import {
  PUMP_FUN_PROGRAM,
  MPLX_METADATA,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_AUTHORITY,
  SYSTEM_PROGRAM_ID,
} from '@/const';
import { getBondingCurvePDA } from '../pump';
import BN from 'bn.js';

export const getATAPublicKey = async (address: PublicKey, token: PublicKey) => {
  return await getAssociatedTokenAddress(new PublicKey(token), address);
};

export const getATAPublicKeys = async (addresses: PublicKey[], token: PublicKey) => {
  return await Promise.all(addresses.map(address => getATAPublicKey(address, token)));
};

export const getNewWsolAccount = async (owner: PublicKey, buyAmount: string) => {
  const randomAccount = Keypair.generate();
  const seed = randomAccount.publicKey.toBase58().slice(0, 32);
  const baseLamports = 2039280;

  const wsolAccount = await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID);

  const lamports = new BN(baseLamports).add(new BN(buyAmount)).toNumber();

  const createWsolAccount = SystemProgram.createAccountWithSeed({
    fromPubkey: owner,
    newAccountPubkey: wsolAccount,
    basePubkey: owner,
    lamports,
    space: 165,
    programId: TOKEN_PROGRAM_ID,
    seed,
  });

  return {
    wsolAccount,
    createWsolAccount,
  };
};

export const createLutAccount = async (
  connection: Connection,
  payer: Keypair
): Promise<{ base64Tx: string; lutAddress: PublicKey } | undefined> => {
  const createLUTixs: TransactionInstruction[] = [];
  const tipInstruction = await new JitoJsonRpcClient().getTipInstruction(payer.publicKey, 0.00001);

  const [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: await connection.getSlot('processed'),
  });
  createLUTixs.push(lookupTableInst);
  createLUTixs.push(tipInstruction);

  const lookupTable = lookupTableProvider(connection);

  const addressesMain: PublicKey[] = [];
  createLUTixs.forEach(ixn => {
    ixn.keys.forEach(key => {
      addressesMain.push(key.pubkey);
    });
  });
  const lookupTablesMain1 = lookupTable.computeIdealLookupTablesForAddresses(addressesMain);

  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    instructions: createLUTixs,
    recentBlockhash: blockhash,
  }).compileToV0Message(lookupTablesMain1);

  const createLUT = new VersionedTransaction(messageV0);

  try {
    createLUT.sign([payer]);
  } catch (error) {
    throw error;
  }

  const serializedTransaction = createLUT.serialize();

  const base64EncodedTransaction = Buffer.from(serializedTransaction).toString('base64');

  if (base64EncodedTransaction.length > 1644) {
    throw new Error('tx too big');
  }

  return { base64Tx: base64EncodedTransaction, lutAddress: lookupTableAddress };
};

export const extendLutAccount = async (
  connection: Connection,
  payer: Keypair,
  lutAddress: PublicKey,
  addresses: PublicKey[],
  mint: PublicKey
) => {
  try {
    let bundledTxns1: VersionedTransaction[] = [];
    const tipInstruction = await new JitoJsonRpcClient().getTipInstruction(payer.publicKey, 0.001);
    let accounts: PublicKey[] = [];

    let lookupTableAccount: AddressLookupTableAccount;

    while (true) {
      const lut = await connection.getAddressLookupTable(lutAddress);
      if (lut.value) {
        lookupTableAccount = lut.value;
        break;
      }
      await sleep(1000);
    }

    const bondingCurve = getBondingCurvePDA(mint);

    const [metadata] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), MPLX_METADATA.toBytes(), mint.toBytes()],
      MPLX_METADATA
    );

    let [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [bondingCurve.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    accounts.push(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      MPLX_METADATA,
      MINT_AUTHORITY,
      SYSTEM_PROGRAM_ID,
      SYSVAR_RENT_PUBKEY,
      NATIVE_MINT,
      mint,
      bondingCurve,
      associatedBondingCurve,
      metadata,
      lutAddress
    );

    const promiseArr: Promise<any>[] = [];
    for (const address of addresses) {
      promiseArr.push(getAssociatedTokenAddress(mint, address));
      accounts.push(address);
    }
    accounts.push(...(await Promise.all(promiseArr)));

    const extendLUTixs1: TransactionInstruction[] = [];
    const extendLUTixs2: TransactionInstruction[] = [];
    const extendLUTixs3: TransactionInstruction[] = [];
    const extendLUTixs4: TransactionInstruction[] = [];

    const accountChunks = Array.from({ length: Math.ceil(accounts.length / 30) }, (v, i) =>
      accounts.slice(i * 30, (i + 1) * 30)
    );
    const lookupTableOwner = payer;
    for (let i = 0; i < accountChunks.length; i++) {
      const chunk = accountChunks[i];
      const extendInstruction = AddressLookupTableProgram.extendLookupTable({
        lookupTable: lutAddress,
        authority: lookupTableOwner.publicKey,
        payer: lookupTableOwner.publicKey,
        addresses: chunk,
      });
      if (i == 0) {
        extendLUTixs1.push(extendInstruction);
        // console.log('Chunk:', i);
      } else if (i == 1) {
        extendLUTixs2.push(extendInstruction);
        // console.log('Chunk:', i);
      } else if (i == 2) {
        extendLUTixs3.push(extendInstruction);
        // console.log('Chunk:', i);
      } else if (i == 3) {
        extendLUTixs4.push(extendInstruction);
        // console.log('Chunk:', i);
      }
    }

    // Add the jito tip to the last txn
    extendLUTixs4.push(tipInstruction);

    const { blockhash } = await connection.getLatestBlockhash();

    const extend1 = buildTxn(extendLUTixs1, blockhash, lookupTableAccount, payer);
    const extend2 = buildTxn(extendLUTixs2, blockhash, lookupTableAccount, payer);
    const extend3 = buildTxn(extendLUTixs3, blockhash, lookupTableAccount, payer);
    const extend4 = buildTxn(extendLUTixs4, blockhash, lookupTableAccount, payer);
    const txns = [extend1, extend2, extend3, extend4];
    const txnsFiltered = txns.filter(tx => tx != null);

    txnsFiltered.forEach(tx => {
      if (tx) {
        bundledTxns1.push(tx);
      }
    });

    const serializedTxns1 = bundledTxns1.map(tx => {
      return Buffer.from(tx.serialize()).toString('base64');
    });

    return serializedTxns1;
  } catch (e) {
    throw e;
  }
};

const buildTxn = (
  extendLUTixs: TransactionInstruction[],
  blockhash: string | Blockhash,
  lut: AddressLookupTableAccount,
  payer: Keypair
): VersionedTransaction | null => {
  if (extendLUTixs.length == 0) {
    return null;
  }
  const lookupTableOwner = payer;
  const messageMain = new TransactionMessage({
    payerKey: lookupTableOwner.publicKey,
    recentBlockhash: blockhash,
    instructions: extendLUTixs,
  }).compileToV0Message([lut]);
  const txn = new VersionedTransaction(messageMain);
  txn.sign([lookupTableOwner]);
  try {
    const serializedMsg = txn.serialize();
    if (serializedMsg.length > 1232) {
      throw new Error('tx too big');
    }
  } catch (e) {
    throw new Error('error signing extendLUT');
  }
  return txn;
};
