/** surf 工具：一轮 B站获取 + 证据更新 + 四区呈现（策展工作台）。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemeError } from '../errors.ts'
import type { Json } from '../models.ts'
import { handleAllow, handleReject, runSurf } from '../surf/run.ts'
import { openOut, toToolError, type Runtime } from './runtime.ts'

const text = (v: unknown): string => {
  const d = v as Record<string, unknown>
  return typeof d.human === 'string' ? d.human : JSON.stringify(d, null, 1)
}

export function registerSurfTool(ctx: Context, rt: Runtime): void {
  ctx.tools.register(defineTool({
    name: 'meme_surf',
    description: '一轮 B站策展：增量获取（推荐流/热门/分区/楼中楼）→ 证据更新（零 LLM）→ 四区呈现'
      + '（新候选/已有梗动态/衰减/欠账）。候选按梗证据分排序，★可add 的优先处理。'
      + '获取失败自动降级为存量模式。变体探测/搜索需登录态（meme login）。',
    parameters: {
      focus: { type: 'string', description: '深入单个候选的完整证据视图（cid）' },
      more: { type: 'boolean', description: '翻页：呈现下一页候选（不重新获取）' },
      reject: { type: 'array', items: { type: 'string' }, description: '显式跳过候选（cid 列表，幂等）' },
      ban: { type: 'boolean', description: '连同 reject：把词头沉淀为持久停用词（信号层永久过滤）' },
      allow: { type: 'array', items: { type: 'string' }, description: '豁免词：从停用词中放行（误杀逃生口）' },
      round_size: { type: 'integer', description: '每页呈现条数（默认取配置）' },
      no_fetch: { type: 'boolean', description: '跳过获取，纯存量呈现（降级模式）' },
      probe: { type: 'array', items: { type: 'string' }, description: '定向搜索探测词（需登录态）' },
    },
    output: { ...openOut({ counts: { type: 'json' }, new_candidates_raw: { type: 'json' }, dynamics: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 600_000, // 一轮 = 采样 + 逐视频评论 + 楼中楼，礼貌延迟下数分钟
    async execute(args, exec): Promise<Record<string, Json>> {
      try {
        const db = rt.db()
        if (args.allow?.length) {
          const allowed = handleAllow(db, args.allow)
          return { allowed, human: `已豁免 ${allowed.join('、')}：下一轮起恢复候选资格` }
        }
        if (args.reject?.length) {
          try {
            const { done, banned } = handleReject(db, args.reject, args.ban ?? false)
            const note = banned.length ? `（词头 ${banned.join('、')} 已沉淀为持久停用词）` : ''
            return { rejected: done, banned, human: `已跳过 ${done.join('、')}${note}` }
          } catch (e) {
            // 不存在的 cid（多半手抄错）：报错引导
            throw toToolError(new MemeError(
              'CANDIDATE_NOT_FOUND',
              `候选 ${(e as Error).message.replace(/^KeyError:\s*/, '')} 不存在或已出队`,
              '用 surf 输出里的 cid。',
            ))
          }
        }
        const result = await runSurf(db, rt.cfg, {
          focus: args.focus,
          more: args.more,
          roundSize: args.round_size,
          noFetch: args.no_fetch,
          probe: args.probe,
          full: true, // agent 输出一次给全量候选（不翻页）
          llm: rt.llm(),
          signal: exec.signal,
        })
        return { ...result.payload, human: result.human }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))
}
