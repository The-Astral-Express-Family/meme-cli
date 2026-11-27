# benchmark

这里保存真实候选、人工金标与模型输出的离线评估数据。金标只用于评估，不进入运行时。

## v5 策展题（`curator-v2`）——当前主基准

设计契约见 [`docs/benchmark-v5-curator.md`](../docs/benchmark-v5-curator.md)。一句话：**被测 agent 拿到候选，自己用 `meme add`/`meme ban` 建库，裁判再用隐藏查询集跑 `meme lookup` 记 TP/TN/FP/FN**。`curator-v2` 从 2026-11-27 三轮 surf 增量扩充为 82 条候选、13 个新家族、79 个噪音候选、249 条隐藏查询；空库与满分库已通过真实 CLI 验收，详见 [`curator-v2/README.md`](curator-v2/README.md)。

红线：主分只能来自库的行为，不能来自 agent 的文字答案；查询集只引用本版本种子候选与金标家族，不得用无关 fixture。题目变化创建新版本，不覆盖旧版；`curator-v1` 的 71 候选 / 29 家族 / 264 查询与九次模型成绩保留在 [`curator-v1/README.md`](curator-v1/README.md)。

## 金标源：candidate-judgment

- **candidate-judgment-v5**：本轮 surf 增量金标，82 条 case / 82 条 label / 13 家族 / 79 噪音候选；另有 3 条真实梗因单视频证据不足移出评分集（`excluded.json`）。
- **candidate-judgment-v4**：v1 的 72 题金标源，保留历史溯源。

## 原则

1. 案例与金标分开存放，答题 agent 只读各自 run 目录的 prompt / 候选，不可见查询集与金标。
2. 查询集与评分逻辑全部机械可校验（`scripts/curator-queries.ts check`）；出题与复核由独立子代理完成，模型记录在对应版本 `manifest.json`。
3. 上下文或题目发生变化时创建新版本，不覆盖当前版本。
4. run 产物（`curator-*/runs/`）与逐题大报告不入 git；摘要可入库。
5. npm 发布包不含 `benchmarks/`。

## 命令

```sh
export CURATOR_BENCH_ROOT=benchmarks/curator-v2
export CURATOR_GOLD_DIR=benchmarks/candidate-judgment-v5

npx tsx scripts/curator-queries.ts check   # 查询集机械校验（默认 v1；上述环境变量切换 v2）
npx tsx scripts/curator-run.ts init|judge|verify --run-id R
npx tsx scripts/curator-score.ts --run R   # 逐题 P/R/F1 + subtask + 消融入口
npx vitest run tests/test-curator.test.ts
```
