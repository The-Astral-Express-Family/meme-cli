# curator-v2 —— surf 增量策展题基准

`curator-v2` 是 `curator-v1` 的独立扩充版，不覆盖 v1 数据或模型成绩。新候选来自 2026-11-27 的 B站 surf round 26–28：84 个新视频、8,416 条新评论。金标源为 [`candidate-judgment-v5`](../candidate-judgment-v5/)。

被测 agent 拿到 82 条候选，用固定 wrapper 建库；裁判用 249 条隐藏查询逐条 `lookup`，沿用 v5 的家族归属、逐题 P/R/F1、`family_pass` 与 `noise_pass`。

## 数据

- 种子候选：82 行，无金标字段。
- 新家族：13 个。
- 噪音候选：79 个（`candidate_verdict=not-meme`；其中 30 个是“候选头为噪音、完整证据指向真梗家族”的截断候选）。
- 查询：249 条 = 13 家族 ×7（3 正 + 4 负）+ 79 噪音候选 ×2。
- 通道：phrase 240 / conditional 2 / interaction 7。

**排除在评分外**（[`excluded.json`](../candidate-judgment-v5/excluded.json)）：`豪猫`、`<X>节金曲`、`<X>我记下了` 三条经操作员判定是**真实梗但证据不足（暂缓/留观）**。它们既不进家族集也不进噪音集——标成 `not-meme` 会让正确识别它们的答题 agent 在 `noise_pass` 上被误扣，等于往金标里灌错标签。三条留在生产候选池，下一轮 surf 补足证据后再入版本。

## 目录

```
queries.jsonl       隐藏查询集（249 条）
manifest.json       哈希 / 来源 / 基线 / 出题记录
seed/candidates.jsonl   82 条白名单候选
agent-prompt.md     答题任务书
wrapper/            run wrapper 模板
runs/<id>/          run 产物（不入 git）
authoring/          出题片段与规格（不入 git）
```

## 命令

v2 通过环境变量切换路径，评分逻辑与 v1 共用：

```sh
export CURATOR_BENCH_ROOT=benchmarks/curator-v2
export CURATOR_GOLD_DIR=benchmarks/candidate-judgment-v5

npx tsx scripts/curator-seed.ts --export
npx tsx scripts/curator-queries.ts merge
npx tsx scripts/curator-queries.ts check
npx tsx scripts/curator-run.ts init --run-id R --model M
npx tsx scripts/curator-perfect.ts --run perfect
npx tsx scripts/curator-run.ts judge --run-id R --finish-reason X
npx tsx scripts/curator-run.ts verify --run-id R
npx tsx scripts/curator-score.ts --run R
```

PowerShell 用 `$env:CURATOR_BENCH_ROOT=...` / `$env:CURATOR_GOLD_DIR=...`。

## 13 个新家族

| family | canonical |
|---|---|
| lei-ting-da-si-kao | 雷霆大思考 |
| yi-yan-su-x | 已严肃\<X\> |
| li-jie-le | 力竭了 |
| zhen-na-ni-mei-ban | 真拿你没办法，坐好喽 |
| zhen-jing-tan-zuo | 震惊瘫坐 |
| wen-wen-de-jie-zhu-ni | 稳稳地接住你 |
| xian-guo-x-zai-tan-wei-lai | 先过\<X\>，再谈未来 |
| ai-da-ren-fu-huo | AI大人，请把我复活吧 |
| niko-shi-jie-xian | Niko到底把我们带到了哪条世界线 |
| ji-qi-ji-qi-ji-qi | 极其极其极其 |
| shuan | 好栓 |
| bu-fei-sheng | 不飞\<省份\> |
| ha-ji-mi-da-jia-zu | 哈基米大家族 |

“意气风发啊 / 没绷住 / 没有吧你太X / belike”已在 v1 有对应家族，本轮不重复新增。

## 操作员修正

- A8 只收“坐好喽 / 坐好了 / 听好了”；“做好喽”是错字。
- A10 只收“稳稳地接住你”。
- A12“豪猫”是“好猫”的变体，暂缓——移出评分集。
- “讲解石”是蒋介石名称谐音的一次性玩笑，标 `not-meme`。
- “前面的区域以后再来探索吧”是已知真实原神梗，但本轮 surf 只拿到一次性改写的“前面的区域请重新投胎后再探索吧”，按本轮证据标 `not-meme` 留观原梗。
- “<X>节金曲”“<X>我记下了”是真实梗但仅单视频源，留观——移出评分集。

## 基线

| run | P | R | F1 | family_pass | noise_pass |
|---|---:|---:|---:|---:|---:|
| empty | 0 | 0 | 0 | 0/13 | 79/79 |
| perfect | 1.000 | 1.000 | 1.000 | 13/13 | 79/79 |

满分库 13 个词条全部经 wrapper 真实 `add`，backtest 全通过；空库/满分库的同库快照重跑均逐字节一致。v2 尚未运行新的被测模型，v1 的九次模型 run 成绩保留在 [`curator-v1/README.md`](../curator-v1/README.md)。
