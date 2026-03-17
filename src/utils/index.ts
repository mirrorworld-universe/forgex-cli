import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import BigNumber from 'bignumber.js';
import { NATIVE_MINT } from '@solana/spl-token';

const validExchanges = ['Pump', 'PumpSwap', 'Raydium', 'Raydium CPMM', 'LaunchLab', 'Meteora'];

export const formatWalletAddress = (address: string): string => {
  if (!address) return '';
  return address.slice(0, 6) + '...' + address.slice(-4);
};

export const getSplitAmount = (amount: number | string, decimals: number): number => {
  const splitStr = String(amount).split('.');
  const left = splitStr[0];
  if (decimals == 0) return Number(left);
  if (splitStr.length > 1) {
    const right = splitStr[1];
    if (right.length > decimals) {
      return Number(left + '.' + right.slice(0, decimals));
    } else {
      return Number(left + '.' + right);
    }
  }
  return Number(left);
};

export const getWalletAddress = (privateKey: string): string => {
  return Keypair.fromSecretKey(bs58.decode(privateKey)).publicKey.toBase58();
};

export const getWalletKeypair = (privateKey: string): Keypair => {
  return Keypair.fromSecretKey(bs58.decode(privateKey));
};

export const formatNumber = (num: number | string) => {
  num = Number(num);
  if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, '') + 'k';
  return num.toString();
};

export const getNativePriceFromAmountInOut = (
  amountIn: string,
  amountOut: string,
  tokenA: string,
  decimals: number = 6
): string => {
  try {
    let price = '0';
    if (tokenA === NATIVE_MINT.toBase58()) {
      price = new BigNumber(amountIn)
        .div(LAMPORTS_PER_SOL)
        .div(new BigNumber(amountOut).div(10 ** decimals))
        .toString(10);
    } else {
      price = new BigNumber(amountOut)
        .div(LAMPORTS_PER_SOL)
        .div(new BigNumber(amountIn).div(10 ** decimals))
        .toString(10);
    }
    return price;
  } catch (error) {
    console.error(error);
    return '0';
  }
};

// Format number to k, m, b, t
export const formatNumberToKMBT = (num: number): string => {
  // Handle positive/negative numbers
  const isNegative = num < 0;
  const absNum = Math.abs(num);

  // Format processing
  let result;
  if (absNum >= 1e12) {
    result = (absNum / 1e12).toFixed(2) + 'T';
  } else if (absNum >= 1e9) {
    result = (absNum / 1e9).toFixed(2) + 'B';
  } else if (absNum >= 1e6) {
    result = (absNum / 1e6).toFixed(2) + 'M';
  } else if (absNum >= 1e3) {
    result = (absNum / 1e3).toFixed(2) + 'K';
  } else {
    result = absNum.toFixed(2);
  }

  // Remove trailing zeros and unnecessary decimal point
  result = result.replace(/\.?0+$/, '');

  // Add negative sign (if original number is negative)
  return isNegative ? '-' + result : result;
};

/* @param {number} num - Number to format
 * @param {number} threshold - Threshold, process when number of zeros >= this value
 * @param {number} significantDigits - Number of significant digits to retain
 * @returns {string} Formatted string
 */
export const formatSmallNumber = (
  num: string,
  threshold = 4,
  significantDigits = 6,
  trimTrailingZeros = true
): string => {
  // Convert number to string to avoid scientific notation
  const numStr = num;
  if (!numStr.includes('.')) return numStr;

  const [intPart, decimalPart] = numStr.split('.');

  // Count leading zeros
  let zeroCount = 0;
  for (let i = 0; i < decimalPart.length; i++) {
    if (decimalPart[i] === '0') {
      zeroCount++;
    } else {
      break;
    }
  }

  // If zero count >= threshold, use subscript format
  if (zeroCount >= threshold) {
    const subscript = zeroCount
      .toString()
      .split('')
      .map(n => '₀₁₂₃₄₅₆₇₈₉'[parseInt(n)])
      .join('');
    const remainingPart = decimalPart.slice(zeroCount);

    // Take specified significant digits
    let formattedRemaining = remainingPart.slice(0, significantDigits);

    // If trailing zeros should be removed
    if (trimTrailingZeros) {
      formattedRemaining = formattedRemaining.replace(/0+$/, '');
    } else {
      // Pad with zeros
      formattedRemaining = formattedRemaining.padEnd(significantDigits, '0');
    }

    // If empty after removing trailing zeros, return without decimal point
    if (formattedRemaining === '') {
      return `${intPart}.0${subscript}`;
    }

    return `${intPart}.0${subscript}${formattedRemaining}`;
  }

  // Otherwise count digits from first non-zero digit
  const firstNonZeroIndex = decimalPart.search(/[1-9]/);
  if (firstNonZeroIndex === -1) {
    // If decimal part is all zeros
    return trimTrailingZeros ? `${intPart}` : `${intPart}.${decimalPart}`;
  }

  let formattedDecimal = decimalPart.slice(0, firstNonZeroIndex + significantDigits);

  // Remove trailing zeros based on trimTrailingZeros parameter
  if (trimTrailingZeros) {
    formattedDecimal = formattedDecimal.replace(/0+$/, '');
    // If empty after removing trailing zeros or all leading zeros, don't show decimal point
    if (formattedDecimal === '' || formattedDecimal.match(/^0+$/)) {
      return intPart;
    }
  }

  return `${intPart}.${formattedDecimal}`;
};

export const normalNumber = (
  num: number | string,
  threshold = 3,
  decimalPlaces = 6,
  trimTrailingZeros = true
): string => {
  if (isNaN(Number(num))) {
    return '0';
  }
  const currentNum = new BigNumber(num).toString(10);
  if (Math.abs(Number(currentNum)) > 0.9999) {
    return formatNumberToKMBT(Number(currentNum));
  } else {
    return formatSmallNumber(currentNum, threshold, decimalPlaces, trimTrailingZeros);
  }
};

export const sleep = (ms: number) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

export const getValidPairs = (pairs: Pair[]) => {
  const filteredPairs = pairs.filter(item => validExchanges.includes(item.exchange.name));
  const solPairs = filteredPairs.filter(
    item => item.tokenA === NATIVE_MINT.toBase58() || item.tokenB === NATIVE_MINT.toBase58()
  );
  return solPairs;
};
