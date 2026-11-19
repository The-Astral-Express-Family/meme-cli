/** read path 工具：lookup / search / show。全本地、零外呼、毫秒级。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { confirmRevival, get as getMeme, resolve } from '../entries.ts'
import { notFound } from '../errors.ts'
import type { Json } from '../models.ts'
import { lookup as doLookup } from '../match/pipeline.ts'
import { getEmbedder } from '../match/vector.ts'
import * as cards from '../render/cards.ts'
import { hybridSearch } from '../retrieve/fuse.ts'
import { nearby, openOut, toToolError, type Runtime } from './runtime.ts'

const text = (v: unknown): string => {
  const d = v as Record<string, Json>
  return typeof d.human === 'string' ? d.human : JSON.stringify(d, null, 1)
}

export function registerReadTools(ctx: Context, rt: Runtime): void {
  ctx.tools.register(defineTool({
    name: 'meme_lookup',
    description: '识别一段文本里的 B站梗：命中即内联玩梗卡（释义/用法/禁忌/攻击性），一次调用即可接梗。'
      + '无命中是合法答案（result=miss 会建议收录动作）。交互梗需给 ctx 会话上文。',
    parameters: {
      text: { type: 'string', required: true, description: '待识别文本（待查句本身）' },
      ctx: { type: 'array', items: { type: 'string' }, description: '会话上文行（按时间序，交互梗需要；最后一行自动视为 text）' },
      bare: { type: 'boolean', description: '精简输出：只列命中不附卡片（批量扫描用）' },
    },
    output: { ...openOut({ result: { type: 'string' }, hits: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 120_000,
    async execute(args): Promise<Record<string, Json>> {
      try {
        // 交互梗（tier 3）匹配对象是"最后一行"——待查文本必须作为会话末行参与匹配，
        // ctx 只提供上文；否则 response 会去匹配 ctx 行，span/excerpt 指向错误文本
        const lines = [...(args.ctx ?? []).filter(Boolean), args.text]
        const hits = await doLookup(
          rt.db(), args.text, lines,
          rt.cfg.retrieval.vector_threshold, getEmbedder(rt.cfg.retrieval.embed_model),
        )
        const payloadHits: Record<string, Json>[] = []
        const humanLines: string[] = []
        for (const h of hits) {
          const d: Record<string, Json> = {
            meme_id: h.meme_id, name: h.name, class: h.class,
            span: [h.start, h.end], excerpt: h.excerpt.slice(0, 24),
            tier: h.tier, confidence: Math.round(h.confidence * 1000) / 1000, method: h.method,
          }
          const m = getMeme(rt.db(), h.meme_id)
          if (m && !args.bare) {
            // 玩梗卡内联：释义 + 前两条用法 + 禁忌（agent 拿到即可接梗）
            d.card = {
              gist: m.card.gist, usage: m.card.usage.slice(0, 2), taboo: m.card.taboo,
              aggression: m.card.aggression, register: m.card.register, state: m.state,
            }
            let line = `✓ ${h.meme_id} ${h.name} [${h.confidence.toFixed(2)} ${h.method}] span ${h.start}-${h.end} "${h.excerpt.slice(0, 24)}"`
            line += `\n    ${m.card.gist}`
            for (const u of m.card.usage.slice(0, 2)) line += `\n    · ${u}`
            if (m.card.taboo) line += `\n    忌：${m.card.taboo}`
            if (m.state === 'observing') line += '\n    [observing] 表达使用前先核对'
            humanLines.push(line)
          } else {
            humanLines.push(`✓ ${h.meme_id} ${h.name} [${h.confidence.toFixed(2)} ${h.method}]`)
          }
          payloadHits.push(d)
        }
        if (hits.length) {
          let human = humanLines.join('\n')
          if (hits.some((h) => h.tier === 4)) human += '\n（含低置信向量命中，建议 meme_show 核对）'
          return { result: 'hit', hits: payloadHits, human }
        }
        const suggestion = `可先用 meme_add 收录裸文本 "${args.text.slice(0, 20)}"（observing 入库），或 meme_note 记录疑点。`
        return {
          result: 'miss', hits: [], nearby: await nearby(rt, args.text), suggestion,
          human: `未知：未识别出已知梗。\n建议：${suggestion}`,
        }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meme_search',
    description: '模糊回忆式检索梗库（BM25 + 例句向量混合，RRF 融合）："那个……的梗叫什么来着"。'
      + 'tombstone 默认退出检索，all=true 含归档。',
    parameters: {
      query: { type: 'string', required: true, description: '情境描述 / 梗的局部记忆' },
      top: { type: 'integer', description: '返回条数（默认 8）' },
      all: { type: 'boolean', description: '包含归档区词条' },
    },
    output: { ...openOut({ result: { type: 'string' }, query: { type: 'string' }, results: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 120_000,
    async execute(args): Promise<Record<string, Json>> {
      try {
        const results = await hybridSearch(rt.db(), args.query, rt.cfg.retrieval, {
          top: args.top ?? undefined, includeArchived: args.all ?? false,
        })
        if (!results.length) {
          const suggestion = '词库可能尚小或该梗未入库：meme_surf 策展采集，或 meme_add 直接收录。'
          return { result: 'empty', results: [], suggestion, human: `无结果：词库中未找到相近词条。\n建议：${suggestion}` }
        }
        return {
          result: 'ok',
          query: args.query,
          results: results.map((r) => ({
            id: r.meme.id, name: r.meme.name, class: r.meme.class,
            gist: r.meme.card.gist, state: r.meme.state, score: r.score,
          })),
          human: results.map((r) => r.brief).join('\n'),
        }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meme_show',
    description: '词条分级输出：brief 一行 / card 玩梗卡（默认，约100 token）/ full 全量（词源/演化/审计）。'
      + 'ID 与名字/别名均可解析。',
    parameters: {
      ref: { type: 'string', required: true, description: '词条 id（m_NNNN）或名字/别名' },
      level: { type: 'string', enum: ['brief', 'card', 'full'], description: '输出级别（默认 card）' },
    },
    output: { ...openOut({ level: { type: 'string' }, meme: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 60_000,
    async execute(args): Promise<Record<string, Json>> {
      try {
        const db = rt.db()
        let m = resolve(db, args.ref)
        if (!m) throw notFound(args.ref, await nearby(rt, args.ref))
        const level = args.level ?? rt.cfg.retrieval.default_level
        m = confirmRevival(db, m, level) // 复活确认流（领域层）
        const [textOut, d] = level === 'brief' ? cards.brief(m) : level === 'full' ? cards.full(m, db) : cards.card(m)
        return { level, meme: d, human: textOut }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))
}
