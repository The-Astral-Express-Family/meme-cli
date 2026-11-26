# benchmark

这里保存真实候选、人工金标与模型输出的离线评估数据。金标只用于评估，不进入运行时。

## v5 策展题（`curator-v1`）——当前主基准，待实现

设计契约见 [`docs/benchmark-v5-curator.md`](../docs/benchmark-v5-curator.md)。一句话：**被测 agent 拿到 72 条候选，自己用 `meme add`/`meme ban` 建库，裁判再用隐藏查询集跑 `meme lookup` 记 TP/TN/FP/FN**。

红线：主分只能来自库的行为，不能来自 agent 的文字答案；查询集必须建立在 72 条的真实家族上，不得用无关 fixture。

## 现有两套遗产（v5 之前，评的是"判断"，不是"操作"）

- **candidate-judgment**：评 LLM 的语义判断——候选是不是梗、family/canonical 是什么。数据集 `candidate-judgment-v4`（72 题）；v5 复用其候选与金标。
- **oj-lookup**：评给定词条/matcher 的 lookup 行为（TP/TN/FP/FN）。其 26 条虚构家族与 72 条零交集，**仅作 matcher 单元行为参考，不进 v5 主分**。

## 原则

1. 案例与金标分开存放，模型只能读各自数据集的 prompt / cases。
2. prompt 是生成物（`scripts/bench-prompt.ts`），示例不得与金标同源；测试有泄漏扫描。
3. 上下文或题目发生变化时创建新版本，不覆盖当前版本。
4. `outputs/` 与 `report.json` 是运行产物不入 git；`report.md` 摘要可入库。
5. npm 发布包不含 `benchmarks/`。

## 命令

```sh
npx tsx scripts/benchmark-score.ts        # candidate-judgment 评分
npx tsx scripts/oj-score.ts               # OJ lookup 评分
npx vitest run tests/test-benchmark.test.ts
```
