# curator-v1 —— v5 策展题基准（当前主基准）

被测 agent 拿到 71 条候选（72 条 v4 case，`c_70855` 双 case 同证据按一行入库），用固定环境的 `meme` wrapper 自己建库（add/iterate/edit/ban/allow/note/show/search/check/lookup，预算 200 条命令 / 20 分钟，禁网）；裁判用本目录 `queries.jsonl`（264 条，对 agent 隐藏）逐条 `meme lookup`，按 `docs/benchmark-v5-curator.md` §4 判定：逐题 P/R/F1 + 两个 subtask（`family_pass` /29、`noise_pass` /45）+ 失败家族原因标签（unbuilt/banned/matcher_wrong/noise）。v5.1 计分消融（policy family/any × balance full/neg2x）随评分器一并实现，只读 run 产物。

## 目录

```
queries.jsonl      隐藏查询集（264 条；评测专用，答题 agent 不可见）
manifest.json      哈希 / 通道分布 / 出题与复核的模型记录 / 基线结果
seed/candidates.jsonl   种子候选（白名单字段，无金标字段，导入前自动扫描）
agent-prompt.md    答题 agent 任务书（init 时拷贝为 runs/<id>/brief.md）
wrapper/           run wrapper 模板（meme.mjs + fetch-block.cjs + sh/cmd/ps1 启动器）
runs/<id>/         run 产物：db/、transcript.jsonl、lookups.jsonl、score.json、meta.json（不入 git）
authoring/         出题片段与规格（不入 git）
ablation.json      v5.1 消融结果（重跑 --ablation 生成）
```

## 命令

```sh
npx tsx scripts/curator-seed.ts --export            # v4 cases → 种子候选（白名单 + 禁止字段扫描）
npx tsx scripts/curator-queries.ts merge            # authoring/frag-T*.jsonl → queries.jsonl（重编号）
npx tsx scripts/curator-queries.ts check            # 查询集机械校验（金标合法/包含/去重/覆盖/配对）
npx tsx scripts/curator-run.ts init --run-id R [--model M]     # 建库 + 生成 wrapper + 任务书
npx tsx scripts/curator-perfect.ts --run perfect    # 金标满分库（经 wrapper 真实 add）
npx tsx scripts/curator-run.ts judge --run-id R --finish-reason X   # 冻结快照逐题 lookup
npx tsx scripts/curator-run.ts verify --run-id R    # 同库快照重跑逐字节比对
npx tsx scripts/curator-score.ts --run R [--policy family|any] [--balance full|neg2x]
npx tsx scripts/curator-score.ts --ablation         # 全部 run × 口径 × 配比 → ablation.json
```

## 归属与判定要点

- 词条归属：候选 `related` 关联优先；transcript 里的显式 `--cid` 同样采信（`settleCandidates` 会跳过已 `inducted` 候选，同候选第二次 `--cid` 不写 related——如 `c_70855` 同证据支撑 `x-da-xue-xi` 与 `325-event` 两个金标家族，两个词条都显式挂它）；无关联时词条名与候选 `head` 字面相等兜底；指向 ≥2 家族的词条命中不计分。
- 词法层只扫末行 text，ctx 只用于 tier3 交互——3 组同文异境 pair（laigushi/x_zuoren/hao-ting）依赖交互词条。
- 两条 `constraint-dependent` 负例（q-0157「好听」、q-0169「325块钱」）靠满分库的交互词条与 `forbid_inner`+`forbid_context['块钱']` 兜住。

## 基线与被测模型（2026-11-27）

主表按模型聚合，避免 run 一多就无限拉长。每个模型 3 次独立作答，均值/标准差按各 run 的逐题指标先算再平均（不是把三次混淆矩阵相加后重算）；`±` 为**样本标准差** `n−1`。空库/满分库是单次基线，不参与聚合。

| 模型 | n | P | R | F1 | family_pass /29 | noise_pass /45 |
| --- | ---: | --- | --- | --- | --- | --- |
| HungerG | 3 | 0.860 ± 0.022 | 0.523 ± 0.041 | **0.649 ± 0.028** | 11.7 ± 1.5 | 44.0 ± 0.0 |
| deepseek-v4.1-flash | 3 | 0.836 ± 0.025 | 0.505 ± 0.194 | 0.615 ± 0.171 | 10.0 ± 3.6 | 44.0 ± 0.0 |
| GLM-5.3 | 3 | 0.877 ± 0.071 | 0.441 ± 0.039 | 0.587 ± 0.046 | 9.7 ± 1.2 | 44.7 ± 0.6 |
| empty（空库基线） | 1 | 0 | 0 | 0 | 0/29 | 45/45 |
| perfect（金标满分库） | 1 | 1.000 | 1.000 | 1.000 | 29/29 | 45/45 |

范围：HungerG F1 0.621–0.677；deepseek-v4.1-flash 0.420–0.738；GLM-5.3 0.549–0.637。空库/满分库验的是"查询真在测库、且金标可通过"；9 个真实 run（3 个模型 ×3）用来确认题目有区分度。同库快照重跑逐字节一致（empty/perfect 均通过 `verify`）。

HungerG 三次的 `noise_pass` 全是 44/45，卡在 `c_63906`（噪音候选「不赖」）；DS 三次全卡在 `c_53591`（「意气风发」）；GLM-5.3 两次 45/45、一次 44/45。不同模型暴露了不同的稳定弱点，不是题错。

<details>
<summary>逐 run 明细（按模型分组，组内按 F1 降序）</summary>

| run | 模型 | P | R | F1 | family_pass | noise_pass |
| --- | --- | --- | --- | --- | --- | --- |
| ds41f-r3 | deepseek-v4.1-flash | 0.857 | 0.649 | 0.738 | 13/29 | 44/45 |
| ds41f-r2 | deepseek-v4.1-flash | 0.843 | 0.581 | 0.688 | 11/29 | 44/45 |
| ds41f-r1 | deepseek-v4.1-flash | 0.808 | 0.284 | 0.420 | 6/29 | 44/45 |
| glm53-r2 | GLM-5.3 | 0.923 | 0.486 | 0.637 | 11/29 | 45/45 |
| glm53-r3 | GLM-5.3 | 0.912 | 0.419 | 0.574 | 9/29 | 45/45 |
| glm53-r1 | GLM-5.3 | 0.795 | 0.419 | 0.549 | 9/29 | 44/45 |
| hungerg-r2 | HungerG | 0.840 | 0.568 | 0.677 | 12/29 | 44/45 |
| hungerg-r1 | HungerG | 0.884 | 0.514 | 0.650 | 13/29 | 44/45 |
| hungerg-r3 | HungerG | 0.857 | 0.486 | 0.621 | 10/29 | 44/45 |

</details>

## v5.1 消融（A 家族 / B any-hit）

`ablation.json`：九个非基线 run 在 A/B 下**逐题判定完全相同**（`policy_divergent_queries` 全为 0），`max ΔF1 = 0`，因此结论是 `insufficient_signal`，不是"归属可放宽"。原因：这些 run 的错法都是没建 / 建错 / 误 ban，没有"正例只被错误家族词条命中"的题——归属规则根本没咬到。要判断 A/B 的必要性，需要一个会跨家族乱挂 cid 的作答。

## 出题与复核

6 个出题子代理（5 组家族 + 1 组 45 条噪音负例）按 `authoring/writer-spec.md` 出题，1 个复核子代理独立机械校验 + 真 matcher 满分库模拟后交付。模型与 prompt 版本记录在 `manifest.json`。答辩侧红线：答题 agent 不可见 `queries.jsonl`、v4 金标、`benchmarks/` 其余内容与 `~/.meme`。

## Related work 与首创性说明

"agent 构建持久产物 → 隐藏查询做行为测试"的评测范式有各自的先例：SWE-bench 用隐藏单元测试验证 agent 产出的补丁，Commit0 用可交互单元测试验证 agent 产出的库；RegexGym 用隐藏 holdout 与突变式硬负例为单条正则打分，RegexCompBench 用示例与测试串打分；τ-bench/AppWorld 检查 agent 操作后数据库的终态并惩罚误伤；ACE 是其中最接近的过程先例：让"策展者"以增量操作维护上下文手册，并以隐藏任务上的下游成功率计分——其手册是 Generator 的上下文，本基准的库是 meme CLI 的上下文，两者都是对下游行为起主导作用的可策展内容，差别在 runtime（LLM vs CLI 匹配器）、产物形态（自然语言 vs 结构化规则）与策展信号（训练任务执行反馈、多轮迭代 vs 无反馈集、一次性策展）；YARA/Sigma/CheckerBench 等规则与检测器生成评规则质量而非策展过程；记忆类基准（LongMemEval、MemoryAgentBench）考写入与遗忘但以问答准确率计分。据我们所知，把**多家族模糊语义匹配库的 CLI 策展（含可逆 ban 与误 ban 惩罚）+ 对抗硬负例 + 200-400 条隐藏查询的 P/R/F1 行为测试 + 按家族与噪音候选分解的子任务归因**组合为一个 agent 基准，尚无先例——范式有渊源，组合无先例，措辞上不声称首创评测范式。
