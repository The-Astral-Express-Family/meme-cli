# 参考文献记录（v0.11 重构的方法依据）

本文档记录 v0.11 梗发现算法重构所参考的 NLP 文献，每条注明**支撑了哪个实现决策**。
文献元数据经后台调研 agent 通过 arXiv/Crossref/OpenAlex/ACL Anthology 核实（2026-11-22）；
未能在线核实的个别 IEEE DOI 已标注。

## 一、固定表达抽取（extract.ts 抽取器 A）

1. **顾森（Matrix67），2012**《互联网时代的社会语言学：基于 SNS 的文本数据挖掘》
   https://www.matrix67.com/blog/archives/5044 （删节版刊于《程序员》2012 年 7/8 月刊）
   → **支撑：PMI 内部凝固度 + 边界自由度的候选判别**。"凝固程度"（取最小切分点的广义
   PMI）与"自由程度"（左右邻字信息熵取小值）三项联合过滤的新词发现法。extractFixed 的
   PMI 闸门直接采用其凝固度定义；边界熵（boundaryEntropy，evidence.ts）用于诊断输出。
   注：实测中发现"凝固度阈值"对词级 gram 的误杀风险，最终以 PMI≥1.5 宽松闸 + 冻结抑制
   + 计数保险的组合实现（召回优先）。

2. **Ted Dunning, 1993**《Accurate Methods for the Statistics of Surprise and Coincidence》
   Computational Linguistics 19(1). ACL J93-1003
   → **支撑：keyness 的 2×2 列联表 LLR**（evidence.ts llr2x2/keynessOf）。泛回应词在
   近窗口与基线窗口分布无差异 → LLR≈0；梗浪表达显著超预期。生产滚动窗口里是区分
   硬控(dv4 真梗)与哥(dv16 泛用字)的正解（湖回放压缩时间线测不出，见 baseline 文档）。

3. **Paul Rayson & Roger Garside, 2000**《Comparing corpora using frequency profiling》
   ACL workshop, DOI 10.3115/1117729.1117730
   → **支撑：keyness 的语料对比框架**（目标语料 vs 参照语料的频率剖面），与 Dunning
   同一套数学的语料对比用法。

4. **Jure Leskovec, Lars Backstrom, Jon Kleinberg, 2009**《Meme-tracking and the dynamics
   of the news cycle》KDD 2009, DOI 10.1145/1557019.1557077
   → **支撑：最大单元原则（频繁超串保留）**。短语级 meme 追踪保留最长频繁超串作为
   规范形——对应 extractFixed 的冻结子串抑制（邻界被单一 token 主导 ≥95% → 不立户，
   证据由更长表达携带）。

## 二、模板抽取（extract.ts 抽取器 B）

5. **R. Srikant & R. Agrawal, 1995**《Mining Sequential Patterns》ICDE 1995,
   DOI 10.1109/ICDE.1995.380415（IEEE DOI 未在线核实，论文为标准经典）
   **J. Pei, J. Han 等, 2001**《PrefixSpan: Mining Sequential Patterns Efficiently by
   Prefix-Projected Pattern Growth》ICDE 2001, DOI 10.1109/ICDE.2001.914830（同上）
   → **支撑：模板=频繁序列+通配槽的挖掘框架**。extractTemplates 的"锚点+共识扩展+
   间隙槽"是其轻量近似：多数票延伸字面核心，跨 ≤2 个可变 cell 的间隙扩展产出
   `<ent>` 槽（"一眼X鉴定为Y" → 一眼<ent>鉴定为<X>）。

6. **Xu 等, 2023**《Enhancing Language Representation with Constructional Information for
   Natural Language Understanding》(HyCxG) arXiv 2306.02819
   → **支撑：构式（construction）表示思想**——"X控""一言不合就X"即构式语法的槽位
   构式；其"槽位约束"表示借鉴为模板头的 <X>/<ent> 槽模型（未用其重模型）。

## 三、爆发检测（burst.ts）

7. **Jon Kleinberg, 2002**《Bursty and Hierarchical Structure in Streams》KDD 2002,
   DOI 10.1145/775047.775061（期刊版 DMKD 7:373-397, 2003）
   → **支撑：burst 自动机整体替换 z-score**。多状态自动机（基线率 × 2^γ 分层）+
   Viterbi 求最优状态序列，burst 等级写入 candidates.z_score 列复用。解决了旧 z-score
   的手选对照窗口与冷启动恒 None 问题。

8. **Qi He, Kuiyu Chang, Ee-Peng Lim, Jun Zhang, 2007**《Bursty Feature Representation for
   Clustering Text Streams》SDM 2007, DOI 10.1137/1.9781611972771.50
   → **支撑：爆发性 × 搭配强度两段串联的范式**（先 keyness/凝固度闸、幸存者再过
   burst 自动机）。

## 四、语义层（semantics.ts）

9. **Maria Ryskina 等, 2020**《Where New Words Are Born: Distributional Semantic Analysis of
   Neologisms and Their Semantic Neighborhoods》Findings of EMNLP 2020
   → **支撑（部分）：mention vs usage 的嵌入判据设想**——候选上下文的分布语义刻画。
   **实测否决记录（重要）**：上下文离散度在真实池上不能区分话题词与梗（韩立 0.648 ≈
   绷 0.696）——评论句子的语言差异远大于话题差异，bge 句嵌入基线余弦 ~0.65-0.70。
   该判据已从实现中移除，话题词治理回归操作员人工（docs/meme-judgment-guide.md）。

10. **Martinc, Kralj Novak & Pollak, 2019**《Leveraging Contextual Embeddings for Detecting
    Diachronic Semantic Shift》arXiv 1912.01072
    → **支撑：用现成句编码器（bge-small-zh-v1.5）的上下文嵌入做语义度量、无需词向量
    训练与 Procrustes 对齐**的做法。语义层的全部特征（泛回应近邻/填充离散度）都建立
    在这一做法上。

11. **Zhengqi Pei, Zhewei Sun, Yang Xu, 2019**《Slang Detection and Identification》CoNLL 2019,
    DOI 10.18653/v1/K19-1082
    → **支撑：句法范畴偏移是俚语最强信号的结论**——全虚词核心标记（allFunctionHead，
    终于/可以/会类词头减分）的理论依据；未采用其监督模型。

12. **Han, Cook & Baldwin, 2013**《Lexical normalization for social media text》ACM TIST 4(1),
    DOI 10.1145/2414425.2414430
    → **支撑：梗家族=变体归簇（lexical normalization 的反向问题）的理解**——绷/绷了/
    绷不住/破绷了 家族不强行归一，各自立户由操作员在收录时合并。

## 五、中文场景参照（未直接实现，设计动机）

13. **Yufeng Wu & Meichun Liu, 2026**《Operationalizing Linguistic Methods through
    Prompt-Engineering Skills: An Automatic Chinese Web Neologism Detection Pipeline》
    arXiv 2606.08715
    → **支撑：字符级候选 + PMI 预过滤 + entity 分离的三分类需求**——其 neologism/
    entity/none 三分类确认了"专名不是新词"是中文新词流水线的公认难点；其"词越长
    语义判分越退化"的发现提示长模板要靠统计通道兜底。

14. **Huang 等, 2025**《Can Large Language Models Understand Internet Buzzwords Through
    User-Generated Content》(CHEER 数据集) arXiv 2505.15071
    → **潜在评测集**（未接入）：中文梗理解的 UGC 数据集，未来评估可参照。

## 六、实现中的实证决策（非文献，但与方法选择同等重要）

以下决策由真实湖回放/标定实测推翻或确立，记录防止回退：

- **dv 广度项与边界熵项不进评分**（曾试验加入）：dv 项把 dv 高的单字泛用词（哥/找/骂）
  从 0.04 抬到 1.2 盖过真梗；熵项同样利好泛用词（自由边界）。区分 硬控(dv4) 与 哥(dv16)
  的正解是 keyness + burst 的时间维。
- **触发门用纯特征分**（memeScore 旧四特征），广度/熵/keyness 只进排序——广度项进门会
  放行"dv 高句句不同"的泛用词（旧行为校准过）。
- **冻结抑制配裸边界豁免**（词头有独立成评出现 → 不抑制）：纯 0.95 比例会杀掉有单用
  形态的家族词头（绷）；但豁免会让话语开头的切片（灵笼第）幸存——由评分与包含族合并兜底。
- **抽取期填充多样性门控**（数量词坍缩为一类、双侧边缘槽拒绝）先于语义弱模板标记——
  统计门零成本，语义门（嵌入调用有成本）只做二道闸。
- **泛回应双通路**（用例均值 ≥0.87 或词头本体 ≥0.93）：带上下文用例会稀释均值向量
  （来啦轮内 0.852），词头本体是更稳的信号源。
- **Embedder 预热**：getEmbedder 立即后台加载，否则 available 恒 false、向量层永远被跳过
  （实战发现的静默失效 bug）。
- **fastembed 模型缓存**固定到 ~/.meme/model_cache（默认 CWD 相对 local_cache 会在任意
  启动目录重复下载）；其内部 fetch 不走代理，离线机器用 curl 经代理手动放置模型文件。

## 七、第二轮迭代（v0.11.1，2026-11-22 下午）的实证决策

操作员经 207 条广泛审查列表（scripts/review.ts）逐条判定 round 12-14 池后确立的判据与修正：

- **"形成时间"是主判据，词的类别不是**（操作员明示）：判定靠"表述此前不存在、近期才出现 /
  承载典故或公式 / 新惯用用法"，而非泛夸/泛用分类。据此：词类候选的 wide 自动触发路径
  （dv≥8 即触发）整体移除——可爱(dv22)/小时(dv23)/神(dv40)/死了(dv30) 全部是 wide 路径
  误触发且操作员全部未确认为梗。
- **新表述判据 = 8-90 天基线窗口缺席**（evidence.ts noveltyOf）：年级语料不可得（操作员
  确认抓取不现实），库内基线缺席是"此前不存在这种表述"的最佳可得代理；安装未满 8 天
  返回 null（不可测 → 宁缺勿滥不自动触发）。**burst 不是形成时间证据**——旧词回潮
  （"神了"类）照样爆发，burst 只保留为排序特征。
- **bumpDaily 归账日缺陷**：信号层曾用"今天"记所有轮次的日聚合——rebuild/回放把湖里
  全部历史轮次压塌成 1 天，phrase_daily 只剩当日，burst/keyness 时间维全灭（实测
  全表 keyness=0）。修复为按轮次采集日（surf_runs.started_at）归账。
- **泛夸云（praise_generic）可分性中等**：可爱 0.866/好看 0.919/牛 0.902/精彩 0.890 被
  捕获，但真梗 nb 0.837（贴边安全）/没绷住 0.760 安全的同时，神系 0.887-0.896 与
  可爱喵 0.882 被覆盖（操作员确认为真梗）——故泛夸标记只作排序罚分（−2.0），
  **不作触发否决**；泛用词的触发治理由触发门的新表述判据承担，双保险分工。
- **自推剪枝扩展到 skeleton 通道**：RunFast API 广告（同 mid 同句跨视频）以"模板"形态
  立户——单作者单文本即假公式（模板前提是填充多样）。phrase 侧的同句多用户不剪
  （copy 通道主粮）的约定不变。
- **负例集改精确匹配**（replay.ts v4）：截断家族（家→家人们、刷到→刷到极品了、爆→爆了）
  归 TRUTH 的 partial 计截断率，不再与负例子串互撞。

## 八、机制收敛重构（v0.12，2026-11-22 晚）的实证决策

操作员在复核形成时间判据的永久锁死问题后，先后做出三个机制决策——**先把机制变干净，
然后再迭代更新**：

- **撤销形成时间判据（操作员明示"完全不要这个时间机制"）**：noveltyOf 是滑动窗口重算，
  词头首次出现 8 天后其早期用量老化进基线窗口，判据从"可能成立"永久翻成 false——慢热梗、
  立户滞后、未及判定的表述全部永久锁死；rebuild/回放还以墙上时钟算窗口偷看未来数据。
  曾实现的闩锁（存在性扫描 + 轮次日锚定）也被一并撤销：机制从简优先于补救。
  "形成时间"保留为**操作员人工判据**（指南 §二三问），管道不再计算。
- **触发门改累计体量线（操作员设计；5/8 为历史阈值，已被 10/15 取代）**：词类 = 累计跨 ≥5 视频，**不限轮数**（操作员质疑
  “为什么只认前两轮”——两轮限期是 z-score 时代遗留，泛用词治理已由特征分门 + 封禁承担）；
  结构通道 ≥8（整句复读类的特征分同样拉满，量阈值是唯一防线）。全门无时间窗：一条规则
  对所有轮次成立，“错过窗口永久进不来”在结构上不可能。
- **体量线按绝对出现次数而非跨视频数（操作员设计）**：同一视频下的反复复读同样是复读
  指征，跨视频数会把单视频评论区的梗浪漏掉；次数 ≥ 跨视频数恒成立，次数线是严格放宽。
  数据源 = 日聚合账本终身总和（词头按 (phrase, day) 主键前缀求和，无需新列）。实现该线
  的前提是修掉一个归账缺陷：候选词头既在候选循环显式归账、又在短语总账作为 gram 再记
  一次——phrase 词头计数被翻了约一倍（实测"难绷"18 次 = 真实 9 次 × 2）；修复为总账
  跳过已显式归账的词头。图梗无日聚合账本，保留跨视频线。
- **部署生命周期（操作员设计，区分开发期与部署期）**：候选 7 轮休眠（末次证据超限则不
  评估不呈现，新证据唤醒）+ 28 天死亡（末次证据超限删除；触发待裁决一视同仁——队列只留
  新鲜工作，词仍在传播会重新触发；inducted 豁免）+ 低价值早清（休眠且从未达体量线直接
  删除）+ 原始湖轮次留存（部署期 7 轮，开发期 0 不清理——原始湖是唯一非派生数据，清理
  它等于永久放弃历史重审）。长期态（词条/封禁/日聚合/笔记/审计）永不清理。
- **封禁 = 永久 + 定期复核**（操作员选定）：不做封禁有效期（常见噪音词会周期性回池增加
  裁决负担）；review.ts 尾部列出各封禁词近 7 天日聚合出现量——零出现 = 词已自然消退
  （惰性封禁），由操作员 `meme allow <词头>` 移除。误封的即时逃生口同此命令。
- **衰减观测日对齐（假衰减修复）**：checkFade 的日序列曾按日历补零——surf 不每天跑，
  空档日的 0 会压低 14 天均值造成假衰减。改为只在有采集的日子（surf_runs.fetched=1）
  上取样，均值分母 = 观测日数。burst 的日序列仍有同类补零（仅影响排序，未改）。
- **存量模式性能（实测 6.8k 候选池）**：两个修复把 `surf --no-fetch` 从 ~7 分钟降到
  ~28 秒。其一，keyness 的全表基线聚合（day 列无索引 × 数千候选 × 2 次 = 1.4 万次
  全扫 36 万行）改为按 (表+窗口) 进程内缓存；其二，触发门重排——便宜的特征分门提到
  嵌入标记之前，语义否决只对特征分已达标的候选计算（门是纯 AND，重排不改变结果，
  只减少嵌入调用），图梗通道没有语义否决、完全免嵌入。

## 九、QQ 群聊入池（v0.13）的实证决策

操作员要求「群聊消息也视为 surf 结果一并入池」。先调研了"养鱼"生态：主流桥接插件是
腾讯官方组织的 `@tencent-connect/dsh-qqbot`。读其源码与底层 SDK 后确立的事实：
QQ 官方 API 有全量群消息事件（`GROUP_MESSAGE_CREATE`，与 @ 消息事件并列），但
dsh-qqbot 把非 @ 消息只写进内存历史缓冲（上限 10 条、回复后清空），既不进 agent
会话也不向插件总线发事件；插件总线唯一可观测点是 `session/event`，只覆盖 agent
看到的流（私聊 + @ 消息）。据此决策：

- **不补丁第三方包、内置自写 bot（操作员选定）**：以官方 SDK
  `@tencent-connect/qqbot-nodejs`（协议层：网关/重连/去重/中间件/发送全包）为基础，
  在本插件内写编排层（约 700 行：中间件链 + 精简会话管理 + 非流式回复 + 采集缓冲）。
  dsh-qqbot 全量源码 531KB（约 2 万行），其中大半是多账号/管理面板/配对码/视觉理解，
  单群部署用不上，vendor 不划算。SDK 作可选依赖（纯 B站用户零影响），配置驱动启动。
  放弃的功能如实记录：流式回复、斜杠命令、配对码、富媒体交互。
- **群消息复用 lake_comments（合成负数编号）**：群 = 占位视频行（lake_videos，
  source='qq'），消息 = 评论行（负数 rpid=hash(msgId) 重投递天然去重、负数 oid=群、
  负数 mid=发送者——跨群同作者的自推剪枝自动适用）。整条既有管线（四路抽取、接龙、
  日聚合、候选合流、休眠/死亡、wildRecheck 词条野外命中）免改直接生效，零新抽取代码。
  负数空间与 B站正数编号永不冲突；哈希相撞在部署规模下可忽略。
- **入池时序 = 认领**：ingest 写 round_id=0（未入轮），每轮 surf 开局第一步认领进
  本轮——对应操作员「同步转发给 meme cli（静默）和下一轮次的 surf 一同加入计算」。
  reapLake 的 round_id>0 守卫恰好保证未认领行不被留存清理误删（surf 运行中 bot
  并发写入安全）。
- **单群部署只看次数（操作员明示）**：跨 ≥3 up 门对带群证据的候选豁免——真实的群梗
  大多只在 1-2 个活跃群刷，跨 3 群门会挡住大部分（与体量线改绝对次数同一逻辑）。
  随后操作员把豁免扩大为**整体取消跨 up 门**（B站侧也取消）：单视频/单群复读浪
  一并放行，噪音由特征分门与封禁承担。次数线随后按真实湖敏感度实测校准为
  **10/15**（5/8 档位下 pending 达标 302 条、93% 是 dv≤2 的话术热点；10/15 档位
  43 条，已确认真梗全部次数 ≥7 零损失；阈值在 lifecycle 配置的
  trigger_videos / trigger_videos_alt）。实测同时确认：**纯次数分不开单容器
  话术热点**（"做出来"50 次/dv=2、"厨房"36 次/dv=1 在任何次数档位都入队）——
  分界维度是跨容器广度，热点的长期治理走精确 ban 沉淀而非阈值。
  落库实测（2026-11-22 晚，10/15）确认了重放语义：**触发是逐轮评估的轨迹
  判定**——特征分随用例多样化而稀释、次数随轮次增长，两条件必须在同一轮同时
  成立。**2026-11-25 操作员取消“触发后粘住”**：每轮对醒着的 pending/triggered
  重算，pending 达标 → triggered，triggered 失格 → pending，并返回 demoted；
  阈值附近抖动先直接呈现，由回放观察，不设永久待裁决队列。截断家族头
  （“刷到”→“刷到极品了”、“家”→“家人们”）的用例句句不同、特征分恒不达线
  （0.13/0.17），从未触发——它们的收录按指南 §四.3 由操作员亲写完整标准形，
  不靠截断头入队。低频真梗（上号 7 次/可爱捏 9 次/阿巴 8 次）被 10 次线暂时挡住，
  词仍在传播则次数只增不减，会在某轮与分数同时达标——无时间窗，不存在永久锁死。
  收割量随线提高（低价值早清按新线删除休眠未达线候选 4422 条，湖完好，词重现重新立户）。
  抽取层同理：QQ 容器豁免「轮内跨容器 ≥2」门（单群部署整个湖只有一个容器），
  但虚词性单字路径不豁免——防单人刷屏噪音的最后防线。
- **修掉两个入池副作用**：占位视频行的 title（群名）曾被 titlesForRound 当视频标题
  以 5 倍权重喂进语料（群名立户）；related_of_top 的顺藤摸瓜种子可能选到负数 aid。
  两处均排除 source='qq' 行。harness 运行时包（dsh-llm/dsh-session）改 peer 语义 +
  tsdown external——vendor 进 lib/node_modules 会缺 package.json 且遮蔽宿主版本。

## 十、候选判定工作流收敛（v0.13，2026-11-25）

- **触发质量**：独立成评从“任意 ≤6 字”改为归一化文本等于/严格包含候选完整形，模板按槽位另算；pending 至少 2 条、skeleton 至少 3 条。统一 `allFunctionCore`，嵌入器不可用也设置 `all_function_core`。独立成评单独贡献上限 0.5，阈值相应从 0.45 提到 0.7，要求第二类证据；真实池敏感性下体量达标候选约从 2175 降至 169。`surfs_seen` 按不同轮次计数，同一轮多条信号（尤其图梗）不再伪造存活轮数；图梗阈值独立为 `trigger_images=8`，且按 pHash 跨视频簇直接过门，不被文本质量分误挡。
- **状态机**：pending/triggered 每轮重算，triggered 失格降为 pending；不维护永久待裁决队列。`surf` 只呈现当前过门条目，`check` 只读重算并支持分页/焦点。
- **精确封禁**：`ban`/`allow` 接收归一化词头而非 cid，跨 phrase/copy/skeleton/image；copy head 不截断，模板按最终 head 过滤，图片发现跳过 banned head。封禁复核按 phrase + skel 账本合计。`generic_auto` 不进入语义客套云，避免精确 ban 产生语义家族式连带否决。
- **收录收口**：`--cid` 可重复，`--text` 精确/唯一解析；成功后收口显式 cids 与 canonical terms 精确同头 active 候选，审计 closed cids/heads，并写 same_form 关联。
- **回测去污染**：候选用例按 canonical 正例口径（name/实际 lex terms/skeleton 槽位形状；可选别名匹配后才含 aliases）筛选，只保留命中完整形的用例；直接洗牌 `UsageSample` 保留 pair/parent；空集要求 `--holdout-text`。已知正例、留出文本与会话上下文都排除出负例采样；交互梗无有效触发上下文不进分母。纯向量词条恢复 matcher 必须提供独立证据或显式留出，显式 `--force` 仍降级纯向量并审计 `matcher_evidence_forced`。
- **aliases**：默认仅元数据/解析/重名/家族收口；`--match-aliases` 才合并非槽位 aliases，交互 aliases 不绕过上下文。
- **运维语义**：`surf --no-fetch` 不联网但仍推进一轮；焦点查看与分页统一使用只读 `check`，噪音治理统一使用顶层 `ban`/`allow`。`benchmarks/` 标签禁入运行时。

## 十一、curator-v1 策展题的首创性调研（2026-11-27，后台调研 agent 核实链接）

结论：**范式有渊源，组合无先例**。"agent 构建持久产物 → 隐藏查询行为测试"各单点均有先例：

- **正则合成（结构最近邻）**：RegexGym https://github.com/ctokx/regexgym （隐藏 holdout 正负例执行打分 + 突变式硬负例）；RegexCompBench https://arxiv.org/abs/2503.20579 ；A-CEGIS（反例反馈归纳）https://arxiv.org/abs/2609.02892
- **隐藏测试验证 agent 产物**：SWE-bench https://arxiv.org/abs/2310.06770 ；Commit0 https://arxiv.org/abs/2412.01769 ；MLE-bench https://arxiv.org/abs/2410.07095
- **持久库状态被评分 + 误伤惩罚**：τ-bench https://arxiv.org/abs/2406.12045 ；AppWorld（collateral damage）https://arxiv.org/abs/2407.18901
- **对抗硬负例**：BFCL irrelevance https://gorilla.cs.berkeley.edu/blogs/8_berkeley_function_calling_leaderboard.html
- **策展式增量维护**：ACE（Curator 角色，add/update/remove）https://arxiv.org/abs/2510.04618 ；MemoryAgentBench（selective forgetting）https://arxiv.org/abs/2507.05257 ；LongMemEval https://arxiv.org/abs/2410.10813
- **规则/检测器自动生成**：CheckerBench https://arxiv.org/abs/2610.07557 ；AutoPYara（家族聚类）https://arxiv.org/abs/2611.08608
- **梗/中文网络语基准（全部是理解评测，无策展）**：CHEER https://arxiv.org/abs/2505.15071 ；MemeBench https://arxiv.org/abs/2607.27798

组合层面的未见先例：数据型语义匹配库作为被评测产物；ban 作为一等可评分决策（可逆、误 ban 受罚）；多家族 + 按噪音候选归因的子任务计分；硬负例与误 ban 惩罚同时成立。完整调研报告含检索渠道与排除理由。
