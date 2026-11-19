# dsh-meme —— B站梗百科（deepseek-harness 插件）

由 LLM 操作员驱动的 B站梗百科：梗的**采集**（surf）、**归纳**（add）、**迭代**（iterate）、**修订**（edit）、**检索**（lookup / search / show）与**生命周期管理**（遗忘 = 降级 + 压缩，不是删除）。

目标场景：一个 agent 要在互联网时代的玩梗群里有趣地互动——理解别人在玩什么梗（lookup）、
自己接梗时不出错（卡片的 usage/taboo/aggression）、发现群外正在发生的新梗（surf）、
并且知道自己的梗知识可能是错的（iterate）。

- **工具即入口**：8 个 `meme_*` 工具（defineTool 注册），玩法手册经 systemPrompt 暴露给主控 agent——无 CLI 装配壳。
- **读写路径分离**：write path（surf / add / iterate）发生 LLM 推理与外呼；read path（lookup / search / show）全本地、毫秒级。
- **零自治**：完全被动，什么时候 surf、一轮刷多深，由调用方决断。
- **自持数据**：单个 SQLite 文件（默认 `~/.meme/memes.db`），备份 = 拷贝文件；数据格式与 Python v0.2 双向兼容。
- **干净安装**：`npm install` 即全部（node:sqlite + 预编译二进制依赖），与 harness 分发模型一致。

## 安装

```sh
# 在 dsh profile 内
dsh plugin --profile <name> add ./dsh-meme     # 本地 checkout
dsh plugin --profile <name> add github:you/dsh-meme   # git（需 pnpm allowBuilds + prepare 构建）
```

要求 Node ≥ 22.19（node:sqlite），dsh ≥ 0.2.0。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `meme_lookup` | 识别文本中的梗——命中内联玩梗卡，一次调用即可接梗 |
| `meme_search` | 模糊回忆式检索（BM25 + 例句级向量混合） |
| `meme_show` | 词条分级输出（brief / card / full） |
| `meme_add` | 归纳入库：候选 cid / 裸文本 / entry 亲写词条（零外部 LLM，闸门全保留） |
| `meme_iterate` | 重归纳词条：野外新证据 + 旧卡先验 → 修订版（原位更新） |
| `meme_edit` | 轻量修订（变体 / drift / 升降格 / 释义 / 复活） |
| `meme_surf` | 一轮 B站获取 + 证据更新 + 四区呈现（策展工作台） |
| `meme_note` | 笔记增删改查（低信任附着物，永不进 matcher/card） |

完整的决策树、玩梗规律与 entry JSON schema 在插件加载时注入系统提示（`src/index.ts` 的 MANUAL）——agent 不需要翻文档。

## 登录（meme login）

搜索探测（surf 的 probe）与完整评论区需要 B站登录态。用户在终端跑一次：

```sh
meme login          # 弹出浏览器扫码页；成功后写 ~/.meme/credentials.json
```

标准扫码登录流（bilibili-API-collect 的 web QR 协议）：本地起一次性回调页 → App 扫码 →
poll 成功后取 SESSDATA/bili_jct/buvid3 → nav 验证身份 → 凭证落盘。插件自动读取该文件。

## 配置（cordis.yml）

全部字段有默认值，按需覆盖（schema 校验在加载时）：

```yaml
- insert:
    - id: meme
      name: dsh-meme
      config:
        db_path: 'D:/data/memes.db'   # 默认 ~/.meme/memes.db（$MEME_DB 覆盖）
        llm_provider: ''              # 归纳用的 harness provider；默认取第一个可用
        fetch:
          regions: [119]              # 鬼畜区；可加 1=动画 4=游戏
          max_video_age_days: 10
          probe_keywords: 3           # 登录态下每轮搜索探测的热词数
        induction:
          model: deepseek-flash
          daily_call_budget: 40
        detect:
          generic_extra: ['希望']     # 追加停用词（--ban 沉淀的 kv generic_auto 之外）
```

环境变量：`MEME_DB`（库路径）、`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`（wire 归纳路径回落时用；
harness 内优先用宿主 llm 服务，无需单独凭证）。

## 发现端架构（五通道，实战湖回放校准）

| 通道 | 抓什么 | 判别信号 |
| --- | --- | --- |
| phrase | 词梗（"难绷"） | 轮内 2 次/2 视频即立户，跨轮累积 dv |
| copy | 整句复读（"警钟长鸣"） | 归一化文本跨视频重复；回复为主 → interaction 预判 |
| skeleton | 公式/格式（"一眼X鉴定为Y"） | 掩码变体跨文本坍缩；字面 ≥2 字符 |
| 后缀族 | 形态学能产性（"赢麻了/亏麻了/输麻了" → `<X>麻了`） | ≥3 族员且 ≥2 员自身跨视频；句尾收束为主 |
| image | 图梗 | pHash 跨视频聚类（重复即梗） |

**泛用词治理**不靠手工黑名单：GENERIC 只留语法虚词，泛用实词允许入榜但被**梗证据分**
（复读对/骨架坍缩度/独立成评率）压在榜底且永不触发。**触发条件**（冷启动友好）：
跨 ≥2 轮 && ≥4 视频 && ≥3 up && 梗证据分达标 &&（爆发 z≥4 ｜ 广泛 dv≥8 ｜ 新物跨 ≥5 视频）。

## 行为要点

- **backtest 闸门**：留出集命中率 ≥0.7、负例误报率 ≤0.02；不达标自动修订一轮，仍不达标降级纯向量
  （entry 路径则报错给修订反馈，force=true 跳过）。
- **重名守卫**：add 产出与库内词条同名/同别名 → `MEME_DUPLICATE` 引导 iterate。
- **观察期隔离**：observing 词条只服务理解侧——理解错梗无害，表达用错才是事故。
- **遗忘**：active → fading（90 天窗口频率 -50%）→ tombstone（近零）；复活先给最小卡；词条永不删除，ID 永不回收。
- **降级**：B站获取失败不阻塞 surf，从原始湖存量照常出内容。

## 开发

```sh
npm install
npm test                # 119 个离线测试（假 fetcher + 假 LLM + 强制词法降级）
npm run typecheck
npm run build
npx tsx scripts/replay.ts          # 真实湖回放：量化发现质量（召回/榜首质量/触发数）
npx tsx scripts/chat-sim.ts        # 群聊场景模拟：理解向 lookup + 接话向 search
```

## 已知边界（v0.3）

- 向量模型（fastembed `BAAI/bge-small-zh-v1.5`）首次使用需联网下载；离线时向量层降级为纯词法。
- B站搜索接口需登录态（`meme login`），匿名时探测通道自动跳过。
- 图梗只发现（pHash 簇）不识图——理解留给归纳时的多模态判断。
