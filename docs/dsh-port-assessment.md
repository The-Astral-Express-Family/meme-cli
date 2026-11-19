# meme CLI → DSH 插件（JS/TS 移植）评估

日期：2026-11-14 ｜ 基线：v0.2.0（本轮重构后）

## 一、当前成熟度判断（"是否足够好转成 JS 插件"）

结论：**核心价值回路已达可移植下限，推荐分层移植（方案 C），不建议现在全量移植。**

证据（本轮实测，非自评）：

| 能力 | 证据 |
| --- | --- |
| 发现 | 真实湖回放：真梗入榜召回 6/39（v1）→ 16/20（v2，经语料验证的可发现集）；真网轮次榜首为真梗（"前来考古"公式族、"最晚之人"、"大肥鱼"），客套复读被成分检测拦截 |
| 使用 | lookup 一次调用返回 span+置信度+玩梗卡（gist/usage/taboo/aggression），subagent 据此产出 taboo 驱动的高质量接梗回复 |
| 归纳 | `add --entry` 操作员路径 + backtest 报错-修订-重试闭环，被两个独立 subagent 走通（interaction 词条两次被闸门逼对，公式词条新槽位泛化命中） |
| 迭代 | subagent 用 `iterate` 四轮修正上一班的误报归纳（"为什么不回答我？"0.95 误报 → 词典层否决），drift/审计自动留痕 |
| 工效 | 错误码+建议、miss 非错误、`meme schema`、批量 reject 幂等、失败不烧 ID——全部来自 subagent 实战反馈并回归测试化（104 tests） |

两个不成熟处（如实）：词库需要持续 surf 喂养才有用（空库的 lookup 恒 miss）；"含梗词的非梗用法"边界靠操作员对抗样本，非全自动（已在 schema 文档声明）。

## 二、移植方案

### 方案 A：DSH 插件 shell out 到 Python CLI
保留单一事实源，但要求用户机器装 Python+uv，分发重、启动慢。**否决。**

### 方案 B：全量 JS/TS 移植（含 surf/fetch）
B站端点风控（-352/-412，本轮实际遇到）是持续维护负担，双语言双倍维护。**暂缓。**

### 方案 C（推荐）：分层移植 `dsh-tool-meme`
第一版只移植 **read path + operator 写路径**：

```
meme_lookup / meme_search / meme_show / meme_schema     ← 高频、零外呼、毫秒级
meme_add --entry / meme_iterate --entry                 ← DSH agent 本身是 LLM，
                                                          operator 路径零外部依赖
meme_note                                               ← 低信任笔记
（backtest 闸门随 add/iterate 移植——纯本地正则+采样）
```

不移植（留在 Python CLI 或后续版本）：`surf`/fetch（B站获取，风控敏感）、WireLLM 直连（DSH 场景根本不需要——agent 自己就是归纳器）、fastembed 向量层（首版纯词法；v2 已验证离线降级路径完全可用）。

**代码量依据**：read+库 1178 行 + induct 闸门 1217 行 + 基础设施约一半 ≈ 全库的 45%；
其中无网络依赖、无 ML 依赖、无平台 API 的纯逻辑占 90%+。

## 三、技术映射

| Python | JS/TS | 风险 |
| --- | --- | --- |
| sqlite3 + FTS5 + pragma | better-sqlite3 | 低：FTS5/application_id/user_version 同构 |
| jieba / jieba.posseg | @node-rs/jieba | 低：词典兼容、posseg 有；分词边界差异用同一套测试语料回归 |
| 骨架归一化/匹配器/约束 DSL | 纯 string+RegExp | 零风险：本就是纯逻辑 |
| pydantic entry schema | zod | 低：`meme schema` 已把 schema 显性化 |
| burst z-score / evidence 评分 | 纯数学 | 零风险 |
| httpx + WBI md5 签名（surf 侧） | undici + node:crypto | 后续再说 |
| fastembed bge-small-zh | transformers.js 或首版跳过 | 首版跳过：纯词法+FTS5 已覆盖 read path 主路径 |

数据兼容：SQLite 库文件格式与 JSON schema（`schema_version: 1`）双端可直接共享，
Python CLI 策展产出的库可以被 JS 插件直接读——两个实现可以并存过渡。

## 四、发布形态建议

- 包位置：`packages/experimental/`，命名 `@deepseek-ai/dsh-tool-meme`（对齐 dsh-tool-terminal）
- 模型面工具 6 个（上列），README 按 package-reference 格式写（Summary/Use this package/Known limitations）
- 迁移验收：把本仓库 tests/ 的匹配器/约束/backtest/entry-schema 用例（约 60 个纯逻辑测试）平移为 JS 测试，同一批 fixture 双语言跑通即验收
- 路线：experimental 组发布 → 词库由 Python CLI 策展或手工 entry 喂养 → 稳定后评估 surf 移植

## 五、不移植 surf 的代价与补偿

代价：JS 插件用户没有自动发现能力。补偿：
1. 词库可以导出/导入（单文件 SQLite，拷贝即分享）——由 Python CLI 用户策展后分发；
2. operator 路径本身支持裸文本收录（群聊里见到新梗 `add --entry` 手动记），发现端只是加速器不是必需品；
3. DSH 插件后续版本可以加 `meme_surf` 作为可选 provider（调 Python CLI 或直连 B站）。
