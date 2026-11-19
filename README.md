# meme —— B站梗百科 CLI（v2）

由 LLM 操作员驱动的 B站梗百科命令行工具：负责梗的**采集**（surf）、**归纳**（add）、**迭代**（iterate）、**修订**（edit）、**检索**（lookup / search / show）与**生命周期管理**（遗忘 = 降级 + 压缩，不是删除）。

目标场景：一个 LLM 驱动的 agent 机器人要在互联网时代的玩梗群里有趣地互动——
理解别人在玩什么梗（lookup）、自己接梗时不出错（卡片的 usage/taboo/aggression）、
发现群外正在发生的新梗（surf）、并且知道自己的梗知识可能是错的（iterate）。

- **读写路径分离**：write path（surf / add / iterate）是发生 LLM 推理与外呼的地方；read path（lookup / search / show）全本地、零外呼、毫秒级。
- **零自治**：工具完全被动，什么时候 surf、一轮刷多深，完全由调用方决断。
- **自持数据**：单个 SQLite 文件（默认 `~/.meme/memes.db`），备份 = 拷贝文件。

## 安装

```bash
uv tool install .        # 推荐
pipx install .
```

要求 Python ≥ 3.11。

## 命令速览

```
meme surf      一轮 B站获取 + 证据更新 + 四区呈现（策展工作台）
meme add       归纳入库：处理候选，或收录裸文本（重名自动拦截并引导 iterate）
meme iterate   重归纳词条：野外新证据 + 旧卡先验 → 修订版（原位更新）
meme edit      轻量修订（变体 / drift / 升降格 / 释义 / 复活）
meme lookup    识别文本中的梗——命中内联玩梗卡，一次调用即可接梗
meme search    模糊回忆式检索（BM25 + 例句级向量混合）
meme show      词条分级输出（brief / card / full）
meme note      笔记增删改查（低信任附着物，永不进 matcher/card）
```

每个子命令 `-h` 自带 2–3 个可抄示例——help 即全量文档。

## Agent 玩梗手册（5 分钟）

```bash
# 场景 A：群里有人发了句摸不着头脑的话，先识别
meme lookup "这波啊，这波是肉蛋葱鸡"            # 命中 → 直接附释义/用法/禁忌
meme lookup "你说得对" --ctx "上句：华强买瓜什么水平"   # 交互梗需会话上下文

# 场景 B：lookup 没命中（可能是没收录的新梗）
meme add "那咋了" --ctx "群聊：工资又降了"       # 记一笔（observing 入库）
meme note add --head "那咋了" "疑似新句式梗，待验证"   # 或只记疑点不建词条

# 场景 C：策展——发现 B站正在发生什么梗
meme surf                                      # 一轮：热门/推荐流/鬼畜区评论
meme --json surf                               # agent 用：候选全量一次给全
meme surf --focus c_0231                       # 深入单个候选的完整证据
meme add c_0231                                # 归纳（走 triage→LLM→backtest 闸门）

# 场景 D：发现词条归纳错了 / matcher 漏报变体（高频操作！）
meme iterate m_0042                            # 收集野外命中+候选新证据，重归纳
meme iterate m_0042 --entry entry.json         # 操作员亲写修订版（无外部 LLM）

# 场景 E：模糊回忆（"那个……的梗叫什么来着"）
meme search "书名号讽刺"
```

## 模型接入（DSH 生态约定）

归纳器按 deepseek-harness 官方适配器的 Messages 协议直连：

```bash
export DEEPSEEK_API_KEY=sk-...            # 仅 add/iterate 的 LLM 路径需要；read path 无凭证可用
export DEEPSEEK_BASE_URL=...              # 可选，默认 https://api.deepseek.com/anthropic
```

**无 key 的归纳路径**：操作员（LLM agent）本身就是归纳器——`add --entry` / `iterate --entry`
直接提交亲写的词条 JSON，零外部 LLM 调用，本地闸门（schema 校验 → matcher 编译 → backtest）全数保留。审计记录 `model: "operator"`。

## v2 发现端架构（五通道，实战湖回放校准）

v1 的教训（6 轮 surf、720 候选、触发 0、榜首全泛用词）催生了统计判别架构：

| 通道 | 抓什么 | 判别信号 |
| --- | --- | --- |
| phrase | 词梗（"难绷"） | 轮内 2 次/2 视频即立户，**跨轮累积** dv |
| copy | 整句复读（"警钟长鸣"） | 归一化文本跨视频重复；回复为主 → interaction 预判 |
| skeleton | 公式/格式（"一眼X鉴定为Y"） | 掩码变体跨文本坍缩；字面 ≥2 字符 |
| 后缀族 | 形态学能产性（"赢麻了/亏麻了/输麻了" → `<X>麻了`） | ≥3 族员且 ≥2 族员自身跨视频；句尾收束为主 |
| image | 图梗 | pHash 跨视频聚类（重复即梗） |

**泛用词治理**不再靠手工黑名单打地鼠（v1 膨胀到 300+ 仍失守）：GENERIC 只留语法虚词，
泛用实词（"决赛/版本/不行"）允许入榜但被**梗证据分**（evidence.py：跨视频复读对 /
骨架坍缩度 / 独立成评率）压在榜底且永不触发——v1 需要操作员手动 reject 324 次，v2 零次。

**触发条件**（冷启动友好）：跨 ≥2 轮 && ≥4 视频 && ≥3 up && 梗证据分达标 &&（爆发 z≥4 ｜ 广泛 dv≥8 ｜ 新物跨 ≥5 视频）。

## 行为要点

- **backtest 闸门**：留出集命中率 ≥0.7、负例误报率 ≤0.02；不达标自动修订一轮，仍不达标降级纯向量词条（`iterate --entry` 路径则是报错给修订反馈，`--force` 跳过）。
- **重名守卫**：add 产出与库内词条同名/同别名 → `MEME_DUPLICATE` 引导 iterate，防重复入库。
- **观察期隔离**：observing 词条只服务理解侧——理解错梗无害，表达用错才是事故。
- **遗忘**：active → fading（90 天窗口频率 -50%）→ tombstone（近零）；复活先给最小卡；磁盘上的词条永不删除，ID 永不回收。
- **降级**：B站获取失败不阻塞 surf，从原始湖存量照常出内容。

## 配置

配置文件可选，查找顺序：`$MEME_CONFIG` → `./meme.toml` → `~/.meme/meme.toml`。完整可配置项见 [meme.example.toml](meme.example.toml)。环境变量：`MEME_DB`（库路径）、`BILI_SESSDATA`（可选登录态，解锁搜索探测）。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功——**包括 lookup miss / search 空结果**（无结果不是错误，输出形态会区分） |
| 1 | 工具失败（错误信息自带稳定错误码 + 下一步建议） |
| 2 | 用法错误 |

`--json` 输出为单文档 snake_case JSON（`schema_version: 1`），与人类可读输出同源生成。

## 开发

```bash
uv sync
uv run pytest          # 全量测试（离线，假 fetcher + 假 LLM）
uv run python exp/replay.py   # 真实湖回放：量化发现质量（召回/榜首质量/触发数）
```

## 已知边界（v0.2）

- 向量模型（fastembed `BAAI/bge-small-zh-v1.5`）首次使用需联网下载；离线时向量层降级为纯词法（stderr 提示）。
- B站搜索接口需登录态（`sessdata_env` 配置），匿名时探测通道自动跳过。
- 图梗只发现（pHash 簇）不识图——理解留给归纳时的多模态判断。
