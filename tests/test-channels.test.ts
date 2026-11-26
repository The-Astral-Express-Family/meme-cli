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
  const m = makeCfg({ lifecycle: { trigger_videos: 5, trigger_videos_alt: 8 } })
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
    expect(cand!.channel).toBe('phrase') // 拼接走普通通道，没有独立 chain 通道
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
  it('词类累计跨 ≥5 视频即触发（慢积累不限轮数）', async () => {
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
    }
    await transitionCandidates(env.db, env.cfg, 4)
    const cand = candidates.byHead(env.db, '难绷')
    expect(cand, '低频真梗跨轮未入榜').not.toBeNull()
    expect(cand!.distinct_videos).toBeGreaterThanOrEqual(5)
    expect(cand!.surfs_seen).toBeGreaterThanOrEqual(3)
    expect(cand!.state, '慢积累真梗达体量线应触发').toBe('triggered')
  })

  it('泛用词体量达线但句句不同 → 特征分挡住，不触发', async () => {
    // 直造候选验证触发门本身：体量线（phrase_daily 终身次数）达标，但用例句句不同
    // → memeScore 的复读/坍缩特征拉不满，语义门应挡住（原实现靠 seedComments 走
    // 全管线，"舒服"根本立不了户，断言 if (cand) 空转多年）
    // 句式结构也要互不相同：骨架层会把同构句坍缩到同一模板，同构会被误判为公式复读
    const diverse = [
      '今天天气真好想出门走走', '我家猫把花瓶打翻了', '新版本更新后卡成幻灯片',
      '食堂阿姨今天手抖得厉害', '作业堆成山根本写不完', '这部电影结局意外好看',
      '早高峰地铁挤到怀疑人生', '房租又涨了真的顶不住', '昨晚球赛绝杀太燃了',
      '单曲循环了一整天这首歌', '图书馆新到的书真不错', '下班路上大堵车',
    ]
    const usages = diverse.map((text, i) => ({ text, aid: 700 + i, rpid: 5000 + i, root: 0, parent: 0, mid: 300 + i, ctime: 0, chain: false }))
    const cand = candidates.upsertFromSignal(env.db, {
      head: '舒服', channel: 'phrase', kind_guess: 'word',
      usages, video_pairs: usages.map((u) => ({ aid: u.aid, up_mid: 0 })), round_id: 3,
    })
    cand.surfs_seen = 4
    candidates.save(env.db, cand)
    const day = new Date().toISOString().slice(0, 10)
    env.db.prepare('INSERT OR REPLACE INTO phrase_daily(phrase,day,cnt,videos) VALUES(?,?,?,?)').run('舒服', day, 40, 12)
    const { candidateShouldTrigger } = await import('../src/lifecycle.ts')
    expect(await candidateShouldTrigger(env.db, candidates.get(env.db, cand.cid)!, env.cfg.lifecycle, env.cfg)).toBe(false)
  })

  it('词类跨 ≥5 视频即触发（新物快传与累计体量同一条线）', async () => {
    for (let rid = 1; rid <= 2; rid++) {
      const filler = Array.from({ length: 8 }, (_, i) => `这期视频质量不错画面也很用心值得反复观看第${rid}组第${i}条`)
      seedComments(env.db, ['鲸鲸', '哦鲸鲸', '鲸鲸好可爱', '给鲸鲸完整的一生', '鲸鲸', ...filler].map((t) => t + rid),
        [901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 911, 912, 913], rid, 0, 80000 + rid * 100)
      await updateSignals(env.db, env.cfg, rid)
    }
    await transitionCandidates(env.db, env.cfg, 2)
    const cand = candidates.byHead(env.db, '鲸鲸')
    expect(cand, '快传新物未入榜').not.toBeNull()
    expect(cand!.state, '跨 5 视频应触发').toBe('triggered')
  })

  it('存活窗口：休眠不出队，新证据唤醒后按体量线触发', async () => {
    for (let rid = 1; rid <= 2; rid++) {
      const filler = Array.from({ length: 8 }, (_, i) => `这期视频质量不错画面也很用心值得反复观看第${rid}组第${i}条`)
      seedComments(env.db, ['鲸鲸', '哦鲸鲸', '鲸鲸好可爱', '给鲸鲸完整的一生', '鲸鲸', ...filler].map((t) => t + rid),
        [901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 911, 912, 913], rid, 0, 80000 + rid * 100)
      await updateSignals(env.db, env.cfg, rid)
    }
    const cand = candidates.byHead(env.db, '鲸鲸')
    expect(cand).not.toBeNull()
    // 评估时点已超出存活窗口（末次证据 2 → 窗口 10 轮）：休眠跳过，不触发也不出队
    const gap = env.cfg.lifecycle.surf_survive_rounds
    const asleep = await transitionCandidates(env.db, env.cfg, 2 + gap)
    expect(asleep.triggered).not.toContain(cand!.cid)
    expect(candidates.get(env.db, cand!.cid)!.state).toBe('pending')
    // 新证据唤醒（回到窗口内）：累计体量线达标 → 触发
    seedComments(env.db, ['鲸鲸真的可爱', '鲸鲸'], [921, 922], 3, 0, 83000)
    await updateSignals(env.db, env.cfg, 3)
    const awake = await transitionCandidates(env.db, env.cfg, 3)
    expect(awake.triggered).toContain(cand!.cid)
  })

  it('普通词有复读证据也可过统计门，但是否为梗仍须人工判定', async () => {
    const variants = ['这也不行那也不行', '进度不行啊', '手感不行', '网络不行', '状态不行',
      '天气不行', '发挥不行', '队形不行', '成绩不行', '翻译不行']
    for (const rid of [1, 2]) {
      const texts = ['不行', ...variants, '不行']
      seedComments(env.db, texts.map((v, i) => `${v}第${rid}轮${i}条`),
        Array.from({ length: texts.length }, (_, i) => 801 + i), rid, 0, 60000 + rid * 100)
      await updateSignals(env.db, env.cfg, rid)
      await transitionCandidates(env.db, env.cfg, rid)
    }
    const cand = candidates.byHead(env.db, '不行')
    expect(cand, '普通词仍应能被统计门暴露给操作员').not.toBeNull()
    expect(cand!.state, '过统计门只表示待判断，不表示已确认是梗').toBe('triggered')
  })

  it('同视频反复复读是梗指征：3 视频 6 次出现即达体量线（跨视频线 5 会漏掉）', async () => {
    // dv=3 过不了旧跨视频线（5），但绝对次数 6 达线——同一梗词在少量视频里
    // 被反复刷是复读行为本身
    const r1 = ['没绷住', '没绷住', '这里真的没绷住了', ...Array.from({ length: 8 }, (_, i) => `普通补充说明第${i}条内容各不相同`)]
    const r2 = ['没绷住', '没绷住了属于是', '直接没绷住了', ...Array.from({ length: 6 }, (_, i) => `另一批普通评论内容${i}各不相同`)]
    seedComments(env.db, r1, [701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 712], 1, 0, 91000)
    seedComments(env.db, r2, [701, 702, 703, 714, 715, 716, 717, 718, 719], 2, 0, 92000)
    await updateSignals(env.db, env.cfg, 1)
    await updateSignals(env.db, env.cfg, 2)
    await transitionCandidates(env.db, env.cfg, 2)
    const cand = candidates.byHead(env.db, '没绷住')
    expect(cand, '少视频多次复读未立户').not.toBeNull()
    expect(cand!.distinct_videos).toBeLessThan(env.cfg.lifecycle.trigger_videos)
    expect(cand!.state, '同视频复读达次数线应触发').toBe('triggered')
  })

  it('归账去重：候选词头不再被短语总账记第二次', async () => {
    seedComments(env.db, ['难绷', '这波难绷', '真的难绷', '普通评论甲', '普通评论乙', '普通评论丙'],
      [731, 732, 733, 734, 735, 736], 1)
    await updateSignals(env.db, env.cfg, 1)
    const row = env.db.prepare('SELECT COALESCE(SUM(cnt),0) AS s FROM phrase_daily WHERE phrase=?').get('难绷') as { s: number }
    expect(row.s, '词头出现 3 次，账本应记 3 而非 6').toBe(3)
  })
})
