# ForgeX CLI Project Team Configuration

> 本文件是 ForgeX CLI 项目的团队配置主文件。所有 project agents 必须在工作开始前阅读本文件。
> 由天天（项目编排者）创建于 2026-02-11。

---

## 1. 项目概述

**项目名称**: ForgeX CLI
**项目目标**: 将 ForgeX DApp 的全部链上操作能力从 UI 层剥离，封装为独立的命令行工具 `forgex-cli`
**代码位置**: `/Users/cat/delay/forgex/front/cli/`
**设计文档**: `/Users/cat/delay/forgex/front/framework.md`
**前端项目**: `/Users/cat/delay/forgex/front/` (Next.js 15 + React 19)
**分支**: `forgex_cli`

### 技术栈

| 层级 | 技术 |
|------|------|
| CLI 框架 | commander.js |
| 输出美化 | chalk + cli-table3 + ora |
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js >= 22.14.0 |
| 区块链 | @solana/web3.js, @coral-xyz/anchor, Raydium SDK |
| 加密 | crypto-js (AES 加密钱包存储) |
| 配置 | ~/.forgex/config.json |
| 钱包存储 | ~/.forgex/wallets/wallet-store.json |

### 命令清单 (8 组, 36+ 命令)

| 命令组 | 命令数 | 文件 |
|--------|--------|------|
| config | 4 | `src/commands/config/index.ts` |
| wallet | 12 | `src/commands/wallet/index.ts` |
| trade | 4 | `src/commands/trade/index.ts` |
| tools | 3 | `src/commands/tools/index.ts` |
| transfer | 3 | `src/commands/transfer/index.ts` |
| token | 3 | `src/commands/token/index.ts` |
| sniper | 2 | `src/commands/sniper/index.ts` |
| query | 5 | `src/commands/query/index.ts` |

---

## 2. 团队角色

### 角色一览

| 角色 | 代号 | 职责核心 | 配置文件 |
|------|------|----------|----------|
| 产品经理 | PM | 需求管理、验收标准 | `agents/PM.md` |
| 架构师 | Architect | 技术方案、代码架构 | `agents/ARCHITECT.md` |
| 开发者 | Developer | 命令实现、SDK连通 | `agents/DEVELOPER.md` |
| 测试者 | Tester | 功能验证、端到端测试 | `agents/TESTER.md` |

### 职责边界（不可重叠）

```
PM:        需求定义 -> 优先级排序 -> 验收标准 -> 验收判定
Architect: 技术方案 -> 架构设计 -> 代码审查 -> 性能方案
Developer: 代码实现 -> Bug修复 -> SDK适配 -> 文档注释
Tester:    测试设计 -> 执行测试 -> Bug报告 -> 回归验证
```

---

## 3. 汇报机制：馆馆

馆馆是项目的技术负责人和技能评估者。

### 汇报触发条件

每个 agent 在以下情况必须向馆馆汇报：

| 触发条件 | 汇报内容 | 优先级 |
|----------|----------|--------|
| Phase 完成 | 完成情况、交付物清单、遗留问题 | P0 |
| 阻塞性问题 | 问题描述、影响范围、建议方案 | P0 |
| 重大技术风险 | 风险描述、概率评估、缓解方案 | P0 |
| 架构决策点 | 决策选项、利弊分析、推荐选择 | P1 |
| 跨角色依赖 | 依赖描述、所需资源、时间估算 | P1 |
| 阶段性成果 | 进度百分比、已完成项、下步计划 | P2 |

### 汇报格式

```markdown
## [角色] 汇报 - [日期]

**汇报类型**: [Phase完成 / 阻塞问题 / 技术风险 / 决策请求 / 进度更新]
**当前Phase**: [Phase X]
**完成度**: [X%]

### 内容
[具体汇报内容]

### 需要馆馆的支持
[具体需求，如果没有写"无"]
```

---

## 4. 调度机制：玲玲

玲玲是项目的统一调度者。

### 调度规则

1. **任务分配**: 所有任务由玲玲统一分配，agent 不得自行认领跨角色任务
2. **优先级执行**: 按 P0 > P1 > P2 的优先级执行
3. **Phase 顺序**: 严格按 Phase 1 -> 2 -> 3 -> 4 顺序推进
4. **阻塞上报**: 遇到阻塞问题时立即上报玲玲，不得自行搁置
5. **完成确认**: 每个任务完成后向玲玲报告，等待下一步调度

### 调度流程

```
玲玲分配任务 -> Agent 确认接收 -> Agent 执行 -> Agent 报告完成
     |                                              |
     +-- 如遇阻塞 <-- Agent 上报阻塞 <--- 执行中发现问题
     |
     +-> 协调其他 Agent 解决 -> 重新调度
```

### 任务状态定义

| 状态 | 含义 |
|------|------|
| PENDING | 待分配，在队列中等待 |
| ASSIGNED | 已分配给某 Agent |
| IN_PROGRESS | 正在执行中 |
| BLOCKED | 遇到阻塞，等待解决 |
| REVIEW | 完成实现，等待验证 |
| DONE | 已验证通过 |

---

## 5. 跨角色协作流程

### 标准工作流

```
PM 定义需求和验收标准
    |
    v
Architect 设计技术方案
    |
    v
Developer 实现代码
    |
    v
Tester 执行测试
    |
    +-- 通过 --> PM 验收 --> 标记 DONE
    |
    +-- 失败 --> Developer 修复 --> Tester 回归测试
```

### 信息流转规则

1. PM 输出需求文档，供 Architect 和 Developer 使用
2. Architect 输出技术方案，供 Developer 实现
3. Developer 输出代码和自测结果，供 Tester 验证
4. Tester 输出测试报告，供 PM 验收和 Developer 修复
5. 所有产出物统一写入 `cli/agents/` 目录下的对应文件

### 共享上下文文件

| 文件 | 用途 | 维护者 |
|------|------|--------|
| `TEAM.md` | 团队配置（本文件） | 天天 |
| `PHASES.md` | Phase 执行计划和进度 | PM + 玲玲 |
| `agents/PM.md` | 产品经理配置 | PM |
| `agents/ARCHITECT.md` | 架构师配置 | Architect |
| `agents/DEVELOPER.md` | 开发者配置 | Developer |
| `agents/TESTER.md` | 测试者配置 | Tester |
| `agents/PROGRESS.md` | 实时进度看板 | 全体 |

---

## 6. 质量检查机制

### 每个 Agent 的内置质量检查

- **PM**: 需求是否可测试、验收标准是否明确、优先级是否合理
- **Architect**: 方案是否可实现、是否与前端 sol-sdk 一致、是否考虑性能
- **Developer**: 代码是否通过 TypeScript 编译、是否遵循 CLAUDE.md 规范、是否有错误处理
- **Tester**: 测试是否覆盖正常/异常/边界场景、是否可重现、报告是否完整

### Phase 完成标准

一个 Phase 的完成需要满足：
1. 所有命令通过 Tester 验证
2. PM 确认验收标准达成
3. Architect 确认无架构问题
4. 馆馆审核通过

---

## 7. 紧急规则

1. **安全红线**: 任何涉及私钥明文暴露的代码必须立即停止并上报
2. **数据保护**: 测试必须使用 devnet 或模拟数据，禁止在 mainnet 执行实际交易测试
3. **SDK 同步**: 修改 `cli/src/sol-sdk/` 时必须确认与 `src/sol-sdk/` 的一致性
4. **回滚机制**: 每个 Phase 完成前创建 git tag，便于回滚
