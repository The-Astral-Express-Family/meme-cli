# candidate-judgment-v4（72 题整合版）

v4 保留原 v3 的 48 条真实候选与金标，新增 24 条来自 2026-11-26 联网 surf round 23–25 的候选，统一评分，不拆分组。v3 旧目录已按操作员确认删除，v4 是唯一当前数据集。

## prompt 版本

- **2026-11-26 sanitized（当前）**：`prompt.md` 由 `scripts/bench-prompt.ts` 生成（§2 = src/index.ts MANUAL，§3 = docs/meme-judgment-guide.md，§4 = cases 渲染）；§0–§3 原先与金标同源的示例（爆了/神了/没绷住家族等）已替换为非基准梗，测试带精确词泄漏扫描。
- **HungerG 首轮作答（provisional）**：对应泄题版 prompt，conditional/family 指标失真，不用于模型排名；`outputs/HungerG/` 仅留作对照。模型排名以 sanitized prompt 上的作答为准。

## 题目构成

- 前 48 条案例与金标原样保留，编号仍为 cjv1-* / cjv3-*。
- 新增 24 条编号 cjv4-049 至 cjv4-072。
- 新增题通道：固定表达 8、公式模板 8、整句复读 8；补上 v3 没有的 copy 通道。
- 图梗暂不纳入：文本 benchmark 只能看到图片 URL/pHash，无法公平判断图义。
- 新增金标已经操作员最终确认；候选判定汇总：meme 10 / conditional 1 / not-meme 13。争议项不纳入评分。
- 每日大学习拆为两题：模板家族 <X>大学习（由青年大学习演变）与事件梗 325；后者在 cases 中标记 derived_from_head。
- 金标只用于离线评估，禁止进入运行时。

## 本轮来源

- 联网 surf round 23–25：新增 83 个视频、10127 条评论。
- 每轮 qualified / triggered / demoted：r23 487/436/39；r24 701/415/200；r25 789/376/287。

## 评分

```sh
npx tsx scripts/benchmark-score.ts
npx tsx scripts/benchmark-score.ts --format json --output benchmarks/candidate-judgment-v4/report.json
npx tsx scripts/bench-prompt.ts --check   # prompt 与生成器一致性
npx vitest run tests/test-benchmark.test.ts
```

`outputs/<run>/` 与 `report.json` 是运行产物，不入 git（见 .gitignore）；`report.md` 摘要可入库。
