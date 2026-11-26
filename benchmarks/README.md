# benchmark

这里保存真实候选、人工金标与模型输出的离线评估数据。金标只用于评估，不进入运行时。

两套评分器，评的不是同一件事：

- **candidate-judgment**：评 LLM 的语义判断——候选是不是梗、family/canonical 是什么。当前数据集 `candidate-judgment-v4`（72 题）。
- **oj-lookup**：评系统行为——给定词条/matcher 与输入文本，lookup 是否正确触发（TP/TN/FP/FN）。见 `oj-lookup-v1/`。

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
