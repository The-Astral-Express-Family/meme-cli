/** 获取器回归：游标翻页、年龄闸门、图片字段、推荐流解析。 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { fetchVideoComments, insertComment, replyImages } from '../src/fetch/sampler.ts'
import { feedRcmd } from '../src/fetch/bilibili.ts'
import type { BiliSession } from '../src/fetch/http.ts'
import type { FetchConfig } from '../src/config.ts'

describe('游标翻页（reply/main 的 next 是从 0 起的游标）', () => {
  it('游标被跟随：0 → 10 → 20，而非 0 → 1 → 2', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(
      'CREATE TABLE lake_comments(rpid INTEGER PRIMARY KEY, oid INTEGER, root INTEGER DEFAULT 0,'
      + 'parent INTEGER DEFAULT 0, mid INTEGER DEFAULT 0, message TEXT, ctime INTEGER,'
      + 'likes INTEGER DEFAULT 0, fetched_at TEXT, round_id INTEGER DEFAULT 0);'
      + 'CREATE TABLE lake_videos(aid INTEGER PRIMARY KEY);'
      + 'INSERT INTO lake_videos VALUES(999);',
    )
    const reply = (rpid: number) => ({ rpid, content: { message: `评论${rpid}` }, ctime: 1, like: 1, rcount: 0, replies: [] })
    const pages = new Map([[0, [reply(1), reply(2)]], [10, [reply(3)]], [20, [reply(4)]]])
    const calls: number[] = []
    const session = {
      // 契约：getJson(url, params) 返回已解包的 data 载荷；next 是 params 里的游标
      async getJson(_url: string | URL, params?: Record<string, unknown>): Promise<Record<string, any>> {
        const nxt = Number(params?.next ?? 0)
        calls.push(nxt)
        return {
          replies: pages.get(nxt) ?? [],
          cursor: { is_end: nxt === 20, next: nxt + 10 },
        }
      },
    } as unknown as BiliSession
    const cfg = { reply_pages_per_video: 3, comments_per_video: 200, subreply_pages_per_root: 0 } as FetchConfig
    const [added, skipped] = await fetchVideoComments(db, session, 999, cfg, 1, true)
    expect(added).toBe(4)
    expect(skipped).toBe(0)
    expect(calls).toEqual([0, 10, 20]) // 游标被跟随
    db.close()
  })
})

describe('评论年龄闸门', () => {
  it('ctime 早于 min_ctime 的远古评论不入湖', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(
      'CREATE TABLE lake_comments(rpid INTEGER PRIMARY KEY, oid INTEGER, root INTEGER DEFAULT 0,'
      + 'parent INTEGER DEFAULT 0, mid INTEGER DEFAULT 0, message TEXT, ctime INTEGER,'
      + 'likes INTEGER DEFAULT 0, fetched_at TEXT, round_id INTEGER DEFAULT 0);',
    )
    const now = Math.floor(Date.now() / 1000)
    const minCtime = now - 30 * 86400
    const ancient = { rpid: 1, content: { message: '2023年的热评' }, ctime: now - 400 * 86400, like: 999, rcount: 0, replies: [] }
    const fresh = { rpid: 2, content: { message: '昨天的热评' }, ctime: now - 3600, like: 5, rcount: 0, replies: [] }
    expect(insertComment(db, ancient, 1, 1, minCtime)).toBe(false)
    expect(insertComment(db, fresh, 1, 1, minCtime)).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS c FROM lake_comments').get() as { c: number }).c).toBe(1)
    db.close()
  })
})

describe('评论图片字段（实探校准）', () => {
  it('content.pictures 优先，content.image 兜底，垃圾元素跳过', () => {
    const r1 = { content: { pictures: [{ img_src: 'http://x/a.png', img_width: 10, img_height: 20 }] } }
    expect(replyImages(r1)).toEqual([['http://x/a.png', 10, 20]])
    const r2 = { content: { image: [{ image_url: 'http://x/b.jpg' }] } }
    expect(replyImages(r2)).toEqual([['http://x/b.jpg', 0, 0]])
    expect(replyImages({ content: {} })).toEqual([])
    expect(replyImages({})).toEqual([])
    expect(replyImages({ content: { pictures: ['垃圾元素', { img_src: 'http://x/c.webp' }] } }))
      .toEqual([['http://x/c.webp', 0, 0]])
  })
})

describe('推荐流解析', () => {
  const fakeSigner = { sign: async (p: Record<string, unknown>) => p } as never
  const payload = {
    item: [
      { id: 111, bvid: 'BV1', title: '标题1', goto: 'av', owner: { mid: 9, name: 'up甲' }, pubdate: 1794000000, stat: { view: 100, like: 5, danmaku: 1 } },
      { id: 222, bvid: 'BV2', title: '直播卡', goto: 'live' },
      { aid: 333, bvid: 'BV3', title: '标题3', goto: 'av', owner: { mid: 8, name: 'up乙' }, pubdate: 1794000100, stat: {} },
    ],
  }

  it('统一视频行：id→aid、owner 提取、无 reply 记 0、非 av 卡片跳过', async () => {
    let calls = 0
    const session = {
      async getJson(): Promise<Record<string, any>> {
        calls += 1
        return payload
      },
    } as unknown as BiliSession
    const out = await feedRcmd(session, fakeSigner, 1)
    expect(out.map((v) => v.aid)).toEqual([111, 333])
    expect(out[0].source).toBe('feed')
    expect(out[0].up_name).toBe('up甲')
    expect(out[0].reply_count).toBe(0) // 推荐流无 reply 字段
    expect(out[1].aid).toBe(333) // aid 键回退兼容
    expect(calls).toBe(1)
  })
})
