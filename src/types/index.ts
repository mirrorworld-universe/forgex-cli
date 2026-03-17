export enum ExternalOrderStatus {
  NONE = 'none', // not opened
  WAITING = 'waiting', // waiting for sniper
  SUCCESS = 'success', // sniper success
  FAILED = 'failed', // sniper failed
}

export enum UserWalletType {
  LOGIN = 'login',
  GROUP = 'group',
}

export enum TransactionStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
}

export enum GroupType {
  LOCAL = 'local',
  MONITOR = 'monitor',
}

export enum ClientMonitorType {
  NORMAL = 'normal',
  TOP100 = 'top100',
  RETAIL = 'retail',
}

export enum ServerMonitorType {
  normal = 1,
  top100 = 2,
  retail = 3,
}

export enum ServerGroupType {
  own = 'own',
  monitor = 'monitor',
}

export enum BundleBuyTime {
  T0 = 'T0',
  T1_T5 = 'T1-T5',
}

export enum VolumeType {
  ONE_BUY_ONE_SELL = 'one_buy_one_sell',
  ONE_BUY_TWO_SELL = 'one_buy_two_sell',
  ONE_BUY_THREE_SELL = 'one_buy_three_sell',
  TWO_BUY_ONE_SELL = 'two_buy_one_sell',
  THREE_BUY_ONE_SELL = 'three_buy_one_sell',
}

export enum StepStatus {
  WAITING = 'waiting', // waiting (gray loading)
  PROCESSING = 'processing', // processing (blue loading)
  COMPLETED = 'completed', // completed (green check)
  FAILED = 'failed', // failed (red error icon)
}

export enum AccountLevel {
  NORMAL = 0, // normal user
  SILVER = 1, // silver member
  GOLD = 2, // gold member
  PLATINUM = 3, // platinum member
  DIAMOND = 4, // diamond member
}

export interface CreateStep {
  id: string;
  name: string;
  status: StepStatus;
  walletAddress?: string; // for sniper wallet step
  error?: string; // error message
}

export interface CreateCoinResult {
  success: boolean;
  steps: CreateStep[];
  bundleIds: {
    devBundle?: string;
    buyBundle?: string;
    sniperBundle?: string;
  };
  mintAddress?: string;
  error?: string;
}

export type CreateStatusCallback = (stepId: string, status: StepStatus, error?: string) => void;
