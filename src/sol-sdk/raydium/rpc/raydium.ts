import { Connection, Keypair } from '@solana/web3.js';
import { Raydium, RaydiumConstructorParams } from '@raydium-io/raydium-sdk-v2';

let raydium: Raydium;

export default (connection: Connection) => {
  if (raydium) {
    return raydium;
  }
  raydium = new Raydium({
    connection,
    owner: Keypair.generate(),
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'processed',
  } as any as RaydiumConstructorParams);
  return raydium;
};
