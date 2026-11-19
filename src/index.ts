/**
 * dsh-meme shim：prompt-only 插件（零工具注册）。
 * 操作面全部在 meme CLI；本插件只负责让主控 agent 知道它存在、怎么调：
 * ① systemPrompt 注入 CLI 手册（决策树 + 规律 + entry schema，一处权威）
 * ② shellEnv 注入 DSH_MEME_NODE / DSH_MEME_BIN——harness 不给 agent 的 shell
 *    加 PATH，绝对路径变量是插件喂给模型可执行入口的唯一正规通道
 *   （先例：harness 的 skill-office 以同法暴露随包 LibreOffice Kit CLI）。
 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
import { SCHEMA_DOC } from './induct/prompts.ts'

export const name = 'dsh-meme'
export const inject = ['systemPrompt', 'shellEnv']

/** 面向主控 agent 的玩梗手册：只放反复可用的规律与决策树，不放一次性信息。 */
const MANUAL = `## meme —— B站梗百科（CLI）

一句话：\`meme lookup\` 理解别人在玩什么梗，\`meme add\` 收录新梗，\`meme surf\` 策展发现，\`meme search\` 模糊回忆。
调用方式（harness 已注入环境变量，bash）：
\`\`\`
"$DSH_MEME_NODE" "$DSH_MEME_BIN" <子命令> [参数]   # pwsh 用 & $env:DSH_MEME_NODE $env:DSH_MEME_BIN ...
\`\`\`
约定：stdout = 单行 JSON（结构化结果）；stderr = 人读文本；业务失败 exit 1 且 stdout 有 {"error":{"code","message","suggestion",...}}；每个子命令 --help 可查。

决策树：
- 群里有人发了句摸不着头脑的话 → lookup "<text>"（命中返回 hits[]，含玩梗卡，可直接接梗）
- lookup miss（合法答案，非错误）→ 确认是梗后写 entry JSON 文件，add --entry-file <f>（observing 入库）
- "那个……的梗叫什么来着" → search "<情境描述>"（BM25+向量混合）
- 要看完整卡/词源/演化/审计 → show <id|名> --level full
- 发现已收录词条归纳错了 / matcher 漏报变体 → 写修订版 entry 文件，iterate <mid> --entry-file <f>（高频！首轮归纳常有偏差）
- 想知道 B站正在发生什么梗 → surf（候选按梗证据分排序，★可add 优先处理；一轮数分钟，给足 timeout 或 run_in_background）

反复可用的规律：
- lookup 的 tier 置信分层：①词表 0.95 ②骨架 0.90 ③交互 0.80 ④向量 ≤0.70（向量命中建议 show 核对）
- 交互梗必须 --ctx 给会话上文行（按时间序）；没有上文 tier 3 永不触发
- observing 词条可安全用于理解；表达使用前看卡片的 taboo/aggression——理解错梗无害，表达用错才是事故
- matcher 宁窄勿宽：误报（把普通句认成梗）比漏报更糟。单字梗 constraints.forbid_inner 必须 true
- 重名报 MEME_DUPLICATE → 走 iterate 修订既有词条，绝不重复入库
- MEME_BACKTEST_FAIL 是修订反馈不是故障：按 error 附带的漏报/误报样例改 matcher 再交；确要跳过加 --force
- 泛用词（"不行/决赛"）允许入榜但梗证分≈0 自动沉底永不触发——不需要手动 reject；--reject 只用于真噪音
- 释义实质变化会被 iterate 自动记 drift，无需手动补
- surf 全部数据源失败会自动降级为存量模式（正常行为）；probe 探测/完整评论区需要登录态：请用户在终端跑 meme login
- 笔记（note）是低信任区：疑点先 note add --head <词头> 不建词条，证据够了再 add
- entry 路径零外部 LLM 调用，永远优先；不带 entry 的 add/iterate 走外部归纳器，需要 ~/.meme/config.json 里的 induction.api_key（agent shell 会被 harness 剥离密钥类环境变量，凭证必须放配置文件）

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

export function apply(ctx: Context): void {
  ctx.shellEnv.register(contributor)
  const sp = ctx.get('systemPrompt')
  sp?.section({ name: 'meme', order: 2450, text: MANUAL })
}
