# dsh-meme —— 梗百科（deepseek-harness 纯 CLI 插件）

由 LLM 操作员驱动的梗百科：梗的**采集**（surf）、**收录**（add：操作员亲写词条）、**修订**（iterate / edit）、**检索**（lookup / search / show）与**生命周期管理**（遗忘 = 降级 + 压缩，不是删除）。库与 CLI **平台无关**——群聊、直播、任何文本里的梗都能 lookup 与收录；发现端有两路：B站 surf（采集站外新梗）与内置 QQ 群聊 bot（可选，采集群内实况，见下）。

目标场景：一个 agent 要在互联网时代的玩梗群里有趣地互动——理解别人在玩什么梗（lookup）、
自己接梗时不出错（卡片的 usage/taboo/aggression）、发现群外正在发生的新梗（surf）、
并且知道自己的梗知识可能是错的（iterate）。

- **纯 CLI 形态**：harness 工具目录**零占用**——操作面全部在 `meme` CLI，主控 agent 经 bash/pwsh 调用；插件本体做三件事：注册 meme skill（一句话目录 + 按需展开的手册）、shellEnv 注入调用入口、可选启动 QQ 群聊 bot（配置驱动，见下）。
- **读写路径分离**：write path 只有 surf 外呼 B站；add / iterate 是操作员亲写词条 + 全本地闸门（JSON 校验、matcher 编译、backtest），不外呼任何 LLM——操作员本身就是 LLM，归纳不需要再调一个。read path（lookup / search / show）全本地、毫秒级。
- **零自治**：完全被动，什么时候 surf、一轮刷多深，由调用方决断。
- **自持数据**：单个 SQLite 文件（默认 `~/.meme/memes.db`），备份 = 拷贝文件；schema 无迁移路径，旧版库文件一律拒收（删除重建）。
- **干净安装**：`npm install` 即全部（node:sqlite + 预编译二进制依赖），与 harness 分发模型一致。

## 接入形态

一个 npm 包，两个面：

| 面 | 入口 | 作用 |
| --- | --- | --- |
| **CLI**（操作面） | `bin` 的 `meme`（`lib/cli.js`） | 命令组见下表；stdout = 单行 JSON（agent 消费），stderr = 人读文本；业务失败 exit 1 且 stdout 仍有 `{"error":{"code","message","suggestion",...}}`，用法错误 exit 2 |
| **shim**（插件面，prompt-only） | `lib/index.js`，`inject: ['skills', 'shellEnv', 'agents']` | ① `ctx.skills.register` 注册 meme 技能——**未激活形态只有技能目录里的一行**（81 字符 ≈ 57 tokens 常驻）；模型经 `skill` 工具按需展开全文（会话瞬态不常驻），**用户消息首行 `/meme` 也是确定性加载手势**；② shellEnv 注入 `DSH_MEME_NODE`（harness 进程的 node）与 `DSH_MEME_BIN`（cli.js 绝对路径）——harness 不给 agent shell 加 PATH，绝对路径变量是插件喂给模型可执行入口的唯一正规通道；③ QQ 群聊 bot（可选）：config.json 配了 `qq` 段才启动，未配置时行为与过去完全一致 |

agent 调用样板（先 `skill meme` 展开手册，之后自会使用）：

```sh
"$DSH_MEME_NODE" "$DSH_MEME_BIN" lookup "这是什么梗"     # bash
& $env:DSH_MEME_NODE $env:DSH_MEME_BIN lookup "这是什么梗"   # pwsh
```

## 安装

```sh
# 在 dsh profile 内（自动得手册 + 环境变量桥）
dsh plugin --profile <name> add ./dsh-meme              # 本地 checkout
dsh plugin --profile <name> add github:you/dsh-meme     # git（需 pnpm allowBuilds + prepare 构建）

# 人类自用（可选）：全局安装得 `meme` 命令
npm i -g dsh-meme
```

要求 Node ≥ 22.19（node:sqlite），dsh ≥ 0.2.0。skill/shellEnv 注入依赖 profile 装载 dsh-skill 与 bash/pwsh 工具（标准 profile 默认具备）；缺任一则 shim 不生效——没有 shell 本就无从调 CLI。

## CLI 一览

| 命令 | 作用 |
| --- | --- |
| `meme lookup <text>` | 识别文本中的梗——命中返回玩梗卡（hits[].card），一次调用即可接梗；交互梗 `--ctx` 给会话上文 |
| `meme search <query>` | 模糊回忆式检索（BM25 + 例句级向量混合，RRF） |
| `meme show <ref>` | 词条分级输出（`--level brief\|card\|full`） |
| `meme add` | 收录：`--entry-file`/`--entry-json` 亲写词条（必给其一，闸门全保留）；`--cid` 可重复，`--text` 精确/唯一解析，`--holdout-text` 可重复，`--match-aliases` 可选开启别名匹配 |
| `meme iterate <mid>` | 修订词条：原位更新，保留 id/state/stats；同样支持多个 `--cid`、`--holdout-text` 与 `--match-aliases` |
| `meme edit <mid>` | 轻量修订（`--variant` / `--drift` / `--promote` / `--kill` / `--gist` / `--revive`） |
| `meme surf` | 执行一轮 B站获取（或 `--no-fetch` 不联网但仍推进轮次）→ 证据更新 → 状态重算 → 呈现当前过门条目 |
| `meme check` | 只读查看当前窗口内过门条目；支持 `--focus`/`--page`/`--round-size`，不写轮次、不认领 QQ、不收割、不写 kv |
| `meme ban <head...>` | 精确归一化词头封禁，跨 phrase/copy/skeleton/image；不做子串或语义家族封禁 |
| `meme allow <head...>` | 精确解除封禁，并恢复被该封禁压住的候选资格 |
| `meme ingest` | 群聊消息批量入池（bot 桥接的落库端，也可手工喂）：JSON 数组 `[{msg_id, group, sender, content, ts_ms?}]`，静默写原始湖，下一轮 surf 一并计算 |
| `meme note add\|list\|show\|edit\|rm` | 笔记增删改查（低信任附着物，永不进 matcher/card） |
| `meme config init` | 写出 `~/.meme/config.json` 模板 |
| `meme auth <action>` | 登录态管理（仿 gh auth）：`login` 弹浏览器扫码；`status` 查登录态（凭证存在性 + nav 实测）；`logout` 删除登录态 |

每个子命令 `--help` 可查详情。entry 走文件通道（agent 先写临时 JSON 文件再 `--entry-file <绝对路径>`），绕开 shell 引号问题。

## 登录（meme auth）

搜索探测（surf 的 probe）与完整评论区需要 B站登录态。用户在终端跑一次：

```sh
meme auth status    # 查登录态：凭证存在性 + nav 实测有效性（未登录时给扫码引导）
meme auth login     # 弹出浏览器扫码页；成功后写 ~/.meme/credentials.json
meme auth logout    # 删除登录态（换账号用）
```

标准扫码登录流（bilibili-API-collect 的 web QR 协议）：本地起一次性回调页 → App 扫码 →
poll 成功后取 SESSDATA/bili_jct/buvid3 → nav 验证身份 → 凭证落盘。CLI 自动读取该文件。

## 配置（~/.meme/config.json）

CLI 是独立进程，读不到 harness profile 的 cordis 配置——单源配置文件，全部字段有默认值：

```jsonc
{
  "db_path": "",                        // 默认 ~/.meme/memes.db（$MEME_DB 覆盖）
  "credentials_file": "",               // 默认 ~/.meme/credentials.json
  "fetch": {
    "regions": [119],                   // 鬼畜区；可加 1=动画 4=游戏
    "max_video_age_days": 10,
    "probe_keywords": 3                 // 登录态下每轮搜索探测的热词数
  },
  "backtest": {
    "min_hit": 0.7,                     // 留出集命中率门槛
    "max_fp": 0.02                      // 负例误报率门槛
  },
  "detect": { "generic_extra": ["希望"] }, // 追加停用词（meme ban 沉淀的 generic_auto 之外）
  "qq": {                               // 可选：QQ 群聊 bot（不配或留空 = 不启动）
    "app_id": "",                       // QQ 开放平台（q.qq.com）机器人 AppID；QQBOT_APPID 环境变量可覆盖
    "app_secret": "",                   // 对应 AppSecret；QQBOT_SECRET 环境变量可覆盖
    "require_mention": true,            // 群聊是否 @bot 才进 agent 会话（采集不受影响：全部群消息都进梗池）
    "group_allow": []                   // 群 OpenID 白名单；空 = 全部接收
  }
}
```

没有凭证类字段：收录与修订由操作员 agent 亲写 entry，CLI 不外呼任何 LLM。环境变量仅作临时覆盖：`MEME_DB`（库路径）。

## QQ 群聊 bot（内置，可选）

插件内置一个精简 QQ bot（基于官方 SDK `@tencent-connect/qqbot-nodejs`，可选依赖），配置 `qq` 段后随 harness 启动，一条 WebSocket 连接同时服务两件事：

- **采集（核心）**：每条群消息——**包括没 @bot 的闲聊**——清洗后静默写入原始湖（`round_id=0` 未入轮），下一轮 surf 开局认领进本轮，与 B站采集同批进抽取管线。群里没有 @bot 的梗浪正是主要素材。
- **桥接（养鱼）**：@bot 的消息进入该群的 dsh agent 会话（`require_mention=false` 时所有群消息都进），agent 回复以非流式文本送回 QQ。群消息上下文（最近 10 条）随 @ 消息一起组装给 agent。

约定与边界：
- **凭据**来自 QQ 开放平台控制台（q.qq.com 的 AppID/AppSecret），写进 config.json `qq` 段或环境变量 `QQBOT_APPID`/`QQBOT_SECRET`。**群消息推送权限**需在开放平台为 bot 开通（`GROUP_MESSAGE_CREATE` 全量群消息事件）。
- **单连接**：一个 bot AppID 同时只能有一条 WebSocket 连接——本插件与 dsh-qqbot 不能同时使用同一凭据，启用内置 bot 时请从 profile 移除 dsh-qqbot。
- **单群部署语义**：触发只看次数线（跨 up 门已整体取消）；群 = 占位视频行（`lake_videos.source='qq'`，负数合成 aid），跨群数在统计里就是跨视频数。
- 一期不做：流式回复、斜杠命令（/new 等）、配对码、富媒体交互。未配置 `qq` 段时插件行为与过去完全一致（纯 B站模式）。
- 采集全程静默：写库失败只记日志丢弃，绝不影响群聊会话与 skill。

## 发现端架构（v0.13：两套统计抽取器 + 图梗 + 群聊入池，文献依据见 docs/references.md）

抽取层（src/detect/extract.ts）替代旧 6 通道特判：

| 单元 | 抓什么 | 判别信号 |
| --- | --- | --- |
| 固定表达（phrase/copy 通道） | 词/短语/整句字面复读 | token n-gram（上限 6 token）+ **PMI 内部凝固度**（取最小切分点）+ **冻结子串抑制**（邻界被单一 token 主导 ≥95% → 更长表达的切片，不立户；有独立成评出现则豁免——"绷"的家族）；**虚词性 gram 计数保险**（jieba 把"上号"标成全虚词——词典外新梗恰恰如此，重复本身即证据）；整句复读（4-48 字归一后跨视频同文）走 copy 通道 |
| 模板（skeleton 通道） | 带槽句式（"XX启动""一眼X鉴定为Y""<X>麻了"） | **字级 cell 锚点 + 共识扩展**（多数票延伸字面核心，可跨 ≤2 个可变 cell 的间隙——PrefixSpan 通配的轻量近似）；标点是硬边界（"原神，启动"的逗号防核心被前句污染）；槽位门控：填充多样性 ≥2（数量词填充坍缩为一类，"X分钟"判假公式）、双侧边缘槽拒绝（<X>词<X>）、字面 ≥2 字符 |
| image（图梗） | 跨视频复现的图片簇 | pHash 汉明距离聚类（不变） |

**视频标题也是证据**：标题按 **5 倍评论权重**计票（跨视频门槛不变），两条不同 up 的标题玩同一公式即可立户。**跨轮创建补救**：轮内 dv=1 的完整表达若 phrase_daily 历史出现过即立户——散布多轮的低频完整单元不再永远立不了户（"steam管家"类截断案例的根因修复）。

**判定与触发（v0.13）**：主判据是操作员判断“表述形成时间 / 典故或公式含义 / 新惯用用法”，词的类别不是主判据。管道只做统计筛选：话题词、普通词、泛夸词都可能过统计门，★仅表示待人工判断。score = 复读对(×2) + 骨架坍缩 + 独立成评 + 文本重复 + **keyness**（Dunning LLR，近 7 天 vs 8-90 天基线的跨语料显著性）+ **burst 等级**（Kleinberg 爆发自动机）− 语义罚分；burst/keyness 只进排序，不参与触发。独立成评只认归一化文本等于或严格包含候选完整形，模板按槽位形状另算；pending 至少 2 条有效用例，skeleton 至少 3 条。触发条件 = 存活 ≥2 轮 && 绝对出现次数达线（phrase ≥10，copy/skeleton ≥15，image 按跨视频数 ≥8）&& 纯特征分 ≥0.7 && 无语义否决。每轮对醒着的 pending/triggered 重算：达标 → triggered，不再达标 → pending；triggered 不粘住，没有永久待裁决队列。跨 up 门已整体取消，单视频/单群复读浪可放行；泛回应否决触发，泛夸只罚分不否决。

**池卫生**（每轮自愈）：**包含族合并**（互为包含且视频重合 ≥50% → 并入终身计数更高方；容器守卫：keeper 视频量超被吸收方 8 倍不得吸收——"感觉"不吞"感觉不如"）+ **固定⊂模板吸并**（固定头是模板核心的扩展实例且视频重合 → 并给模板；模板核心本身永不被自己的模板吸收）+ **自推垃圾剪枝**（同一作者同一句跨 ≥2 视频的 phrase 切片删除；整句复读走 copy 通道免剪）。候选可重建：规则修复后跑 `npx tsx scripts/rebuild.ts --apply` 按湖重放（先预览）。

**部署生命周期（v0.13，区分开发期与部署期）**：开发期（默认）一切保留、可重建可回放；部署期的存储与注意力有界，由三个常数控制（`lifecycle` 配置）——**存活窗口** `surf_survive_rounds=7`（末次证据超过 7 轮的候选休眠：不评估、不呈现，新证据唤醒）；**死亡线** `candidate_death_days=28`（末次证据超过 28 天的候选删除，pending/triggered 一视同仁，inducted 豁免）；**低价值早清**（休眠且从未达体量线的候选直接删除）。候选不是永久待裁决队列：每轮 surf 重新筛选，只读 `meme check` 查看当前窗口过门条目。**原始湖留存** `surf_retention_rounds`：0 = 不清理（开发期默认）；部署期设 7，代价是更早历史不可重审；`round_id=0` 的群聊行永不被留存清理。长期态（词条/封禁/日聚合/笔记/审计）永不清理。收割在每轮 surf 末尾自动执行；`check` 不收割。已收录词条在群聊里的野外命中（wildRecheck）自动进命中日账本。

## 行为要点

- **backtest 闸门**：留出集命中率 ≥0.7、负例误报率 ≤0.02；候选用例按 canonical evidence keys（name/实际 lex terms/skeleton 字面核心；`--match-aliases` 后别名才进入 lex terms）筛选，只保留命中完整形的用例、剔除截断宿主词的普通用法，空集报 `MEME_HOLDOUT_REQUIRED`，必须用可重复 `--holdout-text` 提供独立例句；不达标报 `MEME_BACKTEST_FAIL`，`--force` 跳过并审计实际是否降级
- **重名与收口**：add 产出与库内词条同名/同别名 → `MEME_DUPLICATE` 引导 iterate；成功后收口显式 cids + head 精确等于 canonical name/aliases 的所有 active 候选（跨通道），审计列出 closed cids/heads
- **aliases 契约**：默认只做元数据、解析、重名与家族收口；`--match-aliases` 才把非槽位 aliases 合并进 lex matcher，交互梗 aliases 不得绕过上下文
- **观察期隔离**：observing 词条只服务理解侧——理解错梗无害，表达用错才是事故。
- **遗忘**：词条侧 active → fading（观测日口径均值较峰值 -50%）→ tombstone（近零）；复活先给最小卡；词条永不删除，ID 永不回收。候选侧按部署生命周期休眠/删除；不再维护永久待裁决队列。`rejected` 状态用于记录精确封禁，`allow` 可恢复对应候选。
- **降级**：B站获取失败不阻塞 surf，从原始湖存量照常执行一轮；`--no-fetch` 同样推进轮次、认领群聊、更新证据、重算状态并收割。

## 开发

```sh
npm install
npm test                # 离线测试（假 fetcher + 假嵌入器 + 强制词法降级 + 假 agent 注册表）
npm run typecheck
npm run build
npx tsx scripts/replay.ts          # 真实湖回放：量化发现质量（召回/榜首质量/触发数）
npx tsx scripts/benchmark-score.ts # 当前 v2（修复后上下文）评分；v1 用 --dataset benchmarks/candidate-judgment-v1
npx tsx scripts/rebuild.ts         # 候选池重建（预览）；--apply 就地重建真实库
npx tsx scripts/chat-sim.ts        # 群聊场景模拟：理解向 lookup + 接话向 search
# 操作判定手册见 docs/meme-judgment-guide.md；文献依据见 docs/references.md
```

## 已知边界（v0.13）

- 向量模型（fastembed `BAAI/bge-small-zh-v1.5`）首次使用需联网下载；离线时向量层降级为纯词法。
- B站搜索接口需登录态（`meme auth login`），匿名时探测通道自动跳过；`meme auth status` 可先查状态。
- 图梗只发现（pHash 簇）不识图——理解留给操作员看图判断（check --focus 会列出候选的来源视频与用例）。
- 收录与修订由操作员 agent 亲写 entry，CLI 不外呼任何 LLM；闸门（JSON 校验 / matcher 编译 / backtest）全本地。
