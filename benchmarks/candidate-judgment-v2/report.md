# candidate-judgment-v2 评分报告

案例数：24；模型数：1。候选词头判断与家族/完整形识别分开计分。

| 模型 | 候选准确率 | Precision | Recall | F1 | 覆盖率 | 存疑 | 家族 F1 | 完整形准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HungerG | 68.2% | 100.0% | 36.4% | 53.3% | 91.7% | 2 | 52.2% | 40.0% |

## 模型两两一致率

| 模型 A | 模型 B | 一致率 |
| --- | --- | --- |

## 逐题对照

| 案例 | 词头 | 金标候选 | 金标完整形 | HungerG |
| --- | --- | --- | --- | --- |
| cjv1-001 | 没绷住 | meme | 没绷住 | meme → 没绷住 |
| cjv1-002 | 绷住 | meme | 没绷住 | meme → 没绷住 |
| cjv1-003 | 神了 | meme | 神了 | meme → 神了 |
| cjv1-004 | 神 | not-meme | 神了 | conditional → 神了 |
| cjv1-005 | <X>死了 | meme | 生死不明，那就是死了 | not-meme |
| cjv1-006 | 死了 | meme | 生死不明，那就是死了 | not-meme |
| cjv1-007 | 笑死 | meme | 笑死 | not-meme |
| cjv1-008 | 鲸鲸 | meme | 鲸鲸 | not-meme |
| cjv1-009 | 死我了 | not-meme | 笑死 | not-meme |
| cjv1-010 | 豆姐 | meme | 豆姐 | not-meme |
| cjv1-011 | 牢师 | meme | 牢师 | not-meme |
| cjv1-012 | 泡 | not-meme | — | not-meme |
| cjv1-013 | 绷了 | meme | 没绷住 | meme → 没绷住 |
| cjv1-014 | 爆 | not-meme | 爆了 | conditional → 爆了 |
| cjv1-015 | 老师说 | not-meme | — | conditional → 老师说过图片是没有声音的 |
| cjv1-016 | 一手 | not-meme | — | not-meme |
| cjv1-017 | 绮 | not-meme | — | not-meme |
| cjv1-018 | 家伙 | not-meme | — | not-meme |
| cjv1-019 | nb | meme | nb | not-meme |
| cjv1-020 | 股市 | conditional | 来股市 | abstain |
| cjv1-021 | 参与 | not-meme | — | not-meme |
| cjv1-022 | 赢 | not-meme | — | not-meme |
| cjv1-023 | 艺术 | not-meme | — | abstain |
| cjv1-024 | 你太 | not-meme | — | conditional → 是你太性感了 |
