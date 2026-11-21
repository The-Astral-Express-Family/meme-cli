/** 候选池卫生：非极大抑制（冻结前缀折叠）、纯复制粘贴剪枝、包含族合并。 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { updateSignals } from '../src/detect/signals.ts'
import * as candidates from '../src/candidates.ts'
import type { UsageSample } from '../src/models.ts'
import { makeCfg, openDb, seedComments } from './helpers.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

const usage = (text: string, aid: number, rpid: number): UsageSample => ({
  text, aid, rpid, root: 0, parent: 0, mid: 0, ctime: 0, chain: false,
})

describe('非极大短语抑制（计数证据，冻结前缀折叠）', () => {
  it('笑死我/死我了 折叠进完整习语 笑死我了', async () => {
    const texts = [
      '笑死我了，一环比电影好看', '哈哈哈笑死我了', '真的笑死我了',
      '有一天笑死我了', '笑死我了属于是', '笑死我了[笑哭]',
    ]
    seedComments(env.db, texts, [2101, 2102, 2103, 2104, 2105, 2106], 1)
    const res = await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '笑死我了')).not.toBeNull()
    expect(candidates.byHead(env.db, '笑死我'), '冻结前缀未折叠').toBeNull()
    expect(candidates.byHead(env.db, '死我了'), '冻结前缀未折叠').toBeNull()
    expect(res.pruned_spam).toBe(0) // 六句各不相同，不是复制粘贴
  })

  it('叠用句不被假折叠：蚌埠住了蚌埠住了 → 蚌埠住了照常立户', async () => {
    seedComments(
      env.db,
      Array.from({ length: 10 }, (_, i) => `评论${i}：蚌埠住了蚌埠住了`),
      Array.from({ length: 10 }, (_, i) => 2200 + i), 1,
    )
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '蚌埠住了'), '叠用句被假折叠').not.toBeNull()
  })

  it('多变体扩展不折叠：绷（绷不住/绷了/独立绷）照常立户', async () => {
    const texts: string[] = []
    const aids: number[] = []
    for (let i = 0; i < 200; i++) { texts.push(`普通观众留言第${i}号没有任何梗`); aids.push(1000 + (i % 4)) }
    for (let i = 0; i < 9; i++) { texts.push(`绷不住了第${i}次`); aids.push(2000 + (i % 3)) }
    for (let i = 0; i < 4; i++) { texts.push('直接绷了'); aids.push(2300 + i) }
    texts.push('绷'); aids.push(2400)
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '绷'), '多扩展单字梗被误折叠').not.toBeNull()
  })
})

describe('纯复制粘贴剪枝', () => {
  it('同一作者同一句跨 3 视频 → phrase 切片删净；不同用户的相同短句不误剪', async () => {
    const spam = '想找个帮我打里号的吗，一个月一千'
    const insC = env.db.prepare(
      'INSERT OR IGNORE INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    const now = new Date().toISOString()
    // 同一作者（mid=777）发三遍
    for (const [i, aid] of [3101, 3102, 3103].entries()) {
      insC.run(500000 + i, aid, 0, 0, 777, spam, Math.floor(Date.now() / 1000), 0, now, 1)
    }
    // 不同用户的相同短句（复读信号，不剪）
    const texts = ['我记下了', '我记下了', '我记下了']
    seedComments(env.db, texts, [3201, 3202, 3203], 1)
    const res = await updateSignals(env.db, env.cfg, 1)
    const spamPhrase = env.db.prepare(
      "SELECT COUNT(*) AS c FROM candidates WHERE channel='phrase' AND evidence_usages LIKE '%帮我打里%'",
    ).get() as { c: number }
    expect(spamPhrase.c, '代练广告切片留在 phrase 池').toBe(0)
    expect(res.pruned_spam).toBeGreaterThan(0)
    expect(candidates.byHead(env.db, '我记下了'), '不同用户的复读被误剪').not.toBeNull()
    const copy = env.db.prepare("SELECT head FROM candidates WHERE channel='copy'").all() as Array<{ head: string }>
    expect(copy.some((r) => r.head.includes('帮我打里')), '复读通道没接住整句').toBe(true)
  })
})

describe('包含族合并', () => {
  function seedTwo(
    headA: string, aidsA: number[], textsA: string[],
    headB: string, aidsB: number[], textsB: string[],
  ): void {
    const ins = env.db.prepare(
      'INSERT OR IGNORE INTO cand_video(cid,aid,up_mid,ts) VALUES(?,?,?,?)',
    )
    const a = candidates.upsertFromSignal(env.db, {
      head: headA, channel: 'phrase', kind_guess: 'word',
      usages: aidsA.map((aid, i) => usage(textsA[i], aid, 100 + i)),
      video_pairs: aidsA.map((aid) => ({ aid, up_mid: 0 })),
    })
    for (const aid of aidsA) ins.run(a.cid, aid, 0, new Date().toISOString())
    const b = candidates.upsertFromSignal(env.db, {
      head: headB, channel: 'phrase', kind_guess: 'word',
      usages: aidsB.map((aid, i) => usage(textsB[i], aid, 200 + i)),
      video_pairs: aidsB.map((aid) => ({ aid, up_mid: 0 })),
    })
    for (const aid of aidsB) ins.run(b.cid, aid, 0, new Date().toISOString())
  }

  it('韩立的 → 韩立：dv 大者存活，证据并集，碎片删除', async () => {
    seedTwo(
      '韩立', [1, 2, 3, 4, 5],
      ['韩立真的太强了', '韩立结婴了', '韩立是真的强', '韩立名场面', '韩立不装了'],
      '韩立的', [1, 2], ['韩立的剑是咋回事', '韩立的cd好长'],
    )
    const res = candidates.hygienePass(env.db as unknown as DatabaseSync)
    expect(res.merged).toBe(1)
    const kept = candidates.byHead(env.db, '韩立')
    expect(kept).not.toBeNull()
    expect(candidates.byHead(env.db, '韩立的')).toBeNull()
    expect(kept!.distinct_videos).toBe(5)
    expect(kept!.evidence_usages.map((u) => u.text)).toContain('韩立的剑是咋回事')
  })

  it('同 dv 取更长 head：平平无 并入 平平无奇', async () => {
    seedTwo(
      '平平无奇', [11, 12, 13, 14],
      ['韩立平平无奇的样子', '明明平平无奇却封神', '平平无奇几十万播放', '长得平平无奇'],
      '平平无', [11, 12, 13],
      ['平平无奇几十万播放', '明明平平无奇却封神', '韩立平平无奇的样子'],
    )
    const res = candidates.hygienePass(env.db as unknown as DatabaseSync)
    expect(res.merged).toBe(1)
    expect(candidates.byHead(env.db, '平平无奇')).not.toBeNull()
    expect(candidates.byHead(env.db, '平平无')).toBeNull()
  })

  it('容器词不吞长梗：keeper dv 超过被吸收方 8 倍时不合并，双方保留', async () => {
    // 真网案例："感觉"(49dv 泛用容器) 曾把"感觉不如"(2dv, 鸣潮梗句式) 吸进
    // 泛用噪音里。keeper 的高计数来自无关用法，不是同一表达的家族切片。
    seedTwo(
      '感觉', Array.from({ length: 20 }, (_, i) => i + 1),
      Array.from({ length: 20 }, (_, i) => `感觉第${i}种完全不同的普通用法`),
      '感觉不如', [1, 2], ['感觉不如鸣潮最新演示', '感觉不如 南孚聚能环'],
    )
    const res = candidates.hygienePass(env.db as unknown as DatabaseSync)
    expect(res.merged, '容器词吸收了真梗短语').toBe(0)
    expect(candidates.byHead(env.db, '感觉')).not.toBeNull()
    expect(candidates.byHead(env.db, '感觉不如'), '真梗短语被泛用容器吞掉').not.toBeNull()
  })

  it('无包含关系或视频不重合 → 不合并', async () => {
    seedTwo(
      '难绷', [21, 22, 23],
      ['真的难绷', '难绷时刻', '太难点绷了'],
      '乐子人', [24, 25],
      ['乐子人又来了', '纯乐子人'],
    )
    const res = candidates.hygienePass(env.db as unknown as DatabaseSync)
    expect(res.merged).toBe(0)
    expect(candidates.byHead(env.db, '难绷')).not.toBeNull()
    expect(candidates.byHead(env.db, '乐子人')).not.toBeNull()
  })
})
