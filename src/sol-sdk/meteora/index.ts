import { AnchorProvider, Program, BorshAccountsCoder, BN } from '@coral-xyz/anchor';
import { PublicKey, Connection, Keypair } from '@solana/web3.js';

import { METEORA_DLMM_PROGRAM } from '../../const';

import { IDL, type MeteoraDLMM } from '../../const/IDL/meteora-DLMM';

export const getDLMMPoolInfo = async ({
  connection,
  poolId,
}: {
  connection: Connection;
  poolId: string;
}) => {
  const poolInfo = await connection.getAccountInfo(new PublicKey(poolId));
  if (!poolInfo) {
    throw new Error('Pool not found');
  }
  const decoded = new BorshAccountsCoder(IDL as MeteoraDLMM).decode('LbPair', poolInfo.data);
  return {
    reserve_x: decoded.reserve_x.toBase58(),
    reserve_y: decoded.reserve_y.toBase58(),
    token_x_mint: decoded.token_x_mint.toBase58(),
    token_y_mint: decoded.token_y_mint.toBase58(),
    oracle: decoded.oracle.toBase58(),
    bin_step: decoded.bin_step,
    bin_array_bitmap: decoded.bin_array_bitmap.map((item: BN) => item.toString()),
    active_id: decoded.active_id,
    v_parameters: decoded.v_parameters,
  };
};

export const getBinArrayPDA = (poolId: string, index: number) => {
  const indexBuf = Buffer.alloc(2); // u16
  indexBuf.writeUInt16LE(index, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bin_array'), new PublicKey(poolId).toBuffer(), indexBuf],
    METEORA_DLMM_PROGRAM
  )[0];
};

export const getBinArray = async ({
  connection,
  poolId,
}: {
  connection: Connection;
  poolId: string;
}) => {
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
  const program = new Program(IDL as MeteoraDLMM, provider);
  const binArray = await (program.account as any).binArray.all([
    {
      memcmp: {
        bytes: poolId,
        offset: 8 + 16,
      },
    },
  ]);
  return binArray;
};

/**
 * Calculate DLMM pool current price
 * @param binStep - Pool bin step parameter
 * @param activeId - Current active bin ID
 * @param solIsBase - Whether SOL is base token (tokenX)
 * @returns SOL price (relative to the other token)
 */
export const calculateDLMMPrice = (
  binStep: number,
  activeId: number,
  solIsBase: boolean = true
): number => {
  // DLMM price formula: price = (1 + binStep/10000) ^ activeId
  const basePrice = Math.pow(1 + binStep / 10000, activeId);

  // If SOL is base token (tokenX), price represents tokenY/tokenX
  // If SOL is quote token (tokenY), price represents tokenX/tokenY
  const priceXperY = solIsBase ? 1 / basePrice : basePrice;

  // We need to return SOL price, so adjust based on SOL position
  return solIsBase ? 1 / priceXperY : priceXperY / 1000;
};

export function deriveBinArrayBitmapExtension(lbPair: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('bitmap'), lbPair.toBytes()], programId);
}

export {
  buyInstructions as meteoraDlmmBuyInstructions,
  buyExactOutInstructions as meteoraDlmmBuyExactOutInstructions,
} from './instructions/buy';
export { sellInstructions as meteoraDlmmSellInstructions } from './instructions/sell';
