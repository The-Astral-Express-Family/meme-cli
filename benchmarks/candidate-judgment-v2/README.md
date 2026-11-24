# candidate-judgment-v2（当前系统上下文）

24 条真实候选的判定 benchmark，使用**修复后的运行时技能手册与判定指南**。v2 冻结的是移除 `surf` 旧参数前的上下文快照；后续命令面清理不会追溯修改本题，也不会改写已有模型输出。

## 与 v1 的关系

- `cases.jsonl`、`labels.jsonl` 与 v1 逐字节一致：同一批题、同一套金标。
- `prompt.md` 已替换为当前修复后的上下文：修正了“泛用词永不触发”等错误说法，加入只读 `check`、精确 `ban/allow`、自动回落、回测去污染、aliases 契约等内容。
- v1 的四组历史输出**没有复制**到 v2；v2 分数只能来自重新运行的模型。
- `prompt.md` 受 manifest 哈希锁定，保留当时的完整上下文（包括旧 `surf` 参数说明）；当前运行手册与 `docs/meme-judgment-guide.md` 已移除这些参数。

## 文件

| 文件 | 给谁看 | 内容 |
| --- | --- | --- |
| `prompt.md` | 模型 | 当前修复后的完整上下文与 24 条案例 |
| `cases.jsonl` | 模型/评分器 | 模型可见案例 |
| `labels.jsonl` | **仅评分器/操作员** | 人工金标，禁止喂给模型 |
| `manifest.json` | 评分器 | 版本、来源、文件哈希 |
| `outputs/<run>/output.jsonl` | 评分器 | 模型输出的严格 JSON 契约 |
| `outputs/<run>/meta.json` | 评分器 | 运行元数据 |
| `report.md` / `report.json` | 操作员 | 离线评分汇总 |

## 首轮结果（当前会话模型）

| 上下文 | 候选准确率 | Precision | Recall | F1 | 覆盖率 | 家族 F1 | 完整形准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1 旧上下文 | 56.5% | 55.6% | 45.5% | 50.0% | 95.8% | 58.3% | 46.7% |
| v2 修复后上下文 | **68.2%** | **100.0%** | 36.4% | **53.3%** | 91.7% | 52.2% | 40.0% |

解读：修复后上下文显著减少误报（Precision 100%），但更保守，漏报增加；文化知识缺口仍明显（笑死、nb、豆姐、牢师、鲸鲸、“生死不明那就是死了”仍被漏判）。v2 不代表问题已全部解决，只代表现在测的是修复后的真实部署上下文。

## 评分

```sh
npx tsx scripts/benchmark-score.ts
npx tsx scripts/benchmark-score.ts --format json --output benchmarks/candidate-judgment-v2/report.json
npx vitest run tests/test-benchmark.test.ts
```

历史对照组仍可单独评分：

```sh
npx tsx scripts/benchmark-score.ts --dataset benchmarks/candidate-judgment-v1
```

## 金标口径

候选词头判断与家族/完整形识别分开计分。截断头本身可以不是梗，但证据仍可能属于完整梗；拒绝截断头不会自动获得完整形分。条件题按快照中的实际语境解析。
