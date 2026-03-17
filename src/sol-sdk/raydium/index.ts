import {
  Raydium,
  TxVersion,
  parseTokenAccountResp,
  AMM_V4,
  AMM_STABLE,
  DEVNET_PROGRAM_ID,
} from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

export const owner: Keypair = Keypair.generate();
export const txVersion = TxVersion.V0; // or TxVersion.LEGACY
const cluster = 'mainnet'; // 'mainnet' | 'devnet'

let raydium: Raydium | undefined;
export const initSdk = async (connection: any) => {
  if (raydium) return raydium;
  raydium = await Raydium.load({
    owner: owner.publicKey,
    connection,
    cluster,
    disableFeatureCheck: true,
    disableLoadToken: true,
  });

  return raydium;
};

export const fetchTokenAccountData = async (connection: Connection) => {
  const solAccountResp = await connection.getAccountInfo(owner.publicKey);
  const tokenAccountResp = await connection.getTokenAccountsByOwner(owner.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });
  const token2022Req = await connection.getTokenAccountsByOwner(owner.publicKey, {
    programId: TOKEN_2022_PROGRAM_ID,
  });
  const tokenAccountData = parseTokenAccountResp({
    owner: owner.publicKey,
    solAccountResp,
    tokenAccountResp: {
      context: tokenAccountResp.context,
      value: [...tokenAccountResp.value, ...token2022Req.value],
    },
  });
  return tokenAccountData;
};

const VALID_PROGRAM_ID = new Set([AMM_V4.toBase58(), AMM_STABLE.toBase58()]);

export const isValidAmm = (id: string) => {
  return VALID_PROGRAM_ID.has(id);
};

export {
  buyInstruction as raydiumBuyInstruction,
  buyExactOutInstruction as raydiumBuyExactOutInstruction,
} from './instructions/buy';
export {
  cpmmSwapBaseOutBuyInstruction as raydiumCpmmSwapBaseOutBuyInstruction,
  cpmmSwapBaseInBuyInstruction as raydiumCpmmSwapBaseInBuyInstruction,
} from './instructions/cpmmBuy';
export {
  sellInstruction as raydiumSellInstruction,
  beforeSell as raydiumBeforeSell,
} from './instructions/sell';
export { cpmmSellInstruction as raydiumCpmmSellInstruction } from './instructions/cpmmSell';
export {
  raydiumCalcCaPrice,
  raydiumGetPoolInfo,
  raydiumGetCpmmPoolInfo,
  searchPoolByMint,
  getPoolVault as raydiumGetPoolVault,
  getPoolKeys as raydiumGetPoolKeys,
  getRaydiumCpmmKeys as raydiumGetCpmmKeys,
} from './rpc';
