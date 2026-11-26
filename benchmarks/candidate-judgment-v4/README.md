# candidate-judgment-v4（72 题整合版）

v4 保留 v3 的 48 条真实候选与金标，新增 24 条来自 2026-11-26 联网 surf round 23–25 的候选，统一评分，不拆分组。v3 原目录保持不变。

## 题目构成

- 前 48 条案例与金标原样保留，编号仍为 cjv1-* / cjv3-*。
- 新增 24 条编号 cjv4-049 至 cjv4-072。
- 新增题通道：固定表达 8、公式模板 8、整句复读 8；补上 v3 没有的 copy 通道。
- 图梗暂不纳入：文本 benchmark 只能看到图片 URL/pHash，无法公平判断图义。
- 新增金标已经操作员复核；候选判定汇总：meme 4 / conditional 4 / not-meme 16。
- 金标只用于离线评估，禁止进入运行时。

## 本轮来源

- 联网 surf round 23–25：新增 83 个视频、10127 条评论。
- 每轮 qualified / triggered / demoted：r23 487/436/39；r24 701/415/200；r25 789/376/287。
- v4 暂不附带模型输出；评分报告明确为空，待重新运行模型后生成。

## 评分

```sh
npx tsx scripts/benchmark-score.ts
npx tsx scripts/benchmark-score.ts --format json --output benchmarks/candidate-judgment-v4/report.json
npx vitest run tests/test-benchmark.test.ts
```
