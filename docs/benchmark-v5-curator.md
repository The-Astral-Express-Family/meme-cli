# v5 策展题基准（curator-v1）

> 定稿待实现。本文只写必须遵从的约束；示例、执行清单、待办在临时交接文档（`tmp-curator-v5-handoff.md`）。

## 1. 是什么

被测 agent 拿到 72 条候选，自己用 `meme add` / `meme ban` 建库；裁判用隐藏查询集跑 `meme lookup`，记 TP/TN/FP/FN。**评的是库的行为，不是 agent 的文字答案。**

题型名「策展题」，id `curator-v1`。不叫 OJ（没有在线判题），不叫 judge（和 v4 判断题分不清）。

## 2. 三条红线

- **R1** 主分只能来自 Step 3 的 lookup 行为；任何"让 agent 写判断"的产物不得计分。
- **R2** 查询只引用这 72 条候选与 29 个金标家族；不引入无关 fixture。
- **R3** agent 不可见查询集、v4 金标、`benchmarks/`、`~/.meme`。

## 3. 三步

1. **发题**：建空库并把 72 条候选写进 `candidates` 表（`cid`/`head`/`channel`/`evidence`，与生产 surf 后同形）；给一个固定环境的 `meme` wrapper。预算 200 条命令 / 20 分钟。
2. **策展**：白名单 `add`/`iterate`/`edit`/`ban`/`allow`/`note`/`show`/`search`/`check`/`lookup`；`add` 建议带 `--cid`。逐条记 transcript，结束写 `finish_reason`。
3. **验收**：冻结库，逐条 `meme lookup`，按 §4 判定。

## 4. 判定

### 4.1 主指标（逐题）

- **正例**：命中的词条属于期望家族 → TP，否则 FN。
- **负例**：任何命中 → FP；未命中 → TN。
- **额外命中**：正例命中了其他家族，单列，不进主矩阵。
- **归属**：`--cid` 关联优先；没有关联时用词条名与候选 `head` 字面相等兜底（72 条里 24 条是截断词头，写完整形会让 `--cid` 之外的自动收口失效）；都不中 → 未归属，命中只记「额外」。
- **一个词条跨 ≥2 个家族**：该词条命中不计分。防"一个大词条吞掉所有梗"，否则它能拿满分。

报告：P / R / F1、分通道（phrase / formula / interaction / conditional）、额外命中与未归属计数。

### 4.2 辅助指标（含两个 OI 式子任务）

逐题计分允许偷分：命中几个正例就有分，哪怕该家族硬负例全错。再补两个捆绑口径：

| 指标 | 单元 | 通过条件 | 分母 |
| --- | --- | --- | --- |
| `family_pass` | 一个家族 = 一个子任务（该家族的全部查询） | 全部正例 TP **且**全部负例 TN | 29 |
| `noise_pass` | 一条 `not-meme` 候选 = 一个子任务（它的 ≥2 条负例） | 该候选相关负例全部 TN（无 FP） | 45 |

**两个 subtask 指标必须并列报告，不合成单一分数**：

- `family_pass` 衡量"建对了几个梗"，`noise_pass` 衡量"有没有把噪音也建进去"。
- 只报 `family_pass` 会骗人：29/29 家族全对、但顺手把 45 条噪音也建成词条，`family_pass` 依然满分，而 precision 与 `noise_pass` 已经塌了。
- 只报 `noise_pass` 也会骗人：空库什么都不建，45/45 全过。
- 两者互不替代，也都不替代 §4.1 的逐题主指标。

**失败家族要带原因标签**，代替"建了几个家族"这类覆盖率指标：每个失败家族标 `unbuilt`（没建）/ `banned`（误封）/ `matcher_wrong`（建了但某题失败）/ `noise`（被噪音词条蹭中）。覆盖率指标（如 `add_recall`）没有独立价值——只要无脑 add 就能刷满，而且与 `family_pass` 评的是同一件事。

子任务天然压制"加宽词表乱命中"（任何一条负例误报就整族归零），但它**不能替代归属规则**：一个跨家族的大词条仍然可能通过所有负例，只是靠 §4.1 的跨家族规则不计分。

## 5. 数据与环境

**种子候选**（写入库，agent 可见）：`cid`、`head`、`channel`、`kind_guess`、`videos`、`ups`、`evidence_usages`。禁止写入 `candidate_verdict` / `resolved_verdict` / `family_id` / `canonical_head` / `accepted_canonical_forms` / `rationale`。

**查询**（对 agent 隐藏）：

```json
{"query_id":"q-0001","channel":"phrase","text":"这我真没绷住","ctx":null,
 "expect":{"hit":true,"family":"beng"},"from_candidate":"c_58951","tags":["canonical"]}
```

- `family` 只能来自 29 个金标家族；**正例必须带 `from_candidate`**（v5.1 的 C 口径要用）。
- 覆盖：每家族 ≥5 条（≥2 正例 + ≥3 负例，其中 ≥2 条硬负例）；45 条 `not-meme` 候选各 ≥2 条负例；总量 200–400。
- 负例里不得含其他真梗表达（否则正确命中会被记成 FP）。
- 鼓励出题人主动多出困难题 / 混淆题，仓库内的其它文档和注释可能是创意来源，但需要确认金标可通过。

**run 产物**：`transcript.jsonl`、`db/`、`lookups.jsonl`、`score.json`、`meta.json`。

**环境**：

- `MEME_DB` 由 wrapper 固定（忽略外部同名变量），每次 run 全新库。
- `MEME_EMBED_OFF=1`——否则 `lookup`/`add` 首次调用会下载嵌入模型，既慢又不可复现。
- 白名单外命令（`surf`/`auth`/`ingest`/`config`）直接拒绝并记 `invalid`；预载把 `globalThis.fetch` 换成抛错函数，堵住任何残余出网；run 内无 `credentials.json`。
- 同一库快照重跑 Step 3，结果必须逐题一致。

## 6. 验收

- 空库：正例全 FN、负例全 TN（证明查询真在测库）；此时 `family_pass=0/29`、`noise_pass=45/45`——两者必须同时看。
- 满分库（29 家族按金标写好）：正例全 TP、负例全 TN，`family_pass=29/29`、`noise_pass=45/45`；做不到的硬负例逐条列出。如果发现满分库未满分，说明 a) 题目设计有问题，b) meme cli 的匹配逻辑有问题。都需要排查修复。
- 误 add 噪音 → FP 上升；误 ban 真梗 → 对应正例 FN。
- 种子候选无金标字段（自动扫描）。
- 查询 `family` 全部在 29 个家族内。
- `surf` / `auth` 被拒；出网调用抛错。

## 7. 不做

- 不做在线提交 / 实时判题；不做沙箱容器。
- 不做基于语义的家族推断（只做字面相等兜底）。
- 不做 Elo、显著性检验、校准曲线、多标注一致性。
- 不要求 agent 写理由。
- 不在 v5 评图片梗。

## 8. v5.1 判分消融（与 v5 一并实现）

**目的**：用数据回答"家族归属该不该是必要条件"。证明它必要、或证明它过严，两种结果都算成功。

**不跑新 run。** v5 每个 run 的 `db/` + `lookups.jsonl` 已够用；v5.1 只换口径重算。

### 8.1 两种口径（同一批 lookup 结果）

| 口径 | 正例 TP 条件 | 负例 |
| --- | --- | --- |
| **A 家族**（v5 默认） | 命中词条归属到 `expect.family` | 任何命中 = FP |
| **B any-hit** | 命中任何词条即可 | 任何命中 = FP |

测"归属是否必要"。

### 8.2 输出 `ablation.json`

`runs[]` × `variants{A,B}` × `balance{full,neg2x}`：每格给逐题 P/R/F1 与 §4.2 的两个子任务指标；另给各口径的排序与 `ranking_stable`。

### 8.3 结论怎么用

- B 与 A **排序一致**且分数差 < 5 个百分点 → 归属可放宽（`policy='any'`）。
- B 让"加宽词表"类策略明显上浮或翻转排序 → 保留归属，把数字抄进本文当证据。
- 子任务指标是这里的**重要旁证**：若 B 口径下 `noise_pass` 明显下降而 P/R/F1 变化不大，说明逐题指标掩盖了精度损失，应保留归属。

### 8.4 实现约束

- scorer 判定参数化 `policy: 'family' | 'any'`，默认 `family`。
- 负例配比用"每条负例计两次"实现，不做随机采样（无需 seed，结果确定）。
- 只读 run 产物，不重跑 lookup、不改库。
- 自检：两种口径在**满分库**上结果相同（全对）、在**空库**上也相同（全 FN / 全 TN）——差异只应出现在有错配的库上。
- 子任务指标与 policy 无关这条要守住：`family_pass` / `noise_pass` 的**分组与通过条件固定**，只有"正例算不算命中"随 policy 变。

## 9. 版本

v5 就是本版：三步流程 + 家族归属 + 逐题主指标 + 两个 subtask 辅助指标。v5.1 是它的计分消融，不改变 v5 的数据与主指标定义。
