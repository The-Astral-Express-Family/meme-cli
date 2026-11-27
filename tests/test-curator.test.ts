/** curator-v1 scorer 纯逻辑测试：判定矩阵 / 归属 / subtask 指标 / 原因标签 / 消融参数。
 * 全部合成数据，不依赖 queries.jsonl 与 run 产物。 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { computeScore, type LookupRow, type Query } from '../scripts/curator-score.ts'
import { buildAttribution, containsForm, negativeViolations, parseTranscriptLinks, positiveContains, type GoldData, type LabelRow } from '../scripts/curator-lib.ts'
import { connect } from '../src/db.ts'

function labelRow(cid: string, family: string | null, verdict: LabelRow['candidate_verdict'], head: string | null, forms: string[]): LabelRow {
  return {
    case_id: `t-${cid}`, source_cid: cid, candidate_verdict: verdict,
    resolved_verdict: verdict === 'not-meme' ? 'not-meme' : 'meme',
    family_id: family, canonical_head: head, accepted_canonical_forms: forms, rationale: 't',
  }
}

/** fam1(c_1)、fam2(c_2)、噪音(c_n1)；c_x 同时指向 fam1/fam2（多家族候选）。 */
function fakeGold(): GoldData {
  const rows = [
    labelRow('c_1', 'fam1', 'meme', '梗一', ['梗一']),
    labelRow('c_2', 'fam2', 'meme', '梗二', ['梗二']),
    labelRow('c_n1', null, 'not-meme', '泡', []),
    labelRow('c_x', 'fam1', 'meme', '共', ['梗一', '梗共']),
    labelRow('c_x', 'fam2', 'not-meme', '共', ['梗二']),
  ]
  const byCid = new Map<string, GoldData['byCid'] extends Map<string, infer V> ? V : never>()
  const familiesOfCid = new Map<string, string[]>()
  const familyCids = new Map<string, string[]>([['fam1', ['c_1', 'c_x']], ['fam2', ['c_2', 'c_x']]])
  const familyForms = new Map<string, string[]>([['fam1', ['梗一', '梗共']], ['fam2', ['梗二']]])
  for (const r of rows) {
    const info = byCid.get(r.source_cid)
    if (info) {
      if (r.family_id && !info.families.includes(r.family_id)) info.families.push(r.family_id)
    } else {
      byCid.set(r.source_cid, { cid: r.source_cid, head: r.canonical_head ?? '', verdict: r.candidate_verdict, families: r.family_id ? [r.family_id] : [], forms: r.accepted_canonical_forms })
    }
    if (r.family_id) {
      const f = familiesOfCid.get(r.source_cid) ?? []
      if (!f.includes(r.family_id)) f.push(r.family_id)
      familiesOfCid.set(r.source_cid, f)
    }
  }
  return { rows, byCid, families: ['fam1', 'fam2'], familyCids, familyForms, familiesOfCid, noiseCids: ['c_n1'] }
}

function seedDb(): DatabaseSync {
  const db = connect(':memory:')
  // m_1：--cid 关联 c_1；m_2：名字兜底命中 c_2.head；m_noise：只关联噪音候选 c_n1
  const insMeme = db.prepare("INSERT INTO memes(id,name,aliases,card,created_at,updated_at) VALUES(?,?,?,?,'2026-01-01','2026-01-01')")
  insMeme.run('m_1', '梗一', '[\"绷住了变体\"]', '{}')
  insMeme.run('m_2', '梗二', '[]', '{}')
  insMeme.run('m_noise', '泡', '[]', '{}')
  // m_cross：名字不命中任何家族形式 → 真跨家族（fam1+fam2）；m_narrow：名字「梗共」∈ fam1 forms → 收窄为 fam1
  insMeme.run('m_cross', '梗通', '[]', '{}')
  insMeme.run('m_narrow', '梗共', '[]', '{}')
  const insCand = db.prepare("INSERT INTO candidates(cid,head,state,reject_reason,related,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,?,?,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')")
  insCand.run('c_1', '梗一', 'inducted', 'inducted', '[{\"id\":\"m_1\",\"type\":\"same_form\",\"score\":0.95}]')
  insCand.run('c_2', '梗二', 'rejected', 'banned', '[]')
  insCand.run('c_n1', '泡', 'inducted', 'inducted', '[{\"id\":\"m_noise\",\"type\":\"same_form\",\"score\":0.95}]')
  insCand.run('c_x', '共', 'pending', null, '[{\"id\":\"m_cross\",\"type\":\"same_form\",\"score\":0.95},{\"id\":\"m_narrow\",\"type\":\"same_form\",\"score\":0.95}]')
  return db
}

function q(id: string, hit: boolean, family: string | null, from: string | null, channel = 'phrase'): Query {
  return { query_id: id, channel, text: `text-${id}`, ctx: null, expect: { hit, family }, from_candidate: from, tags: [] }
}
function lk(id: string, hits: Array<{ meme_id: string; family: string | null; attribution: string }>): [string, LookupRow] {
  return [id, {
    query_id: id, hit: hits.length > 0,
    hits: hits.map((h) => ({ meme_id: h.meme_id, name: h.meme_id, tier: 1, confidence: 0.95, method: 'lexicon', family: h.family, attribution: h.attribution, via: null })),
  }]
}

describe('buildAttribution', () => {
  const gold = fakeGold()
  const db = seedDb()
  const attr = buildAttribution(db as unknown as Parameters<typeof buildAttribution>[0], gold)

  it('cid 关联优先', () => {
    expect(attr.byMeme.get('m_1')).toEqual({ kind: 'family', family: 'fam1', via: 'cid' })
  })
  it('名字兜底（词条名 == 候选 head）', () => {
    expect(attr.byMeme.get('m_2')).toEqual({ kind: 'family', family: 'fam2', via: 'name' })
  })
  it('只关联噪音候选 → 未归属 + noiseMemes', () => {
    expect(attr.byMeme.get('m_noise')?.kind).toBe('none')
    expect(attr.noiseMemes.has('m_noise')).toBe(true)
  })
  it('多家族候选：词条名收窄到唯一家族', () => {
    // m_narrow 名字「梗共」∈ fam1 forms 且 ∉ fam2 forms → 收窄为 fam1
    expect(attr.byMeme.get('m_narrow')).toEqual({ kind: 'family', family: 'fam1', via: 'cid' })
    // m_cross 名字不命中任何家族形式 → 真跨家族
    expect(attr.byMeme.get('m_cross')).toEqual({ kind: 'cross', families: ['fam1', 'fam2'] })
  })
  it('误封家族', () => {
    expect(attr.bannedFamilies.has('fam2')).toBe(true)
  })
})

describe('computeScore 判定', () => {
  const gold = fakeGold()
  const db = seedDb()
  const attr = buildAttribution(db as unknown as Parameters<typeof buildAttribution>[0], gold)
  const queries: Query[] = [
    q('q1', true, 'fam1', 'c_1'),
    q('q2', true, 'fam1', 'c_1'), // 命中别的家族
    q('q3', true, 'fam1', 'c_1'), // 命中噪音词条
    q('q4', false, 'fam1', 'c_n1'), // 噪音负例被噪音词条踩
    q('q5', false, 'fam2', null),
    q('q6', true, 'fam2', 'c_2'), // 跨家族词条命中
  ]
  const lookups = new Map([
    lk('q1', [{ meme_id: 'm_1', family: 'fam1', attribution: 'family' }]),
    lk('q2', [{ meme_id: 'm_2', family: 'fam2', attribution: 'family' }]),
    lk('q3', [{ meme_id: 'm_noise', family: null, attribution: 'none' }]),
    lk('q4', [{ meme_id: 'm_noise', family: null, attribution: 'none' }]),
    lk('q5', []),
    lk('q6', [{ meme_id: 'm_cross', family: null, attribution: 'cross' }]),
  ])

  const fam = computeScore('t', queries, lookups, gold, attr, 'family', 'full')
  it('矩阵（family 口径）', () => {
    expect([fam.matrix.tp, fam.matrix.fp, fam.matrix.fn, fam.matrix.tn]).toEqual([1, 1, 3, 1])
    expect(fam.matrix.precision).toBeCloseTo(0.5)
    expect(fam.matrix.recall).toBeCloseTo(0.25)
  })
  it('额外命中单列：错家族 / 未归属 / 跨家族', () => {
    expect(fam.extra_hits_total).toBeGreaterThanOrEqual(3)
    expect(fam.unattributed_hits_total).toBe(2)
    expect(fam.per_query.find((r) => r.query_id === 'q2')?.extra_hits[0]?.kind).toBe('wrong-family')
    expect(fam.per_query.find((r) => r.query_id === 'q6')?.extra_hits[0]?.kind).toBe('cross-family')
  })
  it('family_pass 失败带原因标签（noise / banned）', () => {
    expect(fam.family_pass.total).toBe(2)
    expect(fam.family_pass.passed).toBe(0)
    expect(fam.family_pass.failures.find((f) => f.family === 'fam1')?.labels).toContain('noise')
    expect(fam.family_pass.failures.find((f) => f.family === 'fam2')?.labels).toContain('banned')
  })
  it('noise_pass 按噪音候选分组', () => {
    expect(fam.noise_pass.passed).toBe(0)
    expect(fam.noise_pass.failures[0]?.cid).toBe('c_n1')
    expect(fam.noise_pass.failures[0]?.stepped_by).toEqual(['m_noise'])
  })

  const any = computeScore('t', queries, lookups, gold, attr, 'any', 'full')
  it('any 口径：命中任一单家族词条即 TP，未归属仍不算', () => {
    expect(any.matrix.tp).toBe(2) // q2 升为 TP；q3 未归属仍 FN；q6 跨家族仍 FN
    expect(any.matrix.fn).toBe(2)
  })
  it('subtask 与 policy 无关（分组/通过条件固定）', () => {
    expect(any.family_pass.passed).toBe(fam.family_pass.passed)
    expect(any.noise_pass.passed).toBe(fam.noise_pass.passed)
  })

  const neg2x = computeScore('t', queries, lookups, gold, attr, 'family', 'neg2x')
  it('neg2x：负例计两次压 precision，recall 不变', () => {
    expect(neg2x.matrix.fp).toBe(2)
    expect(neg2x.matrix.precision).toBeCloseTo(1 / 3)
    expect(neg2x.matrix.recall).toBeCloseTo(fam.matrix.recall)
  })
})

describe('parseTranscriptLinks（transcript 显式 --cid 归属）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curator-links-'))
  const file = join(dir, 'transcript.jsonl')
  const line = (o: unknown) => JSON.stringify(o)
  writeFileSync(file, [
    // 同一 cid 两次 add：DB 的 settle 只写第一条，两条都必须在 transcript 里被采信
    line({ argv: ['add', '--entry-file', 'a.json', '--cid', 'c_1'], exit_code: 0, stdout: '{"id":"m_1","name":"甲"}' }),
    line({ argv: ['add', '--entry-file', 'b.json', '--cid', 'c_1', '--cid', 'c_2'], exit_code: 0, stdout: '{"id":"m_2"}' }),
    line({ argv: ['add', '--entry-file', 'c.json', '--cid', 'c_3'], exit_code: 1, stdout: '' }),
    line({ argv: ['add', '--entry-file', 'd.json', '--cid', 'c_4'], exit_code: 1, stdout: '{"id":"m_x"}', invalid: 'budget-exhausted' }),
    line({ argv: ['iterate', 'm_1', '--entry-file', 'e.json', '--cid', 'c_9'], exit_code: 0, stdout: '{"id":"m_1"}' }),
    '{bad json',
  ].join('\n') + '\n', 'utf8')

  const links = parseTranscriptLinks(file)
  it('同一 cid 的两次关联都采信，iterate 追加 cid', () => {
    expect(links.get('m_1')).toEqual(['c_1', 'c_9'])
    expect(links.get('m_2')).toEqual(['c_1', 'c_2'])
  })
  it('跳过失败/ invalid / 坏 JSON 行', () => {
    expect(links.has('m_x')).toBe(false)
    expect([...links.keys()].sort()).toEqual(['m_1', 'm_2'])
  })
  it('transcript 不存在时返回空表', () => {
    expect(parseTranscriptLinks(join(dir, 'nope.jsonl')).size).toBe(0)
  })
})

describe('金标形式 containment', () => {
  it('短 ASCII 形式按整词边界', () => {
    expect(containsForm('这波操作真nb', 'nb')).toBe(true)
    expect(containsForm('NBA常规赛', 'nb')).toBe(false)
    expect(containsForm('G1325次列车', '325')).toBe(false)
    expect(containsForm('等了325天', '325')).toBe(true)
  })
  it('正例查槽形式 prefix+suffix，负例只查非槽形式', () => {
    const forms = ['天不生<X>万古如长夜', '天不生EDG万古如长夜']
    expect(positiveContains('天不生我李淳罡万古如长夜', forms)).toBe(true)
    expect(positiveContains('今天李淳罡万古如长夜', forms)).toBe(false)
    expect(negativeViolations('天不生我李淳罡万古如长夜', ['天不生EDG万古如长夜'])).toEqual([])
    expect(negativeViolations('这集真神了', ['神了', '太神了'])).toEqual(['神了'])
  })
})
