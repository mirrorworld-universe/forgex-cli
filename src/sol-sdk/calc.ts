import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import BN from 'bn.js';
import { getBinArrayPDA } from './meteora';
import { PublicKey } from '@solana/web3.js';
import { IDL as METEORA_DLMM_IDL } from '@/const/IDL/meteora-DLMM';

export default class AmmCalc {
  private baseReserve: bigint;
  private quoteReserve: bigint;
  private readonly baseDecimals: number;
  private readonly quoteDecimals: number;

  constructor(props: {
    baseReserve: string;
    quoteReserve: string;
    baseDecimals: number;
    quoteDecimals: number;
  }) {
    this.baseReserve = BigInt(props.baseReserve);
    this.quoteReserve = BigInt(props.quoteReserve);
    this.baseDecimals = props.baseDecimals;
    this.quoteDecimals = props.quoteDecimals;
  }

  /**
   * Get current reserves
   */
  getReserves(): { base: string; quote: string } {
    return {
      base: this.baseReserve.toString(),
      quote: this.quoteReserve.toString(),
    };
  }

  /**
   * Calculate output amount based on CPMM constant product formula
   * @param amountIn input amount (bigint)
   * @param reserveIn input reserve
   * @param reserveOut output reserve
   */
  private calculateAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
    const amountInWithFee = amountIn; // fee logic can be added
    const numerator = amountInWithFee * reserveOut;
    // const denominator = reserveIn * BigInt(1000) + amountInWithFee; // assuming 0.3% fee, i.e. 997/1000, can be made configurable
    const denominator = reserveIn + amountInWithFee; // assume fee is 0.3%, i.e. 997/1000, can be made configurable
    return numerator / denominator;
  }

  /**
   * Perform swap
   * @param amountIn input amount (string)
   * @param isBaseToQuote true = base->quote, false = quote->base
   */
  swap(amountIn: string, isBaseToQuote: boolean): string {
    const inAmount = BigInt(amountIn);
    if (inAmount <= BigInt(0)) throw new Error('AmountIn must be positive');

    if (isBaseToQuote) {
      const outAmount = this.calculateAmountOut(inAmount, this.baseReserve, this.quoteReserve);
      if (outAmount > this.quoteReserve) throw new Error('Insufficient quote reserve');

      this.baseReserve += inAmount;
      this.quoteReserve -= outAmount;

      return outAmount.toString();
    } else {
      const outAmount = this.calculateAmountOut(inAmount, this.quoteReserve, this.baseReserve);
      if (outAmount > this.baseReserve) throw new Error('Insufficient base reserve');

      this.quoteReserve += inAmount;
      this.baseReserve -= outAmount;

      return outAmount.toString();
    }
  }
}

export class PumpAmmCalc {
  tokenDecimals = 10 ** 6;
  tokenTotalSupply = new BN(1000000000 * this.tokenDecimals);
  initialVirtualSolReserves = new BN(28 * LAMPORTS_PER_SOL);
  initialRealSolReserves = new BN(0);
  initialVirtualTokenReserves = new BN(1073000000 * this.tokenDecimals);
  initialRealTokenReserves = new BN(793100000 * this.tokenDecimals);

  constructor(props: {
    tokenTotalSupply?: BN;
    initialRealSolReserves?: BN;
    initialVirtualTokenReserves?: BN;
    initialRealTokenReserves?: BN;
    initialVirtualSolReserves?: BN;
  }) {
    this.tokenTotalSupply = props.tokenTotalSupply ?? this.tokenTotalSupply;
    this.initialVirtualSolReserves =
      props.initialVirtualSolReserves ?? this.initialVirtualSolReserves;
    this.initialRealSolReserves = props.initialRealSolReserves ?? this.initialRealSolReserves;
    this.initialVirtualTokenReserves =
      props.initialVirtualTokenReserves ?? this.initialVirtualTokenReserves;
    this.initialRealTokenReserves = props.initialRealTokenReserves ?? this.initialRealTokenReserves;
  }

  /**
   * Get current reserves
   */
  getReserves() {
    return {
      virtualSolReserves: this.initialVirtualSolReserves,
      virtualTokenReserves: this.initialVirtualTokenReserves,
      realTokenReserves: this.initialRealTokenReserves,
      realSolReserves: this.initialRealSolReserves,
      tokenTotalSupply: this.tokenTotalSupply,
    };
  }

  getPrice() {
    const totalSolReserves = this.initialRealSolReserves.add(this.initialVirtualSolReserves);
    const totalTokenReserves = this.initialRealTokenReserves.add(this.initialVirtualTokenReserves);
    return totalSolReserves.div(totalTokenReserves);
  }

  calculateBuyAmountOut(amount: string) {
    const solAmount = new BN(amount);

    const virtualTokenReserves = this.initialVirtualTokenReserves; // BN, min units
    const virtualSolReserves = this.initialVirtualSolReserves; // BN, lamports
    const realSolReserves = this.initialRealSolReserves; // BN, lamports
    const realTokenReserves = this.initialRealTokenReserves; // BN, min units

    // k = virtual_token * (virtual_sol)
    const k = virtualTokenReserves.mul(virtualSolReserves); // BN

    // new_virtual_token = k / (virtual_sol + delta_sol)
    const denominator = virtualSolReserves.add(solAmount); // BN
    const newVirtualTokenReserves = k.div(denominator); // BN

    // tokens_bought = virtual_token - new_virtual_token
    let tokensToBuy = virtualTokenReserves.sub(newVirtualTokenReserves); // BN

    // can only buy up to remaining real reserves
    tokensToBuy = BN.min(tokensToBuy, realTokenReserves);

    // update reserves (real part)
    this.initialRealSolReserves = this.initialRealSolReserves.add(solAmount);
    this.initialRealTokenReserves = this.initialRealTokenReserves.sub(tokensToBuy);
    // whether virtual reserves change depends on actual logic (most projects unchanged)
    this.initialVirtualTokenReserves = newVirtualTokenReserves;

    return tokensToBuy; // returns min units, divide by 1e6 for display
  }

  /**
   * Calculate SOL amount needed to buy exact token amount
   * @param tokenAmount amount of tokens to buy (string in min units)
   * @returns SOL amount needed (lamports)
   */
  calculateBuyExactAmountOut(tokenAmount: string): BN {
    const tokensWanted = new BN(tokenAmount);

    const virtualTokenReserves = this.initialVirtualTokenReserves; // BN, min units
    const virtualSolReserves = this.initialVirtualSolReserves; // BN, lamports
    const realSolReserves = this.initialRealSolReserves; // BN, lamports
    const realTokenReserves = this.initialRealTokenReserves; // BN, min units

    // check if enough tokens available for purchase
    if (tokensWanted.gt(realTokenReserves)) {
      throw new Error('Purchase amount exceeds available token reserves');
    }

    if (tokensWanted.lte(new BN(0))) {
      throw new Error('Purchase amount must be greater than 0');
    }

    // k = virtual_token * virtual_sol
    const k = virtualTokenReserves.mul(virtualSolReserves);

    // calculate new virtual token reserves after purchase
    // new_virtual_token = virtual_token - tokens_wanted
    const newVirtualTokenReserves = virtualTokenReserves.sub(tokensWanted);

    // calculate new virtual SOL reserves from constant product formula
    // new_virtual_sol = k / new_virtual_token
    const newVirtualSolReserves = k.div(newVirtualTokenReserves);

    // calculate SOL amount needed
    // sol_needed = new_virtual_sol - virtual_sol
    const solNeeded = newVirtualSolReserves.sub(virtualSolReserves);

    // validate calculation result
    if (solNeeded.lte(new BN(0))) {
      throw new Error('Calculated SOL amount is invalid');
    }

    // update reserves (real part)
    this.initialRealSolReserves = this.initialRealSolReserves.add(solNeeded);
    this.initialRealTokenReserves = this.initialRealTokenReserves.sub(tokensWanted);
    // update virtual reserves
    this.initialVirtualTokenReserves = newVirtualTokenReserves;

    return solNeeded; // returns lamports, divide by 1e9 for display as SOL
  }

  calculateSellAmountOut(amount: string) {
    const tokenAmount = new BN(amount);

    const virtualTokenReserves = this.initialVirtualTokenReserves; // BN
    const virtualSolReserves = this.initialVirtualSolReserves; // BN
    const realSolReserves = this.initialRealSolReserves; // BN
    const realTokenReserves = this.initialRealTokenReserves; // BN

    // k = virtual_token * (virtual_sol + real_sol)
    const k = virtualTokenReserves.mul(virtualSolReserves.add(realSolReserves));

    // new_virtual_token = virtual_token + deltaToken
    const newVirtualTokenReserves = virtualTokenReserves.add(tokenAmount);

    // new_sol_reserves = k / new_virtual_token
    const newSolReserves = k.div(newVirtualTokenReserves);

    // solToReturn = (virtual_sol + real_sol) - new_sol_reserves
    let solToReturn = virtualSolReserves.add(realSolReserves).sub(newSolReserves);

    // Can only withdraw up to real SOL reserves
    solToReturn = BN.min(solToReturn, realSolReserves);

    // Check if sufficient
    if (solToReturn.lte(new BN(0))) throw new Error('Sell amount is invalid');

    // Update reserves
    this.initialRealSolReserves = this.initialRealSolReserves.sub(solToReturn);
    this.initialRealTokenReserves = this.initialRealTokenReserves.add(tokenAmount);
    this.initialVirtualTokenReserves = newVirtualTokenReserves;

    // Returns lamports; divide by 1e9 on frontend to get SOL
    return solToReturn.toString();
  }
}

export class LaunchlabAmmCalc {
  baseDecimals = 6; // Token decimals
  quoteDecimals = 9; // SOL decimals
  migrateType = 1;
  supply: BN; // Total supply
  totalBaseSell: BN; // Tokens available for sale
  virtualBase: BN; // Virtual token reserves
  virtualQuote: BN; // Virtual SOL reserves
  realBase: BN; // Real token reserves
  realQuote: BN; // Real SOL reserves
  totalQuoteFundRaising: BN; // Fundraising target

  constructor(props: {
    baseDecimals?: number;
    quoteDecimals?: number;
    migrateType?: number;
    supply?: BN;
    totalBaseSell?: BN;
    virtualBase?: BN;
    virtualQuote?: BN;
    realBase?: BN;
    realQuote?: BN;
    totalQuoteFundRaising?: BN;
  }) {
    // Use provided parameters or defaults
    this.baseDecimals = props.baseDecimals ?? 6;
    this.quoteDecimals = props.quoteDecimals ?? 9;
    this.migrateType = props.migrateType ?? 1;
    this.supply = props.supply ?? new BN('1000000000000000'); // 1,000,000,000,000,000
    this.totalBaseSell = props.totalBaseSell ?? new BN('793100000000000'); // 793,100,000,000,000
    this.virtualBase = props.virtualBase ?? new BN('1073025605596382'); // 1,073,025,605,596,382
    this.virtualQuote = props.virtualQuote ?? new BN('30000852951'); // 30,000,852,951
    this.realBase = props.realBase ?? new BN('0'); // Initial real token reserves = 0
    this.realQuote = props.realQuote ?? new BN('0'); // Initial real SOL reserves = 0
    this.totalQuoteFundRaising = props.totalQuoteFundRaising ?? new BN('85000000000'); // 85,000,000,000
  }

  /**
   * Get current reserves
   */
  getReserves() {
    return {
      baseDecimals: this.baseDecimals,
      quoteDecimals: this.quoteDecimals,
      migrateType: this.migrateType,
      supply: this.supply,
      totalBaseSell: this.totalBaseSell,
      virtualBase: this.virtualBase,
      virtualQuote: this.virtualQuote,
      realBase: this.realBase,
      realQuote: this.realQuote,
      totalQuoteFundRaising: this.totalQuoteFundRaising,
    };
  }

  /**
   * Get current price (SOL/Token)
   */
  getPrice() {
    const totalQuoteReserves = this.realQuote.add(this.virtualQuote);
    // Fix: realBase represents tokens already sold, so available base reserves = virtualBase - realBase
    const totalBaseReserves = this.virtualBase.sub(this.realBase);
    return totalQuoteReserves.div(totalBaseReserves);
  }

  /**
   * Calculate token amount received from a buy
   * @param solAmount SOL amount (lamports string)
   * @returns Token amount purchasable (in min units)
   */
  calculateBuyAmountOut(solAmount: string): BN {
    const quoteAmountIn = new BN(solAmount);

    // Calculate total reserves
    const totalVirtualBase = this.virtualBase;
    const totalVirtualQuote = this.virtualQuote;
    const totalRealQuote = this.realQuote;
    const totalRealBase = this.realBase;

    console.log('totalVirtualBase: ', totalVirtualBase.toString());
    console.log('totalVirtualQuote: ', totalVirtualQuote.toString());
    console.log('totalRealQuote: ', totalRealQuote.toString());
    console.log('totalRealBase: ', totalRealBase.toString());

    // Fix: realBase represents tokens already sold, so available base reserves = virtualBase - realBase
    const totalBase = totalVirtualBase.sub(totalRealBase);
    const totalQuote = totalVirtualQuote.add(totalRealQuote);

    // Constant product formula: k = (virtual_base - real_base) * (virtual_quote + real_quote)
    const k = totalBase.mul(totalQuote);

    // Calculate new quote reserves
    const newQuoteReserves = totalQuote.add(quoteAmountIn);

    // Calculate new virtual base reserves: new_base = k / new_quote_reserves
    const newBase = k.div(newQuoteReserves);

    // Calculate tokens purchasable: tokens_out = totalBase - new_base
    let tokensOut = totalBase.sub(newBase);

    // Check if exceeds total tokens available for sale
    const remainingTokensForSale = this.totalBaseSell.sub(totalRealBase);
    tokensOut = BN.min(tokensOut, remainingTokensForSale);

    // Check if enough tokens available for sale
    if (tokensOut.lte(new BN(0))) {
      throw new Error('Buy amount invalid: not enough tokens available for sale');
    }

    // Update reserve state (only update real reserves; virtual reserves unchanged)
    this.realQuote = this.realQuote.add(quoteAmountIn);
    this.realBase = this.realBase.add(tokensOut); // realBase represents tokens sold, should increase

    return tokensOut;
  }

  /**
   * Calculate SOL received from a sell
   * @param tokenAmount Token amount (min units string)
   * @returns SOL amount received (lamports)
   */
  calculateSellAmountOut(tokenAmount: string): string {
    const baseAmountIn = new BN(tokenAmount);

    // Calculate total reserves
    const totalVirtualBase = this.virtualBase;
    const totalVirtualQuote = this.virtualQuote;
    const totalRealQuote = this.realQuote;
    const totalRealBase = this.realBase;

    // Fix: realBase represents tokens already sold, so available base reserves = virtualBase - realBase
    const totalBase = totalVirtualBase.sub(totalRealBase);
    const totalQuote = totalVirtualQuote.add(totalRealQuote);

    // Constant product formula: k = (virtual_base - real_base) * (virtual_quote + real_quote)
    const k = totalBase.mul(totalQuote);

    // Calculate new base reserves
    const newBaseReserves = totalBase.add(baseAmountIn);

    // Calculate new quote reserves: new_quote_reserves = k / new_base_reserves
    const newQuoteReserves = k.div(newBaseReserves);

    // Calculate SOL received: sol_out = (virtual_quote + real_quote) - new_quote_reserves
    let solOut = totalQuote.sub(newQuoteReserves);

    // Ensure does not exceed real available reserves
    solOut = BN.min(solOut, totalRealQuote);

    // Check if enough SOL available
    if (solOut.lte(new BN(0))) {
      throw new Error('Sell amount invalid: not enough SOL available');
    }

    // Check if enough sold tokens can be reclaimed
    if (baseAmountIn.gt(totalRealBase)) {
      throw new Error('Sell amount invalid: exceeds tokens already sold');
    }

    // Update reserve state (only update real reserves; virtual reserves unchanged)
    this.realBase = this.realBase.sub(baseAmountIn); // realBase represents tokens sold, should decrease on sell
    this.realQuote = this.realQuote.sub(solOut);

    return solOut.toString();
  }

  /**
   * Check if migration conditions are met
   */
  canMigrate(): boolean {
    return this.realQuote.gte(this.totalQuoteFundRaising);
  }

  /**
   * Get fundraising progress (0-100)
   */
  getFundingProgress(): number {
    const current = this.realQuote.toNumber();
    const target = this.totalQuoteFundRaising.toNumber();
    return Math.min((current / target) * 100, 100);
  }

  /**
   * Get remaining tokens available for sale
   */
  getRemainingTokensForSale(): BN {
    return this.totalBaseSell.sub(this.realBase);
  }

  /**
   * Get market cap (based on current price)
   */
  getMarketCap(): BN {
    const price = this.getPrice();
    const totalSupplyInBase = this.supply;
    return price.mul(totalSupplyInBase);
  }
}

// Q64.64 decoding utility
function decodeQ64_64(priceBN: BN): BigNumber {
  return new BigNumber(priceBN.toString()).div('18446744073709551616');
}

const CONSTANTS = Object.entries(METEORA_DLMM_IDL.constants);

const MAX_BIN_ARRAY_SIZE = new BN(
  CONSTANTS.find(([k, v]) => v.name == 'MAX_BIN_PER_ARRAY')?.[1].value ?? 0
);

const BIN_ARRAY_BITMAP_SIZE = new BN(
  CONSTANTS.find(([k, v]) => v.name == 'BIN_ARRAY_BITMAP_SIZE')?.[1].value ?? 0
);

export class MeteoraDLMMCalc {
  /**
   * DLMM core parameters
   */
  readonly reserveX: string;
  readonly reserveY: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly oracle: string;
  readonly binStep: number;
  readonly binArrayBitmap: string[];
  readonly activeId: number;
  readonly vParameters: {
    index_reference: number;
    last_update_timestamp: string;
    volatility_accumulator: number;
    volatility_reference: number;
  };

  /**
   * All DLMM bin liquidity and prices (must be pre-assembled externally, sorted by binId ascending)
   */
  allBins: Array<{
    account: {
      index: number;
      bins: {
        amountX: BN;
        amountY: BN;
        price: BN;
        liquiditySupply: BN;
        binArrayPubkey: string;
      }[];
    };
    publicKey: PublicKey;
  }> = [];

  // Formula constants
  static BASIS_POINT_MAX = 10000;
  static MAX_FEE_RATE = 100_000_000;
  static FEE_PRECISION = 100_000_000;
  static OFFSET = 99_999_999_999;
  static SCALE = 100_000_000_000;

  baseDecimals: number = 6; // Default 6 decimals
  quoteDecimals: number = 9; // Default 9 decimals

  /**
   * Constructor supports passing allBins
   */
  constructor(
    info: MeteoraDLMMReverseInfo & {
      allBins?: Array<{
        account: {
          index: number;
          bins: {
            amountX: BN;
            amountY: BN;
            price: BN;
            liquiditySupply: BN;
            binArrayPubkey: string;
          }[];
        };
        publicKey: PublicKey;
      }>;
      baseDecimals?: number;
      quoteDecimals?: number;
      binArrayBitmap?: string[];
    }
  ) {
    this.reserveX = info.reserveX;
    this.reserveY = info.reserveY;
    this.mintA = info.mintA;
    this.mintB = info.mintB;
    this.oracle = info.oracle;
    this.binStep = info.binStep;
    this.binArrayBitmap = info.binArrayBitmap;
    this.activeId = info.activeId;
    this.vParameters = info.vParameters;
    if (info.allBins) this.allBins = info.allBins;
    if (info.baseDecimals !== undefined) this.baseDecimals = info.baseDecimals;
    if (info.quoteDecimals !== undefined) this.quoteDecimals = info.quoteDecimals;
    if (info.binArrayBitmap !== undefined) this.binArrayBitmap = info.binArrayBitmap;
  }

  /**
   * Get DLMM current price
   * price = (1 + bin_step/BASIS_POINT_MAX) ^ active_id
   * @returns number
   */
  getPrice(): number {
    return Math.pow(1 + this.binStep / MeteoraDLMMCalc.BASIS_POINT_MAX, this.activeId);
  }

  /**
   * Calculate base fee rate
   * base_fee_rate = base_factor * bin_step * 10 * 10^base_fee_power_factor
   * @param baseFactor number
   * @param baseFeePowerFactor number
   */
  getBaseFeeRate(baseFactor: number, baseFeePowerFactor: number): number {
    return baseFactor * this.binStep * 10 * Math.pow(10, baseFeePowerFactor);
  }

  /**
   * Calculate variable fee rate
   * variable_fee_rate = ((volatility_accumulator * bin_step)^2 * variable_fee_control + OFFSET) / SCALE
   * @param variableFeeControl number
   */
  getVariableFeeRate(variableFeeControl: number): number {
    const { volatility_accumulator } = this.vParameters;
    const t = volatility_accumulator * this.binStep;
    return (t * t * variableFeeControl + MeteoraDLMMCalc.OFFSET) / MeteoraDLMMCalc.SCALE;
  }

  /**
   * Calculate total fee rate
   * total_fee_rate = min(base_fee_rate + variable_fee_rate, MAX_FEE_RATE)
   * @param baseFactor number
   * @param baseFeePowerFactor number
   * @param variableFeeControl number
   */
  getTotalFeeRate(
    baseFactor: number,
    baseFeePowerFactor: number,
    variableFeeControl: number
  ): number {
    const baseFee = this.getBaseFeeRate(baseFactor, baseFeePowerFactor);
    const variableFee = this.getVariableFeeRate(variableFeeControl);
    return Math.min(baseFee + variableFee, MeteoraDLMMCalc.MAX_FEE_RATE);
  }

  /**
   * Calculate composition fee
   * composition_fee = swap_amount * total_fee_rate * (1 + total_fee_rate) / FEE_PRECISION^2
   * @param swapAmount number
   * @param totalFeeRate number
   */
  getCompositionFee(swapAmount: number, totalFeeRate: number): number {
    return (swapAmount * totalFeeRate * (1 + totalFeeRate)) / MeteoraDLMMCalc.FEE_PRECISION ** 2;
  }

  /**
   * Calculate price impact / slippage
   * @param spotPrice number Current price
   * @param maxPriceImpactBps number Max price impact in bps
   * @param direction 'sellX' | 'sellY' Selling X or Y
   * @returns minPrice
   */
  getMinPrice(spotPrice: number, maxPriceImpactBps: number, direction: 'sellX' | 'sellY'): number {
    if (direction === 'sellX') {
      // min_price = spot_price * (BASIS_POINT_MAX - max_price_impact_bps) / BASIS_POINT_MAX
      return (
        (spotPrice * (MeteoraDLMMCalc.BASIS_POINT_MAX - maxPriceImpactBps)) /
        MeteoraDLMMCalc.BASIS_POINT_MAX
      );
    } else {
      // min_price = spot_price * BASIS_POINT_MAX / (BASIS_POINT_MAX - max_price_impact_bps)
      return (
        (spotPrice * MeteoraDLMMCalc.BASIS_POINT_MAX) /
        (MeteoraDLMMCalc.BASIS_POINT_MAX - maxPriceImpactBps)
      );
    }
  }

  /**
   * Helper: jump-search for next bin index with liquidity (buy direction)
   * @param flatBins Flattened bin array
   * @param startIdx Start index
   * @returns Next bin index with amountY liquidity, or -1 if not found
   */
  private findNextBinIndexWithLiquidityY(flatBins: any[], startIdx: number): number {
    for (let i = startIdx; i < flatBins.length; i++) {
      if (flatBins[i] && !new BN(flatBins[i].amountY).isZero()) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Helper: jump-search for next bin index with liquidity (sell direction)
   * @param flatBins Flattened bin array
   * @param startIdx Start index
   * @returns Next bin index with amountX liquidity, or -1 if not found
   */
  private findNextBinIndexWithLiquidityX(flatBins: any[], startIdx: number): number {
    for (let i = startIdx; i >= 0; i--) {
      if (flatBins[i] && !new BN(flatBins[i].amountX).isZero()) {
        return i;
      }
    }
    return -1;
  }

  binIdToBinArrayIndex(binId: BN): BN {
    const { div: idx, mod } = binId.divmod(MAX_BIN_ARRAY_SIZE);
    return binId.isNeg() && !mod.isZero() ? idx.sub(new BN(1)) : idx;
  }

  internalBitmapRange() {
    const lowerBinArrayIndex = BIN_ARRAY_BITMAP_SIZE.neg();
    const upperBinArrayIndex = BIN_ARRAY_BITMAP_SIZE.sub(new BN(1));
    return [lowerBinArrayIndex, upperBinArrayIndex];
  }

  /**
   * DLMM buy: iterate activeId and right-side bins, consume quoteIn, return purchasable base amount and involved binArray pubkeys
   * Optimized: jump-search for bins with liquidity for better performance
   */
  calculateBuyAmountOut(quoteIn: BN): { amount: BN; binArraysPubkey: string[] } {
    let remainQuote = new BigNumber(quoteIn.toString());
    let baseOut = new BigNumber(0);
    const binArraysPubkeySet = new Set<string>();
    const flatBins = this.allBins
      .map(item => {
        const items = item.account.bins.map(item2 => ({
          ...item2,
          binArrayPubkey: item.publicKey.toBase58(),
        }));
        return items;
      })
      .flat();
    let i = this.activeId;
    while (i < flatBins.length) {
      i = this.findNextBinIndexWithLiquidityY(flatBins, i);
      if (i === -1) break;
      const bin = flatBins[i];
      binArraysPubkeySet.add(bin.binArrayPubkey);
      const maxBase = new BigNumber(bin.amountY.toString());
      const price = decodeQ64_64(bin.price);
      const maxQuote = maxBase.multipliedBy(price);
      if (remainQuote.gte(maxQuote)) {
        baseOut = baseOut.plus(maxBase);
        remainQuote = remainQuote.minus(maxQuote);
        i++;
      } else {
        const buyBase = remainQuote.dividedBy(price);
        baseOut = baseOut.plus(buyBase);
        break;
      }
      if (remainQuote.lte(0)) break;
    }
    return {
      amount: new BN(baseOut.integerValue(BigNumber.ROUND_DOWN).toString()),
      binArraysPubkey: Array.from(binArraysPubkeySet),
    };
  }

  /**
   * DLMM sell: iterate activeId and left-side bins, consume baseIn, return quote amount received and involved binArray pubkeys
   * Optimized: jump-search for bins with liquidity for better performance
   */
  calculateSellAmountOut(baseIn: BN): { amount: BN; binArraysPubkey: string[] } {
    let remainBase = new BigNumber(baseIn.toString());
    let quoteOut = new BigNumber(0);
    const binArraysPubkeySet = new Set<string>();
    const flatBins = this.allBins
      .map(item => {
        const items = item.account.bins.map(item2 => ({
          ...item2,
          binArrayPubkey: item.publicKey.toBase58(),
        }));
        return items;
      })
      .flat();
    let i = this.activeId;
    while (i >= 0) {
      i = this.findNextBinIndexWithLiquidityX(flatBins, i);
      if (i === -1) break;
      const bin = flatBins[i];
      binArraysPubkeySet.add(bin.binArrayPubkey);
      const maxBase = new BigNumber(bin.amountX.toString());
      const price = decodeQ64_64(bin.price);
      if (remainBase.gte(maxBase)) {
        quoteOut = quoteOut.plus(maxBase.multipliedBy(price));
        remainBase = remainBase.minus(maxBase);
        i--;
      } else {
        quoteOut = quoteOut.plus(remainBase.multipliedBy(price));
        break;
      }
      if (remainBase.lte(0)) break;
    }
    return {
      amount: new BN(quoteOut.integerValue(BigNumber.ROUND_DOWN).toString()),
      binArraysPubkey: Array.from(binArraysPubkeySet),
    };
  }

  // TODO: swapQuote, swapQuoteExactOut and other core swap estimation methods
}
