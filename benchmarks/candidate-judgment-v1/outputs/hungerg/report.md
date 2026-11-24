# 逐条判定表

判定汇总：收录 5、归并 4、拒绝 13、拒绝并封禁 1、存疑 1；入库 5 个词条。最终实验库仅保留存疑候选 c_57249。

| cid | 词头 | 判定 | 理由 | 把握 | 依据 |
| --- | --- | --- | --- | --- | --- |
| c_58951 | 没绷住 | 收录 | 跨视频独立复读，且“破绷了/炸绷了”等变体明确，是忍不住笑的玩梗表达。 | 高 | 手册点名、用例证据 |
| c_53586 | 绷住 | 归并 | 与“没绷住”同指忍不住笑，证据含“没绷住/绷不住了”，并入 m_0004。 | 高 | 手册点名、用例证据 |
| c_55174 | 神了 | 收录 | 用例反复表达震惊、无奈或哭笑不得，不是普通客观夸赞，按手册主判据收录。 | 高 | 手册点名、用例证据 |
| c_53690 | 神 | 归并 | 单字“神”多为专名或“神了”截断；并入 m_0005，matcher 不匹配裸“神”。 | 高 | 手册点名、用例证据 |
| c_53433 | <X>死了 | 拒绝 | 样本混有真实死亡与“笑死了”，槽位未形成可复用公式，属语法模板误抽。 | 高 | 用例证据 |
| c_52622 | 死了 | 拒绝 | 用例多为字面死亡或“笑死了”内部片段，无独立新用法，不封禁。 | 高 | 用例证据 |
| c_52954 | 笑死 | 收录 | 跨视频固定表达与变体丰富，语义是被逗笑，手册亦将其列为可积累真梗。 | 高 | 手册点名、用例证据 |
| c_55390 | 鲸鲸 | 拒绝 | 用例均在称呼特定鱼角色或博主，是话题名而非可复用玩梗结构。 | 高 | 用例证据 |
| c_53595 | 死我了 | 归并 | 全部用例实为“笑死我了”的截断，归并 m_0006，不收录裸“死我了”。 | 高 | 手册点名、用例证据 |
| c_59058 | 豆姐 | 拒绝 | 用例围绕同一 AI 角色昵称展开，无公式、化用或独立事件含义。 | 高 | 用例证据 |
| c_52303 | 牢师 | 拒绝 | 是角色昵称，用例多在评价该角色，属于话题词而非梗。 | 高 | 用例证据 |
| c_57365 | 泡 | 拒绝 | 仅见“多泡一会儿/茶包泡20包”的字面用法，是普通动词误抽。 | 高 | 用例证据 |
| c_53396 | 绷了 | 归并 | “破绷了/炸绷了”与“没绷住”同族，并入 m_0004。 | 高 | 手册点名、用例证据 |
| c_52990 | 爆 | 拒绝 | 样本横跨抽卡、泡沫、爆发力等字面义，未形成稳定新用法。 | 中 | 用例证据 |
| c_57003 | 老师说 | 收录 | 反复出现完整句“老师说过图片没有声音”，按截断规则补全并收录。 | 中 | 手册点名、用例证据 |
| c_57792 | 一手 | 拒绝 | “留了一手/一手铸造/一手缓存”均为旧词字面义，无玩梗证据。 | 高 | 用例证据 |
| c_56537 | 绮 | 拒绝并封禁 | 仅从表情装扮名“绮星梦使”漏抽单字，无语义且会反复误报，封禁词头。 | 高 | 用例证据 |
| c_58368 | 家伙 | 拒绝 | “你这家伙”是普通称呼，其余用例亦无新惯用义。 | 高 | 用例证据 |
| c_53093 | nb | 拒绝 | 是“牛逼”的既有泛夸写法，用例均为普通赞叹，无近期新用法。 | 高 | 自有知识、用例证据 |
| c_57249 | 股市 | 存疑 | “浪漫股市/来股市”有重复但缺出句场景，无法区分固定玩梗与普通讨论。 | 低 | 用例证据 |
| c_52795 | 参与 | 拒绝 | 混有普通动词与带推广链接的广告模板，无独立梗义，不封禁泛用词头。 | 高 | 用例证据 |
| c_52991 | 赢 | 拒绝 | 样本为普通胜利用法及“参与活动赢奖”广告，是泛用词和模板噪音。 | 高 | 用例证据 |
| c_53718 | 艺术 | 拒绝 | “太艺术了/艺术成分”等均为普通评价或广告话术，无稳定新梗义。 | 高 | 用例证据 |
| c_57217 | 你太 | 收录 | 高频完整回应把“感性”听成“性感”，按交互梗补全触发句与回应句。 | 中 | 手册点名、用例证据 |

# 家族归并

- **没绷住家族**：c_58951 为主入口，收录为 m_0004；c_53586“绷住”、c_53396“绷了”归并。m_0004 的 aliases 为“绷住、绷了、绷不住了、绷不住、破绷了、炸绷了”。
- **神了家族**：c_55174 为主入口，收录为 m_0005；c_53690“神”归并。m_0005 的 aliases 为“这期神了、太神了、这神了、神”。裸“神”只收为别名，不进入 matcher，避免专名与普通词误报。
- **笑死家族**：c_52954 为主入口，收录为 m_0006；c_53595“死我了”是“笑死我了”的截断，归并后不新增裸“死我了”匹配。m_0006 已收录完整变体“笑死我了、笑死我、笑死了、哈哈哈笑死”。

# 词条清单

## m_0004 没绷住

- 文件：`D:/tmp-meme/judge/entries/mei-beng-zhu.json`
- aliases：绷住、绷了、绷不住了、绷不住、破绷了、炸绷了
- 入库命令：`node D:/tmp-meme/judge/meme-scratch.mjs add --entry-file D:/tmp-meme/judge/entries/mei-beng-zhu.json --cid c_58951`
- 闸门：首次通过，留出 3/3，误报 0/1000。对抗测试发现“请帮我绷住”词面误报后，补充 `forbid_context` 并执行 `iterate m_0004`；复测通过，留出 6/6，误报 0/1000，普通祈使不再产生词面命中。

## m_0005 神了

- 文件：`D:/tmp-meme/judge/entries/shen-le.json`
- aliases：这期神了、太神了、这神了、神
- 入库命令：`node D:/tmp-meme/judge/meme-scratch.mjs add --entry-file D:/tmp-meme/judge/entries/shen-le.json --cid c_55174`
- 闸门：首次通过，留出 6/6，误报 0/1000。对抗测试发现“月神了”词面误报后，把完整语境“月神了”加入 `forbid_context` 并执行 `iterate m_0005`；复测通过，留出 6/6，误报 0/1000。

## m_0006 笑死

- 文件：`D:/tmp-meme/judge/entries/xiao-si.json`
- aliases：笑死了、笑死我了、笑死我、哈哈哈笑死
- 入库命令：`node D:/tmp-meme/judge/meme-scratch.mjs add --entry-file D:/tmp-meme/judge/entries/xiao-si.json --cid c_52954`
- 闸门：通过，留出 10/10，误报 0/1000。正例“笑死我了”词面命中正常。

## m_0007 老师说过图片是没有声音的

- 文件：`D:/tmp-meme/judge/entries/lao-shi-shuo-guo-tu-pai-mei-you-sheng-yin.json`
- aliases：老师说过图片不能传播声音、老师说过图片没有声音、老师说图片没有声音、老师说图片不能传播声音
- 入库命令：`node D:/tmp-meme/judge/meme-scratch.mjs add --entry-file D:/tmp-meme/judge/entries/lao-shi-shuo-guo-tu-pai-mei-you-sheng-yin.json --cid c_57003`
- 闸门：首次失败，`MEME_BACKTEST_FAIL`，留出 50%，漏报样例是普通“老师说……”转述。没有扩大 matcher，而是按手册用 `--force` 关联候选，随后执行 `iterate m_0007` 脱离混合候选重测，达到留出 2/2、误报 0/1000，恢复 compiled。
- 后续处理：曾尝试加入“老师说过图片是不能传播声音的”变体，闸门反而降到 50% 并漏掉该例；已撤回扩展，最终再次 `iterate` 达到留出 2/2、误报 0/1000。

## m_0008 没有吧，是你太性感了

- 文件：`D:/tmp-meme/judge/entries/ni-tai-xing-gan-le.json`
- aliases：没有吧，你太性感了、没有啊，是你太性感了、是你太性感了
- 入库命令：`node D:/tmp-meme/judge/meme-scratch.mjs add --entry-file D:/tmp-meme/judge/entries/ni-tai-xing-gan-le.json --cid c_57217`
- 闸门：首次失败，`MEME_BACKTEST_FAIL`，留出 0%，因为候选只有回应句、没有触发句。按手册用 `--force` 关联候选，再执行 `iterate m_0008` 用配对 examples 重测，达到留出 2/2、误报 0/1000，恢复 compiled。
- 验证：带 `--ctx "你太感性了"` 时以 interaction 0.80 命中；无上下文时只有低置信向量命中，不触发 interaction。

# 执行记录

以下均只通过包装脚本操作实验库；退出码按命令实际结果记录。

1. `node D:/tmp-meme/judge/meme-scratch.mjs --help`：退出 0，显示 0.13.0 子命令列表。
2. `node D:/tmp-meme/judge/meme-scratch.mjs add --help`：退出 0。
3. `node D:/tmp-meme/judge/meme-scratch.mjs surf --help`：退出 0。
4. `node D:/tmp-meme/judge/meme-scratch.mjs note --help`：退出 0。
5. `node D:/tmp-meme/judge/meme-scratch.mjs iterate --help`：退出 0。
6. `node D:/tmp-meme/judge/meme-scratch.mjs edit --help`：退出 0。
7. `node D:/tmp-meme/judge/meme-scratch.mjs lookup --help`：退出 0。
8. `node D:/tmp-meme/judge/meme-scratch.mjs show --help`：退出 0。
9. `node D:/tmp-meme/judge/meme-scratch.mjs note add --help`：退出 0。
10. `node D:/tmp-meme/judge/meme-scratch.mjs surf --no-fetch --round-size 30`：退出 0，基线为新候选 24、欠账 24。
11. `mkdir -p D:/tmp-meme/judge/entries`：退出 0。
12. 写入 5 份词条 JSON：均成功；随后用本地 `node -e` 解析并检查必填字段、gist 长度、examples 数量与 patterns，退出 0，`files=5, bad=0`。
13. `add --entry-file .../mei-beng-zhu.json --cid c_58951`：退出 0，m_0004 observing，闸门通过。
14. `add --entry-file .../shen-le.json --cid c_55174`：退出 0，m_0005 observing，闸门通过。
15. `add --entry-file .../xiao-si.json --cid c_52954`：退出 0，m_0006 observing，闸门通过。
16. `add --entry-file .../lao-shi-shuo-guo-tu-pai-mei-you-sheng-yin.json --cid c_57003`：退出 1，`MEME_BACKTEST_FAIL`；留出 50%，漏报 1 例，样例为“那个时候念大学，老师说你们不如赶紧劝家里买房……”。
17. 同一 `add` 增加 `--force`：退出 0，m_0007 observing，但降级为 vector-only。
18. `iterate m_0007 --entry-file .../lao-shi-shuo-guo-tu-pai-mei-you-sheng-yin.json`：退出 0，留出 2/2、误报 0/1000，恢复 compiled。
19. `add --entry-file .../ni-tai-xing-gan-le.json --cid c_57217`：退出 1，`MEME_BACKTEST_FAIL`；留出 0%，漏报 2 例“没有吧，你太性感了”。
20. 同一 `add` 增加 `--force`：退出 0，m_0008 observing，但降级为 vector-only。
21. `iterate m_0008 --entry-file .../ni-tai-xing-gan-le.json`：退出 0，留出 2/2、误报 0/1000，恢复 compiled。
22. `surf --reject c_53586 --reject c_53396 --reject c_53690 --reject c_53595`：退出 0，4 条归并候选全部出队。
23. `surf --reject c_53433 --reject c_52622 --reject c_55390 --reject c_59058 --reject c_52303 --reject c_57365 --reject c_52990 --reject c_57792 --reject c_58368 --reject c_53093 --reject c_52795 --reject c_52991 --reject c_53718`：退出 0，13 条拒绝候选全部出队。
24. `surf --reject c_56537 --ban`：退出 0，c_56537 出队，词头“绮”沉淀为停用词。
25. `note add --head 股市 --content "“浪漫股市”“来股市”有重复，但缺少出句场景，无法区分固定玩梗与普通股市讨论；待更多上下文。"`：退出 0，写入笔记 #4。
26. `surf --no-fetch --round-size 30`：退出 0，仅剩 c_57249，欠账 1。
27. `lookup "这游戏剧情谁能绷住，我真绷不住了" --bare`：退出 0，m_0004 以 lexicon 0.95 命中；另有低置信向量命中。
28. `lookup "请帮我绷住这张海报" --bare`：退出 0，但发现 m_0004 以 lexicon 0.95 误报。
29. `lookup "这期神了" --bare`：退出 0，m_0005 以 lexicon 0.95 命中。
30. `lookup "都说不要对亡灵泰兰特用月神了" --bare`：退出 0，但发现 m_0005 以 lexicon 0.95 误报。
31. `lookup "笑死我了" --bare`：退出 0，m_0006 以 lexicon 0.95 命中。
32. `lookup "老师说过图片是不能传播声音的" --bare`：退出 0，m_0007 只有 vector 0.70 命中，未词面命中。
33. `lookup "没有吧，是你太性感了" --ctx "你太感性了" --bare`：退出 0，m_0008 以 interaction 0.80 命中。
34. `lookup "没有吧，是你太性感了" --bare`：退出 0，无 interaction 命中，只有低置信向量命中。
35. 修订 m_0004、m_0005 的 `forbid_context`；尝试给 m_0007 增加“是不能传播声音”变体。本地 JSON 复验退出 0，`files=5, bad=0`。
36. `iterate m_0004 --entry-file .../mei-beng-zhu.json`：退出 0，留出 6/6、误报 0/1000。
37. `iterate m_0005 --entry-file .../shen-le.json`：退出 0，留出 6/6、误报 0/1000。
38. `iterate m_0007 --entry-file .../lao-shi-shuo-guo-tu-pai-mei-you-sheng-yin.json`：退出 1，`MEME_BACKTEST_FAIL`；留出 50%，漏报样例“老师说过图片是不能传播声音的”。
39. 撤回 m_0007 的变体扩展，恢复证据原有完整形。
40. `iterate m_0007 --entry-file .../lao-shi-shuo-guo-tu-pai-mei-you-sheng-yin.json`：退出 0，留出 2/2、误报 0/1000。
41. `lookup "请帮我绷住这张海报" --bare`：退出 0，m_0004 不再有 lexicon 命中。
42. `lookup "都说不要对亡灵泰兰特用月神了" --bare`：退出 0，m_0005 不再有 lexicon 命中。
43. `lookup "老师说过图片不能传播声音" --bare`：退出 0，m_0007 以 lexicon 0.95 命中。
44. `lookup "这游戏剧情谁能绷住，我真绷不住了" --bare`：退出 0，m_0004 仍以 lexicon 0.95 命中。
45. `show m_0004 --level brief`：退出 0，词条存在且为 observing。
46. `show m_0005 --level brief`：退出 0，词条存在且为 observing。
47. `show m_0006 --level brief`：退出 0，词条存在且为 observing。
48. `show m_0007 --level brief`：退出 0，词条存在且为 observing。
49. `show m_0008 --level brief`：退出 0，词条存在且为 observing。
50. `note list --head 股市`：退出 0，返回笔记列表，其中 #4 为本次“股市”疑点。
51. `surf --no-fetch --round-size 30`：退出 0，最终仍仅 c_57249 一条存疑候选，triggered 1、pending 0。
52. 写入 `D:/tmp-meme/judge/verdicts.md`：成功。

# 遇到的障碍

- 两条候选的正例池不纯或结构不完整：m_0007 混入普通“老师说……”转述，m_0008 只有回应句。首次闸门分别失败在 50% 和 0%；按手册强制关联候选后，再用配对或完整 examples 重跑 `iterate`，最终均恢复 compiled 且闸门 100%。
- 自动回测不覆盖“含词面但非梗”的边界。对抗 `lookup` 发现“帮我绷住”和“月神了”误报，已补 `forbid_context` 并复测消除词面误报。
- 给 m_0007 扩展“是不能传播声音”变体时出现闸门回归，已撤回，保留证据中稳定完整形。
- 低置信向量仍可能对无关文本返回近邻命中；按手册需 `show` 核对，不把向量命中当作词面误报。
- 无其他阻塞；未读仓库源码、包装脚本或其他文档，未联网，未向用户提问。

# 读过的文件

除本文件与本次写出的 5 份词条 JSON 外，没有读取其他文件。任务上下文为 `D:/tmp-meme/judge/CONTEXT.md`。
