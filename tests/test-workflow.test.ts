/** 候选判定与 CLI 工作流回归：触发重算、精确封禁、只读检查、别名与回测隔离。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { kvGet, kvSet } from '../src/db.ts'
import * as evidence from '../src/detect/evidence.ts'
import * as semantics from '../src/detect/semantics.ts'
import * as extract from '../src/detect/extract.ts'
import { RE_SUB, normalize } from '../src/detect/skel.ts'
import * as lifecycle from '../src/lifecycle.ts'
import * as candidates from '../src/candidates.ts'
import * as surf from '../src/surf/run.ts'
import * as present from '../src/surf/present.ts'
import { updateSignals, genericSet } from '../src/detect/signals.ts'
import { ingestGroupMessages } from '../src/lake.ts'
import { COMMANDS } from '../src/cli/commands.ts'
import { openRuntime } from '../src/cli/runtime.ts'
import { collectIterateEvidence, runAddEntry, runIterate } from '../src/induct/inductor.ts'
import * as entries from '../src/entries.ts'
import { makeCfg, openDb, seedComments } from './helpers.ts'
import type { Candidate, UsageSample } from '../src/models.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg({ lifecycle: { trigger_videos: 2, trigger_videos_alt: 3, trigger_images: 3, trigger_rounds: 2 } })
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

let nextRpid = 1
const usage = (text: string, aid = 1, rpid = 0, parent = 0): UsageSample =>
  ({ text, aid, rpid: rpid || nextRpid++, root: 0, parent, mid: 1, ctime: 0, chain: false })

const candidate = (head: string, channel: Candidate['channel'], usages: UsageSample[]): Candidate => {
  const c = candidates.upsertFromSignal(env.db, {
    head, channel, kind_guess: channel === 'skeleton' ? 'formula' : 'word', usages,
    video_pairs: [...new Set(usages.map((u) => u.aid))].map((aid) => ({ aid, up_mid: aid })),
    round_id: 1,
  })
  c.surfs_seen = 2
  candidates.save(env.db, c)
  return candidates.get(env.db, c.cid)!
}

const ledger = (table: 'phrase_daily' | 'skel_daily', key: string, cnt: number): void => {
  const col = table === 'phrase_daily' ? 'phrase' : 'skel'
  env.db.prepare(`INSERT OR REPLACE INTO ${table}(${col},day,cnt,videos) VALUES(?,?,?,?)`)
    .run(key, new Date().toISOString().slice(0, 10), cnt, 2)
}

const entry = (name: string, aliases: string[] = [], matcher: unknown = null) => ({
  name, aliases, class: 'word' as const, birth_circa: null,
  card: { gist: '工作流测试词条', usage: [], taboo: null, register: null, aggression: '低' },
  examples: [`${name}例句`], matcher, lineage_parent: null, lineage_mutation: null, notes: null,
})

describe('触发质量与状态重算', () => {
  it('独立成评只认完整形精确相等或严格包含，不把任意短句算作独立成评', () => {
    const f = evidence.memeFeatures([
      usage('今天天气很好'), usage('真的不错'), usage('不错'), usage('我觉得不错'), usage('不错不错'),
    ], '不错')
    expect(f.standalone_rate).toBe(4 / 5)
    const standaloneOnly = evidence.memeScore({ copy_pairs: 0, skel_top_share: 0, standalone_rate: 1, usage_text_share: 0, n_usages: 2 })
    expect(standaloneOnly).toBe(0.5)
    expect(standaloneOnly).toBeLessThan(env.cfg.lifecycle.trigger_meme_score)
  })

  it('模板独立成评按完整槽位模板另算，不把短评论混入', () => {
    const f = evidence.memeFeatures([usage('原神，启动'), usage('启动'), usage('今天开会')], '<X>启动')
    expect(f.standalone_rate).toBe(1 / 3)
  })

  it('pending 至少两条有效证据，skeleton 至少三条', async () => {
    const p = candidate('新词', 'phrase', [usage('新词')])
    ledger('phrase_daily', '新词', 20)
    expect(await lifecycle.candidateShouldTrigger(env.db, p, env.cfg.lifecycle, env.cfg)).toBe(false)
    p.evidence_usages = [usage('新词', 1), usage('新词', 2)]
    candidates.save(env.db, p)
    expect(await lifecycle.candidateShouldTrigger(env.db, p, env.cfg.lifecycle, env.cfg)).toBe(true)

    const s = candidate('<X>启动', 'skeleton', [usage('原神启动', 3), usage('魔兽启动', 4)])
    ledger('skel_daily', '<X>启动', 20)
    expect(await lifecycle.candidateShouldTrigger(env.db, s, env.cfg.lifecycle, env.cfg)).toBe(false)
    s.evidence_usages.push(usage('明日方舟启动', 5))
    candidates.save(env.db, s)
    expect(await lifecycle.candidateShouldTrigger(env.db, s, env.cfg.lifecycle, env.cfg)).toBe(true)
  })

  it('triggered 不再粘住：每轮重算，失去资格返回 demoted 并落回 pending', async () => {
    const c = candidate('过门词', 'copy', [usage('过门词', 1), usage('过门词', 2)])
    ledger('phrase_daily', '过门词', 20)
    env.db.prepare("UPDATE candidates SET state='triggered' WHERE cid=?").run(c.cid)
    c.state = 'triggered'
    c.evidence_usages = [usage('今天天气很好', 3), usage('晚饭吃什么', 4), usage('周末去爬山', 5)]
    candidates.save(env.db, c)
    const trans = await lifecycle.transitionCandidates(env.db, env.cfg, 2)
    expect(trans.demoted).toContain(c.cid)
    expect(candidates.get(env.db, c.cid)!.state).toBe('pending')
  })

  it('allFunctionCore 在 embedder 不可用时仍设置，scoreCandidate 复用同一 helper', async () => {
    const c = candidate('<X>还是', 'skeleton', [usage('原神还是', 1), usage('魔兽还是', 2), usage('方舟还是', 3)])
    const unavailable = { available: false, dim: null, async embed() { return null } }
    const flags = await semantics.semanticFlags(env.db, env.cfg, c, unavailable)
    expect(flags.all_function_core).toBe(true)
    expect(evidence.scoreCandidate(env.db, c).flags.all_function_core).toBe(true)
  })

  it('surfs_seen 按不同轮次计，同一轮多条信号不伪造存活轮数', () => {
    const c = candidates.upsertFromSignal(env.db, {
      head: '同轮词', channel: 'phrase', kind_guess: 'word', usages: [usage('同轮词', 1)],
      video_pairs: [{ aid: 1, up_mid: 1 }], round_id: 1,
    })
    candidates.upsertFromSignal(env.db, {
      head: '同轮词', channel: 'phrase', kind_guess: 'word', usages: [usage('同轮词', 2)],
      video_pairs: [{ aid: 2, up_mid: 2 }], round_id: 1,
    })
    expect(candidates.get(env.db, c.cid)!.surfs_seen).toBe(1)
    candidates.upsertFromSignal(env.db, {
      head: '同轮词', channel: 'phrase', kind_guess: 'word', usages: [usage('同轮词', 3)],
      video_pairs: [{ aid: 3, up_mid: 3 }], round_id: 2,
    })
    expect(candidates.get(env.db, c.cid)!.surfs_seen).toBe(2)
  })

  it('图梗按跨视频线过门，不被纯文本质量分误挡', async () => {
    const c = candidate('img:abc', 'image', [usage('[图片] https://x/1', 1), usage('[图片] https://x/2', 2)])
    ledger('phrase_daily', 'img:abc', 0)
    c.distinct_videos = env.cfg.lifecycle.trigger_images
    candidates.save(env.db, c)
    expect(await lifecycle.candidateShouldTrigger(env.db, c, env.cfg.lifecycle, env.cfg)).toBe(true)
  })

  it('candDict 暴露证据数、终身体量与纯特征分', () => {
    const c = candidate('统计词', 'phrase', [usage('统计词', 1), usage('统计词', 2)])
    ledger('phrase_daily', '统计词', 37)
    const d = present.candDict(env.db, c)
    expect(d.n_usages).toBe(2)
    expect(d.lifetime_volume).toBe(37)
    expect(d.meme_score).toBe(Math.round(evidence.memeScore(evidence.scoreCandidate(env.db, c).features) * 1000) / 1000)
  })
})

describe('精确 ban 与长标签', () => {
  it('ban 使用归一化精确词头，跨通道生效并清除 generic_allow', () => {
    const phrase = candidate('启动', 'phrase', [usage('启动')])
    const tpl = candidate('<X>启动', 'skeleton', [usage('原神启动')])
    const copy = candidate('这是一条超过二十四个字符的完整复读句用于验证不截断', 'copy', [usage('这是一条超过二十四个字符的完整复读句用于验证不截断')])
    const image = candidate('img:abc', 'image', [usage('[图片] x')])
    const longer = candidate('启动器', 'phrase', [usage('启动器')])
    kvSet(env.db, 'generic_allow', JSON.stringify(['<x>启动', 'img:ABC']))
    const banned = surf.handleBan(env.db, [' <X>启动 ', '这是一条超过二十四个字符的完整复读句用于验证不截断', 'IMG:ABC'])
    expect(banned).toEqual(['<x>启动', '这是一条超过二十四个字符的完整复读句用于验证不截断', 'img:abc'])
    for (const c of [tpl, copy, image]) expect(candidates.get(env.db, c.cid)!.state).toBe('rejected')
    for (const c of [phrase, longer]) expect(candidates.get(env.db, c.cid)!.state).toBe('pending')
    expect(JSON.parse(kvGet(env.db, 'generic_allow', '[]')!)).toEqual([])
    expect(genericSet(env.db, env.cfg).has('启动')).toBe(false)
    expect(genericSet(env.db, env.cfg).has('启动器')).toBe(false)
  })

  it('allow 精确解除 ban，不解除家族或子串', () => {
    surf.handleBan(env.db, ['启动', '<x>启动'])
    surf.handleAllow(env.db, ['启动'])
    const g = genericSet(env.db, env.cfg)
    expect(g.has('启动')).toBe(false)
    expect(g.has('<x>启动')).toBe(true)
    expect(g.has('启动器')).toBe(false)
  })

  it('封禁键保留数字：版本词头不撞键，纯数字词头可封', () => {
    expect(evidence.banKey('绝区零2.0')).toBe('绝区零20')
    expect(evidence.banKey('绝区零2.1')).toBe('绝区零21')
    expect(evidence.banKey('22娘')).toBe('22娘')
    expect(evidence.banKey('666')).toBe('666')
    expect(evidence.banKey('！？')).toBe('')
    // 旧口径（normalizeHead→normText）会把数字掩成槽位后丢弃
    expect(evidence.normalizeHead('22娘')).toBe('娘')
  })

  it('ban 22娘 不误伤词头 娘；版本词头各自独立；停用词表认封禁键', () => {
    const mother = candidate('娘', 'phrase', [usage('娘')])
    const v2 = candidate('绝区零2.0', 'phrase', [usage('绝区零2.0')])
    const v21 = candidate('绝区零2.1', 'phrase', [usage('绝区零2.1')])
    surf.handleBan(env.db, ['22娘'])
    expect(candidates.get(env.db, mother.cid)!.state).toBe('pending')
    surf.handleBan(env.db, ['绝区零2.0'])
    expect(candidates.get(env.db, v2.cid)!.state).toBe('rejected')
    expect(candidates.get(env.db, v21.cid)!.state).toBe('pending')
    surf.handleBan(env.db, ['666'])
    const g = genericSet(env.db, env.cfg)
    expect(g.has('666')).toBe(true)
    expect(g.has('绝区零20')).toBe(true)
    expect(g.has('绝区零')).toBe(false)
    // 提取层按同一口径判定：封禁键命中、版本不同则不命中
    expect(evidence.isStopped(g, '绝区零2.0')).toBe(true)
    expect(evidence.isStopped(g, '绝区零2.1')).toBe(false)
    expect(evidence.isStopped(g, '娘')).toBe(false)
  })

  it('模板与整句复读抽取都按最终完整 head 精确过滤，copy 不截断', () => {
    const long = '这是一条超过二十四个字符的完整复读句用于验证不截断'
    const units = [
      { text: '原神，启动', aid: 1, rpid: 0, root: 0, parent: 0, mid: 0, ctime: 0, chain: false, weight: 1 },
      { text: '魔兽，启动', aid: 2, rpid: 0, root: 0, parent: 0, mid: 0, ctime: 0, chain: false, weight: 1 },
      { text: '方舟，启动', aid: 3, rpid: 0, root: 0, parent: 0, mid: 0, ctime: 0, chain: false, weight: 1 },
      { text: long, aid: 4, rpid: 0, root: 0, parent: 0, mid: 0, ctime: 0, chain: false, weight: 1 },
      { text: long, aid: 5, rpid: 0, root: 0, parent: 0, mid: 0, ctime: 0, chain: false, weight: 1 },
    ]
    const corpus = extract.buildCorpus(units)
    expect(extract.extractFixed(corpus, new Set()).some((c) => c.head === long)).toBe(true)
    expect(extract.extractFixed(corpus, new Set([long])).some((c) => c.head === long)).toBe(false)
    expect(extract.extractTemplates(corpus).some((c) => c.head === '<X>启动')).toBe(true)
    expect(extract.extractTemplates(corpus, new Set(['<x>启动'])).some((c) => c.head === '<X>启动')).toBe(false)
  })

  it('图片通道跳过已 ban 的精确 image head', async () => {
    kvSet(env.db, 'generic_auto', JSON.stringify(['img:abc']))
    seedComments(env.db, ['普通评论'], [901], 1)
    env.db.prepare('INSERT INTO lake_comment_images(rpid,url,phash,round_id) VALUES(?,?,?,?)').run(50000, 'https://x/y', 'abc', 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, 'img:abc')).toBeNull()
  })

  it('长装扮标签允许空格且最长 128 字符、不跨行', () => {
    const label = '[米雪儿·绮星梦使 应援装扮_阿巴阿巴]'
    expect(label.match(RE_SUB)?.[0]).toBe(label)
    expect(normalize(`好看${label}`)).toContain('<emo>')
    expect('[a\nb]'.match(RE_SUB)).toBeNull()
    expect(`[${'a'.repeat(128)}]`.match(RE_SUB)?.[0]).toHaveLength(130)
    expect(`[${'a'.repeat(129)}]`.match(RE_SUB)).toBeNull()
  })
})

describe('check 只读与 surf 轮次语义', () => {
  it('check 只呈现当前过门条目，不写轮次、kv、候选或认领 QQ', async () => {
    const passing = candidate('过门词', 'copy', [usage('过门词', 1), usage('过门词', 2)])
    ledger('phrase_daily', '过门词', 20)
    candidate('未过门', 'phrase', [usage('今天天气好', 3), usage('晚上吃什么', 4)])
    ledger('phrase_daily', '未过门', 20)
    ingestGroupMessages(env.db, [{ msg_id: 'm1', group: 'g1', sender: 'u1', content: '群聊新消息' }])
    kvSet(env.db, 'surf_round', '7')
    const before = env.db.prepare('SELECT * FROM kv_meta ORDER BY key').all()
    const rt = openRuntime(env.cfg)
    try {
      const out = await COMMANDS.check.run({ _: [], flags: { 'round-size': 1, page: 0 } }, rt)
      const raw = out.payload.new_candidates_raw as Array<Record<string, unknown>>
      expect(raw.map((c) => c.cid)).toEqual([passing.cid])
      expect(raw[0].qualified_now).toBe(true)
      expect(out.human).toContain('★待判断')
      expect(out.payload.round).toBe(7)
      expect(env.db.prepare('SELECT * FROM kv_meta ORDER BY key').all()).toEqual(before)
      expect(env.db.prepare('SELECT COUNT(*) c FROM surf_runs').get()).toEqual({ c: 0 })
      expect(env.db.prepare('SELECT round_id FROM lake_comments WHERE message=?').get('群聊新消息')).toEqual({ round_id: 0 })
      expect(candidates.get(env.db, passing.cid)!.state).toBe('pending')
    } finally { rt.close() }
  })

  it('check focus 显示父评文本', async () => {
    seedComments(env.db, ['父评原话', '追评回应'], [901, 901], 1)
    const c = candidate('追评回应', 'phrase', [usage('追评回应', 901, 50001, 50000)])
    const rt = openRuntime(env.cfg)
    try {
      const out = await COMMANDS.check.run({ _: [], flags: { focus: c.cid } }, rt)
      expect(out.human).toContain('父评原话')
    } finally { rt.close() }
  })

  it('surf --no-fetch 仍推进一轮并认领群聊', async () => {
    ingestGroupMessages(env.db, [{ msg_id: 'm2', group: 'g2', sender: 'u2', content: '群聊消息' }])
    const fetcher = vi.fn()
    const out = await surf.runSurf(env.db, env.cfg, { noFetch: true, fetch: fetcher })
    expect(fetcher).not.toHaveBeenCalled()
    expect(out.payload.round).toBe(1)
    expect(env.db.prepare('SELECT round_id FROM lake_comments WHERE message=?').get('群聊消息')).toEqual({ round_id: 1 })
    expect(String(out.payload.fetch && (out.payload.fetch as Record<string, unknown>).note)).toContain('不联网')
  })
})

describe('收录收口、别名匹配与回测隔离', () => {
  it('--cid 可多个且全部预检；成功后按 canonical terms 跨通道精确收口并写审计', async () => {
    const a = candidate(' canonical ', 'phrase', [usage('canonical例句甲', 1), usage('canonical例句乙', 2)])
    const b = candidate('<X>别名', 'skeleton', [usage('原神别名', 3), usage('魔兽别名', 4), usage('方舟别名', 5)])
    const family = entry('canonical', ['别名'], { patterns: [{ kind: 'lex', terms: ['canonical', '别名'] }], constraints: {} })
    const res = await runAddEntry(env.db, env.cfg, family, {
      cids: [a.cid, b.cid], holdout_texts: ['canonical独立留出例'],
    } as never)
    expect(candidates.get(env.db, a.cid)!.state).toBe('inducted')
    expect(candidates.get(env.db, b.cid)!.state).toBe('inducted')
    expect(candidates.get(env.db, a.cid)!.related.some((r) => r.id === res.meme.id && r.type === 'same_form')).toBe(true)
    const log = env.db.prepare('SELECT payload FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { payload: string }
    expect(JSON.parse(log.payload).closed_cids.sort()).toEqual([a.cid, b.cid].sort())

    const before = env.db.prepare('SELECT COUNT(*) c FROM memes').get()
    await expect(runAddEntry(env.db, env.cfg, entry('另一个词'), { cids: [a.cid, 'c_9999'] } as never))
      .rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' })
    expect(env.db.prepare('SELECT COUNT(*) c FROM memes').get()).toEqual(before)
  })

  it('--text 先精确、再唯一前缀/包含；多义要求 --cid', async () => {
    const exact = candidate('青铜巨像', 'phrase', [usage('青铜巨像', 1)])
    candidate('青铜巨像名场面', 'copy', [usage('青铜巨像名场面', 2)])
    candidate('青铜器', 'phrase', [usage('青铜器', 3)])
    await expect(runAddEntry(env.db, env.cfg, entry('精确词'), { text: '青铜巨像' }))
      .resolves.toMatchObject({ meme: { name: '精确词' } })
    expect(candidates.get(env.db, exact.cid)!.state).toBe('inducted')
    await expect(runAddEntry(env.db, env.cfg, entry('歧义词'), { text: '青铜' }))
      .rejects.toMatchObject({ code: 'MEME_CANDIDATE_AMBIGUOUS' })
    const unique = candidate('独一无二的词头', 'phrase', [usage('独一无二的词头', 3)])
    await runAddEntry(env.db, env.cfg, entry('唯一词'), { text: '句子里包含独一无二的词头' })
    expect(candidates.get(env.db, unique.cid)!.state).toBe('inducted')
  })

  it('aliases 默认只做元数据；--match-aliases 才合并非槽位别名，交互别名不绕过上下文', async () => {
    const plain = entry('默认词', ['默认别名'], { patterns: [{ kind: 'lex', terms: ['默认词'] }], constraints: {} })
    const added = await runAddEntry(env.db, env.cfg, plain)
    expect(added.meme.matcher!.patterns[0]).toMatchObject({ terms: ['默认词'] })
    const matched = await runAddEntry(env.db, env.cfg, entry('匹配词', ['匹配别名'], {
      patterns: [{ kind: 'lex', terms: ['匹配词'] }], constraints: {},
    }), { match_aliases: true } as never)
    expect(matched.meme.matcher!.patterns[0]).toMatchObject({ terms: ['匹配词', '匹配别名'] })

    const interaction = {
      ...entry('交互词', ['交互别名'], {
        patterns: [{ kind: 'interaction', trigger_terms: ['触发'], response_terms: ['回应'] }], constraints: {},
      }), class: 'interaction' as const,
    }
    await expect(runAddEntry(env.db, env.cfg, interaction, { match_aliases: true } as never))
      .rejects.toMatchObject({ code: 'MEME_INTERACTION_EVIDENCE_REQUIRED' })
    const ia = await runAddEntry(env.db, env.cfg, interaction, {
      match_aliases: true, holdout_texts: ['上句：触发 本句：回应'],
    } as never)
    expect(ia.meme.matcher!.patterns.some((p) => p.kind === 'lex' && p.terms.includes('交互别名'))).toBe(false)
    const { lookup } = await import('../src/match/pipeline.ts')
    const { noEmbed } = await import('./test-matchers.test.ts')
    expect(await lookup(env.db, '交互别名', null, 0.6, noEmbed())).toEqual([])
    expect((await lookup(env.db, '回应', ['触发', '回应'], 0.6, noEmbed())).some((h) => h.meme_id === ia.meme.id)).toBe(true)
  })

  it('canonical evidence keys 只保留完整形用例；空集明确报错且可用 --holdout-text', async () => {
    const c = candidate('截断头', 'phrase', [
      usage('截断头普通用法一', 1), usage('截断头普通用法二', 2), usage('截断头普通用法三', 3),
      usage('完整形例句一', 4), usage('完整形例句二', 5), usage('完整形例句三', 6),
    ])
    const data = entry('完整形', [], { patterns: [{ kind: 'lex', terms: ['完整形'] }], constraints: {} })
    data.examples = ['完整形例句一', '完整形例句二', '完整形例句三']
    const res = await runAddEntry(env.db, env.cfg, data, { cids: [c.cid] })
    expect(res.backtest!.holdout_size).toBe(1)
    expect(res.backtest!.hits).toBe(1)
    expect(res.backtest!.missed).toEqual([])

    const empty = candidate('宿主词', 'phrase', [usage('宿主词普通用法一', 7), usage('宿主词普通用法二', 8)])
    await expect(runAddEntry(env.db, env.cfg, entry('另一个完整形', [], {
      patterns: [{ kind: 'lex', terms: ['另一个完整形'] }], constraints: {},
    }), { cids: [empty.cid] })).rejects.toMatchObject({ code: 'MEME_HOLDOUT_REQUIRED' })
    const explicit = await runAddEntry(env.db, env.cfg, entry('另一个完整形', [], {
      patterns: [{ kind: 'lex', terms: ['另一个完整形'] }], constraints: {},
    }), { cids: [empty.cid], holdout_texts: ['另一个完整形独立留出例'] } as never)
    expect(explicit.backtest!.holdout_size).toBe(1)
    expect(explicit.backtest!.hits).toBe(1)
  })

  it('带间隙槽的 skeleton 正例按完整槽位形状识别，不要求字面核心连续', async () => {
    const c = candidate('鉴定为', 'phrase', [
      usage('原神一眼就能鉴定为神作', 1), usage('魔兽一眼必须鉴定为鬼才', 2), usage('方舟一眼直接鉴定为王者', 3),
      usage('日常鉴定为普通句子', 4), usage('随便鉴定为无关内容', 5),
    ])
    const data = {
      ...entry('一眼鉴定为', [], {
        patterns: [{ kind: 'skeleton', tokens: ['一眼', '<ent>', '鉴定为', '<ent>'] }], constraints: {},
      }), class: 'formula' as const,
      examples: ['原神一眼就能鉴定为神作', '魔兽一眼必须鉴定为鬼才', '方舟一眼直接鉴定为王者'],
    }
    const res = await runAddEntry(env.db, env.cfg, data, { cids: [c.cid] })
    expect(res.backtest!.holdout_size).toBe(1)
    expect(res.backtest!.hits).toBe(1)
    expect(res.backtest!.missed).toEqual([])
  })

  it('默认元数据 alias 不作为回测正例；--match-aliases 后才可作为完整形证据', async () => {
    const c = candidate('宿主词', 'phrase', [usage('别名例句甲', 1), usage('别名例句乙', 2), usage('别名例句丙', 3)])
    const data = entry('完整词', ['别名'], { patterns: [{ kind: 'lex', terms: ['完整词'] }], constraints: {} })
    data.examples = ['完整词例句']
    await expect(runAddEntry(env.db, env.cfg, data, { cids: [c.cid] }))
      .rejects.toMatchObject({ code: 'MEME_HOLDOUT_REQUIRED' })
    const res = await runAddEntry(env.db, env.cfg, data, { cids: [c.cid], match_aliases: true } as never)
    expect(res.backtest!.hits).toBe(res.backtest!.holdout_size)
  })

  it('iterate 排除自身重名；恢复 matcher 需独立候选证据或显式 holdout，force 可绕过并审计', async () => {
    await runAddEntry(env.db, env.cfg, entry('原词'))
    await expect(runIterate(env.db, env.cfg, 'm_0001', { entry: entry('原词') })).resolves.toBeTruthy()
    const compiled = { patterns: [{ kind: 'lex', terms: ['新词'] }], constraints: {} }
    await expect(runIterate(env.db, env.cfg, 'm_0001', { entry: entry('新词', [], compiled) }))
      .rejects.toMatchObject({ code: 'MEME_MATCHER_EVIDENCE_REQUIRED' })
    const forced = await runIterate(env.db, env.cfg, 'm_0001', { entry: entry('新词', [], compiled), force: true })
    expect(forced.meme.matcher).toBeNull()
    const log = env.db.prepare("SELECT payload FROM audit_log WHERE action='iterate' ORDER BY seq DESC LIMIT 1").get() as { payload: string }
    expect(JSON.parse(log.payload).forced_vector_only).toBe(true)
    expect(JSON.parse(log.payload).matcher_evidence_forced).toBe(true)
  })

  it('iterate 收集候选证据保留 parent/pair；交互无触发上下文不进 holdout', async () => {
    seedComments(env.db, ['触发原话', '回应原话', '孤立回应'], [901, 901, 902], 1)
    const c = candidate('回应原话', 'phrase', [usage('回应原话', 901, 50001, 50000), usage('孤立回应', 902, 50002)])
    const meme = entries.get(env.db, 'm_0001') ?? (await runAddEntry(env.db, env.cfg, entry('回应原话'))).meme
    const ev = collectIterateEvidence(env.db, meme, [c])
    expect(ev.usages.some((u) => u.parent === 50000 && Array.isArray(u.pair))).toBe(true)
    expect(c.evidence_usages[0].parent).toBe(50000)
  })
})
