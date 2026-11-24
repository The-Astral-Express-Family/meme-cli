/** QQ 群聊入池回归：合成编号、去重、轮次认领、留存保护、抽取与触发门豁免。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { claimPendingIngest, ingestGroupMessages, qqSyntheticId, reapLake } from '../src/lake.ts'
import { updateSignals } from '../src/detect/signals.ts'
import * as candidates from '../src/candidates.ts'
import { transitionCandidates } from '../src/lifecycle.ts'
import { makeCfg, openDb } from './helpers.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg({ lifecycle: { trigger_videos: 5, trigger_videos_alt: 8 } })
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

const msg = (over: Partial<{ msg_id: string; group: string; sender: string; content: string; ts_ms: number }>) => ({
  msg_id: 'ROBOT1.0_' + Math.random().toString(36).slice(2),
  group: 'G1ABCDEF',
  sender: 'S1AAAAAA',
  content: '测试消息',
  ts_ms: Date.now(),
  ...over,
})

describe('合成编号', () => {
  it('同 key 同值、恒为负、与 B站正数编号空间不冲突', () => {
    const a = qqSyntheticId('G1ABCDEF')
    expect(a).toBe(qqSyntheticId('G1ABCDEF'))
    expect(a).toBeLessThan(0)
    expect(qqSyntheticId('S1BBBBBB')).toBeLessThan(0)
    expect(a).not.toBe(qqSyntheticId('S1BBBBBB'))
  })
})

describe('入池与认领', () => {
  it('重投递去重：同 msg_id 第二次插入计 duplicate', () => {
    const m = msg({ msg_id: 'M_DUP_1', content: '难绷' })
    const r1 = ingestGroupMessages(env.db, [m])
    expect(r1.inserted).toBe(1)
    const r2 = ingestGroupMessages(env.db, [m])
    expect(r2.inserted).toBe(0)
    expect(r2.duplicates).toBe(1)
    // 群占位视频行只留一行
    const vids = env.db.prepare("SELECT COUNT(*) AS c FROM lake_videos WHERE source='qq'").get() as { c: number }
    expect(vids.c).toBe(1)
  })

  it('认领把 round_id=0 行并入当前轮；reapLake 不动未入轮行', () => {
    ingestGroupMessages(env.db, [msg({ content: '群聊第甲条' }), msg({ content: '群聊第乙条' })])
    // 未认领时留存清理不删（round_id>0 守卫）
    reapLake(env.db, 10, 7)
    const before = env.db.prepare("SELECT COUNT(*) AS c FROM lake_comments WHERE oid<0").get() as { c: number }
    expect(before.c).toBe(2)
    // 认领后进入本轮
    const claimed = claimPendingIngest(env.db, 3)
    expect(claimed).toBe(2)
    const rows = env.db.prepare("SELECT round_id FROM lake_comments WHERE oid<0").all() as Array<{ round_id: number }>
    expect(rows.every((r) => r.round_id === 3)).toBe(true)
    // 已认领行的留存语义与 B站行一致：留存窗口内保留，窗口外照常清理
    // （currentRound=10、留存 7 → cut=3，round 3 恰在边界外）
    reapLake(env.db, 10, 7)
    const after = env.db.prepare("SELECT COUNT(*) AS c FROM lake_comments WHERE oid<0").get() as { c: number }
    expect(after.c).toBe(0)
  })
})

describe('群消息进抽取与触发门', () => {
  it('群消息与 B站评论同批抽取：词头立户，来源可辨', async () => {
    ingestGroupMessages(env.db, [
      msg({ content: '鲸鲸', msg_id: 'Q1' }), msg({ content: '哦鲸鲸', msg_id: 'Q2' }),
      msg({ content: '鲸鲸好可爱', msg_id: 'Q3' }), msg({ content: '给鲸鲸完整的一生', msg_id: 'Q4' }),
      msg({ content: '鲸鲸', msg_id: 'Q5' }),
      ...Array.from({ length: 8 }, (_, i) => msg({ content: `这期视频质量不错画面也很用心值得反复观看第${i}条`, msg_id: `QF${i}` })),
    ])
    claimPendingIngest(env.db, 1)
    await updateSignals(env.db, env.cfg, 1)
    const cand = candidates.byHead(env.db, '鲸鲸')
    expect(cand, '群消息词头未立户').not.toBeNull()
  })

  it('单群复读浪：无跨 up 要求，次数达线即触发', async () => {
    // 同一群 2 轮刷"没绷住"：up_mid=0（ups=0<3），绝对次数 ≥5 达线
    ingestGroupMessages(env.db, [
      msg({ content: '没绷住', msg_id: 'D1' }), msg({ content: '没绷住', msg_id: 'D2' }),
      msg({ content: '这里真的没绷住了', msg_id: 'D3' }),
      ...Array.from({ length: 8 }, (_, i) => msg({ content: `普通评论补充说明内容各不相同第${i}条`, msg_id: `DFA${i}` })),
    ])
    claimPendingIngest(env.db, 1)
    await updateSignals(env.db, env.cfg, 1)
    ingestGroupMessages(env.db, [
      msg({ content: '没绷住', msg_id: 'D4' }), msg({ content: '没绷住了属于是', msg_id: 'D5' }),
      msg({ content: '直接没绷住了', msg_id: 'D6' }),
      ...Array.from({ length: 6 }, (_, i) => msg({ content: `另一批普通评论内容各不相同第${i}条`, msg_id: `DFB${i}` })),
    ])
    claimPendingIngest(env.db, 2)
    await updateSignals(env.db, env.cfg, 2)
    await transitionCandidates(env.db, env.cfg, 2)
    const cand = candidates.byHead(env.db, '没绷住')
    expect(cand, '单群复读未立户').not.toBeNull()
    expect(cand!.distinct_ups, '群占位视频 up_mid=0').toBeLessThan(3)
    expect(cand!.state, '跨 up 门已取消，次数线达线应触发').toBe('triggered')
  })
})
