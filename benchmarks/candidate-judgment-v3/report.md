# candidate-judgment-v3 评分报告

案例数：48；模型数：2。候选词头判断与家族/完整形识别分开计分。

| 模型 | 候选准确率 | Precision | Recall | F1 | 覆盖率 | 存疑 | 家族 F1 | 完整形准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hungerg-free | 88.9% | 100.0% | 64.3% | 78.3% | 93.8% | 3 | 75.0% | 65.2% |
| hy4-flash-free | 81.3% | 88.9% | 50.0% | 64.0% | 100.0% | 0 | 55.6% | 43.5% |

## 模型两两一致率

| 模型 A | 模型 B | 一致率 |
| --- | --- | --- |
| hungerg-free | hy4-flash-free | 81.3% |

## 逐题对照

| 案例 | 词头 | 金标候选 | 金标完整形 | hungerg-free | hy4-flash-free |
| --- | --- | --- | --- | --- | --- |
| cjv1-001 | 没绷住 | meme | 没绷住 | meme → 没绷住 | meme → 没绷住 |
| cjv1-002 | 绷住 | meme | 没绷住 | meme → 没绷住 | meme → 没绷住 |
| cjv1-003 | 神了 | meme | 神了 | meme → 神了 | meme → 神了 |
| cjv1-004 | 神 | not-meme | 神了 | not-meme → 神了 | not-meme |
| cjv1-005 | <X>死了 | meme | 生死不明，那就是死了 | not-meme | not-meme |
| cjv1-006 | 死了 | meme | 生死不明，那就是死了 | not-meme | not-meme |
| cjv1-007 | 笑死 | meme | 笑死 | meme → 笑死我了 | not-meme |
| cjv1-008 | 鲸鲸 | meme | 鲸鲸 | abstain | not-meme |
| cjv1-009 | 死我了 | not-meme | 笑死 | not-meme → 笑死我了 | not-meme |
| cjv1-010 | 豆姐 | meme | 豆姐 | abstain | not-meme |
| cjv1-011 | 牢师 | meme | 牢师 | meme → 牢师 | meme → 牢师 |
| cjv1-012 | 泡 | not-meme | — | not-meme | not-meme |
| cjv1-013 | 绷了 | meme | 没绷住 | meme → 没绷住 | meme → 没绷住 |
| cjv1-014 | 爆 | not-meme | 爆了 | not-meme → 爆了 | conditional → 爆了 |
| cjv1-015 | 老师说 | not-meme | — | not-meme → 老师说过图片是没有声音的 | meme → 老师说过 |
| cjv1-016 | 一手 | not-meme | — | not-meme | not-meme |
| cjv1-017 | 绮 | not-meme | — | not-meme | not-meme |
| cjv1-018 | 家伙 | not-meme | — | not-meme | not-meme |
| cjv1-019 | nb | meme | nb | not-meme | not-meme |
| cjv1-020 | 股市 | conditional | 来股市 | not-meme | not-meme |
| cjv1-021 | 参与 | not-meme | — | not-meme | not-meme |
| cjv1-022 | 赢 | not-meme | — | not-meme | not-meme |
| cjv1-023 | 艺术 | not-meme | — | not-meme | not-meme |
| cjv1-024 | 你太 | not-meme | — | not-meme → 是你太性感了 | conditional → 你太性感了 |
| cjv3-025 | 真的可以 | not-meme | <X>你做人真的可以 | not-meme → 陈泽斌你真的可以 | not-meme |
| cjv3-026 | is | not-meme | <X>be like | not-meme → 我的英语水平is be like | conditional → is be like |
| cjv3-027 | 非凡 | conditional | 早上好，梁非凡 | not-meme | conditional → 非凡之爱 |
| cjv3-028 | 如 | not-meme | 天不生<X>万古如长夜 | not-meme | not-meme |
| cjv3-029 | 人来 | conditional | <X>来 | meme → 人来 | meme → 人来 |
| cjv3-030 | 难绷 | meme | 没绷住 | meme → 没绷住 | meme → 没绷住 |
| cjv3-031 | 看到了 | not-meme | — | not-meme | not-meme |
| cjv3-032 | cs | not-meme | — | not-meme | not-meme |
| cjv3-033 | 拿下 | not-meme | — | not-meme | not-meme |
| cjv3-034 | 可以去 | not-meme | 去见拉瓦锡 | not-meme → 可以去见拉瓦锡 | not-meme |
| cjv3-035 | <X>冠军 | not-meme | — | not-meme | not-meme |
| cjv3-036 | 省流 | meme | 省流 | meme → 省流 | meme → 省流 |
| cjv3-037 | 天使 | not-meme | — | not-meme | not-meme |
| cjv3-038 | 爱情 | not-meme | — | not-meme | not-meme |
| cjv3-039 | 神圣 | not-meme | — | abstain | not-meme |
| cjv3-040 | 本来就是 | not-meme | — | not-meme | not-meme |
| cjv3-041 | 家族 | not-meme | — | not-meme | not-meme |
| cjv3-042 | 画风 | not-meme | — | not-meme | not-meme |
| cjv3-043 | 做出来 | not-meme | — | not-meme | not-meme |
| cjv3-044 | 改造 | not-meme | — | not-meme | not-meme |
| cjv3-045 | 玩法 | not-meme | — | not-meme | not-meme |
| cjv3-046 | 怎么样 | not-meme | — | not-meme | not-meme |
| cjv3-047 | 算不算 | not-meme | — | not-meme | not-meme |
| cjv3-048 | 太大 | not-meme | — | not-meme | not-meme |
