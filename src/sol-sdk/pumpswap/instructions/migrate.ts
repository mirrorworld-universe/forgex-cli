import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { ComputeBudgetProgram } from '@solana/web3.js';
import { IDL } from '../../../const/IDL/pump-fun';
import { PumpFun } from '../../../const/IDL/pump-fun';

export const migrate = async (
  connection: Connection,
  migrator: Keypair,
  mint: PublicKey
): Promise<Transaction> => {
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
    {
      commitment: 'processed',
    }
  );
  const program = new Program<PumpFun>(IDL as PumpFun, provider);
  const transaction = new Transaction();
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 500000,
    })
  );
  const tx = await program.methods
    .migrate()
    .accountsPartial({
      // @ts-ignore
      mint: new PublicKey(mint),
      user: migrator.publicKey,
    })
    .instruction();

  transaction.add(tx);

  return transaction;
};
