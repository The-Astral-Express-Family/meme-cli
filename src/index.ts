/**
 * dsh-meme 插件入口：B站梗百科工具组（lookup/search/show/add/iterate/edit/surf/note）。
 *
 * 工具描述保持短（进系统提示的按行成本）；完整玩法手册与 entry schema 通过
 * systemPrompt 单段暴露，一处权威。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { SCHEMA_DOC } from './induct/prompts.ts'
import { createRuntime } from './tools/runtime.ts'
import { registerInductTools } from './tools/induct.ts'
import { registerNoteTool } from './tools/notes.ts'
import { registerReadTools } from './tools/read.ts'
import { registerSurfTool } from './tools/surf.ts'

export { Config } from './config.ts'

export const name = 'dsh-meme'
export const inject = ['tools']

/** 面向主控 agent 的玩梗手册：只放反复可用的规律与决策树，不放一次性信息。 */
const MANUAL = `## meme —— B站梗百科

一句话：${'`meme_lookup`'} 理解别人在玩什么梗，${'`meme_add`'} 收录新梗，${'`meme_surf`'} 策展发现，${'`meme_search`'} 模糊回忆。

决策树：
- 群里有人发了句摸不着头脑的话 → meme_lookup（命中即附玩梗卡，可直接接梗）
- lookup miss（合法答案，非错误）→ 确认是梗后 meme_add 的 entry 路径记一笔（observing 入库）
- "那个……的梗叫什么来着" → meme_search（BM25+向量混合）
- 要看完整卡/词源/演化/审计 → meme_show（brief/card/full）
- 发现已收录词条归纳错了 / matcher 漏报变体 → meme_iterate（高频！首轮归纳常有偏差）
- 想知道 B站正在发生什么梗 → meme_surf（候选按梗证据分排序；★可add 优先处理）

反复可用的规律：
- lookup 的 tier 置信分层：①词表 0.95 ②骨架 0.90 ③交互 0.80 ④向量 ≤0.70（向量命中建议 show 核对）
- 交互梗必须给 ctx（会话上文行，按时间序）；没有上文 tier 3 永不触发
- observing 词条可安全用于理解；表达使用前看卡片的 taboo/aggression——理解错梗无害，表达用错才是事故
- matcher 宁窄勿宽：误报（把普通句认成梗）比漏报更糟。单字梗必须 forbid_inner=true
- 重名报 MEME_DUPLICATE → 走 meme_iterate 修订既有词条，绝不重复入库
- backtest 报 MEME_BACKTEST_FAIL 是修订反馈不是故障：按附带的漏报/误报样例改 matcher 再交；确要跳过加 force=true
- 泛用词（"不行/决赛"）允许入榜但梗证分≈0 自动沉底永不触发——不需要手动 reject 它们；reject 只用于真噪音
- 释义实质变化会被 iterate 自动记 drift，无需手动补
- surf 全部数据源失败会自动降级为存量模式（正常行为）；搜索探测（probe）需要登录态：请用户在终端跑 meme login
- 笔记（note）是低信任区：疑点先记 note 不建词条，证据够了再 add

entry JSON schema（meme_add / meme_iterate 的亲写词条路径，全部字段必填，无内容用 null/[]）：
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

export function apply(ctx: Context, config: Config): void {
  const rt = createRuntime(ctx, config)
  registerReadTools(ctx, rt)
  registerInductTools(ctx, rt)
  registerSurfTool(ctx, rt)
  registerNoteTool(ctx, rt)

  const sp = ctx.get('systemPrompt')
  sp?.section({ name: 'tool:meme', order: 2450, text: MANUAL })
}
