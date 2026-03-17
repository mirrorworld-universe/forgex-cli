import { PublicKey, Connection } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BigNumber from 'bignumber.js';
import initSDK from './raydium';
import { Api, Market } from '@raydium-io/raydium-sdk-v2';
import axios from 'axios';
import { initSdk } from '../index';

export const raydiumCalcCaPrice = async (connection: Connection, poolId: string) => {
  const raydium = initSDK(connection);
  const pool = await raydium.liquidity.getRpcPoolInfo(poolId);
  const baseReserve = pool.baseReserve.toString(10);
  const quoteReserve = pool.quoteReserve.toString(10);
  const baseDecimal = pool.baseDecimal.toString(10);
  const quoteDecimal = pool.quoteDecimal.toString(10);
  const baseAmount = new BigNumber(baseReserve).div(
    new BigNumber(10).pow(new BigNumber(baseDecimal))
  );
  const quoteAmount = new BigNumber(quoteReserve).div(
    new BigNumber(10).pow(new BigNumber(quoteDecimal))
  );
  const price = baseAmount.div(quoteAmount).toFixed(9);
  return price;
};

export const raydiumGetPoolInfo = async (connection: Connection, poolId: string) => {
  const raydium = await initSdk(connection);
  const pool = await raydium.liquidity.getRpcPoolInfo(poolId);
  return {
    poolBaseTokenInfo: {
      amount: pool.baseReserve.toString(10),
    },
    poolQuoteTokenInfo: {
      amount: pool.quoteReserve.toString(10),
    },
  };
};

export const raydiumGetCpmmPoolInfo = async (connection: Connection, poolId: string) => {
  const raydium = await initSdk(connection);
  const pool = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  return {
    poolBaseTokenInfo: {
      amount: pool.rpcData.baseReserve.toString(10),
    },
    poolQuoteTokenInfo: {
      amount: pool.rpcData.quoteReserve.toString(10),
    },
  };
};

export const searchPoolByMint = async (
  mint: string,
  isNew: boolean
): Promise<string | { poolId: string; poolKeys: object }> => {
  return new Promise(async (resolve, reject) => {
    try {
      const pools = await new Api({
        cluster: 'mainnet',
        timeout: 10000,
      }).fetchPoolByMints({ mint1: NATIVE_MINT, mint2: new PublicKey(mint) });
      const pool = pools.data.filter(item => item.type === 'Standard');

      resolve(pool[0]?.id ?? null);
    } catch (error) {
      throw new Error(error as string);
    }
  });
};

export const getPoolVault = async (
  poolId: string
): Promise<{ A: string; B: string; mintA: string; mintB: string }> => {
  const res = await axios.get(`https://api-v3.raydium.io/pools/key/ids?ids=${poolId}`);
  return {
    A: res.data.data[0].vault.A,
    B: res.data.data[0].vault.B,
    mintA: res.data.data[0].mintA.address,
    mintB: res.data.data[0].mintB.address,
  };
};

export const getPoolKeys = async (connection: Connection, poolId: string) => {
  const raydium = await initSdk(connection);
  const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolId);
  return {
    poolKeys,
  };
};

export const getRaydiumCpmmKeys = async (connection: Connection, poolId: string) => {
  const raydium = await initSdk(connection);
  const poolKeys = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  return {
    poolKeys,
  };
};
