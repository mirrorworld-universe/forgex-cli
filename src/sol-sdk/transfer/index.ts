import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BigNumber from 'bignumber.js';

const MIN_COMMISSION_AMOUNT = new BigNumber(0.005).times(LAMPORTS_PER_SOL).toNumber();

// Transfer SOL instruction
export const transferSOLInstruction = (
  from: PublicKey,
  to: PublicKey,
  amount: number
): TransactionInstruction => {
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: to,
    lamports: amount,
  });
};

export const transferSOL = (addresses: TransferSOLAddress[]): TransactionInstruction[] => {
  return addresses.map(address =>
    transferSOLInstruction(new PublicKey(address.from), new PublicKey(address.to), address.amount)
  );
};

// Transfer token instruction
export const transferTokenInstruction = ({
  from,
  to,
  amount,
  token,
  fromAta,
  toAta,
  decimals,
}: {
  from: PublicKey;
  to: PublicKey;
  amount: number;
  token: string;
  fromAta: PublicKey;
  toAta: PublicKey;
  decimals: number;
}): Transaction[] => {
  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      from,
      toAta,
      new PublicKey(to),
      new PublicKey(token)
    )
  );
  tx.add(
    createTransferCheckedInstruction(
      fromAta,
      new PublicKey(token),
      toAta,
      from,
      BigInt(amount),
      decimals,
      [from]
    )
  );
  return [tx];
};

// Batch transfer token instruction
export const transferToken = (addresses: TransferTokenAddress[]): Transaction[] => {
  const alltxs: Transaction[] = [];
  addresses.forEach(address => {
    const fromAta = getAssociatedTokenAddressSync(
      new PublicKey(address.token),
      new PublicKey(address.from)
    );
    const toAta = getAssociatedTokenAddressSync(
      new PublicKey(address.token),
      new PublicKey(address.to)
    );
    const txs = transferTokenInstruction({
      from: new PublicKey(address.from),
      to: new PublicKey(address.to),
      fromAta: fromAta,
      toAta: toAta,
      amount: address.amount,
      token: address.token,
      decimals: address.decimals,
    });
    alltxs.push(...txs);
  });
  return alltxs;
};

// Transfer SOL to WSOL instruction
export const solToWsolInstruction = ({
  from,
  fromAta,
  amount,
}: {
  from: PublicKey;
  fromAta: PublicKey;
  amount: number;
}): TransactionInstruction[] => {
  const txs: TransactionInstruction[] = [];
  txs.push(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: fromAta,
      lamports: amount,
    }),
    createSyncNativeInstruction(fromAta)
  );
  return txs;
};

// Transfer WSOL to SOL instruction
export const wsolToSolInstruction = ({
  from,
  fromAta,
}: {
  from: PublicKey;
  fromAta: PublicKey;
}): TransactionInstruction[] => {
  const txs: TransactionInstruction[] = [];
  txs.push(createCloseAccountInstruction(fromAta, from, from));
  return txs;
};


