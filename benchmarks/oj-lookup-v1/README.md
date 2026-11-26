# oj-lookup-v1（OJ 行为基准 v1）

OJ（online-judge 式行为测试）评的是**系统行为**：给定词条/matcher 与输入文本（含会话上下文），lookup 是否正确触发——TP/TN/FP/FN，而不是让模型写一段自由评测答案。这是主基准；`candidate-judgment-v4` 主要作为真值标签与候选判定历史参考。

## 构成

- `entries.jsonl`：26 个 fixture 词条，覆盖 word（词表）/ formula（骨架槽位）/ interaction（会话配对）/ conditional（forbid/require context 约束）四类。示例刻意避开 candidate-judgment-v4 金标同源梗。
- `cases.jsonl`：264 题（正例 138 / 负例 126），通道分布 phrase 158 / formula 67 / interaction 22 / conditional 17。负例全部可解释：同子串普通用法、forbid_inner 更长词内部、语法受限槽、字面义、缺上文/错上文、语境约束否决。interaction 通道存在"同回应句换 ctx"的最小对照对（正/负、缺/错上文），是有意设计。
- `build.ts`：fixture 源。改题目后运行 `npx tsx benchmarks/oj-lookup-v1/build.ts` 重新生成三个 JSON/JSONL 文件（manifest 带哈希）。
- `outputs/`、`report.json`、`judge-prompt*`：运行产物，不入 git。

## 运行与评分

```sh
npx tsx scripts/oj-run.ts                 # 系统基线：真实 lookup 管线（词表/骨架/交互，无向量）
npx tsx scripts/oj-judge-prompt.ts --chunks 4   # 生成模型作答 prompt（无期望）
npx tsx scripts/oj-score.ts               # 评分全部 outputs/<run>/output.jsonl
npx tsx scripts/oj-score.ts --format json --output benchmarks/oj-lookup-v1/report.json
```

模型作答与系统行共用同一 output schema（`{"case_id","hit","families"}`），同一评分器。

## 评分口径

- 正例命中目标家族且未踩 forbid 家族 → TP，否则 FN；
- 负例未踩 forbid 家族 → TN，踩了 → FP；
- 非目标/非 forbid 的命中记"额外无关命中"，不进主混淆矩阵；
- 报告 Overall + 四通道；公式组补替换成功率，conditional 组补上下文区分率；
- tag 含 `slot-literal-hard`/`literal` 的失分单独列出——这些是 matcher 已知硬负例（槽吞字面词，窗口约束管不到 span 内部），系统 FP 是真实暴露。

## v1 基线（matcher 行，2026-11-26）

准确率 95.1%（TP=135 FP=10 FN=3 TN=116）；phrase 98.1% / formula 85.1% / interaction 100% / conditional 100%。formula 的失分全部来自槽吞字面义的已知硬负例；词表层的 3 个 FN 来自单字梗胶水字表（的/住/实不在 GLUE 表）。
