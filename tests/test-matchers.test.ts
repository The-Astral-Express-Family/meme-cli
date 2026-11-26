/** 匹配器体系：词表约束、骨架槽位、交互配对、流水线分层。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { CompiledMatcher, lookup, matchCompiled } from '../src/match/pipeline.ts'
import { findTerms } from '../src/match/lexicon.ts'
import { compileTokens, matchSkeleton } from '../src/match/skeleton.ts'
import { matchInteraction } from '../src/match/interaction.ts'
import type { PatternSpec } from '../src/models.ts'
import { save as saveMeme } from '../src/entries.ts'
import { makeCfg, makeMeme, matcher, noEmbed, openDb, constraints, pattern } from './helpers.ts'

describe('词表层', () => {
  it('standalone 防长词内部误报', () => {
    const m = makeMeme({ matcher: matcher([pattern({ kind: 'lex', terms: ['典'] })], constraints({ standalone: true })) })
    const cm = new CompiledMatcher(m)
    expect(matchCompiled(cm, '典', null)).not.toBeNull() // 单独成句
    expect(matchCompiled(cm, '这部古籍真是经典', null)).toBeNull() // 长词内部 → 否决
  })

  it('forbid_inner 按分词判定', () => {
    const cons = constraints({ forbid_inner: true })
    expect(findTerms('古典文学研究', ['典'], cons)).toBeNull()
    expect(findTerms('这波操作真典', ['典'], cons)).not.toBeNull()
  })

  it('forbid_context 重叠语义：检查去重叠后的剩余（"回答我吗"→查"吗"）', () => {
    const cons = constraints({ forbid_context: ['回答我吗', '回答我吧', '回答我一下'] })
    expect(findTerms('为什么不回答我吗？', ['回答我'], cons)).toBeNull() // 疑问用法应被否决
    expect(findTerms('回答我！look in my eyes', ['回答我'], cons)).not.toBeNull() // 祈使咆哮应命中
    expect(findTerms('老师回答我一下吧', ['回答我'], cons)).toBeNull()
    expect(findTerms('回答我，为什么改设定', ['回答我'], cons)).not.toBeNull()
  })

  it('forbid_context 不重叠时用两侧窗口（"古典"否决"典"）', () => {
    const cons = constraints({ forbid_context: ['古典'] })
    expect(findTerms('这个太典了', ['典'], cons)).not.toBeNull()
    expect(findTerms('古典文学', ['典'], cons)).toBeNull()
  })
})

describe('骨架层', () => {
  it('槽位通配命中两槽公式', () => {
    const pat = compileTokens(['一眼', '<ent>', '鉴定为', '<ent>'])
    expect(matchSkeleton('一眼原神鉴定为云玩家', pat)).not.toBeNull()
    expect(matchSkeleton('一眼华为鉴定为遥遥领先', pat)).not.toBeNull()
    expect(matchSkeleton('今天天气不错', pat)).toBeNull()
  })

  it('命中 span 映射回原文', () => {
    const pat = compileTokens(['一眼', '<ent>', '鉴定为', '<ent>'])
    const text = '我看了一眼原神鉴定为云玩家，笑死'
    const hit = matchSkeleton(text, pat)!
    expect(text.slice(hit.start, hit.end).startsWith('一眼')).toBe(true)
    expect(text.slice(hit.start, hit.end)).toContain('鉴定为')
  })
})

describe('交互层', () => {
  const pat: PatternSpec = pattern({
    kind: 'interaction',
    trigger_terms: ['什么水平'],
    response_terms: ['你说得对'],
  })

  it('需要会话上下文且 trigger 在前 ≤2 行', () => {
    expect(matchInteraction(['华强买瓜什么水平', '你说得对'], pat)).not.toBeNull()
    expect(matchInteraction(['今天吃什么', '你说得对'], pat)).toBeNull() // 无触发句
    expect(matchInteraction(['你说得对'], pat)).toBeNull() // 无上文
  })
})

describe('流水线', () => {
  let ctx: { db: ReturnType<typeof openDb> }
  beforeEach(() => {
    ctx = { db: openDb(makeCfg().cfg) }
  })

  it('分层去重：骨架层命中唯一', async () => {
    saveMeme(ctx.db, makeMeme({ id: 'm_0001', name: '急', matcher: null }))
    saveMeme(ctx.db, makeMeme({
      id: 'm_0002', name: '一眼X鉴定为Y', class: 'formula',
      matcher: matcher([pattern({ kind: 'skeleton', tokens: ['一眼', '<ent>', '鉴定为', '<ent>'] })]),
    }))
    const hits = await lookup(ctx.db, '一眼原神鉴定为云玩家', null, 0.6, noEmbed())
    expect(hits).toHaveLength(1)
    expect(hits[0].meme_id).toBe('m_0002')
    expect(hits[0].tier).toBe(2)
  })

  it('约束否决的词条不得有向量回声', async () => {
    saveMeme(ctx.db, makeMeme({
      id: 'm_0001', name: '回答我', matcher: matcher(
        [pattern({ kind: 'lex', terms: ['回答我'] })], constraints({ forbid_context: ['为什么'] }),
      ),
    }))
    const hits = await lookup(ctx.db, '为什么不回答我', null, 0.6, noEmbed())
    expect(hits).toEqual([])
  })
})
