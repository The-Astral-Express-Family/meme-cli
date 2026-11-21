# dsh-meme —— 梗百科（deepseek-harness 纯 CLI 插件）

由 LLM 操作员驱动的梗百科：梗的**采集**（surf）、**收录**（add：操作员亲写词条）、**修订**（iterate / edit）、**检索**（lookup / search / show）与**生命周期管理**（遗忘 = 降级 + 压缩，不是删除）。库与 CLI **平台无关**——群聊、直播、任何文本里的梗都能 lookup 与收录（来源自动落 `platform` 元数据：surf 候选标 bilibili，其余留空）；B站 surf 是发现端（采集站外新梗）。

目标场景：一个 agent 要在互联网时代的玩梗群里有趣地互动——理解别人在玩什么梗（lookup）、
自己接梗时不出错（卡片的 usage/taboo/aggression）、发现群外正在发生的新梗（surf）、
并且知道自己的梗知识可能是错的（iterate）。

- **纯 CLI 形态**：harness 工具目录**零占用**——操作面全部在 `meme` CLI，主控 agent 经 bash/pwsh 调用；插件本体只做两件事：注册 meme skill（一句话目录 + 按需展开的手册）、shellEnv 注入调用入口。
- **读写路径分离**：write path 只有 surf 外呼 B站；add / iterate 是操作员亲写词条 + 全本地闸门（JSON 校验、matcher 编译、backtest），不外呼任何 LLM——操作员本身就是 LLM，归纳不需要再调一个。read path（lookup / search / show）全本地、毫秒级。
- **零自治**：完全被动，什么时候 surf、一轮刷多深，由调用方决断。
- **自持数据**：单个 SQLite 文件（默认 `~/.meme/memes.db`），备份 = 拷贝文件；schema 无迁移路径，旧版库文件一律拒收（删除重建）。
- **干净安装**：`npm install` 即全部（node:sqlite + 预编译二进制依赖），与 harness 分发模型一致。

## 接入形态

一个 npm 包，两个面：

| 面 | 入口 | 作用 |
| --- | --- | --- |
| **CLI**（操作面） | `bin` 的 `meme`（`lib/cli.js`） | 9 组子命令，stdout = 单行 JSON（agent 消费），stderr = 人读文本；业务失败 exit 1 且 stdout 仍有 `{"error":{"code","message","suggestion",...}}`，用法错误 exit 2 |
| **shim**（插件面，prompt-only） | `lib/index.js`，`inject: ['skills', 'shellEnv']` | ① `ctx.skills.register` 注册 meme 技能——**未激活形态只有技能目录里的一行**（81 字符 ≈ 57 tokens 常驻）；模型经 `skill` 工具按需展开全文（≈2.2k tokens，会话瞬态不常驻），**用户消息首行 `/meme` 也是确定性加载手势**；② shellEnv 注入 `DSH_MEME_NODE`（harness 进程的 node）与 `DSH_MEME_BIN`（cli.js 绝对路径）——harness 不给 agent shell 加 PATH，绝对路径变量是插件喂给模型可执行入口的唯一正规通道 |

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
| `meme add` | 收录：`--entry-file`/`--entry-json` 亲写词条（必给其一，闸门全保留）；`--cid`/`--text` 关联候选证据并收口候选 |
| `meme iterate <mid>` | 修订词条：带新证据亲写修订版（原位更新，保留 id/state/stats；释义实质变化自动记 drift） |
| `meme edit <mid>` | 轻量修订（`--variant` / `--drift` / `--promote` / `--kill` / `--gist` / `--revive`） |
| `meme surf` | 一轮 B站获取 + 证据更新 + 四区呈现（数分钟；调用方给足 timeout 或 run_in_background） |
| `meme note add\|list\|show\|edit\|rm` | 笔记增删改查（低信任附着物，永不进 matcher/card） |
| `meme config init` | 写出 `~/.meme/config.json` 模板 |
| `meme login` | 弹出浏览器扫码登录 B站（交互命令，人读输出） |

每个子命令 `--help` 可查详情。entry 走文件通道（agent 先写临时 JSON 文件再 `--entry-file <绝对路径>`），绕开 shell 引号问题。

## 登录（meme login）

搜索探测（surf 的 probe）与完整评论区需要 B站登录态。用户在终端跑一次：

```sh
meme login          # 弹出浏览器扫码页；成功后写 ~/.meme/credentials.json
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
  "detect": { "generic_extra": ["希望"] } // 追加停用词（--ban 沉淀的 kv generic_auto 之外）
}
```

没有凭证类字段：收录与修订由操作员 agent 亲写 entry，CLI 不外呼任何 LLM。环境变量仅作临时覆盖：`MEME_DB`（库路径）。

## 发现端架构（五通道，实战湖回放校准）

| 通道 | 抓什么 | 判别信号 |
| --- | --- | --- |
| phrase | 词梗（"难绷"） | 轮内 2 次/2 视频即立户，跨轮累积 dv |
| copy | 整句复读（"警钟长鸣"） | 归一化文本跨视频重复；回复为主 → interaction 预判 |
| skeleton | 公式/格式（"一眼X鉴定为Y"） | 掩码变体跨文本坍缩；字面 ≥2 字符 |
| 后缀族 | 形态学能产性（"赢麻了/亏麻了/输麻了" → `<X>麻了`） | ≥3 族员且 ≥2 员自身跨视频；句尾收束为主 |
| image | 图梗 | pHash 跨视频聚类（重复即梗） |

**视频标题也是证据**：标题是 up 主刻意为之的文本（写标题要过脑子，评论区是顺手打字），
本身就常在玩梗。标题按 **5 倍评论权重**计票进各通道（跨视频门槛不变——单条标题只算 1 个视频），
两条不同 up 的标题玩同一公式即可立户；入库用例样本不带权重。

**泛用词治理**不靠手工黑名单：GENERIC 只留语法虚词，泛用实词允许入榜但被**梗证据分**
（复读对/骨架坍缩度/独立成评率）压在榜底且永不触发。**触发条件**（冷启动友好）：
跨 ≥2 轮 && ≥4 视频 && ≥3 up && 梗证据分达标 &&（爆发 z≥4 ｜ 广泛 dv≥8 ｜ 新物跨 ≥5 视频）。

## 行为要点

- **backtest 闸门**：留出集命中率 ≥0.7、负例误报率 ≤0.02；不达标报 `MEME_BACKTEST_FAIL` 附样例
  给修订反馈（按漏报/误报样例改 matcher 再交），`--force` 跳过（降级纯向量，进审计）。
- **重名守卫**：add 产出与库内词条同名/同别名 → `MEME_DUPLICATE` 引导 iterate。
- **观察期隔离**：observing 词条只服务理解侧——理解错梗无害，表达用错才是事故。
- **遗忘**：active → fading（90 天窗口频率 -50%）→ tombstone（近零）；复活先给最小卡；词条永不删除，ID 永不回收。
- **降级**：B站获取失败不阻塞 surf，从原始湖存量照常出内容。

## 开发

```sh
npm install
npm test                # 146 个离线测试（假 fetcher + 强制词法降级）
npm run typecheck
npm run build
npx tsx scripts/replay.ts          # 真实湖回放：量化发现质量（召回/榜首质量/触发数）
npx tsx scripts/chat-sim.ts        # 群聊场景模拟：理解向 lookup + 接话向 search
```

## 已知边界（v0.5）

- 向量模型（fastembed `BAAI/bge-small-zh-v1.5`）首次使用需联网下载；离线时向量层降级为纯词法。
- B站搜索接口需登录态（`meme login`），匿名时探测通道自动跳过。
- 图梗只发现（pHash 簇）不识图——理解留给操作员看图判断（surf --focus 会列出候选的来源视频与用例）。
- 收录与修订由操作员 agent 亲写 entry，CLI 不外呼任何 LLM；闸门（JSON 校验 / matcher 编译 / backtest）全本地。
