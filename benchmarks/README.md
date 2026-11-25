# 候选判定 benchmark

这里保存真实候选、人工金标与模型输出的离线评估数据。金标只用于评估，不进入运行时。

当前只保留 `candidate-judgment-v3`：48 题整合版，包含 hungerg-free 与 hy4-flash-free 两组输出。

## 原则

1. 案例与金标分开存放，模型只能读 `prompt.md` / `cases.jsonl`。
2. 评分区分“候选词头是否是梗”和“家族/完整形是否补对”。
3. 上下文或题目发生变化时创建新版本，不覆盖当前版本。
4. npm 发布包不含 `benchmarks/`。

## 命令

```sh
npx tsx scripts/benchmark-score.ts
npx tsx scripts/benchmark-score.ts --format json --output benchmarks/candidate-judgment-v3/report.json
npx vitest run tests/test-benchmark.test.ts
```
