/**
 * ForgeX CLI Codex API Data Source Adapter
 *
 * Fetches token info, prices, candlestick and other market data via Codex GraphQL API,
 * replacing the previous dependency on forgex.online/api.
 *
 * Codex API docs: https://docs.codex.io
 * GraphQL endpoint: https://graph.codex.io/graphql
 *
 * Design reference: ARCH-DESIGN-v2.md Section 2.3
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { loadConfig } from '../config.js';

// ============================================================
// Constants
// ============================================================

/** Codex GraphQL endpoint */
const CODEX_GRAPHQL_URL = 'https://graph.codex.io/graphql';

/** Solana networkId in Codex */
const SOLANA_NETWORK_ID = 1399811149;

/** Wrapped SOL address (Codex doesn't support native token queries, use Wrapped SOL) */
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Default retry count */
const DEFAULT_MAX_RETRIES = 3;

/** Initial retry delay (ms) */
const INITIAL_RETRY_DELAY_MS = 500;

/** getTokenPrices max batch size */
const TOKEN_PRICES_BATCH_SIZE = 25;

/** Default cache TTL (ms) -- 30s for real-time data like prices */
const PRICE_CACHE_TTL_MS = 30_000;

/** Token info cache TTL (ms) -- 10 minutes */
const TOKEN_INFO_CACHE_TTL_MS = 600_000;

// ============================================================
// Type Definitions
// ============================================================

/** Codex API configuration */
export interface CodexConfig {
  /** Codex API Key */
  apiKey: string;
  /** GraphQL endpoint (default https://graph.codex.io/graphql) */
  baseUrl?: string;
  /** Max retry count */
  maxRetries?: number;
}

/** Token info (aligned with ARCH-DESIGN-v2.md TokenInfoFile) */
export interface CodexTokenInfo {
  /** Contract address */
  address: string;
  /** Token symbol */
  symbol: string;
  /** Token name */
  name: string;
  /** Decimals */
  decimals: number;
  /** Total supply */
  totalSupply: string;
  /** Icon URL */
  imageUrl: string | null;
  /** Creation time (Unix timestamp seconds) */
  createdAt: number | null;
  /** Network ID */
  networkId: number;
}

/** Token price */
export interface CodexTokenPrice {
  /** Contract address */
  address: string;
  /** Network ID */
  networkId: number;
  /** USD price */
  priceUsd: number;
  /** Timestamp */
  timestamp: number | null;
}

/** Token detailed market data (from filterTokens) */
export interface CodexTokenMarketData {
  /** Contract address */
  address: string;
  /** Token symbol */
  symbol: string;
  /** Token name */
  name: string;
  /** Decimals */
  decimals: number;
  /** USD price */
  priceUsd: number;
  /** 24h volume (USD) */
  volume24h: number;
  /** 24h price change percentage */
  priceChange24h: number;
  /** Liquidity (USD) */
  liquidity: number;
  /** Fully diluted market cap */
  marketCap: number;
  /** Holder count */
  holders: number;
  /** 24h buy count */
  buyCount24h: number;
  /** 24h sell count */
  sellCount24h: number;
  /** 24h total transaction count */
  txnCount24h: number;
  /** Top pair address */
  topPairAddress: string | null;
  /** Creation time (Unix timestamp seconds) */
  createdAt: number | null;
}

/** Candlestick bar (OHLCV) */
export interface CodexBar {
  /** Timestamp (Unix seconds) */
  t: number;
  /** Open price (USD) */
  o: number;
  /** High price (USD) */
  h: number;
  /** Low price (USD) */
  l: number;
  /** Close price (USD) */
  c: number;
  /** Volume */
  v: number;
}

/** Pair/pool info */
export interface CodexPairInfo {
  /** Pair address */
  pairAddress: string;
  /** Exchange/DEX name */
  exchangeName: string;
  /** Liquidity (USD) */
  liquidity: number;
  /** token0 address */
  token0Address: string;
  /** token1 address */
  token1Address: string;
  /** Price (USD) */
  priceUsd: number;
  /** 24h volume */
  volume24h: number;
  /** 24h transaction count */
  txnCount24h: number;
  /** Creation time */
  createdAt: number | null;
}

/** Candlestick query params */
export interface GetBarsParams {
  /** Token contract address */
  tokenAddress: string;
  /** Pair address (optional, uses top pair if not provided) */
  pairAddress?: string;
  /** Time resolution */
  resolution: '1' | '5' | '15' | '30' | '60' | '240' | '720' | '1D';
  /** Start time (Unix seconds) */
  from: number;
  /** End time (Unix seconds) */
  to: number;
  /** Number of bars to look back */
  countback?: number;
}

/** Internal cache entry */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// ============================================================
// GraphQL Queries
// ============================================================

const GQL_GET_TOKEN_PRICES = `
  query GetTokenPrices($inputs: [GetPriceInput!]!) {
    getTokenPrices(inputs: $inputs) {
      address
      networkId
      priceUsd
      timestamp
    }
  }
`;

const GQL_FILTER_TOKENS = `
  query FilterTokens($tokens: [String!], $networkFilter: [Int!], $limit: Int) {
    filterTokens(
      tokens: $tokens
      filters: { network: $networkFilter }
      limit: $limit
    ) {
      results {
        token {
          address
          symbol
          name
          decimals
          totalSupply
          info {
            imageThumbUrl
          }
        }
        priceUSD
        liquidity
        marketCap
        holders
        buyCount24
        sellCount24
        txnCount24
        volume24
        change24
        createdAt
        pair {
          address
        }
      }
    }
  }
`;

const GQL_GET_BARS = `
  query GetBars($symbol: String!, $from: Int!, $to: Int!, $resolution: String!, $countback: Int) {
    getBars(
      symbol: $symbol
      from: $from
      to: $to
      resolution: $resolution
      countback: $countback
    ) {
      t
      o
      h
      l
      c
      v
    }
  }
`;

const GQL_FILTER_PAIRS = `
  query FilterPairs($phrase: String, $networkFilter: [Int!], $limit: Int) {
    filterPairs(
      phrase: $phrase
      filters: { network: $networkFilter }
      limit: $limit
      rankings: { attribute: liquidity, direction: DESC }
    ) {
      results {
        pair {
          address
          token0
          token1
          createdAt
        }
        exchange {
          name
        }
        liquidity
        price
        volume24
        txnCount24
      }
    }
  }
`;

// ============================================================
// CodexAdapter Implementation
// ============================================================

export class CodexAdapter {
  private client: AxiosInstance;
  private maxRetries: number;
  private priceCache: Map<string, CacheEntry<CodexTokenPrice>>;
  private tokenInfoCache: Map<string, CacheEntry<CodexTokenMarketData>>;

  constructor(config?: Partial<CodexConfig>) {
    const cliConfig = loadConfig();
    const apiKey = config?.apiKey || cliConfig.codexApiKey;
    const baseUrl = config?.baseUrl || CODEX_GRAPHQL_URL;
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;

    if (!apiKey) {
      throw new Error(
        'Missing Codex API Key. Run: forgex config set codexApiKey <your-key>\n' +
        'Or set env var: export FORGEX_CODEX_API_KEY=<your-key>\n' +
        'Get API Key: https://www.codex.io'
      );
    }

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
    });

    this.priceCache = new Map();
    this.tokenInfoCache = new Map();
  }

  // ============================================================
  // Retry and Error Handling
  // ============================================================

  /**
   * GraphQL request executor with exponential backoff retry
   */
  private async executeQuery<T>(
    query: string,
    variables: Record<string, unknown>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.post('', { query, variables });

        // GraphQL-level errors
        if (response.data?.errors && response.data.errors.length > 0) {
          const gqlErrors = response.data.errors;
          const messages = gqlErrors.map((e: any) => e.message).join('; ');
          throw new Error(`Codex GraphQL error [${operationName}]: ${messages}`);
        }

        return response.data?.data as T;
      } catch (err: any) {
        lastError = err;

        if (!this.isRetryableError(err)) {
          throw err;
        }

        // Exponential backoff wait
        if (attempt < this.maxRetries - 1) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
        }
      }
    }

    throw lastError || new Error(`${operationName}: All retries failed`);
  }

  /** Check if error is retryable */
  private isRetryableError(err: any): boolean {
    // Do not retry GraphQL business errors
    if (err.message?.includes('Codex GraphQL error')) {
      return false;
    }

    // Axios errors
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      // 429 (rate limit), 502, 503, 504 are retryable
      if (status && [429, 502, 503, 504].includes(status)) {
        return true;
      }
      // Network error
      if (!err.response && err.code) {
        return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code);
      }
    }

    const message = (err?.message || '').toLowerCase();
    if (message.includes('timeout') || message.includes('rate limit') || message.includes('too many requests')) {
      return true;
    }

    return false;
  }

  // ============================================================
  // Cache Management
  // ============================================================

  /** Get cached value (returns data if not expired, null otherwise) */
  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /** Set cache */
  private setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, ttlMs: number): void {
    cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  /** Clear all caches */
  clearCache(): void {
    this.priceCache.clear();
    this.tokenInfoCache.clear();
  }

  // ============================================================
  // Token Info Queries
  // ============================================================

  /**
   * Get detailed token market data (using filterTokens)
   * Includes price, liquidity, market cap, holders, volume, etc.
   */
  async getTokenMarketData(ca: string): Promise<CodexTokenMarketData> {
    // Check cache
    const cached = this.getCached(this.tokenInfoCache, ca);
    if (cached) return cached;

    const data = await this.executeQuery<{
      filterTokens: {
        results: Array<{
          token: {
            address: string;
            symbol: string;
            name: string;
            decimals: number;
            totalSupply: string;
            info: { imageThumbUrl: string | null } | null;
          };
          priceUSD: string | null;
          liquidity: string | null;
          marketCap: string | null;
          holders: number | null;
          buyCount24: number | null;
          sellCount24: number | null;
          txnCount24: number | null;
          volume24: string | null;
          change24: string | null;
          createdAt: number | null;
          pair: { address: string } | null;
        }>;
      };
    }>(
      GQL_FILTER_TOKENS,
      {
        tokens: [ca],
        networkFilter: [SOLANA_NETWORK_ID],
        limit: 1,
      },
      'getTokenMarketData'
    );

    const results = data.filterTokens?.results;
    if (!results || results.length === 0) {
      throw new Error(`Token ${ca} not found (no data on Codex)`);
    }

    const r = results[0];
    const tokenData: CodexTokenMarketData = {
      address: r.token.address,
      symbol: r.token.symbol || 'UNKNOWN',
      name: r.token.name || 'Unknown Token',
      decimals: r.token.decimals ?? 9,
      priceUsd: parseFloat(r.priceUSD || '0'),
      volume24h: parseFloat(r.volume24 || '0'),
      priceChange24h: parseFloat(r.change24 || '0'),
      liquidity: parseFloat(r.liquidity || '0'),
      marketCap: parseFloat(r.marketCap || '0'),
      holders: r.holders ?? 0,
      buyCount24h: r.buyCount24 ?? 0,
      sellCount24h: r.sellCount24 ?? 0,
      txnCount24h: r.txnCount24 ?? 0,
      topPairAddress: r.pair?.address || null,
      createdAt: r.createdAt ?? null,
    };

    // Cache
    this.setCache(this.tokenInfoCache, ca, tokenData, TOKEN_INFO_CACHE_TTL_MS);

    return tokenData;
  }

  /**
   * Get basic token info (compact version, extracted from filterTokens)
   */
  async getTokenInfo(ca: string): Promise<CodexTokenInfo> {
    const marketData = await this.getTokenMarketData(ca);
    return {
      address: marketData.address,
      symbol: marketData.symbol,
      name: marketData.name,
      decimals: marketData.decimals,
      totalSupply: '0', // totalSupply from filterTokens may be inaccurate, on-chain query is more reliable
      imageUrl: null,
      createdAt: marketData.createdAt,
      networkId: SOLANA_NETWORK_ID,
    };
  }

  // ============================================================
  // Price Queries
  // ============================================================

  /**
   * Get real-time price (USD) for a single token
   */
  async getTokenPrice(ca: string): Promise<CodexTokenPrice> {
    // Check cache
    const cached = this.getCached(this.priceCache, ca);
    if (cached) return cached;

    const data = await this.executeQuery<{
      getTokenPrices: Array<{
        address: string;
        networkId: number;
        priceUsd: number;
        timestamp: number | null;
      }>;
    }>(
      GQL_GET_TOKEN_PRICES,
      {
        inputs: [{ address: ca, networkId: SOLANA_NETWORK_ID }],
      },
      'getTokenPrice'
    );

    const prices = data.getTokenPrices;
    if (!prices || prices.length === 0) {
      throw new Error(`Token ${ca} price not found`);
    }

    const price: CodexTokenPrice = {
      address: prices[0].address,
      networkId: prices[0].networkId,
      priceUsd: prices[0].priceUsd ?? 0,
      timestamp: prices[0].timestamp ?? null,
    };

    // Cache
    this.setCache(this.priceCache, ca, price, PRICE_CACHE_TTL_MS);

    return price;
  }

  /**
   * Batch get token prices
   * Codex limits max 25 inputs per request
   */
  async getTokenPrices(addresses: string[]): Promise<CodexTokenPrice[]> {
    if (addresses.length === 0) return [];

    const allPrices: CodexTokenPrice[] = [];

    // Batch query
    for (let i = 0; i < addresses.length; i += TOKEN_PRICES_BATCH_SIZE) {
      const batch = addresses.slice(i, i + TOKEN_PRICES_BATCH_SIZE);
      const inputs = batch.map(address => ({
        address,
        networkId: SOLANA_NETWORK_ID,
      }));

      const data = await this.executeQuery<{
        getTokenPrices: Array<{
          address: string;
          networkId: number;
          priceUsd: number;
          timestamp: number | null;
        }>;
      }>(
        GQL_GET_TOKEN_PRICES,
        { inputs },
        'getTokenPrices'
      );

      if (data.getTokenPrices) {
        for (const p of data.getTokenPrices) {
          const price: CodexTokenPrice = {
            address: p.address,
            networkId: p.networkId,
            priceUsd: p.priceUsd ?? 0,
            timestamp: p.timestamp ?? null,
          };
          allPrices.push(price);
          // Cache each price
          this.setCache(this.priceCache, p.address, price, PRICE_CACHE_TTL_MS);
        }
      }
    }

    return allPrices;
  }

  /**
   * Get SOL price (USD)
   * Uses Wrapped SOL address for query
   */
  async getSolPrice(): Promise<number> {
    const price = await this.getTokenPrice(WRAPPED_SOL_MINT);
    return price.priceUsd;
  }

  // ============================================================
  // Candlestick Data
  // ============================================================

  /**
   * Get candlestick (OHLCV) data
   *
   * getBars symbol format: tokenAddress:pairAddress (uses default pair if no pairAddress)
   */
  async getBars(params: GetBarsParams): Promise<CodexBar[]> {
    // Build symbol: Codex getBars requires "tokenAddress:networkId" or "pairAddress:networkId" format
    const symbolBase = params.pairAddress || params.tokenAddress;
    const symbol = `${symbolBase}:${SOLANA_NETWORK_ID}`;

    const data = await this.executeQuery<{
      getBars: Array<{
        t: number;
        o: number;
        h: number;
        l: number;
        c: number;
        v: number;
      }>;
    }>(
      GQL_GET_BARS,
      {
        symbol,
        from: params.from,
        to: params.to,
        resolution: params.resolution,
        countback: params.countback,
      },
      'getBars'
    );

    if (!data.getBars) return [];

    return data.getBars.map(bar => ({
      t: bar.t,
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
      v: bar.v,
    }));
  }

  // ============================================================
  // Pair/Liquidity Pool Queries
  // ============================================================

  /**
   * Find trading pairs for a token (sorted by liquidity descending)
   */
  async getPairsForToken(ca: string, limit: number = 10): Promise<CodexPairInfo[]> {
    // filterPairs phrase supports token address search
    const data = await this.executeQuery<{
      filterPairs: {
        results: Array<{
          pair: {
            address: string;
            token0: string;
            token1: string;
            createdAt: number | null;
          };
          exchange: { name: string } | null;
          liquidity: string | null;
          price: string | null;
          volume24: string | null;
          txnCount24: number | null;
        }>;
      };
    }>(
      GQL_FILTER_PAIRS,
      {
        phrase: `${ca}:${SOLANA_NETWORK_ID}`,
        networkFilter: [SOLANA_NETWORK_ID],
        limit,
      },
      'getPairsForToken'
    );

    const results = data.filterPairs?.results;
    if (!results) return [];

    return results.map(r => ({
      pairAddress: r.pair.address,
      exchangeName: r.exchange?.name || 'Unknown',
      liquidity: parseFloat(r.liquidity || '0'),
      token0Address: r.pair.token0,
      token1Address: r.pair.token1,
      priceUsd: parseFloat(r.price || '0'),
      volume24h: parseFloat(r.volume24 || '0'),
      txnCount24h: r.txnCount24 ?? 0,
      createdAt: r.pair.createdAt ?? null,
    }));
  }

  /**
   * Get top (highest liquidity) trading pair for a token
   */
  async getTopPair(ca: string): Promise<CodexPairInfo | null> {
    const pairs = await this.getPairsForToken(ca, 1);
    return pairs.length > 0 ? pairs[0] : null;
  }

  // ============================================================
  // Convenience combo methods -- aligned with ARCH-DESIGN-v2.md interfaces
  // ============================================================

  /**
   * Get token price (SOL and USD)
   * Fetches both USD and SOL prices simultaneously
   */
  async getTokenPriceInSolAndUsd(ca: string): Promise<{
    priceSol: number;
    priceUsd: number;
  }> {
    const [tokenPrice, solPrice] = await Promise.all([
      this.getTokenPrice(ca),
      this.getSolPrice(),
    ]);

    const priceUsd = tokenPrice.priceUsd;
    const priceSol = solPrice > 0 ? priceUsd / solPrice : 0;

    return { priceSol, priceUsd };
  }

  /**
   * Get pool info (aligned with ARCH-DESIGN-v2.md PoolInfoFile format)
   * Combines Codex price and pair data
   */
  async getPoolInfo(ca: string): Promise<{
    ca: string;
    pairAddress: string;
    dex: string;
    liquidity: { sol: number; token: number };
    priceSol: number;
    priceUsd: number;
    updatedAt: number;
  }> {
    const [marketData, solPrice] = await Promise.all([
      this.getTokenMarketData(ca),
      this.getSolPrice(),
    ]);

    const priceUsd = marketData.priceUsd;
    const priceSol = solPrice > 0 ? priceUsd / solPrice : 0;

    // Approximate liquidity split: Codex returns total USD liquidity, roughly estimate 50/50 SOL side
    const liquidityUsd = marketData.liquidity;
    const liquiditySolSide = solPrice > 0 ? (liquidityUsd / 2) / solPrice : 0;
    const liquidityTokenSide = priceSol > 0 ? (liquidityUsd / 2) / priceUsd : 0;

    return {
      ca,
      pairAddress: marketData.topPairAddress || '',
      dex: 'unknown', // Codex filterTokens doesn't return DEX name directly, use getPairsForToken to query
      liquidity: {
        sol: liquiditySolSide,
        token: liquidityTokenSide,
      },
      priceSol,
      priceUsd,
      updatedAt: Date.now(),
    };
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Verify Codex API Key and connection availability
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    endpoint: string;
    solPriceUsd?: number;
    error?: string;
  }> {
    try {
      const solPrice = await this.getSolPrice();
      return {
        healthy: true,
        endpoint: CODEX_GRAPHQL_URL,
        solPriceUsd: solPrice,
      };
    } catch (err: any) {
      return {
        healthy: false,
        endpoint: CODEX_GRAPHQL_URL,
        error: err.message,
      };
    }
  }
}

// ============================================================
// Singleton Management
// ============================================================

let _instance: CodexAdapter | null = null;

/**
 * Get CodexAdapter singleton
 * Creates instance from config Codex API Key on first call
 */
export function getCodexAdapter(): CodexAdapter {
  if (!_instance) {
    _instance = new CodexAdapter();
  }
  return _instance;
}

/**
 * Reset singleton (re-initialize after config changes)
 */
export function resetCodexAdapter(): void {
  _instance = null;
}

// ============================================================
// Export constants (for use by other modules)
// ============================================================

export { SOLANA_NETWORK_ID, WRAPPED_SOL_MINT };

// ============================================================
// Utility Functions
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
