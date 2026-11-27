/**
 * dsh-meme shim：prompt-only 插件（零工具注册）。
 * 操作面全部在 meme CLI；本插件只负责让主控 agent 知道它存在、怎么调：
 * ① skill 注册——未激活形态只有技能目录里的一行 name+description，
 *    模型经 `skill meme` 工具按需展开全文，用户消息首行 `/meme` 也是
 *    确定性加载手势。手册（决策树/规律/entry schema）不常驻系统提示。
 * ② shellEnv 注入 DSH_MEME_NODE / DSH_MEME_BIN——harness 不给 agent 的
 *    shell 加 PATH，绝对路径变量是插件喂给模型可执行入口的唯一正规通道
 *   （先例：harness 的 skill-office 以同法暴露随包 LibreOffice Kit CLI）。
 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { loadConfig } from './config.ts'
import { SCHEMA_DOC } from './models.ts'
import { startQQBot, type QQBotHandle } from './qq/bot.ts'

export const name = 'dsh-meme'
export const inject = ['skills', 'shellEnv', 'agents']

/**
 * 技能手册全文。它是答题 agent 操作 meme CLI 的说明面：
 * 改这里会改变 curator-v1 策展题被测 agent 的行为面——示例不能用 benchmarks/
 * 金标里的梗（泄题），新增示例前先对照 candidate-judgment-v4/labels.jsonl。
 */
export const MANUAL = `# meme —— 梗百科（CLI）

一句话：\`meme lookup\` 理解别人在玩什么梗，\`meme add\` 收录新梗，\`meme surf\` 策展发现，\`meme search\` 模糊回忆。
梗库不限来源：群聊、直播、任何文本里的梗都能 lookup 与收录；surf 只是 B站采集端。
调用方式（harness 已注入环境变量，bash）：
\`\`\`
"$DSH_MEME_NODE" "$DSH_MEME_BIN" <子命令> [参数]   # pwsh 用 & $env:DSH_MEME_NODE $env:DSH_MEME_BIN ...
\`\`\`
约定：stdout = 单行 JSON（结构化结果）；stderr = 人读文本；业务失败 exit 1 且 stdout 有 {"error":{"code","message","suggestion",...}}；每个子命令 --help 可查。

判定主判据（先判断，再看统计）：
1. 形成时间：这种表述此前不存在、近期才出现吗？管道不自动判断形成时间。
2. 典故或公式：它承载事件引用，或有可自由填槽的公式吗？
3. 新惯用用法：它是旧词的新用法吗？词类（话题词/普通词/泛夸）不是主要判据。
统计门只负责把值得看的条目送上来：话题词和普通词也可能过门；★只表示待人工判断，不表示已确认是梗。

决策树：
- 群里有人发了句摸不着头脑的话 → lookup "<text>"（命中返回 hits[]，含玩梗卡，可直接接梗）
- lookup miss（合法答案，非错误）→ 确认是梗后写 entry JSON 文件，add --entry-file <f>（observing 入库）
- "那个……的梗叫什么来着" → search "<情境描述>"（BM25+向量混合）
- 要看完整卡/词源/演化/审计 → show <id|名> --level full
- 发现已收录词条归纳错了 / matcher 漏报变体 → 写修订版 entry 文件，iterate <mid> --entry-file <f>（高频！首轮归纳常有偏差）
- 想知道 B站正在发生什么梗 → surf（执行一轮并呈现当前过门条目；数分钟，给足 timeout 或 run_in_background）
- 只想看当前窗口过门条目 → meme check [--focus <cid>] [--page N] [--round-size N]（只读，不推进轮次）
- 确认是噪音 → meme ban <精确词头...>；误封 → meme allow <精确词头...>

反复可用的规律：
- lookup 的 tier 置信分层：①词表 0.95 ②骨架 0.90 ③交互 0.80 ④向量 ≤0.70（向量命中建议 show 核对）
- 交互梗必须 --ctx 给会话上文行（按时间序）；没有上文 tier 3 永不触发
- observing 词条可安全用于理解；表达使用前看卡片的 taboo/aggression——理解错梗无害，表达用错才是事故
- matcher 宁窄勿宽：误报（把普通句认成梗）比漏报更糟。单字梗 constraints.forbid_inner 必须 true
- 重名报 MEME_DUPLICATE → 走 iterate 修订既有词条，绝不重复入库
- MEME_BACKTEST_FAIL 是修订反馈不是故障：按 error 附带的漏报/误报样例改 matcher 再交；确要跳过加 --force
- 触发条件每轮对醒着的 pending/triggered 重算：达标 → triggered，不再达标 → pending（返回 demoted）。triggered 不粘住，没有永久待裁决队列；阈值附近抖动先直接呈现，靠回放观察
- 最小证据：pending 至少 2 条有效用例，skeleton 至少 3 条；独立成评只认归一化文本等于或严格包含候选完整形，模板按槽位形状另算
- 家族收口：同一梗的多形态（蚌埠住了/蚌住了）只建一个 entry，用 aliases 收变体；add/iterate 成功后自动收口显式 cid 及 head 精确等于 canonical name/aliases 的所有 active 候选（跨通道）
- aliases 默认只做元数据、名字解析、重名守卫与家族收口；只有 --match-aliases 才把非槽位 aliases 合并进 lex matcher。交互梗 aliases 永不增加可绕过上下文的词表命中
- ban 是精确归一化词头，跨 phrase/copy/skeleton/image 生效；不做子串或语义家族封禁。ban “启动”不会封 “<X>启动” 或 “启动器”
- check 只读：不写 surf_round、不认领 QQ、不收割、不写 kv、不改候选状态。surf --no-fetch 只是不联网，仍会推进一轮并执行认领、证据更新、状态重算与收割
- benchmarks/ 的人工标签只用于离线评估，严禁进入运行时词表、规则或提示
- 释义实质变化会被 iterate 自动记 drift，无需手动补
- surf 全部数据源失败会自动降级（正常行为）；probe 探测/完整评论区需要登录态：先 auth status 查状态，未登录请用户在终端跑 meme auth login 扫码
- 笔记（note）是低信任区：疑点先 note add --head <词头> 不建词条，证据够了再 add
- add/iterate 只收 entry 文件——归纳由你（操作员）亲写，没有外部归纳器；写前先取证（check --focus <cid> 看候选完整证据，show --level full 看词条全量）
- --cid 可重复；--text 先精确、再唯一前缀/包含解析，多义必须 --cid。所有 cid 在写库前预检
- 候选留出集按 canonical evidence keys（name/实际 lex terms/skeleton 字面核心；--match-aliases 后别名才进入 lex terms）筛选：只保留命中完整形的用例，剔除截断宿主词的普通用法；空集报 MEME_HOLDOUT_REQUIRED，必须用可重复的 --holdout-text 提供独立例句，不回退污染全集
- 交互梗留出必须是有效触发对；可用 “上句：X 本句：Y”。纯向量词条恢复 matcher 需独立野外/候选证据或显式留出；否则 MEME_MATCHER_EVIDENCE_REQUIRED，确认绕过可加 --force 并进审计

entry JSON schema（add --entry-file / iterate --entry-file 的词条文件，全部字段必填，无内容用 null/[]）：
${SCHEMA_DOC}

最小可抄 entry 示例：
\`\`\`json
{
  "name": "我软脚了", "aliases": ["软脚了"], "class": "word", "birth_circa": "2024",
  "card": {"gist": "关键局操作变形的自嘲", "usage": ["决胜局我软脚了"],
           "taboo": "别用于真实伤病", "register": "电竞圈", "aggression": "低"},
  "examples": ["决胜局我软脚了"],
  "matcher": {"patterns": [{"kind": "lex", "terms": ["我软脚了", "软脚了"]}],
              "constraints": {"forbid_inner": true}},
  "lineage_parent": null, "lineage_mutation": null, "notes": null
}
\`\`\``

/** 未激活形态 = 目录一行（≤500 字符上限内的一句路由描述）；展开靠 skill 工具或用户 /meme。 */
const SKILL: SkillRegistration = {
  name: 'meme',
  source: 'runtime',
  description: '梗百科 CLI（meme）：识别/接梗/收录/检索/修订梗——不限来源，群聊梗可直接收录；surf 采B站新梗'
    + '——群里出现摸不着头脑的梗、要收录新梗、回忆梗名时先加载本技能',
  content: MANUAL,
}

/** bundler 对 new URL('相对字面量', import.meta.url) 有静态 asset 解析倾向；手工拼 URL 避开。 */
function cliEntrypoint(): string {
  return fileURLToPath(import.meta.url.replace(/[^/]*$/, 'cli.js'))
}

const contributor: BashEnvContributor = {
  name: 'dsh-meme',
  variables: {
    DSH_MEME_NODE: { description: '运行 meme CLI 用的 node 可执行文件（harness 进程自带的那个）' },
    DSH_MEME_BIN: { description: 'meme CLI 入口脚本（cli.js）绝对路径' },
  },
  resolve: () => ({ DSH_MEME_NODE: process.execPath, DSH_MEME_BIN: cliEntrypoint() }),
}

export function apply(ctx: Context): (() => void) | void {
  ctx.skills.register(SKILL)
  ctx.shellEnv.register(contributor)
  // QQ 群聊 bot（可选）：config.json 填了 qq.app_id（或设环境变量 QQBOT_APPID）才启动；
  // 不配 = 纯 B站模式，行为与过去完全一致。启动/运行错误全兜日志，
  // 绝不影响 skill 与 shellEnv（bot 是附加能力，梗库操作面不依赖它）。
  let bot: QQBotHandle | null = null
  try {
    const cfg = loadConfig()
    if (cfg.qq.app_id || process.env.QQBOT_APPID) {
      void startQQBot({ ctx, cfg: cfg.qq, dbPath: cfg.dbPath })
        .then((h) => { bot = h })
        .catch((e) => console.error(`[dsh-meme] QQ bot 启动失败：${e instanceof Error ? e.message : e}`))
    }
  } catch (e) {
    console.error(`[dsh-meme] 配置读取失败（QQ bot 未启动）：${e instanceof Error ? e.message : e}`)
  }
  return () => {
    void bot?.stop()
  }
}
