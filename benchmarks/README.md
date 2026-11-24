# 候选判定 benchmark

这里保存“同一批真实候选、同一套人工金标、不同上下文/模型”的离线评估数据。金标只用于评估，不进入运行时。

| 版本 | 用途 | 上下文 | 输出 |
| --- | --- | --- | --- |
| `candidate-judgment-v1` | 历史对照组 | 四组模型实验当时的原始上下文 | GLM-5.4 / GLM-5.3-Flash / GLM-5.3 / HungerG 四组历史输出 |
| `candidate-judgment-v2` | 修复后上下文组 | 修复后的运行时技能手册与判定指南（移除 `surf` 旧参数前的快照） | 必须重新运行模型，不沿用 v1 输出 |

## 原则

1. 新版本追加，不覆盖旧版本；否则历史分数失去意义。
2. 案例与金标分开存放，模型只能读 `prompt.md` / `cases.jsonl`。
3. 上下文变化必须升版本；v1 的旧问题不会被悄悄带进 v2。
4. 评分区分“候选词头是否是梗”和“家族/完整形是否补对”。
5. npm 发布包不含 `benchmarks/`。

## 命令

```sh
# 当前版本（v2）
npx tsx scripts/benchmark-score.ts

# 指定历史版本
npx tsx scripts/benchmark-score.ts --dataset benchmarks/candidate-judgment-v1

# 测试
npx vitest run tests/test-benchmark.test.ts
```
