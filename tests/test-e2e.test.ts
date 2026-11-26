/** 端到端（领域流）：lookup 玩梗卡、show 分级、note 增删改查、edit 修订。CLI 层已由工具层取代。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { save as saveMeme, resolve as resolveMeme } from '../src/entries.ts'
import * as notes from '../src/notes.ts'
import { lookup } from '../src/match/pipeline.ts'
import { hybridSearch } from '../src/retrieve/fuse.ts'
import * as cards from '../src/render/cards.ts'
import { makeMeme, matcher, constraints, noEmbed, pattern } from './helpers.ts'
import { makeCfg, openDb } from './helpers.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

function installWordMeme() {
  const m = makeMeme({
    id: 'm_0001', name: '典', aliases: ['典中典'], class: 'word', state: 'active',
    card: {
      gist: '单字反讽"经典"', usage: ['这波是典'],
      taboo: '真诚场合慎用', register: '泛B站', aggression: '中',
    },
    examples: ['这就是典中典吧'],
    matcher: matcher(
      [pattern({ kind: 'lex', terms: ['典', '典中典'] })],
      constraints({ standalone: true, forbid_context: ['古典', '经典'] }),
    ),
  })
  saveMeme(env.db, m)
  return m
}

describe('lookup', () => {
  it('命中附玩梗卡（gist/usage/taboo 内联）', async () => {
    installWordMeme()
    const hits = await lookup(env.db, '这波啊，这波是典', null, 0.6, noEmbed())
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].method).toBe('lexicon')
  })

  it('miss 是合法答案', async () => {
    installWordMeme()
    const hits = await lookup(env.db, '普通得不能再普通的一句话', null, 0.6, noEmbed())
    expect(hits).toEqual([])
  })

  it('lookup 玩梗卡字段（工具层口径）', async () => {
    const m = makeMeme({
      id: 'm_0001', name: '我软脚了', state: 'active',
      card: {
        gist: '关键局操作变形的自嘲', usage: ['决胜局我软脚了'],
        taboo: '别用于真实伤病', register: '电竞圈', aggression: '低',
      },
      matcher: matcher([pattern({ kind: 'lex', terms: ['我软脚了', '软脚了'] })]),
    })
    saveMeme(env.db, m)
    const hits = await lookup(env.db, '这波团战我软脚了', null, 0.6, noEmbed())
    expect(hits[0].meme_id).toBe('m_0001')
    // 卡片内容直接可得（工具层同源逻辑）
    const m2 = resolveMeme(env.db, 'm_0001')!
    expect(m2.card.gist).toBe('关键局操作变形的自嘲')
    expect(m2.card.usage).toContain('决胜局我软脚了')
    expect(m2.card.taboo).toBe('别用于真实伤病')
  })
})

describe('show（三级输出）', () => {
  it('brief/card/full 分级', () => {
    installWordMeme()
    const m = resolveMeme(env.db, 'm_0001')!
    const [briefT] = cards.brief(m)
    expect(briefT).toContain('词梗')
    const [cardT, cardD] = cards.card(m)
    expect(cardT).toContain('反讽')
    expect((cardD as { taboo: string | null }).taboo).toBe('真诚场合慎用')
    const [fullT, fullD] = cards.full(m, env.db)
    expect(fullT).toContain('审计')
    expect(fullD).toHaveProperty('audit')
  })

  it('名字/别名可解析', () => {
    installWordMeme()
    expect(resolveMeme(env.db, '典')!.id).toBe('m_0001')
    expect(resolveMeme(env.db, '典中典')!.id).toBe('m_0001')
  })
})

describe('search', () => {
  it('BM25 命中 + 无结果空态', async () => {
    installWordMeme()
    const rs = await hybridSearch(env.db, '单字反讽经典', env.cfg.retrieval, { embedder: noEmbed() })
    expect(rs.length).toBeGreaterThan(0)
    expect(rs[0].meme.id).toBe('m_0001')
    const rs2 = await hybridSearch(env.db, '完全无关的查询词xyzq', env.cfg.retrieval, { embedder: noEmbed() })
    expect(rs2).toEqual([])
  })
})

describe('note 增删改查', () => {
  it('add/list/show/edit/rm 全链路', () => {
    installWordMeme()
    const id = notes.add(env.db, '观察：疑似新变体"孝典"', 'm_0001')
    expect(notes.listNotes(env.db, 'm_0001').some((n) => n.content.includes('疑似新变体'))).toBe(true)
    expect(notes.listNotes(env.db).some((n) => n.meme_id === 'm_0001')).toBe(true)
    expect(notes.update(env.db, id, '更新后的笔记')).toBe(true)
    expect(notes.get(env.db, id)!.content).toBe('更新后的笔记')
    expect(notes.remove(env.db, id)).toBe(true)
    expect(notes.get(env.db, id)).toBeNull()
  })
})

describe('edit（领域动作）', () => {
  it('variant 收编进 aliases 与 lex terms；gist 修正留审计', async () => {
    installWordMeme()
    const audit = await import('../src/audit.ts')
    const m = resolveMeme(env.db, 'm_0001')!
    if (!m.aliases.includes('孝典')) m.aliases.push('孝典')
    for (const p of m.matcher!.patterns) {
      if (p.kind === 'lex') p.terms = [...new Set([...p.terms, '孝典'])]
    }
    m.card.gist = '单字反讽：经典（升级版）'
    audit.record(env.db, m.id, 'edit_variant', 'edit', { variants: ['孝典'] })
    saveMeme(env.db, m)
    const m2 = resolveMeme(env.db, 'm_0001')!
    expect(m2.aliases).toContain('孝典')
    expect(m2.card.gist).toContain('升级版')
    const hits = await lookup(env.db, '孝中孝，孝典了', null, 0.6, noEmbed())
    expect(hits.some((h) => h.meme_id === 'm_0001' && h.excerpt.includes('典'))).toBe(true)
  })
})
