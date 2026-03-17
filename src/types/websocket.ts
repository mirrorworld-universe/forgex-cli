// Subscribable data types
export enum WSTopicType {
  TRANSACTION_FEED = 'subscribeTokenTrades',
  NEW_POOL_CREATED = 'subscribeNewPoolCreated',
  POOL_REVERSE = 'subscribePoolReverse',
  KLINE = 'subscribeKline',
  GROUP_BS_TRADE = 'subscribeGroupBsTrades',
}

export enum WSUnsubscribeType {
  subscribeTokenTrades = 'unsubscribeTokenTrades',
  subscribeNewPoolCreated = 'unsubscribeNewPoolCreated',
  subscribePoolReverse = 'unsubscribePoolReverse',
  subscribeKline = 'unsubscribeKline',
  subscribeGroupBsTrades = 'unsubscribeGroupBsTrades',
}
