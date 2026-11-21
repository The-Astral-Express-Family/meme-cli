/** 证据更新管线（零 LLM）：短语/骨架双通道、跨视频新颖性、关联预计算。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { updateSignals } from '../src/detect/signals.ts'
import * as candidates from '../src/candidates.ts'
import { makeCfg, openDb, seedComments } from './helpers.ts'
import { nowIso } from '../src/models.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

describe('短语通道', () => {
  it('跨视频短语建候选并写日聚合', async () => {
    seedComments(env.db, Array.from({ length: 10 }, (_, i) => `评论${i}：蚌埠住了蚌埠住了`), Array.from({ length: 10 }, (_, i) => 101 + i), 1)
    const res = await updateSignals(env.db, env.cfg, 1)
    expect(res.scanned).toBe(10)
    const cand = candidates.byHead(env.db, '蚌埠住了')
    expect(cand).not.toBeNull()
    expect(cand!.distinct_videos).toBeGreaterThanOrEqual(8)
    expect(cand!.channel).toBe('phrase')
    const n = (env.db.prepare("SELECT SUM(cnt) AS c FROM phrase_daily WHERE phrase='蚌埠住了'").get() as { c: number }).c
    expect(n).toBeGreaterThanOrEqual(10)
  })

  it('同一视频内刷屏 → 视频内梗，不入队', async () => {
    seedComments(env.db, Array.from({ length: 20 }, (_, i) => `刷屏${i}：无敌了无敌了`), [555], 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '无敌了')).toBeNull()
  })

  it('单字梗与多字句式梗照常创建（黑名单只收语法虚词）', async () => {
    const texts: string[] = []
    const aids: number[] = []
    for (let i = 0; i < 200; i++) { texts.push(`普通观众留言第${i}号没有任何梗`); aids.push(1000 + (i % 4)) }
    for (let i = 0; i < 9; i++) { texts.push(`绷不住了第${i}次`); aids.push(2000 + (i % 3)) }
    texts.push('绷'); aids.push(2000)
    for (let i = 0; i < 5; i++) { texts.push('我记下了。'); aids.push(3000 + (i % 2)) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '绷'), '单字梗绷被误杀').not.toBeNull()
    expect(candidates.byHead(env.db, '我记下了'), '句式梗被误杀').not.toBeNull()
  })

  it('功能词头僵尸（零独立成评）不入队；功能词头句式梗（独立成评）正常入队', async () => {
    const texts: string[] = []
    const aids: number[] = []
    for (let i = 0; i < 9; i++) { texts.push(`开头这里有人${i}接着聊别的`); aids.push(701 + i) }
    for (let i = 0; i < 3; i++) { texts.push('我记下了'); aids.push(801 + i) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '这里有人')).toBeNull()
    expect(candidates.byHead(env.db, '我记下了')).not.toBeNull()
  })

  it('泛用词不被手工拉黑（统计判别负责）', async () => {
    const { GENERIC } = await import('../src/detect/signals.ts')
    for (const w of ['的', '了', '没有', '是什么', '的时候', '一个', '什么']) expect(GENERIC.has(w)).toBe(true)
    for (const w of ['绷', '典', '麻', '蚌', '孝', '急', '寄', '润', '燃', '乐', '拉', '会', '说', '看', '想', '决赛', '版本']) {
      expect(GENERIC.has(w), `${w} 不该被手工拉黑`).toBe(false)
    }
    expect(GENERIC.has('我记下了')).toBe(false)
  })

  it('--allow 豁免表恢复被误杀词', async () => {
    const { genericSet } = await import('../src/detect/signals.ts')
    const { kvSet } = await import('../src/db.ts')
    expect(genericSet(env.db, env.cfg).has('没有')).toBe(true)
    kvSet(env.db, 'generic_allow', '["没有", "绷"]')
    const g2 = genericSet(env.db, env.cfg)
    expect(g2.has('没有')).toBe(false)
    expect(g2.has('绷')).toBe(false)
  })
})

describe('客套成分检测', () => {
  it('纯客套组合复读再跨视频也不入榜', async () => {
    const texts: string[] = []
    const aids: number[] = []
    for (let i = 0; i < 6; i++) { texts.push('视频做得真不错，支持up主'); aids.push(1001 + i) }
    texts.push('支持up主', '支持up主'); aids.push(1007, 1008)
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '支持up主'), '客套复读入榜了').toBeNull()
    expect(candidates.byHead(env.db, '视频做得真不错')).toBeNull()
  })

  it('含任意真内容词的短语不受客套检测影响', async () => {
    const texts: string[] = []
    const aids: number[] = []
    for (let i = 0; i < 6; i++) { texts.push(`第${i}条：支持up主挖到坟了，前来考古`); aids.push(1101 + i) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '前来考古')).not.toBeNull()
  })
})

describe('骨架通道', () => {
  it('跨文本公式坍缩建候选（formula 预判）', async () => {
    const texts = ['一眼原神鉴定为云玩家', '一眼华为鉴定为遥遥领先']
    const aids = [5001, 5002]
    for (let i = 0; i < 200; i++) { texts.push(`普通评论第${i}号`); aids.push(5004 + (i % 4)) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    const skels = candidates.allActive(env.db).filter((c) => c.channel === 'skeleton')
    expect(skels.some((c) => c.head.includes('一眼') && c.head.includes('鉴定') && c.head.includes('<ent>'))).toBe(true)
    expect(skels.every((c) => c.kind_guess === 'formula')).toBe(true)
  })

  it('复制粘贴家族（同文本跨视频）不建骨架候选', async () => {
    const cp = '还是shy哥操作干净，奈何队友不争气[笑哭]'
    const texts = [cp, cp]
    const aids = [4001, 4002]
    for (let i = 0; i < 200; i++) { texts.push(`普通评论第${i}号`); aids.push(4003 + (i % 4)) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    const rows = env.db.prepare("SELECT head FROM candidates WHERE channel='skeleton' AND head LIKE '%奈何%'").all()
    expect(rows).toEqual([])
  })

  it('低频专名与刷屏词并存（创建上限不截断独特词）', async () => {
    const texts: string[] = []
    const aids: number[] = []
    for (let i = 0; i < 200; i++) { texts.push(`希望大家多多点赞支持${i}`); aids.push(950 + (i % 3)) }
    for (let i = 0; i < 5; i++) { texts.push(`真是青铜巨像，第${i}个名场面`); aids.push(960 + (i % 2)) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '青铜巨像'), '独特低频词被创建上限杀死').not.toBeNull()
    expect(candidates.byHead(env.db, '希望')).toBeNull() // df≈1.0 的刷屏词被 df 闸门拒绝
  })
})

describe('关联预计算', () => {
  it('词表同形 → same_form', async () => {
    const { save } = await import('../src/entries.ts')
    const { makeMeme, matcher, constraints, pattern } = await import('./test-matchers.test.ts')
    save(env.db, makeMeme({
      id: 'm_0001', name: '典', aliases: [], state: 'active',
      matcher: matcher([pattern({ kind: 'lex', terms: ['典'] })], constraints({ standalone: true })),
    }))
    const texts = Array.from({ length: 8 }, (_, i) => `评论${i}：典中典，太典了`)
    seedComments(env.db, texts, Array.from({ length: 8 }, (_, i) => 301 + i), 1)
    await updateSignals(env.db, env.cfg, 1)
    const cand = candidates.byHead(env.db, '典中典')
    expect(cand).not.toBeNull()
    expect(cand!.related.some((r) => r.id === 'm_0001' && r.type === 'same_form')).toBe(true)
  })

  it('用例文本归属于各自的词头（回归：循环变量错位）', async () => {
    const texts = ['我记下了', '我记下了', '我记下了', '结尾灵笼第二季真好看', '结尾灵笼第二季真好看', '结尾灵笼第二季真好看']
    seedComments(env.db, texts, [901, 902, 903, 911, 912, 913], 1)
    await updateSignals(env.db, env.cfg, 1)
    for (const head of ['我记下了', '灵笼第二季']) {
      const cand = candidates.byHead(env.db, head)
      expect(cand, head).not.toBeNull()
      for (const u of cand!.evidence_usages) {
        expect(u.text.includes(head), `${head} 的用例文本错位：${u.text}`).toBe(true)
      }
    }
  })
})

// ---- 标题证据：视频标题本身在玩梗，按 TITLE_WEIGHT 加权计票 ----

/** 灌一条视频标题（round_id 直挂本轮）。 */
function seedTitle(db: ReturnType<typeof openDb>, aid: number, title: string, roundId = 1): void {
  db.prepare(
    'INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source,round_id) '
    + 'VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(aid) DO UPDATE SET title=excluded.title, round_id=excluded.round_id',
  ).run(aid, `BV${aid % 100000}`, title, 119, 0, `up${aid}`, Math.floor(Date.now() / 1000), 0, nowIso(), 'test', roundId)
}

describe('标题证据（标题玩梗按 TITLE_WEIGHT 计票）', () => {
  it('单条标题 + 单条评论跨视频即立户（权重是决定因素）', async () => {
    seedComments(env.db, ['看完这个视频我蚌埠住了'], [1002], 1)
    seedTitle(env.db, 1001, '全网最全蚌埠住了合集')
    const res = await updateSignals(env.db, env.cfg, 1)
    expect(res.scanned).toBe(2) // 1 评论 + 1 标题
    expect(candidates.byHead(env.db, '蚌埠住了')).not.toBeNull()
  })

  it('对照：同样一条评论、无标题 → 不入户', async () => {
    seedComments(env.db, ['看完这个视频我蚌埠住了'], [1002], 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '蚌埠住了')).toBeNull()
  })

  it('仅两条不同视频的标题，同公式骨架即立户（零评论轮次也跑检测）', async () => {
    seedTitle(env.db, 2001, '这个丁真真的太抽象了')
    seedTitle(env.db, 2002, '这个老八真的太抽象了')
    const res = await updateSignals(env.db, env.cfg, 1)
    expect(res.scanned).toBe(2)
    const row = env.db.prepare(
      "SELECT head FROM candidates WHERE channel='skeleton' AND head LIKE '%抽象%'",
    ).get() as { head: string } | undefined
    expect(row, '公式骨架候选未建立').toBeDefined()
  })
})
