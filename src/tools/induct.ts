/** write path 工具：add / iterate / edit。发生 LLM 推理与外部调用的入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as audit from '../audit.ts'
import * as entries from '../entries.ts'
import * as lifecycle from '../lifecycle.ts'
import { notFound } from '../errors.ts'
import type { Json } from '../models.ts'
import { addResultToDict, runAdd, runAddEntry, runIterate } from '../induct/inductor.ts'
import { validateAndCompile } from '../induct/compileMatcher.ts'
import * as cards from '../render/cards.ts'
import { nearby, openOut, toToolError, type Runtime } from './runtime.ts'

const text = (v: unknown): string => {
  const d = v as Record<string, unknown>
  return typeof d.human === 'string' ? d.human : JSON.stringify(d, null, 1)
}

const backtestLine = (bt: { hit_rate: number; holdout_size?: number; fp_rate: number; negatives?: number } | null): string => {
  if (!bt) return ''
  return `\n  backtest: 命中 ${Math.round(bt.hit_rate * 100)}%${bt.holdout_size !== undefined ? `（留出 ${bt.holdout_size}）` : ''}`
    + `｜误报 ${(bt.fp_rate * 100).toFixed(1)}%${bt.negatives !== undefined ? `（${bt.negatives} 负例）` : ''}`
}

export function registerInductTools(ctx: Context, rt: Runtime): void {
  ctx.tools.register(defineTool({
    name: 'meme_add',
    description: '归纳入库：处理候选（cid），或收录裸文本（text）。'
      + '推荐 entry 路径——你亲写词条 JSON，零外部 LLM 调用，本地闸门（schema 校验→matcher 编译→backtest）全数保留，'
      + '未达标报 MEME_BACKTEST_FAIL 附漏报/误报样例供修订，force=true 跳过（降级纯向量）。'
      + '重名会报 MEME_DUPLICATE 引导 iterate。entry schema 见系统提示的 meme 手册。',
    parameters: {
      cid: { type: 'string', description: '候选 id（surf 输出的 c_NNNN）' },
      text: { type: 'string', description: '裸文本（新梗直收录，observing 入库）' },
      ctx: { type: 'string', description: '裸文本的出处/上下文' },
      entry: { type: 'json', description: '操作员亲写词条 JSON（schema 同归纳器输出，见手册）' },
      force: { type: 'boolean', description: '连同 entry：backtest 未达标仍入库（纯向量降级，进审计）' },
      kind: { type: 'string', enum: ['word', 'formula', 'format', 'interaction', 'event', 'derived'], description: '覆盖 triage 类别预判（仅 LLM 路径）' },
    },
    output: { ...openOut({ id: { type: 'string' }, name: { type: 'string' }, card: { type: 'json' }, backtest: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 600_000,
    async execute(args, exec): Promise<Record<string, Json>> {
      try {
        const db = rt.db()
        const res = args.entry !== undefined
          ? await runAddEntry(db, rt.cfg, args.entry, { cid: args.cid, text: args.text, force: args.force })
          : await runAdd(db, rt.cfg, {
            cid: args.cid, text: args.text, ctx: args.ctx, force_kind: args.kind,
            llm: rt.llm(), signal: exec.signal,
          })
        const [cardText, cardDict] = cards.card(res.meme)
        let human = `已入库（observing）：\n${cardText}${backtestLine(res.backtest)}`
        for (const w of res.warnings) human += `\n  ⚠ ${w}`
        return { ...addResultToDict(res), card: cardDict, human }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meme_iterate',
    description: '重归纳词条：野外新证据 + 旧卡先验 → 修订版（原位更新，保留 id/state/stats）。'
      + '高频操作——首轮归纳常有偏差（释义过度概括/类别误判/匹配器漏报变体），修订应当常做。'
      + 'entry 路径 = 你亲写修订版 JSON（零外部 LLM）；无 entry 走归纳器。',
    parameters: {
      mid: { type: 'string', required: true, description: '词条 id（m_NNNN）' },
      entry: { type: 'json', description: '操作员亲写修订版词条 JSON（schema 同 meme_add 的 entry）' },
      force: { type: 'boolean', description: 'backtest 未达标仍更新（降级纯向量，进审计）' },
    },
    output: { ...openOut({ id: { type: 'string' }, name: { type: 'string' }, card: { type: 'json' }, backtest: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 600_000,
    async execute(args, exec): Promise<Record<string, Json>> {
      try {
        const res = await runIterate(rt.db(), rt.cfg, args.mid, {
          entry: args.entry, force: args.force, llm: rt.llm(), signal: exec.signal,
        })
        const [cardText, cardDict] = cards.card(res.meme)
        let human = `已修订（${res.meme.id} 保持 ${res.meme.state}）：\n${cardText}${backtestLine(res.backtest)}`
        for (const w of res.warnings) human += `\n  ⚠ ${w}`
        return { ...addResultToDict(res), card: cardDict, action: 'iterate', human }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meme_edit',
    description: '轻量修订词条：收编变体 / 追加词义演化 / 升降格 / 修释义 / 复活。全部动作强制记审计。',
    parameters: {
      mid: { type: 'string', required: true, description: '词条 id 或名字/别名' },
      variant: { type: 'array', items: { type: 'string' }, description: '收编新变体/别名（骨架漂移的吸收）' },
      drift: { type: 'string', description: "追加词义演化：'分期: 变化描述'" },
      promote: { type: 'boolean', description: 'observing → active 升格' },
      kill: { type: 'boolean', description: '主观判死：加速降级' },
      gist: { type: 'string', description: '修正释义' },
      revive: { type: 'boolean', description: 'fading/tombstone → active 复活（先给最小卡）' },
      reason: { type: 'string', description: '动作理由（进审计日志）' },
      source: { type: 'string', enum: ['surf', 'lookup', 'note', 'edit'], description: '洞察来源（进审计日志，默认 edit）' },
    },
    output: { ...openOut({ id: { type: 'string' }, actions: { type: 'json' }, card: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 60_000,
    async execute(args): Promise<Record<string, Json>> {
      try {
        const db = rt.db()
        const m = entries.resolve(db, args.mid)
        if (!m) throw notFound(args.mid, await nearby(rt, args.mid))
        const source = (args.source ?? 'edit') as audit.AuditSource
        const reason = args.reason ?? ''
        const actions: string[] = []
        if (args.variant?.length) {
          for (const v of args.variant) if (!m.aliases.includes(v)) m.aliases.push(v)
          if (m.matcher) {
            for (const p of m.matcher.patterns) {
              if (p.kind === 'lex') p.terms = [...new Set([...p.terms, ...args.variant])]
            }
            try {
              m.matcher = validateAndCompile(m.matcher)
            } catch (e) {
              actions.push(`⚠ matcher 校验失败保持原样：${e instanceof Error ? e.message : e}`)
            }
          }
          audit.record(db, m.id, 'edit_variant', source, { variants: args.variant, reason })
          actions.push(`变体收编：${args.variant.join('、')}`)
        }
        if (args.drift) {
          const idx = args.drift.indexOf(':')
          const period = args.drift.slice(0, idx).trim()
          const change = args.drift.slice(idx + 1).trim()
          m.drift = [...m.drift, { period, change, evidence: null }]
          audit.record(db, m.id, 'edit_drift', source, { drift: args.drift, reason })
          actions.push(`drift 追加：${period} → ${change}`)
        }
        if (args.promote) {
          lifecycle.promote(db, m, source, reason)
          actions.push('已升格 active')
        }
        if (args.kill) {
          lifecycle.kill(db, m, source, reason)
          actions.push('已判死（加速降级 fading）')
        }
        if (args.revive) {
          lifecycle.revive(db, m, source, reason)
          actions.push('已复活（先给最小卡，确认后恢复完整卡）')
        }
        if (args.gist) {
          m.card.gist = args.gist
          audit.record(db, m.id, 'edit_gist', source, { gist: args.gist, reason })
          actions.push('释义已修正')
        }
        if (!actions.length) {
          throw toToolError(new Error('未指定任何编辑动作：用 variant/drift/promote/kill/gist/revive 之一。'))
        }
        entries.save(db, m)
        const [cardText, cardDict] = cards.card(m)
        return { id: m.id, actions, card: cardDict, human: actions.join('\n') + '\n' + cardText }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))
}
