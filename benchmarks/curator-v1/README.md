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

## 基线（2026-11-27，设计 §6 验收）

| run | P | R | F1 | family_pass | noise_pass |
| --- | --- | --- | --- | --- | --- |
| empty（空库） | 0 | 0 | 0 | 0/29 | 45/45 |
| perfect（金标满分库，30 词条） | 1.000 | 1.000 | 1.000 | 29/29 | 45/45 |

同库快照重跑逐字节一致（empty/perfect 均通过 `verify`）；两种计分口径在两个基线上结果一致（§8.4 自检）。

## 出题与复核

6 个出题子代理（5 组家族 + 1 组 45 条噪音负例）按 `authoring/writer-spec.md` 出题，1 个复核子代理独立机械校验 + 真 matcher 满分库模拟后交付。模型与 prompt 版本记录在 `manifest.json`。答辩侧红线：答题 agent 不可见 `queries.jsonl`、v4 金标、`benchmarks/` 其余内容与 `~/.meme`。
