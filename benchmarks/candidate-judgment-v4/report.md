# candidate-judgment-v4 评分报告

案例数：72；模型数：2。候选词头判断与家族/完整形识别分开计分。

| 模型 | 候选判定准确率 | Resolved 准确率 | Precision | Recall | F1 | 覆盖率 | 存疑 | conditional 命中 | 完整形准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HungerG | 75.7% | 77.1% | 100.0% | 48.4% | 65.2% | 97.2% | 2 | 1/4 | 43.9% |
| GLM-5.3 | 68.1% | 76.4% | 80.8% | 63.6% | 71.2% | 100.0% | 0 | 3/4 | 31.7% |

## 模型两两一致率

| 模型 A | 模型 B | 一致率 |
| --- | --- | --- |
| HungerG | GLM-5.3 | 73.6% |

## 逐题对照

| 案例 | 词头 | 金标候选 | 金标完整形 | HungerG | GLM-5.3 |
| --- | --- | --- | --- | --- | --- |
| cjv1-001 | 没绷住 | meme | 没绷住 | meme → 绷住 | meme → 绷不住了 |
| cjv1-002 | 绷住 | meme | 没绷住 | meme → 绷住 | meme → 绷不住了 |
| cjv1-003 | 神了 | meme | 神了 | meme → 神了 | not-meme |
| cjv1-004 | 神 | not-meme | 神了 | not-meme → 神了 | not-meme |
| cjv1-005 | <X>死了 | meme | 生死不明，那就是死了 | not-meme | not-meme |
| cjv1-006 | 死了 | meme | 生死不明，那就是死了 | not-meme | not-meme |
| cjv1-007 | 笑死 | meme | 笑死 | not-meme | meme → 笑死我了 |
| cjv1-008 | 鲸鲸 | meme | 鲸鲸 | conditional → 哦鲸鲸 | not-meme |
| cjv1-009 | 死我了 | not-meme | 笑死 | not-meme | meme → 笑死我了 |
| cjv1-010 | 豆姐 | meme | 豆姐 | not-meme | meme → 豆姐 |
| cjv1-011 | 牢师 | meme | 牢师 | not-meme | meme → 牢师 |
| cjv1-012 | 泡 | not-meme | — | not-meme | not-meme |
| cjv1-013 | 绷了 | meme | 没绷住 | meme → 绷住 | meme → 绷不住了 |
| cjv1-014 | 爆 | not-meme | 爆了 | not-meme → 爆了 | not-meme |
| cjv1-015 | 老师说 | not-meme | — | not-meme → 老师说过图片是没有声音的 | meme → 老师说过图片不能传播声音 |
| cjv1-016 | 一手 | not-meme | — | not-meme | not-meme |
| cjv1-017 | 绮 | not-meme | — | not-meme | not-meme |
| cjv1-018 | 家伙 | not-meme | — | not-meme | not-meme |
| cjv1-019 | nb | meme | nb | not-meme | not-meme |
| cjv1-020 | 股市 | conditional | 来股市 | not-meme | not-meme |
| cjv1-021 | 参与 | not-meme | — | not-meme | not-meme |
| cjv1-022 | 赢 | not-meme | — | not-meme | not-meme |
| cjv1-023 | 艺术 | not-meme | — | not-meme | not-meme |
| cjv1-024 | 你太 | not-meme | 没有吧，是你太性感了 | not-meme → 是你太性感了 | meme → 没有吧，你太性感了 |
| cjv3-025 | 真的可以 | not-meme | <X>你做人真的可以 | not-meme → bin哥你做人真的可以 | conditional → 陈泽斌你真的可以 |
| cjv3-026 | is | not-meme | <X>be like | not-meme → 我的英语水平 is be like | meme → is be like |
| cjv3-027 | 非凡 | conditional | 早上好，梁非凡 | not-meme → 早上好，梁非凡 | conditional → 梁非凡 |
| cjv3-028 | 如 | not-meme | 天不生<X>万古如长夜 | not-meme | not-meme |
| cjv3-029 | 人来 | conditional | <X>来 | conditional → 人来！ | conditional → 人来！✋😡🤚 |
| cjv3-030 | 难绷 | meme | 没绷住 | meme → 绷住 | meme → 绷不住了 |
| cjv3-031 | 看到了 | not-meme | — | not-meme | not-meme |
| cjv3-032 | cs | not-meme | — | not-meme | not-meme |
| cjv3-033 | 拿下 | not-meme | — | not-meme → 韭姐她爸也拿下 | not-meme |
| cjv3-034 | 可以去 | not-meme | 去见拉瓦锡 | not-meme → 直播展示神力 | not-meme |
| cjv3-035 | <X>冠军 | not-meme | — | not-meme → 你什么冠军 | not-meme |
| cjv3-036 | 省流 | meme | 省流 | meme → 省流 | meme → 省流 |
| cjv3-037 | 天使 | not-meme | — | not-meme | not-meme |
| cjv3-038 | 爱情 | not-meme | — | not-meme → 爱情使人插队，也使人偷伞 | not-meme |
| cjv3-039 | 神圣 | not-meme | — | not-meme | not-meme |
| cjv3-040 | 本来就是 | not-meme | — | not-meme | not-meme |
| cjv3-041 | 家族 | not-meme | — | not-meme | not-meme |
| cjv3-042 | 画风 | not-meme | — | not-meme | not-meme |
| cjv3-043 | 做出来 | not-meme | — | not-meme | not-meme |
| cjv3-044 | 改造 | not-meme | — | not-meme | not-meme |
| cjv3-045 | 玩法 | not-meme | — | not-meme | not-meme |
| cjv3-046 | 怎么样 | not-meme | — | not-meme | not-meme |
| cjv3-047 | 算不算 | not-meme | — | not-meme | not-meme |
| cjv3-048 | 太大 | not-meme | — | not-meme | not-meme |
| cjv4-049 | 可爱捏 | meme | 可爱捏 | meme → 可爱捏 | meme → 可爱捏 |
| cjv4-050 | 意气风发 | not-meme | 意气风发啊 | meme → 意气风发啊，<X> | meme → 意气风发啊，<X> |
| cjv4-051 | 破绷 | not-meme | 没绷住 | not-meme → 绷住 | meme → 绷不住了 |
| cjv4-052 | 不赖 | not-meme | — | not-meme | not-meme |
| cjv4-053 | 爆了 | meme | 爆了 | meme → 爆了 | conditional → 爆了 |
| cjv4-054 | 真求你了 | meme | 真求你了 | not-meme | not-meme |
| cjv4-055 | 牛大了 | meme | 牛大了 | not-meme | not-meme |
| cjv4-056 | 吓哭 | meme | 吓哭 | not-meme | not-meme |
| cjv4-057 | <X>没绷住 | not-meme | 没绷住 | meme → 绷住 | meme → 绷不住了 |
| cjv4-058 | <X>吓哭了 | not-meme | — | not-meme | not-meme |
| cjv4-059 | 好谢谢 | not-meme | — | not-meme | not-meme |
| cjv4-060 | <X>神了 | not-meme | 神了 | meme → 神了 | not-meme |
| cjv4-061 | <X>吓人 | not-meme | — | not-meme | not-meme |
| cjv4-062 | <X>好吗 | not-meme | 这好吗？这不好 | not-meme → 这好吗？这不好！ | conditional → 这好吗？这不好！ |
| cjv4-063 | <X>的耳朵 | not-meme | — | not-meme | not-meme |
| cjv4-064 | <X>不大 | not-meme | — | not-meme | not-meme |
| cjv4-065 | 破绷了 | meme | 没绷住 | meme → 绷住 | meme → 绷不住了 |
| cjv4-066 | 帅帅帅 | not-meme | — | not-meme | not-meme |
| cjv4-067 | 炸绷了 | meme | 没绷住 | meme → 绷住 | meme → 绷不住了 |
| cjv4-068 | 老霸道了 | meme | 老霸道了 | not-meme | not-meme |
| cjv4-069 | 问了吗 | meme | 问了吗 | abstain | not-meme |
| cjv4-070 | 豪庭 | conditional | 豪庭 | abstain | conditional → 豪庭 |
| cjv4-071 | 每日大学习 | not-meme | <X>大学习 | not-meme → 每日325大学习 | conditional → 每日325大学习 |
| cjv4-072 | 325 | meme | 325 | not-meme → 每日325大学习 | conditional → 每日325大学习 |
