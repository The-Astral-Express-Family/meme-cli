# oj-lookup-v1（OJ 行为基准 v1）

OJ（online-judge 式行为测试）评的是**系统行为**：给定词条/matcher 与输入文本（含会话上下文），lookup 是否正确触发——TP/TN/FP/FN，而不是让模型写一段自由评测答案。这是主基准；`candidate-judgment-v4` 主要作为真值标签与候选判定历史参考。

## 构成

- `entries.jsonl`：26 个 fixture 词条，覆盖 word（词表）/ formula（骨架槽位）/ interaction（会话配对）/ conditional（forbid/require context 约束）四类。示例刻意避开 candidate-judgment-v4 金标同源梗。
- `cases.jsonl`：264 题（正例 138 / 负例 126），通道分布 phrase 158 / formula 67 / interaction 22 / conditional 17。负例全部可解释：同子串普通用法、forbid_inner 更长词内部、语法受限槽、字面义、缺上文/错上文、语境约束否决。interaction 通道存在"同回应句换 ctx"的最小对照对（正/负、缺/错上文），是有意设计。
- `build.ts`：fixture 源。改题目后运行 `npx tsx benchmarks/oj-lookup-v1/build.ts` 重新生成三个 JSON/JSONL 文件（manifest 带哈希）。
- `outputs/`、`report.json`、`judge-prompt*`：运行产物，不入 git。

## 运行与评分

```sh
# ① 系统基线：数据集自带 fixture 词条 + 真实 lookup 管线
npx tsx scripts/oj-run.ts

# ② 评"某套词条/matcher 好不好用"：装外部 entries.jsonl，跑同一批用例
npx tsx scripts/oj-run.ts --entries path/to/generated-entries.jsonl --run-name glm-matcher

# ③ 判题 prompt（无期望）：让模型模拟 matcher 逐题判 hit（不是生成能力）
npx tsx scripts/oj-judge-prompt.ts --chunks 4

npx tsx scripts/oj-score.ts               # 评分全部 outputs/<run>/output.jsonl
npx tsx scripts/oj-score.ts --format json --output benchmarks/oj-lookup-v1/report.json
```

模型判题与系统行共用同一 output schema（`{"case_id","hit","families"}`），同一评分器。

**三种运行评的不是同一件事，报告里不要混着排名：**

| 运行方式 | 评什么 | 能得出的结论 |
| --- | --- | --- |
| `oj-run.ts`（fixture 词条） | 真实 matcher 在固定用例上的行为 | 系统能力基线、已知硬负例清单 |
| `oj-run.ts --entries <模型产物>` | 模型**写出的 matcher** 能否正确触发 | matcher 生成质量（OJ 的正题） |
| `oj-judge-prompt.ts` + 模型作答 | 模型**照规则判题**的准确率 | "用 LLM 当运行时判定器"的可行性，不是生成能力 |

## 评分口径

- 正例命中目标家族且未踩 forbid 家族 → TP，否则 FN；
- 负例未踩 forbid 家族 → TN，踩了 → FP；
- 非目标/非 forbid 的命中记"额外无关命中"，不进主混淆矩阵；
- **公式正例召回**：公式通道正例的命中率——即 `<X>` 替换后公式是否仍成立；按槽位标签
  （同类替换 / 跨域替换 / 多槽 / 多词 / 标点）分组报告，两种替换的失败含义不同；
- **同文异境成对**：同一句文本分别以"该命中"与"不该命中"的语境出现，两边都判对才算
  区分成功——这才是 conditional/交互通道要证明的能力，分组准确率本身不区分；
- tag 含 `slot-literal-hard`/`literal` 的失分单独列出——这些是 matcher 已知硬负例（槽吞
  字面词，窗口约束管不到 span 内部），系统 FP 是真实暴露。

## v1 基线（matcher 行，2026-11-26）

准确率 95.1%（TP=135 FP=10 FN=3 TN=116）；phrase 98.1% / formula 85.1% / interaction 100% / conditional 100%。

- 公式正例召回 100%（20/20 同类替换、9/9 跨域替换、10/10 多槽、2/2 多词）——公式通道的
  失分**全部在负例侧**：10 个 FP 都是字面义被槽吞进 span（"脚麻了""发动机启动了"），
  而非替换后不成立。这说明该通道的短板是精度，不是泛化。
- 词表层 3 个 FN 来自单字梗胶水字表（的/住/实不在 GLUE 表）。
- 同文异境成对 3 组全部通过（交互通道的有效上句 / 缺上文 / 错上文对照）。
