declare interface Response<T> {
  code: number;
  message: string;
  data: T;
}

declare interface SystemConfig {
  rpc_node: RpcNode[];
}

declare interface CommissionRecordItem {
  createdTime: string;
  updatedTime: string;
  deletedTime: string | null;
  version: number;
  id: number;
  accountId: number;
  address: string;
  fromAddress: string;
  amount: string;
  txHash: string;
  status: number;
}

declare interface CommissionRecord {
  count: number;
  totalAmount: string;
  list: CommissionRecordItem[];
}

declare interface InviteListItem {
  createdTime: string;
  id: number;
  address: string;
}

declare type InviteListResponse = InviteListItem[];

declare interface RpcNode {
  key: string;
  node_name: string;
  url: string;
  latency: number;
}
declare interface FeeConfig {
  trade_fee: number; // trade fee
  tip_address: string; // tip address
  referral_fee: number; // referral fee
  batch_transfer_fee_for_batch: number; // batch transfer fee
  batch_collection_fee_for_wallet: number; // batch collection fee
  multi_to_multi: number; // multi-to-multi fee
  launch_sniper_switch: boolean; // active launch sniper fee
  launch_sniper_fee: number; // active launch sniper external fee
  same_block_shift: number; // same-block turnover fee
  same_block_shift_jump: number; // same-block turnover multi-hop fee
  same_block_swap: number; // same-block volume fee
}

declare type NativePrice = {
  usd: number;
};

declare interface UserInfo {
  createdTime: string;
  id: number;
  address: string;
  inviteCode: string;
  parentId: number | null;
  lastLoginTime: string;
  feeConfig: FeeConfig;
}

declare interface CodexExchangeItem {
  address: string;
  color: string;
  exchangeVersion: string;
  iconUrl: string;
  id: string;
  name: string;
  networkId: number;
  tradeUrl: string;
}

declare interface TokenItem {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  icon: {
    large: string;
    small: string;
    thumb: string;
  };
  totalSupply: string;
}

declare type TokenList = TokenItem[];

declare type TokenListFromAddressItem = {
  token: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    info: {
      imageSmallUrl: string;
      name: string;
      symbol: string;
      description: string;
      totalSupply: string;
    };
  };
  balance: string;
};

declare type TokenListFromAddress = TokenListFromAddressItem[];

declare interface CAInfo {
  holders: number;
  pairs: {
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
  }[];
  token: {
    createdAt: number;
    creatorAddress: string;
    symbol: string;
    bv;
    name: string;
    decimals: number;
    info: {
      address: string;
      imageSmallUrl: string;
      name: string;
      symbol: string;
      description: string;
      totalSupply: string;
    };
    socialLinks: {
      twitter: string;
      website: string;
      telegram: string;
    };
    exchanges: CodexExchangeItem[];
    creatorAddress: string;
  };
  priceSol: number;
  priceUsd: number;
}

declare interface TokenData {
  address: string;
  cmcId: number | null;
  createBlockNumber: number | null;
  createTransactionHash: string | null;
  createdAt: number;
  creatorAddress: string | null;
  decimals: number;
  exchanges: Exchange[];
  freezable: boolean | null;
  id: string;
  info: TokenInfo;
  isScam: boolean | null;
  launchpad: Launchpad | null;
  mintable: boolean | null;
  name: string;
  networkId: number;
  socialLinks: SocialLinks;
  symbol: string;
  creatorAddress: string;
}

interface GroupTransaction {
  ts: string;
  block_time: number;
  tx_hash: string;
  token_in_addr: string;
  token_out_addr: string;
  amount_in: string;
  amount_out: string;
  tx_type: string;
  block_slot: number;
  tx_index: number;
  user_addr: string;
  tokenInfo: {
    tokenAddress: string;
    symbol: string;
    name: string;
    decimals: number;
    icon: {
      large: string;
      small: string;
      thumb: string;
    };
  };
}
declare interface GroupTransactionList {
  count: number;
  list: GroupTransaction[];
}

declare interface TopToken {
  symbol: string;
  icon: {
    large: string;
    small: string;
    thumb: string;
  };
  token_address: string;
  totalValue: number;
}

declare interface GroupOverview {
  buyAvgPrice: number;
  avgCost: number;
  donePnl: number;
  groupId?: number;
  groupIds?: number[];
  groupName: string;
  pnl: number;
  topTokens: TopToken[];
  totalAmount: number;
  totalCost: number;
  totalValue: number;
  unDonePnl: number;
  sellTotalAmount: number;
  totalSell: number;
}

declare interface KlineData {
  getBars: {
    buyVolume: string[];
    buyers: number[];
    buys: number[];
    c: number[];
    h: number[];
    l: number[];
    o: number[];
    sellVolume: string[];
    sellers: number[];
    sells: number[];
    t: number[];
    v: number[];
    liquidity: string[];
    volume: string[];
    volumeNativeToken: string[];
    traders: number[];
    transactions: number[];
    pair?: {
      address: string;
      createdAt: number | null;
      exchangeHash: string;
      fee: number | null;
      id: string;
      networkId: number;
      pooled: {
        token0: string;
        token1: string;
      };
      tickSpacing: number | null;
      token0: string;
      token0Data: TokenData;
      token1: string;
      token1Data: TokenData;
    };
    s?: string;
  };
}

declare interface WalletMonitorData {
  address: string;
  tokenBalance: string;
  totalSupply: string;
  buyTotalAmount: number;
  sellTotalAmount: number;
  buyTotalCost: number;
  sellTotalRevenue: number;
  decimals: number;
  shiftedBalance: number;
  priceSol: number;
  totalValue: number;
  tokenCount: number;
  pnl: number;
  unDonePnl: number;
  donePnl: number;
  avgCost: number;
}

declare interface MonitorDataItem {
  pnl: number;
  unDonePnl: number;
  donePnl: number;
  totalValue: number;
  totalBuy: number;
  totalSell: number;
  totalAmount: number;
  avgCost: string;
  totalCost: number;
}

declare interface MonitorData {
  list: WalletMonitorData[];
  monitorData: MonitorDataItem;
}

declare interface CreateGroupResponse {
  id: number;
}

declare interface GroupResponse {
  group: {
    createdTime: string;
    updatedTime: string;
    deletedTime: string | null;
    version: number;
    id: number;
    accountId: number;
    name: string;
    groupType: string;
    monitorType: number;
    monitorCA: string;
    filterGroupIds: string[];
    remark: string;
  };
  wallets: string[];
}

declare interface TransactionResponse {
  count: number;
  list: Transaction[];
}

declare interface Transaction {
  ts: number;
  tx_hash: string;
  user_addr: string;
  token_in_addr: string;
  token_out_addr: string;
  amount_in: number;
  amount_out: number;
  tx_type: string;
  block_slot: number;
  instruction_index: number;
  mint_addr: string;
  network: string;
}

declare interface IpfsResponse {
  metadataUri: string;
  metadata: {
    name: string;
    symbol: string;
    description: string;
    image: string;
    showName: boolean;
    createdOn: string;
  };
}

declare interface BsTradeItem {
  ts: string;
  block_time: number;
  tx_hash: string;
  user_addr: string;
  token_in_addr: string;
  token_out_addr: string;
  amount_in: string;
  amount_out: string;
  tx_type: 'SELL' | 'BUY';
  block_slot: number;
  tx_index: number;
  instruction_index: number;
}

declare interface BsTradeItemResponse {
  avgCost: number;
  buyAvgPrice: number;
  buyTotalAmount: number;
  buyTotalCost: number;
  groupId: number;
  sellAvgPrice: number;
  sellTotalAmount: number;
  sellTotalRevenue: number;
  transactions: BsTradeItem[];
}

declare type BsTradeResponse = BsTradeItemResponse[];

declare interface JitoResponse {
  jsonrpc: string;
  result?: string;
  id: number;
  error?: any;
}

declare interface BundleStatusResponse {
  jsonrpc: string;
  result: any;
  context: {
    slot: number;
  };
  id: number;
}

declare interface SendTransactionItem {
  node: string;
  result: JitoResponse;
}

declare type SendTransactionResponse = SendTransactionItem[][];

declare interface BatchImportWalletItem {
  name: string;
  groupType: 'own' | 'monitor';
  wallets: string[];
  monitorType: 1 | 2 | 3;
  remark: string;
  monitorCA: string;
  filterGroupIds: number[];
}

declare interface BatchImportWalletRequest {
  data: BatchImportWalletItem[];
}
