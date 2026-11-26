# v5 策展题基准（curator-v1）· 顶层设计

> 状态：定稿，待实现。
> 实现与本文冲突时以本文为准；本文未覆盖处按 §10 保守处理，不要自行扩展。

## 1. 定位与命名

被测 agent 拿到 72 条候选，**自己动手**用 `meme add` / `meme ban` 建一个梗库；裁判再用隐藏查询集逐条跑 `meme lookup`，按命中情况记 TP/TN/FP/FN。

- 题型名：**策展题**；数据集 id `curator-v1`；脚本前缀 `curator-`。
- 不叫 OJ：没有在线提交与实时判题，这名字会诱导实现者去做在线评测服务。
- 不叫 judge：judge 泛指一切裁判，v4 的答题表也是 judge，无法区分"答判断题"与"建库后被查询"。
- 判分方式是 judge 式隐藏用例；被评的是**库的行为**，不是 agent 的文字答案。

## 2. 评测对象与硬约束

**被测对象：Step 2 结束时库的状态**（有哪些词条、matcher 怎么写、哪些候选被收入或封禁）。

以下六条都可自动校验，**任一条不满足即实现错误**（它们就是"禁止清单"的正向写法，不再另列）：

| 编号 | 约束 |
| --- | --- |
| **R1** | 主分只能来自 Step 3 的 `meme lookup` 行为。任何"让 agent 输出判断答案"的产物不得计分。 |
| **R2** | 查询集只引用这 72 条候选及其金标；不得引入与候选无关的 fixture 词条或家族。 |
| **R3** | Step 2 的 agent 不可见查询集、v4 金标、`benchmarks/` 目录，也不可见用户真实库 `~/.meme`。 |
| **R4** | Step 2 全程离线：命令白名单 + `MEME_EMBED_OFF=1` + 入口处 `fetch` 拦截（见 §7）。 |
| **R5** | 每次 run 独立库，只从 runner 写入的种子候选开始；不得跨 run 复用。 |
| **R6** | 判定可复现：同一份库快照重跑 Step 3，结果必须逐题一致。 |

## 3. 三步流程

### Step 1 发题

runner 准备一个 run：

1. 建空库，**把 72 条候选写入 `candidates` 表**（含 `evidence_usages`，`state='triggered'`），与生产 surf 后的形态一致。
2. 写入一份可读副本 `candidates.jsonl` 供人核对（agent 以 `meme check` 为准，不以读文件为准）。
3. 写一页命令说明：允许的子命令、预算、完成方式。
4. agent 只通过 runner 提供的 `meme` wrapper 调用（wrapper 固定 `MEME_DB`、`MEME_EMBED_OFF`，忽略外部同名变量）。

预算：命令数 ≤ 200，总时长 ≤ 20 分钟，单命令超时 60s。

### Step 2 策展

- 每条候选的终态三选一：`add`（收录）、`ban`（精确封禁）、`不动`。
- **推荐** `add` / `iterate` 带 `--cid`（建立"候选 → 词条"归属）；没带时 runner 按 §5 通道 B 兜底。
- `transcript.jsonl` 逐条记录：时间戳、argv、exit code、stdout（截断）、stderr（截断）。
- 结束条件：agent 声明完成，或预算耗尽；写入 `meta.finish_reason`。
- 出现非白名单命令、或任何网络异常 → 该 run 记 `invalid`，不参与评分。

### Step 3 验收

- 冻结库（关闭写入），在**同一个库**上逐条执行 `meme lookup <text> [--ctx ...]`。
- 判定见 §6，归属见 §5（只做归一化字面匹配，不做语义推断）。
- 保留 lookup 原始 stdout 与判定结果，便于复核。

## 4. 数据契约

### 4.1 种子候选（写入库，agent 可见）

字段取自 v4 `cases.jsonl`，但只保留运行时应该有的部分：

| 字段 | 用途 |
| --- | --- |
| `cid`（= v4 `source_cid`） | 归属键 |
| `head`、`channel`、`kind_guess`、`distinct_videos`、`distinct_ups`、`surfs_seen`、`last_round` | 供 `meme check` 呈现 |
| `evidence_usages[]`（text/aid/rpid/mid/ctime/chain/parent） | 供 `--cid` 取证与 backtest |
| `first_seen`、`last_seen` | 原样保留 |

**禁止入库的字段**：`candidate_verdict`、`resolved_verdict`、`family_id`、`canonical_head`、`accepted_canonical_forms`、`rationale`。runner 必须自动扫描并拒绝。

### 4.2 查询集（对 agent 隐藏）

**判定单位是家族，不是候选 cid。** 同一家族可以有多个候选（`beng` 8 个、`shen` 3 个），合并成一条词条是合法的；用 cid 作判定单位会把这种正常收编判成错。

```json
{"query_id":"q-0001","channel":"phrase","text":"这我真没绷住","ctx":null,
 "expect":{"hit":true,"family":"beng"},
 "guard_cids":[],
 "tags":["canonical"],
 "from_candidate":"c_58951"}
```

硬性要求：

- `expect.family` 只能取自 29 个金标家族（自动校验，不得新造）；`guard_cids` / `from_candidate` 只能引用这 72 条 cid。
- `guard_cids` **只用于诊断**（命中它时记 `fp_guarded`）；负例的判定不看它——任何命中都是 FP。
- 每个有正例的家族，至少 1 条硬负例（同子串普通用法 / 更长词内部 / 话题义 / 疑问语用）。
- 覆盖：29 个金标家族每个 ≥3 条（≥1 正例 + ≥1 硬负例）；45 条 `not-meme` 候选各 ≥1 条负例（负例不需要家族）。
- 规模 250–400 条。

### 4.3 run 产物

```
runs/<run_id>/
  candidates.jsonl   # 种子候选的可读副本
  wrapper/meme       # 固定环境的调用入口
  transcript.jsonl   # 每条命令
  db/                # 该 run 的库快照
  lookups.jsonl      # Step 3 原始输出
  score.json         # 主分 + 辅分
  meta.json          # 模型、命令数、耗时、finish_reason、invalid 原因、环境版本、git commit
```

## 5. 溯源：家族从哪来

`meme lookup` 不返回 family，也不该返回（命中项只有 `meme_id`/`name`/`class`/`span`/`excerpt`/`tier`/`confidence`/`method`）。家族是评测标签，映射由 runner 算，两个通道：

- **A 显式**：`add --cid c_x` → `candidates[c_x].state='inducted'` 且 `related` 指向该词条；`ban` → `rejected`/`banned`。
- **B 兜底**：词条没关联候选时，用 `name`/`aliases` 与候选 `head`、家族 `canonical_head`/`accepted_canonical_forms` 做**归一化字面相等**（模板只比字面核心）。不做语义或模糊匹配。

需要 B 的原因：72 条里 24 条是截断词头（涉及 16 家族），写完整形会让"head 精确相等"的自动收口失效；只认 `--cid` 等于用记账错误惩罚做对的 agent。

归属规则：

- 同一家族的多个候选可合成一条词条（`beng` 有 8 个候选）。
- 跨 ≥2 个家族 → `merged_families`：该词条命中不计 TP（记 FN + `structural_fail`），负例照常 FP。这是"一个大词条吞掉所有梗"的唯一防线。
- 两通道都不中 → 无归属：命中只进「额外命中」，计入 `unattributed_entries` / `unattributed_hits`。

## 6. 评分

### 6.1 主指标

- 正例：存在命中，其词条归属到 `expect.family` → **TP**；否则 **FN**。
- 负例：**任何命中都算 FP**（不设豁免，避免"无归属词条"变成逃生口）；未命中 → **TN**。
- 正例命中归属到其他家族 → 「额外命中」，单列，不进主矩阵。
- `FP` 细分 `fp_guarded` / `fp_unattributed`，只作诊断，不改变计数。
- `precision = TP/(TP+FP)`、`recall = TP/(TP+FN)`、`F1`、`accuracy = (TP+TN)/N`。

归属是必需项，不是洁癖：不要求归属时，"加宽词表乱命中"可拿 F1≈0.69，压过诚实建了 10/29 家族的 F1≈0.52（算法见交接文档）。高分段两者一致。

### 6.2 分层报告

- 分通道：phrase / formula / interaction / conditional
- 公式替换分组（正例召回）：同类替换 / 跨域替换 / 多槽 / 多词 / 标点
- 同文异境成对：同一 `text` 分别以"该命中 / 不该命中"语境出现，两边都对才算成功

### 6.3 诊断指标（与主分并列，不改主分）

`cross_family_hits`（正例被别的家族蹭中）、`unattributed_hits`（被无归属词条命中）、`any_hit_recall`（不计归属的召回，与主 recall 之差即蹭中率）、`merged_families`（跨家族词条数，验收要求 0）。

### 6.4 辅助指标（来自 v4 金标，只做诊断，不得替代主分）

| 指标 | 定义 |
| --- | --- |
| `add_recall` | 正确收录的真梗家族数 / 29（家族内任一候选被 `inducted` 即算收录） |
| `noise_kept_rate` | 45 条 `not-meme` 候选中未变成词条的比例 |
| `false_ban` | 真梗候选被 `rejected`（reason=`banned`）的数量 |
| `untouched` | 终态仍为 `pending`/`triggered` 的候选数 |
| `disposition_accuracy` | 处置与 v4 金标一致的比例（meme→add / conditional→add 带约束 / not-meme→ban 或不 add） |
| `unattributed_entries` | 无法归属到任何家族的词条数 |

## 7. 环境与离线

### 7.1 命令白名单

| 放行 | 理由 |
| --- | --- |
| `lookup`、`search`、`show`、`check` | 只读，agent 自检用 |
| `add`、`iterate`、`edit` | 建库与修订 |
| `ban`、`allow` | 处置候选 |
| `note` | 低信任笔记，不影响 matcher 与卡片 |

| 禁止 | 理由 |
| --- | --- |
| `surf`（含 `--no-fetch`） | 出网；且会推进轮次、写原始湖，污染 run |
| `ingest` | 写原始湖 `round_id=0`，对评测无意义且可污染 |
| `config` | 会写用户 `~/.meme/config.json`，越出 run 目录 |
| `auth` | 出网（nav/passport）且涉及凭证 |

### 7.2 离线四层强制

1. **白名单**：runner 拒绝非白名单子命令，并记 `invalid`。
2. **`MEME_EMBED_OFF=1`**：关掉向量层与嵌入模型下载（`lookup`/`search`/`add`/`iterate` 首次调用都会触发下载）。
3. **入口 `fetch` 拦截**：用 `NODE_OPTIONS=--require <offline.cjs>` 预载，把 `globalThis.fetch` 换成抛错函数——覆盖 surf、auth、模型下载以及将来新增的任何出网代码。
4. **不提供出网前提**：run 内无 `credentials.json`；`MEME_DB` 由 wrapper 固定；工作目录限于 run 目录。

**判定**：transcript 里出现非白名单命令、或 `offline` 抛错任何一次 → 该 run `invalid`，不计分。

**边界如实标注**：以上是应用层强制，不是操作系统级沙箱。若 agent 绕过 CLI 直接用 `curl`，只能靠 "run 后审计 transcript" 发现。需要强保证时用容器/网络命名空间，属 v5.1，不在本版范围。

## 8. 验收清单

- [ ] 空库基线：正例全 FN、负例全 TN
- [ ] 满分库基线（29 家族按金标写好）：正例全 TP、负例全 TN（例外逐条列出）
- [ ] 误 add 噪音 → FP 上升
- [ ] 误 ban 真梗 → 对应正例 FN
- [ ] 同一库快照重跑 Step 3，逐题结果一致
- [ ] 种子候选不含任何金标字段（自动扫描）
- [ ] 查询集 `expect.family` 全部来自 29 个金标家族；`guard_cids` / `from_candidate` 全部来自 72 条
- [ ] agent 工作目录无查询集、无 v4 labels、无 `~/.meme`（自动校验）
- [ ] `surf` / `auth` / `ingest` / `config` 被拒并记 `invalid`
- [ ] 离线 shim 生效：任意出网调用抛错（可注入测试）
- [ ] `merged_families` 为 0；`unattributed_entries` 为 0 或逐条说明
- [ ] transcript 含 argv / exit code / 耗时
- [ ] 单 run 可在无网络机器上复现

## 9. 版本路线

- **v5（本版）**：家族级归属判定（§5/§6）；归属是必要条件。
- **v5.1（计划）**：判分消融。在 v5 数据上并列跑「家族归属 / any-hit / 仅 cid」三种口径与不同负例配比，量化各自的分数差与排序稳定性，用数据决定是否放宽归属要求；同时把离线强制升级为容器级隔离。消融结果写回本文，不改 v5 数据。

## 10. 不做的事

- 不做在线提交 / 实时判题
- 不做基于语义的家族推断（只做归一化字面匹配，猜错比猜不到更糟）
- 不做 Elo、显著性检验、校准曲线
- 不做多标注一致性体系
- 不要求 agent 写理由（可留可选字段，不进分）
- 不把 v4 的 72 题判题表当作 v5 的一部分
- 不在 v5 里评测图片梗（向量 / 多模态另立）
