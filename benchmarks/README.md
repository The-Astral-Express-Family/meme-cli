# benchmark

这里保存真实候选、人工金标与模型输出的离线评估数据。金标只用于评估，不进入运行时。

## v5 策展题（`curator-v1`）——当前主基准

设计契约见 [`docs/benchmark-v5-curator.md`](../docs/benchmark-v5-curator.md)。一句话：**被测 agent 拿到候选，自己用 `meme add`/`meme ban` 建库，裁判再用隐藏查询集跑 `meme lookup` 记 TP/TN/FP/FN**。已实现并完成基线验收（空库 family_pass 0/29、满分库 29/29 + 45/45），详见 [`curator-v1/README.md`](curator-v1/README.md)。

红线：主分只能来自库的行为，不能来自 agent 的文字答案；查询集只引用这 72 条候选与 29 个金标家族，不得用无关 fixture。

## 遗产：candidate-judgment（v5 之前，评的是"判断"，不是"操作"）

- **candidate-judgment**：评 LLM 的语义判断——候选是不是梗、family/canonical 是什么。数据集 `candidate-judgment-v4`（72 题）；v5 复用其候选与金标（`labels.jsonl` 是 curator-v1 的评测专用金标源）。

## 原则

1. 案例与金标分开存放，答题 agent 只读各自 run 目录的 prompt / 候选，不可见查询集与金标。
2. 查询集与评分逻辑全部机械可校验（`scripts/curator-queries.ts check`）；出题与复核由独立子代理完成，模型记录在 `curator-v1/manifest.json`。
3. 上下文或题目发生变化时创建新版本，不覆盖当前版本。
4. run 产物（`curator-v1/runs/`）与逐题大报告不入 git；摘要可入库。
5. npm 发布包不含 `benchmarks/`。

## 命令

```sh
npx tsx scripts/curator-queries.ts check   # 查询集机械校验
npx tsx scripts/curator-run.ts init|judge|verify --run-id R
npx tsx scripts/curator-score.ts --run R   # 逐题 P/R/F1 + subtask + 消融入口
npx vitest run tests/test-curator.test.ts
```
