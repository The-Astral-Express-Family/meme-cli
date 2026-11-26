# 模型对照实验（2026-11-26）

本对照覆盖两套基准、两个作答方；opencode 侧模型（deepseek-v4.1-flash / hy4-flash-free 等）因凭证过期与免费额度耗尽暂缓，重跑命令见文末。

## 一、candidate-judgment-v4（72 题语义判定）

作答条件：sanitized prompt（2026-11-26，泄漏已清除，见数据集 README）；HungerG 首轮作答对应**泄题版 prompt**，其 family/canonical 分数直接受益于泄漏示例，**不用于排名**，仅留作对照。

| 模型 | 作答 prompt | 候选判定准确率 | Resolved 准确率 | Precision | Recall | F1 | 覆盖率 | 存疑 | conditional 命中 | 完整形准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HungerG | 泄题版（provisional） | 75.7% | 78.6% | 100.0% | 50.0% | 66.7% | 97.2% | 2 | 1/4 | 42.5% |
| GLM-5.3 | sanitized | 68.1% | 75.0% | 76.9% | 62.5% | 69.0% | 100.0% | 0 | 3/4 | 30.0% |

两模型 verdict 一致率 73.6%（53/72）。

**GLM-5.3 失败画像**（候选判错 23、完整形未中 12）：

- 完整形未中大多是**同家族不同形**：判出「绷不住了」而金标 accepted forms 只收到「绷不住」（无"了"）；「梁非凡」vs 金标「早上好，梁非凡」。家族识别是对的，完整形逐字对不上——这正是 scorer 把 candidate 判定与 family/canonical 分开计分的原因。
- 偏保守：神了/鲸鲸/nb/来股市等金标 meme 判成 not-meme（候选判定层 23 错中的约半数）。
- 偏激进：死我了/老师说/你太 等金标 not-meme 判成 meme。
- 与 HungerG（泄题版）相比：HungerG 的 canonical 优势（42.5% vs 30.0%）主要来自泄漏示例直接给了完整形，不能据此排名。

## 二、oj-lookup-v1（264 题行为判定）

同一套 264 题，系统行跑真实 lookup 管线（词表/骨架/交互，无向量），模型行按词条定义+输入判 hit。评分口径见数据集 README。

| 运行 | 准确率 | Precision | Recall | F1 | 额外命中 | 已知硬负例失分 | 公式替换成功率 | 上下文区分率 | phrase | formula | interaction | conditional |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matcher（系统基线） | 95.1% | 93.1% | 97.8% | 95.4% | 6 | 8 | 100.0% | 100.0% | 98.1% | 85.1% | 100.0% | 100.0% |
| GLM-5.3 | 99.2% | 100.0% | 98.6% | 99.3% | 6 | 0 | 97.6% | 100.0% | 99.4% | 98.5% | 100.0% | 100.0% |

- 系统行 10 个 FP 全部是公式通道的**已知硬负例**（槽吞字面义："脚麻了""发动机启动了"——槽内词被 ent 吞进 span，窗口约束管不到 span 内部），3 个 FN 来自单字梗胶水字表（的/住/实不在 GLUE 表，"真的典""硬控住了"漏报）。
- GLM-5.3 仅 2 失分，且都在可辩 case 上：oj-0020「销量遥遥领先的还是它」按字面叙述判不命中（出题方判命中）；oj-0221「看了一眼，鉴定为巧合」判不命中（出题方按标点桥接判命中）。
- **结论：语义判断上 GLM-5.3 明显强于当前规则 matcher**，尤其公式通道（98.5% vs 85.1%）；matcher 的价值在毫秒级本地执行与确定性，两者互补。已知硬负例是 matcher 层的真实改进方向（如槽位词性检查或语义守卫）。

## 三、待补行（opencode）

- deepseek-v4.1-flash、hy4-flash-free（用户指定）；原计划的 hungerg-free 已从 opencode 目录下架（全目录 240 个模型中不存在），经确认改用 opencode/glm-5.3-flash-free。
- 暂缓原因：本机 opencode OAuth 凭证 2026-11-21 过期、免费额度耗尽，任何模型调用需先重新授权。
- 重跑步骤：终端 `opencode auth login` 授权后，`npx tsx scripts/bench-prompt.ts --check` 确认 prompt 未漂移，模型读 `benchmarks/candidate-judgment-v4/prompt.md` 作答写入 `outputs/<模型名>/output.jsonl`（OJ 用 `scripts/oj-judge-prompt.ts --chunks 4`），再跑两个评分器即可并入本表。

## 四、复现

```sh
npx tsx scripts/benchmark-score.ts                                  # v4 评分
npx tsx scripts/oj-run.ts && npx tsx scripts/oj-score.ts            # OJ 系统行 + 评分
npx vitest run tests/test-benchmark.test.ts                         # 泄漏扫描 + scorer 数学
```
