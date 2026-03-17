// Global type declarations
declare type GroupType = 'local' | 'monitor';
declare type MonitorType = 'normal' | 'top100' | 'retail';

declare enum TransactionStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
}

declare enum UserWalletType {
  LOGIN = 'login',
  GROUP = 'group',
}

declare enum PriorityFeeSpeed {
  NORMAL = 'normal',
  FAST = 'fast',
  FASTEST = 'fastest',
}

declare interface WalletInfo {
  walletAddress: string;
  privateKey: string;
  note: string;
}

declare interface GroupInfo {
  name: string;
  groupId: number;
  groupType: GroupType;
  wallets: WalletInfo[];
  monitorType: MonitorType;
  note: string;
  monitorCA?: string;
  filterGroupIds?: number[];
}

declare interface MergedGroupInfo {
  id: string;
  name: string;
  groupIds: number[];
}

declare interface TransferSOLAddress {
  from: PublicKey;
  to: PublicKey;
  amount: number;
}

declare interface TransferTokenAddress {
  from: PublicKey;
  to: PublicKey;
  amount: number;
  token: string;
  decimals: number;
}

declare interface WalletTransferItem {
  from: string;
  to: string;
  amount: string;
  decimals: number;
  token?: string;
  status: TransactionStatus;
  txHash: string;
  time: string;
}

declare interface ToolsTransactionItem {
  time: string;
  tradeType: 'buy' | 'sell';
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountIn: string;
  amountOut: string;
  address: string;
  txHash: string;
  status: TransactionStatus;
}

declare interface Pair {
  createdAt: number;
  liquidity: string;
  pairAddress: string;
  volume: string;
  tokenA: string;
  tokenB: string;
  exchange: {
    name: string;
    address: string;
  };
}

declare interface TokenInfoProps {
  icon: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  description: string;
  price: string;
  priceInSol: number;
  volume24h: string;
  liquidity: string;
  fdv: string;
  marketCap: string;
  age: number;
  holders: number;
  twitter: string;
  website: string;
  telegram: string;
  isPumpfun: boolean;
  totalSupply: string;
  poolInfo: Pair;
  pairs: Pair[];
  creatorAddress: string;
}

declare interface WalletGroup {
  key: string;
  name: string;
  wallets: {
    id: string;
    name: string;
    address: string;
    checked: boolean;
    privateKey: string;
  }[];
  // Optional group selection state
  checked?: boolean;
}

declare interface Exchange {
  address: string;
  color: string | null;
  exchangeVersion: string | null;
  iconUrl: string;
  id: string;
  name: string;
  networkId: number;
  tradeUrl: string;
}

declare interface Project {
  id: string;
  ca: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  poolId: string;
  exchange?: string;
}

declare interface TokenInfo {
  address: string;
  circulatingSupply: string;
  cmcId: number | null;
  description: string;
  id: string;
  imageBannerUrl: string | null;
  imageLargeUrl: string;
  imageSmallUrl: string;
  imageThumbUrl: string;
  isScam: boolean | null;
  name: string;
  networkId: number;
  symbol: string;
  totalSupply: string;
}

declare interface Launchpad {
  completed: boolean;
  completedAt: number;
  completedSlot: number;
  graduationPercent: number;
  migrated: boolean;
  migratedAt: number;
  migratedPoolAddress: string;
  migratedSlot: number;
  poolAddress: string;
}

declare interface SocialLinks {
  bitcointalk: string | null;
  blog: string | null;
  coingecko: string | null;
  coinmarketcap: string | null;
  discord: string | null;
  email: string | null;
  facebook: string | null;
  github: string | null;
  instagram: string | null;
  linkedin: string | null;
  reddit: string | null;
  slack: string | null;
  telegram: string | null;
  twitch: string | null;
  twitter: string | null;
  website: string | null;
  wechat: string | null;
  whitepaper: string | null;
  youtube: string | null;
}

declare interface ClientRedis {
  pumpCache: Record<string, any>;
  pumpAtaCache: Record<string, any>;
  pumpSwapCache: Record<string, any>;
  pumpSwapAtaCache: Record<string, any>;
}

declare interface TradeWallet {
  solBalance: number;
  tokenBalance: number;
}

declare type TradeWalletsBalance = Record<string, TradeWallet>;

declare interface PumpfunReverseInfo {
  virtualSolReserves?: string;
  virtualTokenReserves: string;
  realTokenReserves: string;
  realSolReserves: string;
  tokenTotalSupply: string;
  complete: boolean;
}

declare interface LaunchlabReverseInfo {
  totalVirtualBase: string;
  totalVirtualQuote: string;
  totalRealQuote: string;
  totalRealBase: string;
  supply: string;
  baseDecimals: number;
  quoteDecimals: number;
  migrateType: number;
  totalBaseSell: string;
  virtualBase: string;
  virtualQuote: string;
  realBase: string;
  realQuote: string;
  migrateType: number;
  fundRaising: string;
}

declare interface PumpswapReverseInfo {
  mintA: string;
  mintB: string;
  poolBaseTokenInfo: {
    amount: string;
  };
  poolQuoteTokenInfo: {
    amount: string;
  };
}

declare interface AmmReverseInfo {
  mintA: string;
  mintB: string;
  poolBaseTokenInfo: {
    amount: string;
  };
  poolQuoteTokenInfo: {
    amount: string;
  };
  baseTokenProgram?: import('@solana/web3.js').PublicKey;
  quoteTokenProgram?: import('@solana/web3.js').PublicKey;
}

declare interface MeteoraDLMMReverseInfo {
  reserveX: string;
  reserveY: string;
  mintA: string;
  mintB: string;
  oracle: string;
  binStep: number;
  binArrayBitmap: string[];
  activeId: number;
  realBinArrays?: Array<{
    index: number;
    bins: string[];
  }>;
  vParameters: {
    index_reference: number;
    last_update_timestamp: string;
    volatility_accumulator: number;
    volatility_reference: number;
  };
}

declare interface WalletData {
  key: string;
  type: string;
  solBalance: string;
  solAddress: string;
  totalValue: string;
  pnl: string;
  realizedPnl: string;
  unrealizedPnl: string;
  totalBuyAmount: string;
  totalSellAmount: string;
  tokenCount: number;
  note: string;
  privateKey?: string;
  avgCost?: string;
  sellTotal?: string;
  buyTotalCost?: string;
  sellTotalRevenue?: string;
  tokenBalance?: string;
  decimals?: number;
}
