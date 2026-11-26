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

- **正例**：命中的词条属于期望家族 → TP，否则 FN。
- **负例**：任何命中 → FP；未命中 → TN。
- **额外命中**：正例命中了其他家族，单列，不进主矩阵。
- **归属**：`--cid` 关联优先；没有关联时用词条名与候选 `head` 字面相等兜底（72 条里 24 条是截断词头，写完整形会让 `--cid` 之外的自动收口失效）；都不中 → 未归属，命中只记「额外」。
- **一个词条跨 ≥2 个家族**：该词条命中不计分。防"一个大词条吞掉所有梗"，否则它能拿满分。

指标：P / R / F1、分通道（phrase / formula / interaction / conditional）、额外命中与未归属计数。

辅分（只看不排名）：`add_recall`（正确建出的家族 / 29）、`false_ban`（误封真梗数）、`untouched`（没处理的候选数）。

## 5. 数据与环境

**种子候选**（写入库，agent 可见）：`cid`、`head`、`channel`、`kind_guess`、`videos`、`ups`、`evidence_usages`。禁止写入 `candidate_verdict` / `resolved_verdict` / `family_id` / `canonical_head` / `accepted_canonical_forms` / `rationale`。

**查询**（对 agent 隐藏）：

```json
{"query_id":"q-0001","channel":"phrase","text":"这我真没绷住","ctx":null,
 "expect":{"hit":true,"family":"beng"},"from_candidate":"c_58951","tags":["canonical"]}
```

- `family` 只能来自 29 个金标家族。
- 覆盖：每家族 ≥3 条（≥1 正例 + ≥1 硬负例）；45 条 `not-meme` 候选各 ≥1 条负例；总量 250–400。
- 负例里不得含其他真梗表达（否则正确命中会被记成 FP）。

**run 产物**：`transcript.jsonl`、`db/`、`lookups.jsonl`、`score.json`、`meta.json`。

**环境**：

- `MEME_DB` 由 wrapper 固定（忽略外部同名变量），每次 run 全新库。
- `MEME_EMBED_OFF=1`——否则 `lookup`/`add` 首次调用会下载嵌入模型，既慢又不可复现。
- 白名单外命令（`surf`/`auth`/`ingest`/`config`）直接拒绝并记 `invalid`；预载把 `globalThis.fetch` 换成抛错函数，堵住任何残余出网；run 内无 `credentials.json`。
- 同一库快照重跑 Step 3，结果必须逐题一致。

## 6. 验收

- 空库：正例全 FN、负例全 TN（证明查询真在测库）。
- 满分库（29 家族按金标写好）：正例全 TP、负例全 TN；做不到的硬负例逐条列出。
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

## 8. 版本路线

v5.1 再谈判分消融：同一批 run 上对比「家族归属 / any-hit / 仅 cid」三种口径，以及不同负例配比，看排序是否稳定。先让 v5 跑起来，不提前优化。
