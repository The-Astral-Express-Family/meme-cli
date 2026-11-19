/** 新通道回归：接龙（一人一字）、回复前缀剥离、pHash 图梗聚类、后缀公式族、跨轮累积。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { updateSignals } from '../src/detect/signals.ts'
import * as candidates from '../src/candidates.ts'
import { transitionCandidates } from '../src/lifecycle.ts'
import { phrases } from '../src/detect/ngram.ts'
import { skeletonVariants } from '../src/detect/skel.ts'
import { hamming, phashBytes } from '../src/detect/imgphash.ts'
import { makeCfg, openDb, seedComments } from './helpers.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

describe('接龙通道', () => {
  it('楼中楼短消息自动拼接（同人连发也拼接）', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const rows: Array<[number, number, number, number, number, string, number]> = [
      // 视频 8001，根 900：同人连发「好」「笑」
      [6001, 8001, 900, 900, 11, '好', ts - 50],
      [6002, 8001, 900, 900, 11, '笑', ts - 49],
      // 视频 8001，根 901：两人各一字
      [6003, 8001, 901, 901, 12, '好', ts - 40],
      [6004, 8001, 901, 901, 13, '笑', ts - 39],
      // 视频 8002，根 902：含「句号」特例
      [6005, 8002, 902, 902, 14, '好', ts - 30],
      [6006, 8002, 902, 902, 15, '笑', ts - 29],
      [6007, 8002, 902, 902, 16, '句号', ts - 28],
      // 干扰：被打断的短评论串——好/笑 分属两侧 run，各长 1，不拼接
      [6011, 8003, 903, 903, 21, '好', ts - 20],
      [6012, 8003, 903, 903, 22, '这句很长所以打断了拼接', ts - 19],
      [6013, 8003, 903, 903, 23, '笑', ts - 18],
    ]
    const insC = env.db.prepare(
      'INSERT INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    const insV = env.db.prepare(
      'INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    for (const [rpid, oid, root, parent, mid, msg, ctime] of rows) {
      insC.run(rpid, oid, root, parent, mid, msg, ctime, 0, 't', 1)
    }
    for (const aid of [8001, 8002, 8003]) insV.run(aid, `BV${aid}`, 'v', 119, 7, 'up', 0, 0, 't', 'test')

    const res = await updateSignals(env.db, env.cfg, 1)
    const cand = candidates.byHead(env.db, '好笑')
    expect(cand, '拼接文本未走通短语通道').not.toBeNull()
    expect(cand!.distinct_videos).toBe(2)
    expect(cand!.evidence_usages.length).toBeGreaterThan(0)
    expect(cand!.evidence_usages.every((u) => u.chain), '拼接来源未标记 chain').toBe(true)
    expect(candidates.allActive(env.db).some((c) => c.channel === 'chain')).toBe(false)
    expect(res.scanned).toBe(13) // 10 条真实评论 + 3 个拼接单元
  })
})

describe('回复前缀剥离', () => {
  it('楼中楼 UI 前缀不进骨架/短语', () => {
    const ps = phrases('回复 @某人 ：太典了')
    expect(ps).toContain('太典了')
    expect(ps.every((p) => !p.includes('回复'))).toBe(true)
    const vs = skeletonVariants('回复 @某人 ：太典了')
    expect(vs.every((v) => !v.startsWith('回复'))).toBe(true)
  })
})

describe('pHash 图梗', () => {
  const png = async (r: number, g: number, b: number): Promise<Uint8Array> => {
    const sharp = (await import('sharp')).default
    return sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toBuffer()
  }

  it('同图同哈希；异图远距离', async () => {
    const h1 = await phashBytes(await png(255, 0, 0))
    expect(h1).not.toBeNull()
    expect(h1).toHaveLength(16)
    expect(await phashBytes(await png(255, 0, 0))).toBe(h1)
    const h2 = await phashBytes(await png(0, 0, 255))
    expect(hamming(h1!, h2!)).toBeGreaterThan(8)
  })

  it('pHash 相近的跨视频图片聚成同簇候选，跨轮累积视频数', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const insC = env.db.prepare(
      'INSERT INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id) VALUES(?,?,0,0,0,\'[图]\',?,0,\'t\',?)',
    )
    const insV = env.db.prepare(
      'INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source) VALUES(?,\'BV\',\'v\',119,7,\'up\',0,0,\'t\',\'test\')',
    )
    const insI = env.db.prepare(
      'INSERT INTO lake_comment_images(rpid,url,phash,width,height,round_id) VALUES(?,?,?,0,0,?)',
    )
    for (const [rpid, oid, ph, rid] of [[7001, 8001, '0000000000000000', 1], [7002, 8002, '0700000000000000', 1], [7003, 8003, 'ffffffffffffffff', 1]] as const) {
      insC.run(rpid, oid, ts, rid)
      insV.run(oid)
      insI.run(rpid, `https://img/${rpid}.jpg`, ph, rid)
    }
    insC.run(7004, 8004, ts + 1, 2)
    insV.run(8004)
    insI.run(7004, 'https://img/7004.jpg', '0f00000000000000', 2) // 与 0000... 汉明距 4

    await updateSignals(env.db, env.cfg, 1)
    const cands = candidates.allActive(env.db).filter((c) => c.channel === 'image')
    expect(cands).toHaveLength(2) // 0000 簇 + ffff 簇
    const big = cands.filter((c) => c.distinct_videos === 2)
    expect(big).toHaveLength(1)
    expect(big[0].head.startsWith('img:00000000')).toBe(true)

    await updateSignals(env.db, env.cfg, 2)
    const big2 = candidates.allActive(env.db).filter((c) => c.channel === 'image' && c.distinct_videos === 3)
    expect(big2).toHaveLength(1)
    expect(big2[0].surfs_seen).toBeGreaterThanOrEqual(2)
  })
})

describe('后缀公式族', () => {
  it('赢麻了/亏麻了/输麻了 → <X>麻了 公式候选', async () => {
    const texts: string[] = []
    const aids: number[] = []
    ;['赢麻了', '亏麻了', '输麻了', '赚麻了'].forEach((w, i) => {
      texts.push(`这波直接${w}`); aids.push(301 + i)
      texts.push(`兄弟们${w}，没眼看了`); aids.push(305 + i)
    })
    for (let i = 0; i < 60; i++) { texts.push(`普通评论第${i}条`); aids.push(400 + (i % 4)) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    const cand = candidates.byHead(env.db, '<X>麻了')
    expect(cand, '后缀公式族未合成').not.toBeNull()
    expect(cand!.channel).toBe('skeleton')
    expect(cand!.kind_guess).toBe('formula')
    expect(cand!.distinct_videos).toBeGreaterThanOrEqual(4)
  })

  it('普通动宾搭配（X市场）不合成公式：族员无自身跨视频证据', async () => {
    const texts: string[] = []
    const aids: number[] = []
    for (const w of ['股票市场', '期货市场', '牛市市场']) {
      for (let i = 0; i < 2; i++) { texts.push(`聊聊${w}的事第${i}条`); aids.push(501 + i) }
    }
    for (let i = 0; i < 60; i++) { texts.push(`普通评论第${i}条`); aids.push(600 + (i % 4)) }
    seedComments(env.db, texts, aids, 1)
    await updateSignals(env.db, env.cfg, 1)
    expect(candidates.byHead(env.db, '<X>市场'), '普通搭配被误合成为公式').toBeNull()
  })
})

describe('跨轮累积与触发', () => {
  it('低频真梗跨轮累积后触发', async () => {
    const rounds: Array<[string[], number[]]> = [
      [['难绷', '又是这活，难绷'], [705, 706]],
      [['真难绷', '难绷时刻'], [707, 708]],
      [['难绷住了', '这很难绷'], [709, 710]],
      [['太难绷了', '难绷，真的'], [711, 712]],
    ]
    for (let rid = 1; rid <= rounds.length; rid++) {
      const [texts, aids] = rounds[rid - 1]
      const filler = Array.from({ length: 4 }, (_, i) => `普通评论${rid}${i}条`)
      seedComments(env.db, [...texts, ...filler], [...aids, ...[713, 714, 715, 716]], rid, 0, 50000 + rid * 100)
      await updateSignals(env.db, env.cfg, rid)
      transitionCandidates(env.db, env.cfg.lifecycle, rid)
    }
    const cand = candidates.byHead(env.db, '难绷')
    expect(cand, '低频真梗跨轮未入榜').not.toBeNull()
    expect(cand!.distinct_videos).toBeGreaterThanOrEqual(5)
    expect(cand!.surfs_seen).toBeGreaterThanOrEqual(3)
    expect(cand!.state, '跨轮累积后应触发').toBe('triggered')
  })

  it('泛用词 dv 高但句句不同 → 永不触发', async () => {
    const variants = ['这也不行那也不行', '进度不行啊', '手感不行', '网络不行', '状态不行',
      '天气不行', '发挥不行', '队形不行', '成绩不行', '翻译不行']
    for (const rid of [1, 2]) {
      const texts = variants.map((v, i) => `${v}第${rid}${i}条`)
      seedComments(env.db, texts, Array.from({ length: 10 }, (_, i) => 801 + i), rid, 0, 60000 + rid * 100)
      await updateSignals(env.db, env.cfg, rid)
      transitionCandidates(env.db, env.cfg.lifecycle, rid)
    }
    const cand = candidates.byHead(env.db, '不行')
    if (cand) expect(cand.state, '泛用词被误触发').not.toBe('triggered')
  })
})
