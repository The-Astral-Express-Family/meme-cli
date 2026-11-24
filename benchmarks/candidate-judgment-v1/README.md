# candidate-judgment-v1（历史对照组）

24 条真实候选的判定 benchmark。用于比较不同操作 agent 在**同一份旧上下文材料、同一个候选快照**上的判定能力；不是运行时词表。

> 注意：本版本保留四组模型实验当时的原始上下文，其中包含后来已修复的问题（例如“泛用词永不触发”的错误说法）。它代表历史基线，不代表当前部署形态。当前系统请使用 `candidate-judgment-v2`。

## 文件

| 文件 | 给谁看 | 内容 |
| --- | --- | --- |
| `prompt.md` | 模型 | 四组历史实验使用的完整上下文包（技能手册、判定指南、榜单、24 条证据、执行边界） |
| `cases.jsonl` | 模型/评分器 | 24 条模型可见案例；含词头、通道、传播量、来源视频、用例证据 |
| `labels.jsonl` | **仅评分器/操作员** | 人工金标；绝不能喂给被测模型，也不能进入 `src/` |
| `manifest.json` | 评分器 | 数据集版本、案例数、来源快照哈希、文件哈希 |
| `outputs/<run>/output.jsonl` | 评分器 | 模型输出的严格 JSON 契约 |
| `outputs/<run>/report.md` | 操作员 | 对应模型的原始人读报告 |
| `outputs/<run>/meta.json` | 评分器 | 模型名、运行顺序、耗时/token/工具调用数（能捕获到的部分） |
| `report.md` / `report.json` | 操作员 | 离线评分汇总 |

## 金标口径

评分分两层，不能混算：

1. **候选词头判断**：这个抽取出的词头本身是否足以立为梗。
   - 例：`爆` 是截断头，候选级 = `not-meme`；`神`、`死我了` 是宿主/日常补语，候选级 = `not-meme`。
2. **家族与完整形**：这些证据属于哪个梗、完整形是什么。
   - 例：`爆` 的证据家族 = `baole`，完整形 = `爆了`；拒绝 `爆` 不会自动获得“识别了爆了”的分。

条件题单独记录 `candidate_verdict: conditional` 与 `resolved_verdict`。本题快照中 `股市` 满足“来古士/浪漫古士”谐音语境，所以 `resolved_verdict: meme`；普通炒股讨论仍不算。

## 输出契约

每个 `output.jsonl` 必须恰好 24 行，每行：

```json
{
  "case_id": "cjv1-001",
  "source_cid": "c_58951",
  "head": "没绷住",
  "verdict": "meme",
  "family_id": "beng",
  "canonical_head": "没绷住",
  "confidence": "high",
  "rationale": "跨视频独立复读与化用明确",
  "evidence_ids": ["cjv1-001:e1"]
}
```

- `verdict`: `meme | not-meme | conditional | abstain`
- `family_id` / `canonical_head`: 可为 `null`
- `confidence`: `high | medium | low | null`
- `evidence_ids`: 必须引用该案例 `cases.jsonl` 中存在的 `evidence_id`

## 评分

```sh
npx tsx scripts/benchmark-score.ts
npx tsx scripts/benchmark-score.ts --format json --output benchmarks/candidate-judgment-v1/report.json
npx vitest run tests/test-benchmark.test.ts
```

评分器会校验 manifest 哈希、案例/金标数量、重复或缺失案例、非法证据引用；任何无效输出直接报错，不会静默给分。

## 扩充题库

后续每轮 surf 后，把新通过触发门的候选按同样字段追加为新版本数据集（不要覆盖 v1）。金标仍由操作员判定；模型可见案例与金标必须分文件存放。`package.json` 的 `files` 白名单不含 `benchmarks/`，因此金标不会随 npm 包发布。
