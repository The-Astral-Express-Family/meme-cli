# candidate-judgment-v1 评分报告

案例数：24；模型数：4。候选词头判断与家族/完整形识别分开计分。

| 模型 | 候选准确率 | Precision | Recall | F1 | 覆盖率 | 存疑 | 家族 F1 | 完整形准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GLM-5.4 | 62.5% | 66.7% | 50.0% | 57.1% | 100.0% | 0 | 66.7% | 53.3% |
| GLM-5.3-Flash | 68.2% | 70.0% | 63.6% | 66.7% | 91.7% | 2 | 72.0% | 60.0% |
| GLM-5.3 | 69.6% | 66.7% | 72.7% | 69.6% | 95.8% | 1 | 74.1% | 66.7% |
| HungerG | 56.5% | 55.6% | 45.5% | 50.0% | 95.8% | 1 | 58.3% | 46.7% |

## 模型两两一致率

| 模型 A | 模型 B | 一致率 |
| --- | --- | --- |
| GLM-5.4 | GLM-5.3-Flash | 87.5% |
| GLM-5.4 | GLM-5.3 | 83.3% |
| GLM-5.4 | HungerG | 87.5% |
| GLM-5.3-Flash | GLM-5.3 | 83.3% |
| GLM-5.3-Flash | HungerG | 87.5% |
| GLM-5.3 | HungerG | 79.2% |

## 逐题对照

| 案例 | 词头 | 金标候选 | 金标完整形 | GLM-5.4 | GLM-5.3-Flash | GLM-5.3 | HungerG |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cjv1-001 | 没绷住 | meme | 没绷住 | meme → 没绷住 | meme → 没绷住 | meme → 没绷住 | meme → 没绷住 |
| cjv1-002 | 绷住 | meme | 没绷住 | meme → 没绷住 | meme → 没绷住 | meme → 没绷住 | meme → 没绷住 |
| cjv1-003 | 神了 | meme | 神了 | meme → 神了 | meme → 神了 | meme → 神了 | meme → 神了 |
| cjv1-004 | 神 | not-meme | 神了 | meme → 神了 | meme → 神了 | meme → 神了 | meme → 神了 |
| cjv1-005 | <X>死了 | meme | 生死不明，那就是死了 | not-meme | not-meme | not-meme | not-meme |
| cjv1-006 | 死了 | meme | 生死不明，那就是死了 | not-meme | not-meme | not-meme | not-meme |
| cjv1-007 | 笑死 | meme | 笑死 | meme → 笑死 | meme → 笑死 | meme → 笑死 | meme → 笑死 |
| cjv1-008 | 鲸鲸 | meme | 鲸鲸 | not-meme | not-meme | abstain | not-meme |
| cjv1-009 | 死我了 | not-meme | 笑死 | meme → 笑死 | meme → 笑死 | meme → 笑死 | meme → 笑死 |
| cjv1-010 | 豆姐 | meme | 豆姐 | not-meme | not-meme | meme → 豆姐 | not-meme |
| cjv1-011 | 牢师 | meme | 牢师 | not-meme | meme → 牢师 | meme → 牢师 | not-meme |
| cjv1-012 | 泡 | not-meme | — | not-meme | not-meme | not-meme | not-meme |
| cjv1-013 | 绷了 | meme | 没绷住 | meme → 没绷住 | meme → 没绷住 | meme → 没绷住 | meme → 没绷住 |
| cjv1-014 | 爆 | not-meme | 爆了 | not-meme | not-meme | not-meme | not-meme |
| cjv1-015 | 老师说 | not-meme | — | meme → 老师说过图片是没有声音的 | meme → 老师说过图片不能传播声音 | meme → 老师说过图片是没有声音的 | meme → 老师说过图片是没有声音的 |
| cjv1-016 | 一手 | not-meme | — | not-meme | not-meme | not-meme | not-meme |
| cjv1-017 | 绮 | not-meme | — | not-meme | not-meme | not-meme | not-meme |
| cjv1-018 | 家伙 | not-meme | — | not-meme | not-meme | not-meme | not-meme |
| cjv1-019 | nb | meme | nb | meme → nb | meme → nb | meme → nb | not-meme |
| cjv1-020 | 股市 | conditional | 来股市 | not-meme | abstain | not-meme | abstain |
| cjv1-021 | 参与 | not-meme | — | not-meme | not-meme | not-meme | not-meme |
| cjv1-022 | 赢 | not-meme | — | not-meme | not-meme | not-meme | not-meme |
| cjv1-023 | 艺术 | not-meme | — | not-meme | not-meme | not-meme | not-meme |
| cjv1-024 | 你太 | not-meme | — | not-meme | abstain | meme → 没有吧，你太性感了 | meme → 没有吧，是你太性感了 |
