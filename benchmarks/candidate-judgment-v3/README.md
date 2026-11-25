# candidate-judgment-v3（48 题整合版）

48 条真实候选的判定 benchmark，使用**移除旧 surf 参数后的当前运行时技能手册与判定指南**。v3 将原 24 题与 2026-11-25 联网 surf 第 22 轮筛出的 24 条补充题合并为 48 题，统一评分，不拆分组。

## 题目构成

- 前 24 条案例与金标保留，案例编号仍为 `cjv1-*`。
- 后 24 条案例编号为 `cjv3-025` 至 `cjv3-048`。
- v3 使用当前提示与判定指南，包含 hungerg-free 与 hy4-flash-free 两组重新运行的输出。
- 新增 24 题金标已经操作员复核确认；`cjv3-031「看到了」` 判为非梗，`cjv3-036「省流」` 判为梗，`cjv3-034「可以去」` 保留候选非梗但补出完整梗“去见拉瓦锡”。

## 首轮评分

| 模型 | 候选准确率 | Precision | Recall | F1 | 覆盖率 | 家族 F1 | 完整形准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hungerg-free | 88.9% | 100.0% | 64.3% | 78.3% | 93.8% | 75.0% | 65.2% |
| hy4-flash-free | 81.3% | 88.9% | 50.0% | 64.0% | 100.0% | 55.6% | 43.5% |

两模型候选判定一致率 81.3%。hungerg-free 精度更高，hy4-flash-free 覆盖更完整；公式梗的完整形识别仍是主要失分点。

## 本轮来源

- 联网 surf 第 22 轮：新增 30 个视频、3015 条评论。
- 补充题覆盖截断头、条件题、普通词负例、弱模板与日常话语格式。
- 金标只用于离线评估，禁止进入运行时。

## 评分

```sh
npx tsx scripts/benchmark-score.ts
npx tsx scripts/benchmark-score.ts --format json --output benchmarks/candidate-judgment-v3/report.json
npx vitest run tests/test-benchmark.test.ts
```
