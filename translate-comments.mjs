import fs from 'fs';
import path from 'path';

const translations = [
  // Section headers
  ['// 类型定义', '// Type Definitions'],
  ['// 常量', '// Constants'],
  ['// 工具函数', '// Utility Functions'],
  ['// 辅助方法', '// Helper Methods'],
  ['// 默认配置', '// Default Configuration'],
  ['// 路径常量', '// Path Constants'],
  ['// 默认值', '// Defaults'],
  ['// 单例管理', '// Singleton Management'],
  ['// 公共 API', '// Public API'],
  ['// 缓存管理', '// Cache Management'],
  ['// 重试和错误处理', '// Retry and Error Handling'],
  ['// 重试和容错 (与 RpcAdapter 一致的模式)', '// Retry and Fault Tolerance (same pattern as RpcAdapter)'],

  // rpc-adapter.ts
  ['// 单例管理 (与 RpcAdapter 一致的模式)', '// Singleton Management (same pattern as RpcAdapter)'],
  ['// SPL Token 查询', '// SPL Token Queries'],
  ['// 交易状态查询', '// Transaction Status Queries'],
  ['// 通用 RPC 查询', '// General RPC Queries'],
  ['// 分批查询 (getMultipleAccountsInfo 上限 100 个账户)', '// Batch query (getMultipleAccountsInfo limit 100 accounts)'],
  ['// 先尝试标准 TOKEN_PROGRAM_ID', '// First try standard TOKEN_PROGRAM_ID'],
  ['// 标准 ATA 不存在，继续尝试 Token-2022', '// Standard ATA does not exist, try Token-2022'],
  ['// 再尝试 TOKEN_2022_PROGRAM_ID（Pump.fun 等使用）', '// Try TOKEN_2022_PROGRAM_ID (used by Pump.fun etc.)'],
  ['// ATA 不存在 = 余额为 0', '// ATA does not exist = balance is 0'],
  ['// 并发查询，但做流控 (每批最多 10 个并发)', '// Concurrent queries with rate limiting (max 10 concurrent per batch)'],
  ['// getSignatureStatuses 一次最多 256 个签名', '// getSignatureStatuses supports max 256 signatures per call'],
  ['// 提取 accountKeys', '// Extract accountKeys'],
  ['/**\n   * 批量获取多个钱包的 SOL 余额\n   * 使用 getMultipleAccountsInfo 批量查询，减少 RPC 调用次数\n   * @returns Record<地址, SOL余额>\n   */', '/**\n   * Batch get SOL balances for multiple wallets\n   * Uses getMultipleAccountsInfo for batch queries, reducing RPC call count\n   * @returns Record<address, SOL balance>\n   */'],
  ['/**\n   * 获取单个钱包的单个 Token 余额\n   * @returns Token 余额 (UI 单位)\n   */', '/**\n   * Get single token balance for a wallet\n   * @returns Token balance (UI units)\n   */'],
  ['/**\n   * 获取单个钱包的所有 Token 账户\n   * 直接通过 RPC 查询，替代 forgex.online/api 的 getTokenListFromAddress\n   */', '/**\n   * Get all token accounts for a wallet\n   * Queries directly via RPC, replacing forgex.online/api getTokenListFromAddress\n   */'],
  ['/**\n   * 批量获取多个钱包在指定代币上的余额\n   * @returns Record<钱包地址, Token余额>\n   */', '/**\n   * Batch get token balances for multiple wallets on a specific token\n   * @returns Record<wallet address, Token balance>\n   */'],
  ['/**\n   * 查询单笔交易的确认状态\n   */', '/**\n   * Query confirmation status of a single transaction\n   */'],
  ['/**\n   * 获取交易详情\n   * 返回解析后的交易数据，包含余额变化、Token 变化等\n   */', '/**\n   * Get transaction details\n   * Returns parsed transaction data including balance changes, token changes, etc.\n   */'],
  ['/**\n   * 批量查询交易状态\n   * @returns Record<txHash, TransactionStatus>\n   */', '/**\n   * Batch query transaction statuses\n   * @returns Record<txHash, TransactionStatus>\n   */'],
  ['/**\n   * 获取账户信息 (原始)\n   */', '/**\n   * Get account info (raw)\n   */'],
  ['/**\n   * 获取最新区块哈希\n   */', '/**\n   * Get latest blockhash\n   */'],
  ['/**\n   * 获取当前 slot\n   */', '/**\n   * Get current slot\n   */'],
  ['/**\n   * 健康检查: 验证当前端点是否可用\n   */', '/**\n   * Health check: verify current endpoint availability\n   */'],
  ['/**\n * 获取 RpcAdapter 单例\n * 首次调用时从 config 读取 RPC 配置创建实例\n */', '/**\n * Get RpcAdapter singleton\n * Creates instance from config RPC settings on first call\n */'],
  ['/**\n * 重置单例 (用于配置变更后重新初始化)\n */', '/**\n * Reset singleton (for re-initialization after config changes)\n */'],

  // jito-adapter.ts
  ['// 常量 (复用 sol-sdk/jito 配置)', '// Constants (reuses sol-sdk/jito config)'],
  ['/** Jito Block Engine API 端点列表 (多区域容错) */', '/** Jito Block Engine API endpoint list (multi-region fault tolerance) */'],
  ['/** Jito Tip 账户列表 */', '/** Jito Tip account list */'],
  ['/** JSON-RPC 响应 */', '/** JSON-RPC response */'],
  ['/** Bundle 确认状态枚举 */', '/** Bundle confirmation status enum */'],
  ['/** 已发送，尚未处理 */', '/** Sent, not yet processed */'],
  ['/** 已处理 (包含在区块中) */', '/** Processed (included in block) */'],
  ['/** 已确认 (超级多数验证) */', '/** Confirmed (supermajority validation) */'],
  ['/** 已最终确认 (不可逆) */', '/** Finalized (irreversible) */'],
  ['/** 执行失败 */', '/** Execution failed */'],
  ['/** 查询超时 */', '/** Query timeout */'],
  ['/** 在 landing 中 (inflight) */', '/** In landing (inflight) */'],
  ['/** 未知状态 */', '/** Unknown status */'],
  ['/** Bundle 状态查询结果 (getBundleStatuses API) */', '/** Bundle status query result (getBundleStatuses API) */'],
  ['/** 确认状态 */', '/** Confirmation status */'],
  ['/** Bundle 所在的 Slot */', '/** Slot containing the bundle */'],
  ['/** Bundle 中包含的交易签名列表 */', '/** List of transaction signatures in the bundle */'],
  ['/** 确认时间 (Unix ms) */', '/** Confirmation time (Unix ms) */'],
  ['/** 错误信息 (如果失败) */', '/** Error info (if failed) */'],
  ['/** Inflight Bundle 状态 */', '/** Inflight bundle status */'],
  ['/** Bundle 确认等待结果 */', '/** Bundle confirmation wait result */'],
  ['/** 最终状态 */', '/** Final status */'],
  ['/** 是否成功 (processed/confirmed/finalized) */', '/** Whether successful (processed/confirmed/finalized) */'],
  ['/** Bundle 所在的 Slot */', '/** Slot of the bundle */'],
  ['/** Bundle 中的交易列表 */', '/** Transaction list in the bundle */'],
  ['/** 错误信息 */', '/** Error info */'],
  ['/** 等待确认选项 */', '/** Wait for confirmation options */'],
  ['/** 超时时间 (ms), 默认 60000 */', '/** Timeout (ms), default 60000 */'],
  ['/** 轮询间隔 (ms), 默认 2000 */', '/** Poll interval (ms), default 2000 */'],
  ['// JitoAdapter 实现', '// JitoAdapter Implementation'],
  ['// 端点列表: 用户配置 > 默认 Jito 端点', '// Endpoint list: user config > default Jito endpoints'],
  ['// 尝试从 config 读取自定义 Jito 端点', '// Try reading custom Jito endpoints from config'],
  ['// 底层 JSON-RPC 通信', '// Low-level JSON-RPC Communication'],
  ['// 指数退避等待', '// Exponential backoff wait'],
  ['// 当前端点全部重试失败，尝试切换', '// All retries failed on current endpoint, try switching'],
  [`throw lastError || new Error(\`\${operationName}: 所有 Jito 端点均不可用\`)`, `throw lastError || new Error(\`\${operationName}: All Jito endpoints unavailable\`)`],
  ['/** 判断错误是否可重试 */', '/** Check if error is retryable */'],
  ['// HTTP 状态码判断', '// HTTP status code check'],
  ['// 网络错误', '// Network error'],
  ['// 超时', '// Timeout'],
  ['// 速率限制', '// Rate limit'],
  ['/** 切换到下一个端点 */', '/** Switch to next endpoint */'],
  ['/** 获取当前端点 URL (供调试使用) */', '/** Get current endpoint URL (for debugging) */'],
  ['// Bundle 状态查询', '// Bundle Status Queries'],
  ['// Bundle 确认等待 (轮询)', '// Bundle Confirmation Wait (polling)'],
  ['// Bundle 发送', '// Bundle Sending'],
  ['// 单笔交易发送 (sendTransaction)', '// Single Transaction Sending (sendTransaction)'],
  ['// RPC 交易确认', '// RPC Transaction Confirmation'],
  ['// Tip 相关查询', '// Tip Queries'],
  ['// 如果 inflight 已 landed，但 final 端还没刷新，把它视为成功并继续返回可观测信息', '// If inflight has landed but final status not yet updated, treat as success and return observable info'],
  [`error: success ? undefined : \`Bundle 状态: \${status.status}\``, `error: success ? undefined : \`Bundle status: \${status.status}\``],
  [`error: \`等待 Bundle 确认超时 (\${timeoutMs}ms)\``, `error: \`Bundle confirmation timeout (\${timeoutMs}ms)\``],
  [`throw new Error(\`Jito getBundleStatuses 错误: \${response.error.message}\`)`, `throw new Error(\`Jito getBundleStatuses error: \${response.error.message}\`)`],
  ['// 没有找到任何 bundle 状态', '// No bundle statuses found'],
  [`throw new Error(\`Jito getInflightBundleStatuses 错误: \${response.error.message}\`)`, `throw new Error(\`Jito getInflightBundleStatuses error: \${response.error.message}\`)`],
  [`throw new Error('sendBundle: 交易列表不能为空')`, `throw new Error('sendBundle: transaction list cannot be empty')`],
  [`throw new Error(\`Jito sendBundle 错误: \${response.error.message}\`)`, `throw new Error(\`Jito sendBundle error: \${response.error.message}\`)`],
  [`throw new Error('Jito sendBundle: 未返回有效的 Bundle ID')`, `throw new Error('Jito sendBundle: no valid Bundle ID returned')`],
  [`throw new Error('sendBundleBase58: 交易列表不能为空')`, `throw new Error('sendBundleBase58: transaction list cannot be empty')`],
  [`throw new Error(\`Jito sendBundle(base58) 错误: \${response.error.message}\`)`, `throw new Error(\`Jito sendBundle(base58) error: \${response.error.message}\`)`],
  [`throw new Error('Jito sendBundle(base58): 未返回有效的 Bundle ID')`, `throw new Error('Jito sendBundle(base58): no valid Bundle ID returned')`],
  [`throw new Error(\`Jito sendTransaction 错误: \${response.error.message}\`)`, `throw new Error(\`Jito sendTransaction error: \${response.error.message}\`)`],
  [`return { success: false, error: '交易确认超时' }`, `return { success: false, error: 'Transaction confirmation timeout' }`],
  ['// fallback 到本地硬编码列表', '// Fallback to local hardcoded list'],
  ['// 单例管理 (与 RpcAdapter 一致的模式)', '// Singleton Management (same pattern as RpcAdapter)'],
  ['// getTipAccounts 是最轻量的 Jito API 调用，适合做健康检查', '// getTipAccounts is the lightest Jito API call, suitable for health checks'],

  // Multi-line JSDoc blocks in jito-adapter.ts
  ['/**\n   * 发送 JSON-RPC 请求到 Jito Block Engine\n   * @param path API 路径 (如 /bundles)\n   * @param method JSON-RPC 方法名\n   * @param params JSON-RPC 参数\n   */', '/**\n   * Send JSON-RPC request to Jito Block Engine\n   * @param path API path (e.g. /bundles)\n   * @param method JSON-RPC method name\n   * @param params JSON-RPC params\n   */'],
  ['/**\n   * 带指数退避重试 + 端点轮转的执行器\n   * 1. 在当前端点上重试 maxRetries 次 (指数退避)\n   * 2. 如果当前端点全部失败，切换到下一个端点继续\n   * 3. 所有端点都失败后抛出最后一个错误\n   */', '/**\n   * Executor with exponential backoff retry + endpoint rotation\n   * 1. Retry maxRetries times on current endpoint (exponential backoff)\n   * 2. If current endpoint fails all retries, switch to next endpoint\n   * 3. Throw last error after all endpoints fail\n   */'],
  ['/**\n   * 查询 Bundle 状态\n   * 调用 Jito 的 getBundleStatuses JSON-RPC 方法\n   *\n   * @param bundleIds 要查询的 Bundle ID 列表\n   * @returns 每个 Bundle 的状态\n   */', '/**\n   * Query bundle statuses\n   * Calls Jito getBundleStatuses JSON-RPC method\n   *\n   * @param bundleIds Bundle IDs to query\n   * @returns Status for each bundle\n   */'],
  ['/**\n   * 查询单个 Bundle 的状态 (便捷方法)\n   */', '/**\n   * Query single bundle status (convenience method)\n   */'],
  ['/**\n   * 查询 Inflight Bundle 状态\n   * 用于查询刚发送、尚未落地的 bundle\n   */', '/**\n   * Query inflight bundle statuses\n   * For querying bundles that have been sent but not yet landed\n   */'],
  ['/**\n   * 等待 Bundle 确认\n   * 轮询 getBundleStatuses 直到达到终态或超时\n   *\n   * @param bundleId Bundle ID\n   * @param options 超时和轮询间隔配置\n   * @returns Bundle 确认结果\n   */', '/**\n   * Wait for bundle confirmation\n   * Polls getBundleStatuses until terminal state or timeout\n   *\n   * @param bundleId Bundle ID\n   * @param options Timeout and poll interval config\n   * @returns Bundle confirmation result\n   */'],
  ['/**\n   * 发送 Bundle 到 Jito Block Engine\n   * 直连 Jito，不经过 forgex.online/api 代理\n   *\n   * @param base64Txs Base64 编码的交易列表\n   * @returns Bundle ID\n   */', '/**\n   * Send bundle to Jito Block Engine\n   * Direct connection to Jito, not through forgex.online/api proxy\n   *\n   * @param base64Txs Base64 encoded transaction list\n   * @returns Bundle ID\n   */'],
  ['/**\n   * 通过 Jito 发送单笔交易\n   * 使用 /transactions 端点 + base64 编码\n   *\n   * @param base64Tx Base64 编码的交易\n   * @returns 交易签名 (txHash)\n   */', '/**\n   * Send single transaction via Jito\n   * Uses /transactions endpoint + base64 encoding\n   *\n   * @param base64Tx Base64 encoded transaction\n   * @returns Transaction signature (txHash)\n   */'],
  ['/**\n   * 通过标准 Solana RPC 确认交易状态\n   * 轮询 getSignatureStatuses 直到交易确认或超时\n   *\n   * @param connection Solana Connection\n   * @param signature 交易签名\n   * @param timeoutMs 超时时间 (ms), 默认 30000\n   * @param intervalMs 轮询间隔 (ms), 默认 2000\n   * @returns 确认结果\n   */', '/**\n   * Confirm transaction status via standard Solana RPC\n   * Polls getSignatureStatuses until confirmed or timeout\n   *\n   * @param connection Solana Connection\n   * @param signature Transaction signature\n   * @param timeoutMs Timeout (ms), default 30000\n   * @param intervalMs Poll interval (ms), default 2000\n   * @returns Confirmation result\n   */'],
  ['/**\n   * 从 Jito API 获取最新的 Tip 账户列表\n   * 通常使用本地硬编码的 JITO_TIP_ACCOUNTS 即可，\n   * 此方法用于需要动态获取最新 tip 账户的场景\n   */', '/**\n   * Fetch latest tip account list from Jito API\n   * Normally the local hardcoded JITO_TIP_ACCOUNTS suffice,\n   * this method is for scenarios requiring dynamic tip account retrieval\n   */'],
  ['/**\n   * 随机获取一个 Tip 账户地址\n   * 使用本地硬编码列表，无网络开销\n   */', '/**\n   * Get a random tip account address\n   * Uses local hardcoded list, no network overhead\n   */'],
  ['/**\n   * 构建 Jito Tip 转账指令\n   * 复用 sol-sdk/jito 中的逻辑\n   *\n   * @param payer 付款者的 PublicKey\n   * @param tipAmountSol Tip 金额 (SOL 单位)\n   * @returns SystemProgram.transfer 指令\n   */', '/**\n   * Build Jito tip transfer instruction\n   * Reuses logic from sol-sdk/jito\n   *\n   * @param payer Payer PublicKey\n   * @param tipAmountSol Tip amount (SOL units)\n   * @returns SystemProgram.transfer instruction\n   */'],
  ['/**\n   * 判断 Bundle 状态是否为成功状态\n   * (processed / confirmed / finalized 均视为成功)\n   */', '/**\n   * Check if bundle status is a success state\n   * (processed / confirmed / finalized are all considered successful)\n   */'],
  ['/**\n   * 判断 Bundle 状态是否为终态 (不会再变化)\n   */', '/**\n   * Check if bundle status is a terminal state (will not change)\n   */'],
  ['/**\n   * 将 Jito API 返回的状态字符串映射到 BundleStatusEnum\n   */', '/**\n   * Map Jito API status string to BundleStatusEnum\n   */'],
  ['/**\n   * 健康检查: 验证当前 Jito 端点是否可用\n   */', '/**\n   * Health check: verify current Jito endpoint availability\n   */'],
  ['/**\n * 获取 JitoAdapter 单例\n * 首次调用时创建实例\n */', '/**\n * Get JitoAdapter singleton\n * Creates instance on first call\n */'],
  ['/**\n * 重置单例 (用于配置变更后重新初始化)\n */', '/**\n * Reset singleton (for re-initialization after config changes)\n */'],

  // jito-adapter.ts file header
  ['/**\n * ForgeX CLI Jito Bundle 直连适配器\n *\n * 替代现有通过 forgex.online/api 代理的 bundle 状态查询和发送。\n * 直接调用 Jito Block Engine 的 JSON-RPC API。\n *\n * 设计参考: ARCH-DESIGN-v2.md Section 2.5\n *\n * 复用自 sol-sdk/jito/index.ts 的端点配置和 tip 账户列表。\n */', '/**\n * ForgeX CLI Jito Bundle Direct Adapter\n *\n * Replaces the existing bundle status query and sending via forgex.online/api proxy.\n * Directly calls Jito Block Engine JSON-RPC API.\n *\n * Design reference: ARCH-DESIGN-v2.md Section 2.5\n *\n * Reuses endpoint config and tip account list from sol-sdk/jito/index.ts.\n */'],

  // jito-adapter.ts console.log messages
  [`console.log(\`[Jito] 发送 Bundle: \${base64Txs.length} 笔交易, 端点: \${this.getCurrentEndpoint()}\`)`, `console.log(\`[Jito] Sending bundle: \${base64Txs.length} transactions, endpoint: \${this.getCurrentEndpoint()}\`)`],
  [`console.log(\`[Jito] 发送 Bundle(base58): \${base58Txs.length} 笔交易, 端点: \${this.getCurrentEndpoint()}\`)`, `console.log(\`[Jito] Sending bundle (base58): \${base58Txs.length} transactions, endpoint: \${this.getCurrentEndpoint()}\`)`],

  // codex-adapter.ts file header
  ['/**\n * ForgeX CLI Codex API 数据源适配器\n *\n * 通过 Codex GraphQL API 获取代币信息、价格、K线等市场数据,\n * 替代原有对 forgex.online/api 的依赖。\n *\n * Codex API 文档: https://docs.codex.io\n * GraphQL 端点: https://graph.codex.io/graphql\n *\n * 设计参考: ARCH-DESIGN-v2.md Section 2.3\n */', '/**\n * ForgeX CLI Codex API Data Source Adapter\n *\n * Fetches token info, prices, candlestick and other market data via Codex GraphQL API,\n * replacing the previous dependency on forgex.online/api.\n *\n * Codex API docs: https://docs.codex.io\n * GraphQL endpoint: https://graph.codex.io/graphql\n *\n * Design reference: ARCH-DESIGN-v2.md Section 2.3\n */'],

  // codex-adapter.ts constants
  ['/** Codex GraphQL 端点 */', '/** Codex GraphQL endpoint */'],
  ['/** Solana 在 Codex 中的 networkId */', '/** Solana networkId in Codex */'],
  ["/** SOL 原生代币 Wrapped 地址 (Codex 不支持原生代币直接查询, 需使用 Wrapped SOL) */", "/** Wrapped SOL address (Codex doesn't support native token queries, use Wrapped SOL) */"],
  ['/** 默认重试次数 */', '/** Default retry count */'],
  ['/** 初始重试延迟 (ms) */', '/** Initial retry delay (ms) */'],
  ['/** getTokenPrices 每次最大批量 */', '/** getTokenPrices max batch size */'],
  ['/** 默认缓存 TTL (ms) -- 价格等实时数据 30 秒 */', '/** Default cache TTL (ms) -- 30s for real-time data like prices */'],
  ['/** 代币信息缓存 TTL (ms) -- 10 分钟 */', '/** Token info cache TTL (ms) -- 10 minutes */'],

  // codex-adapter.ts type comments
  ['/** Codex API 配置 */', '/** Codex API configuration */'],
  ['/** GraphQL 端点 (默认 https://graph.codex.io/graphql) */', '/** GraphQL endpoint (default https://graph.codex.io/graphql) */'],
  ['/** 最大重试次数 */', '/** Max retry count */'],
  ['/** 代币信息 (与 ARCH-DESIGN-v2.md 中 TokenInfoFile 对齐) */', '/** Token info (aligned with ARCH-DESIGN-v2.md TokenInfoFile) */'],
  ['/** 合约地址 */', '/** Contract address */'],
  ['/** 代币符号 */', '/** Token symbol */'],
  ['/** 代币名称 */', '/** Token name */'],
  ['/** 小数位数 */', '/** Decimals */'],
  ['/** 总供应量 */', '/** Total supply */'],
  ['/** 图标 URL */', '/** Icon URL */'],
  ['/** 创建时间 (Unix timestamp 秒) */', '/** Creation time (Unix timestamp seconds) */'],
  ['/** 网络 ID */', '/** Network ID */'],
  ['/** 代币价格 */', '/** Token price */'],
  ['/** USD 价格 */', '/** USD price */'],
  ['/** 时间戳 */', '/** Timestamp */'],
  ['/** 代币详细市场数据 (来自 filterTokens) */', '/** Token detailed market data (from filterTokens) */'],
  ['/** 24h 交易量 (USD) */', '/** 24h volume (USD) */'],
  ['/** 24h 价格变化百分比 */', '/** 24h price change percentage */'],
  ['/** 流动性 (USD) */', '/** Liquidity (USD) */'],
  ['/** 完全稀释市值 */', '/** Fully diluted market cap */'],
  ['/** 持有者数量 */', '/** Holder count */'],
  ['/** 24h 买入次数 */', '/** 24h buy count */'],
  ['/** 24h 卖出次数 */', '/** 24h sell count */'],
  ['/** 24h 总交易笔数 */', '/** 24h total transaction count */'],
  ['/** 顶部交易对地址 */', '/** Top pair address */'],
  ['/** K线柱 (OHLCV) */', '/** Candlestick bar (OHLCV) */'],
  ['/** 时间戳 (Unix 秒) */', '/** Timestamp (Unix seconds) */'],
  ['/** 开盘价 (USD) */', '/** Open price (USD) */'],
  ['/** 最高价 (USD) */', '/** High price (USD) */'],
  ['/** 最低价 (USD) */', '/** Low price (USD) */'],
  ['/** 收盘价 (USD) */', '/** Close price (USD) */'],
  ['/** 成交量 */', '/** Volume */'],
  ['/** 交易对/池信息 */', '/** Pair/pool info */'],
  ['/** 交易对地址 */', '/** Pair address */'],
  ['/** 交易所/DEX 名称 */', '/** Exchange/DEX name */'],
  ['/** token0 地址 */', '/** token0 address */'],
  ['/** token1 地址 */', '/** token1 address */'],
  ['/** 价格 (USD) */', '/** Price (USD) */'],
  ['/** 24h 交易量 */', '/** 24h volume */'],
  ['/** 24h 交易笔数 */', '/** 24h transaction count */'],
  ['/** 创建时间 */', '/** Creation time */'],
  ['/** K线查询参数 */', '/** Candlestick query params */'],
  ['/** 代币合约地址 */', '/** Token contract address */'],
  ['/** 交易对地址 (可选, 不传则使用顶部交易对) */', '/** Pair address (optional, uses top pair if not provided) */'],
  ['/** 时间粒度 */', '/** Time resolution */'],
  ['/** 开始时间 (Unix 秒) */', '/** Start time (Unix seconds) */'],
  ['/** 结束时间 (Unix 秒) */', '/** End time (Unix seconds) */'],
  ['/** 向前回溯柱数 */', '/** Number of bars to look back */'],
  ['/** 内部缓存条目 */', '/** Internal cache entry */'],

  // codex-adapter.ts section headers
  ['// GraphQL 查询', '// GraphQL Queries'],
  ['// CodexAdapter 实现', '// CodexAdapter Implementation'],
  ['// 代币信息查询', '// Token Info Queries'],
  ['// 价格查询', '// Price Queries'],
  ['// K线数据', '// Candlestick Data'],
  ['// 交易对/流动性池查询', '// Pair/Liquidity Pool Queries'],
  ['// 便捷组合方法 -- 与 ARCH-DESIGN-v2.md 中接口对齐', '// Convenience combo methods -- aligned with ARCH-DESIGN-v2.md interfaces'],
  ['// 健康检查', '// Health Check'],
  ['// 导出常量 (供其他模块使用)', '// Export constants (for use by other modules)'],

  // codex-adapter.ts function JSDoc
  ['/**\n   * 带指数退避重试的 GraphQL 请求执行器\n   */', '/**\n   * GraphQL request executor with exponential backoff retry\n   */'],
  ['// GraphQL 层面的错误', '// GraphQL-level errors'],
  ['// 指数退避等待', '// Exponential backoff wait'],
  [`throw lastError || new Error(\`\${operationName}: 所有重试均失败\`)`, `throw lastError || new Error(\`\${operationName}: All retries failed\`)`],
  ['/** 判断错误是否可重试 */', '/** Check if error is retryable */'],
  ['// GraphQL 业务错误不重试', '// Do not retry GraphQL business errors'],
  ['// axios 错误', '// Axios errors'],
  ['// 429 (rate limit), 502, 503, 504 可重试', '// 429 (rate limit), 502, 503, 504 are retryable'],
  ['// 网络错误', '// Network errors'],
  ['/** 获取缓存值 (未过期则返回数据, 否则返回 null) */', '/** Get cached value (returns data if not expired, null otherwise) */'],
  ['/** 设置缓存 */', '/** Set cache */'],
  ['/** 清除所有缓存 */', '/** Clear all caches */'],
  ['// 检查缓存', '// Check cache'],
  ['// 缓存', '// Cache'],
  ['// 缓存每个价格', '// Cache each price'],
  ['// 分批查询', '// Batch query'],

  // codex-adapter.ts multi-line JSDoc
  ['/**\n   * 获取代币详细市场数据 (使用 filterTokens)\n   * 包含价格、流动性、市值、持有者、交易量等\n   */', '/**\n   * Get detailed token market data (using filterTokens)\n   * Includes price, liquidity, market cap, holders, volume, etc.\n   */'],
  [`throw new Error(\`代币 \${ca} 未找到 (Codex 上无数据)\`)`, `throw new Error(\`Token \${ca} not found (no data on Codex)\`)`],
  ['/**\n   * 获取代币基本信息 (精简版, 从 filterTokens 提取)\n   */', '/**\n   * Get basic token info (compact version, extracted from filterTokens)\n   */'],
  ["// filterTokens 返回的 totalSupply 可能不准, 链上查询更可靠", "// totalSupply from filterTokens may be inaccurate, on-chain query is more reliable"],
  ['/**\n   * 获取单个代币的实时价格 (USD)\n   */', '/**\n   * Get real-time price (USD) for a single token\n   */'],
  [`throw new Error(\`代币 \${ca} 价格未找到\`)`, `throw new Error(\`Token \${ca} price not found\`)`],
  ['/**\n   * 批量获取代币价格\n   * Codex 限制每次最多 25 个输入\n   */', '/**\n   * Batch get token prices\n   * Codex limits max 25 inputs per request\n   */'],
  ['/**\n   * 获取 SOL 价格 (USD)\n   * 使用 Wrapped SOL 地址查询\n   */', '/**\n   * Get SOL price (USD)\n   * Uses Wrapped SOL address for query\n   */'],
  ['/**\n   * 获取 K线 (OHLCV) 数据\n   *\n   * getBars 的 symbol 格式: tokenAddress:pairAddress (如无 pairAddress 则用默认交易对)\n   */', '/**\n   * Get candlestick (OHLCV) data\n   *\n   * getBars symbol format: tokenAddress:pairAddress (uses default pair if no pairAddress)\n   */'],
  ['// 构建 symbol: Codex getBars 需要 "tokenAddress:networkId" 或 "pairAddress:networkId" 格式', '// Build symbol: Codex getBars requires "tokenAddress:networkId" or "pairAddress:networkId" format'],
  ['/**\n   * 查找代币的交易对列表 (按流动性降序排列)\n   */', '/**\n   * Find trading pairs for a token (sorted by liquidity descending)\n   */'],
  ['// filterPairs 的 phrase 支持代币地址搜索', '// filterPairs phrase supports token address search'],
  ['/**\n   * 获取代币的顶部 (最高流动性) 交易对\n   */', '/**\n   * Get top (highest liquidity) trading pair for a token\n   */'],
  ['/**\n   * 获取代币价格 (SOL 和 USD)\n   * 同时获取代币的 USD 价格和 SOL 价格\n   */', '/**\n   * Get token price (SOL and USD)\n   * Fetches both USD and SOL prices simultaneously\n   */'],
  ['/**\n   * 获取池信息 (与 ARCH-DESIGN-v2.md PoolInfoFile 格式对齐)\n   * 综合 Codex 价格和交易对数据\n   */', '/**\n   * Get pool info (aligned with ARCH-DESIGN-v2.md PoolInfoFile format)\n   * Combines Codex price and pair data\n   */'],
  ['// 流动性近似拆分: Codex 返回 USD 总流动性, 粗略按 50/50 估算 SOL 一侧', '// Approximate liquidity split: Codex returns total USD liquidity, roughly estimate 50/50 SOL side'],
  ["// Codex filterTokens 不直接返回 DEX 名, 可通过 getPairsForToken 查", "// Codex filterTokens doesn't return DEX name directly, use getPairsForToken to query"],
  ['/**\n   * 验证 Codex API Key 和连接是否可用\n   */', '/**\n   * Verify Codex API Key and connection availability\n   */'],
  ['/**\n * 获取 CodexAdapter 单例\n * 首次调用时从 config 读取 Codex API Key 创建实例\n */', '/**\n * Get CodexAdapter singleton\n * Creates instance from config Codex API Key on first call\n */'],
  ['/**\n * 重置单例 (配置变更后重新初始化)\n */', '/**\n * Reset singleton (re-initialize after config changes)\n */'],

  // codex-adapter.ts error message
  ["'缺少 Codex API Key，请运行: forgex config set codexApiKey <your-key>\\n' +\n        '或设置环境变量: export FORGEX_CODEX_API_KEY=<your-key>\\n' +\n        '获取 API Key: https://www.codex.io'", "'Missing Codex API Key. Run: forgex config set codexApiKey <your-key>\\n' +\n        'Or set env var: export FORGEX_CODEX_API_KEY=<your-key>\\n' +\n        'Get API Key: https://www.codex.io'"],
];

function processFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf-8');
  let changed = false;

  for (const [from, to] of translations) {
    if (content.includes(from)) {
      content = content.replaceAll(from, to);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✓ ${filePath}`);
  } else {
    // Check if there's still Chinese
    const chinesePattern = /[\u4e00-\u9fff\u3400-\u4dbf]+/;
    if (chinesePattern.test(content)) {
      console.log(`⚠ ${filePath} - still has Chinese`);
    } else {
      console.log(`  ${filePath} - already English`);
    }
  }
}

// Process all files
const srcDir = '/Users/liu/sonic/forgex-cli/src';

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith('.ts')) {
      processFile(fullPath);
    }
  }
}

walkDir(srcDir);
