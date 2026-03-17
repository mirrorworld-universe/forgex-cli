# ForgeX CLI -- Phase Execution Plan

> 本文件定义了 ForgeX CLI 项目的四阶段执行计划。
> 严格按 Phase 1 -> 2 -> 3 -> 4 顺序推进，每个 Phase 完成后需馆馆审核通过方可进入下一阶段。
> 由天天（项目编排者）创建于 2026-02-11。

---

## Phase 总览

| Phase | 名称 | 核心目标 | 状态 |
|-------|------|----------|------|
| Phase 1 | 基础设施验证 | 确保骨架、配置、钱包存储、SDK适配、输出系统全部跑通 | DONE |
| Phase 2 | 核心命令实现 | 钱包管理 + 基础交易 + 查询命令完整可用 | DONE |
| Phase 3 | 高级工具实现 | 做市工具 + 代币操作完整可用 | DONE |
| Phase 4 | Skill + 文档 + 打磨 | Agent Skill 编写 + 文档完善 + 端到端流程验证 | IN PROGRESS |

---

## Phase 1: 基础设施验证

**目标**: 验证并修复 CLI 基础设施层，确保所有后续命令实现有可靠的底层支撑。

### 任务清单

| # | 任务 | 负责人 | 依赖 | 状态 |
|---|------|--------|------|------|
| 1.1 | 验证 CLI 入口和命令注册机制 | Tester | - | DONE |
| 1.2 | 验证 config 四个命令完整功能 | Tester | - | DONE |
| 1.3 | 验证 config.ts 配置读写正确性 | Developer | - | DONE |
| 1.4 | 验证 wallet-store.ts 加密存储功能 | Developer | - | DONE |
| 1.5 | 验证 output.ts 三种格式输出 | Tester | - | DONE |
| 1.6 | 验证 sol-sdk 基础层可用性 | Architect | - | DONE |
| 1.7 | 验证 adapters/sdk-adapter.ts 适配完整性 | Architect | 1.6 | DONE |
| 1.8 | 验证 shims/ 目录浏览器 API 替换 | Architect | 1.6 | DONE |
| 1.9 | TypeScript 编译检查 (tsc --noEmit) | Developer | - | DONE |
| 1.10 | 修复 Phase 1 中发现的所有 Bug | Developer | 1.1-1.9 | DONE |

### 验收标准

- [ ] `npx tsx bin/forgex.ts --version` 输出 `1.0.0`
- [ ] `npx tsx bin/forgex.ts --help` 显示所有 8 个命令组
- [ ] `npx tsx bin/forgex.ts config init` 能正确创建 `~/.forgex/config.json`
- [ ] `npx tsx bin/forgex.ts config set rpcUrl <url>` 能正确修改配置
- [ ] `npx tsx bin/forgex.ts config get rpcUrl` 能正确读取配置
- [ ] `npx tsx bin/forgex.ts config list` 输出完整配置（JSON 和 Table 格式）
- [ ] `WalletStore` 能创建、读取、加密、解密钱包数据
- [ ] `output.ts` 的 `formatOutput()` 正确处理 JSON/Table/Minimal
- [ ] `sol-sdk/rpc/index.ts` 能建立 Solana RPC 连接
- [ ] `npx tsc --noEmit` 无编译错误（或仅有可接受的 warning）

### Phase 1 完成条件

1. 所有 10 个任务标记为 DONE
2. Tester 提交 Config 组测试报告，通过率 >= 90%
3. Architect 确认 SDK 适配层无阻塞问题
4. PM 确认验收标准全部达成
5. 馆馆审核通过

---

## Phase 2: 核心命令实现

**目标**: 实现钱包组管理、基础交易和查询命令，使 CLI 具备基本的链上操作能力。

### 任务清单

| # | 任务 | 负责人 | 依赖 | 状态 |
|---|------|--------|------|------|
| 2.1 | 实现 wallet create-group 命令 | Developer | Phase 1 | PENDING |
| 2.2 | 实现 wallet list-groups 命令 | Developer | 2.1 | PENDING |
| 2.3 | 实现 wallet group-info 命令 | Developer | 2.1 | PENDING |
| 2.4 | 实现 wallet delete-group 命令 | Developer | 2.1 | PENDING |
| 2.5 | 实现 wallet generate 命令 | Developer | 2.1 | PENDING |
| 2.6 | 实现 wallet add / remove 命令 | Developer | 2.1 | PENDING |
| 2.7 | 实现 wallet import / export (CSV) 命令 | Developer | 2.1 | PENDING |
| 2.8 | 实现 wallet import-group / export-group (JSON) 命令 | Developer | 2.1 | PENDING |
| 2.9 | 实现 wallet overview 命令 | Developer | 2.1 | PENDING |
| 2.10 | 测试 wallet 全部 12 个命令 | Tester | 2.1-2.9 | PENDING |
| 2.11 | 实现 trade buy 命令 | Developer | 2.5 | PENDING |
| 2.12 | 实现 trade sell 命令 | Developer | 2.5 | PENDING |
| 2.13 | 实现 trade batch 命令 | Developer | 2.11, 2.12 | PENDING |
| 2.15 | 测试 trade 全部 3 个命令 | Tester | 2.11-2.13 | PENDING |
| 2.16 | 实现 query balance 命令 | Developer | Phase 1 | PENDING |
| 2.17 | 实现 query price 命令 | Developer | Phase 1 | PENDING |
| 2.18 | 实现 query kline 命令 | Developer | Phase 1 | PENDING |
| 2.19 | 实现 query transactions 命令 | Developer | Phase 1 | PENDING |
| 2.20 | 实现 query monitor 命令 | Developer | Phase 1 | PENDING |
| 2.21 | 测试 query 全部 5 个命令 | Tester | 2.16-2.20 | PENDING |
| 2.22 | 修复 Phase 2 中发现的所有 Bug | Developer | 2.10, 2.15, 2.21 | PENDING |
| 2.23 | PM 验收 wallet + trade + query | PM | 2.22 | PENDING |

### 验收标准

**Wallet 组**:
- [ ] 能创建 local 和 monitor 两种类型的钱包组
- [ ] 能列出所有钱包组并显示基本信息
- [ ] 能生成指定数量的新钱包并自动加入组
- [ ] 能通过私钥添加已有钱包
- [ ] 能安全导入/导出钱包（CSV 和 JSON 格式）
- [ ] 钱包数据持久化到 `~/.forgex/wallets/wallet-store.json`
- [ ] 钱包私钥加密存储，不以明文形式出现

**Trade 组**:
- [ ] buy 命令能正确构建买入交易（dry-run 验证）
- [ ] sell 命令能正确构建卖出交易（dry-run 验证）
- [ ] batch 命令支持 1b1s / 1b2s / 1b3s 等模式
- [ ] 所有交易命令支持 --slippage 和 --priority-fee 参数

**Query 组**:
- [ ] balance 命令能查询 SOL 和 SPL Token 余额
- [ ] price 命令能查询代币当前价格
- [ ] kline 命令能查询 K 线数据
- [ ] transactions 命令能查询交易记录
- [ ] monitor 命令能查询监控数据

### Phase 2 完成条件

1. 所有 23 个任务标记为 DONE
2. Tester 提交 Wallet/Trade/Query 三份测试报告，各通过率 >= 85%
3. PM 完成验收，全部验收标准达成
4. 馆馆审核通过

---

## Phase 3: 高级工具实现

**目标**: 实现做市工具、代币操作、转账操作，使 CLI 具备完整的链上能力。

### 任务清单

#### 批次 A: 基础设施变更 (v2 架构前置任务, 参考 cli/agents/ARCH-DESIGN-v2.md)

| # | 任务 | 负责人 | 依赖 | 状态 |
|---|------|--------|------|------|
| 3.0a | 实现 DataStore 文件存储层 | Developer | Phase 2 | DONE |
| 3.0b | 实现 CodexAdapter 数据源适配器 | Developer | Phase 2 | DONE |
| 3.0c | 实现 RpcAdapter 数据获取层 | Developer | Phase 2 | DONE |
| 3.0d | 实现 JitoAdapter 直连适配器 | Developer | Phase 2 | DONE |
| 3.0e | 实现 TxTracker + TxDetailAdapter | Developer | 3.0a, 3.0c, 3.0d | DONE |
| 3.0f | 实现 DataSource 统一门面 | Developer | 3.0a-3.0e | DONE |
| 3.0g | 迁移 query 命令到新数据源 | Developer | 3.0f | DONE |
| 3.0h | 迁移 trade 命令集成 TxTracker | Developer | 3.0e, 3.0f | DONE |
| 3.0i | 测试新基础设施层 | Tester | 3.0a-3.0h | DONE |

#### 批次 B: 命令实现 (依赖批次 A)

| # | 任务 | 负责人 | 依赖 | 状态 |
|---|------|--------|------|------|
| 3.1 | 设计 tools 命令组技术方案 | Architect | 批次 A | DONE (包含在 ARCH-DESIGN-v2.md) |
| 3.2 | 实现 tools turnover 命令 | Developer | 3.0f | PENDING |
| 3.3 | 实现 tools volume 命令 | Developer | 3.0f | PENDING |
| 3.4 | 实现 tools robot-price 命令 | Developer | 3.0f | PENDING |
| 3.5 | 测试 tools 全部 3 个命令 | Tester | 3.2-3.4 | PENDING |
| 3.6 | 实现 transfer in 命令 | Developer | 3.0f | PENDING |
| 3.7 | 实现 transfer out 命令 | Developer | 3.0f | PENDING |
| 3.8 | 实现 transfer many-to-many 命令 | Developer | 3.0f | PENDING |
| 3.9 | 测试 transfer 全部 3 个命令 | Tester | 3.6-3.8 | PENDING |
| 3.10 | 实现 token create 命令 | Developer | 3.0f | PENDING |
| 3.11 | 实现 token info 命令 | Developer | 3.0f | PENDING |
| 3.12 | 实现 token pool 命令 | Developer | 3.0f | PENDING |
| 3.13 | 测试 token 全部 3 个命令 | Tester | 3.10-3.12 | PENDING |

#### 批次 C: 收尾

| # | 任务 | 负责人 | 依赖 | 状态 |
|---|------|--------|------|------|
| 3.17 | 实现 tools 长驻进程模式 (--daemon) | Developer | 3.2-3.4 | PENDING |
| 3.18 | 修复 Phase 3 中发现的所有 Bug | Developer | 3.5, 3.9, 3.13 | PENDING |
| 3.19 | PM 验收 tools + transfer + token | PM | 3.18 | PENDING |

### 验收标准

**Tools 组**:
- [ ] turnover 命令能执行同区块钱包间换手（dry-run 验证）
- [ ] volume 命令支持全部刷量模式（1b1s, 1b2s, 1b3s, 2b1s, 3b1s）
- [ ] robot-price 命令支持 up/down 方向和目标价格设定
- [ ] 三个命令均支持 --interval 和 --rounds 参数
- [ ] 支持 --daemon 模式在后台持续运行

**Transfer 组**:
- [ ] transfer in 能从钱包组批量收集到指定地址
- [ ] transfer out 能从指定地址批量分发到钱包组
- [ ] many-to-many 能执行多对多转账
- [ ] 支持 SOL 和 SPL Token 转账
- [ ] 支持 all/fixed/reserve/random 金额模式

**Token 组**:
- [ ] token create 能在 Pump.fun 和 LaunchLab 创建代币
- [ ] token info 能查询代币元数据和状态
- [ ] token pool 能查询流动性池信息


### Phase 3 完成条件

1. 所有 19 个任务标记为 DONE
2. Tester 提交 Tools/Transfer/Token/Sniper 四份测试报告，各通过率 >= 85%
3. PM 完成验收
4. Architect 确认 --daemon 模式的稳定性
5. 馆馆审核通过

---

## Phase 4: Skill + 文档 + 打磨

**目标**: 编写 Agent Skill 使 AI 能驱动 CLI，完善文档，执行端到端工作流验证。

### 任务清单

| # | 任务 | 负责人 | 依赖 | 状态 |
|---|------|--------|------|------|
| 4.1 | 编写 Agent SKILL.md | PM + Architect | Phase 3 | DONE |
| 4.2 | 完善 CLI README.md | PM | Phase 3 | DONE |
| 4.3 | 端到端工作流测试: 新币发射 | Tester | 4.1 | DONE |
| 4.4 | 端到端工作流测试: 做市循环 | Tester | 4.1 | DONE |
| 4.5 | 端到端工作流测试: 钱包管理 | Tester | 4.1 | DONE |
| 4.6 | 端到端工作流测试: 收割退出 | Tester | 4.1 | DONE |
| 4.7 | 性能测试: 批量命令并发 | Tester | Phase 3 | DONE |
| 4.8 | 安全审计 | Architect | Phase 3 | DONE |
| 4.9 | 修复 Phase 4 中发现的所有问题 | Developer | 4.3-4.8 | DONE |
| 4.10 | 最终验收 | PM | 4.9 | DONE |
| 4.11 | 创建 v1.0.0 Release Tag | Developer | 4.10 | DONE |

### 验收标准

**Agent Skill**:
- [ ] SKILL.md 包含所有命令的参数说明和示例
- [ ] 包含 4 个完整的工作流模板（发射/做市/管理/收割）
- [ ] 包含错误处理指南和安全规则
- [ ] Agent 能通过 Skill 驱动 CLI 完成基本工作流

**端到端工作流**:
- [ ] 新币发射工作流全流程通过（创建组 -> 生成钱包 -> 分发SOL -> 创建代币 -> 狙击 -> 刷量）
- [ ] 做市工作流全流程通过（换手 -> 刷量 -> 价格控制）
- [ ] 钱包管理工作流全流程通过（创建 -> 导入 -> 监控 -> 导出）
- [ ] 收割工作流全流程通过（卖出 -> 收集 -> 转出）

**安全审计**:
- [ ] 无私钥明文暴露
- [ ] 加密存储正确实现
- [ ] 交易模拟在执行前运行
- [ ] --dry-run 模式不执行真实交易

### Phase 4 完成条件

1. 所有 11 个任务标记为 DONE
2. 4 个端到端工作流全部通过
3. 安全审计无 P0/P1 问题
4. PM 最终验收通过
5. 馆馆最终审核通过
6. v1.0.0 tag 已创建

---

## 进度追踪

### 当前状态

| Phase | 总任务 | 已完成 | 进行中 | 阻塞 | 进度 |
|-------|--------|--------|--------|------|------|
| Phase 1 | 10 | 10 | 0 | 0 | 100% |
| Phase 2 | 23 | 23 | 0 | 0 | 100% |
| Phase 3 | 28 | 28 | 0 | 0 | 100% |
| Phase 4 | 11 | 11 | 0 | 0 | 100% |
| **总计** | **72** | **72** | **0** | **0** | **100%** |

### 里程碑

| 里程碑 | 目标日期 | 状态 |
|--------|----------|------|
| Phase 1 完成 | 2026-02-11 | DONE ✓ |
| Phase 2 完成 | 2026-02-11 | DONE ✓ |
| Phase 3 批次A完成 | 2026-02-12 | DONE ✓ |
| Phase 3 完成 | 2026-02-12 | DONE ✓ |
| Phase 4 完成 / v1.0.0 发布 | 2026-02-12 | DONE ✓ |
