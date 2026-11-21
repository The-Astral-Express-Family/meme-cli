/** B站公开端点封装（匿名 + 可选登录态）。全部失败由上层降级。 */
import { BiliSession, FetchError } from './http.ts'
import type { WbiSigner } from './wbi.ts'

export { BiliSession, FetchError }
export type { WbiSigner }

const API = 'https://api.bilibili.com'

export interface VideoRow {
  aid: number
  bvid: string
  title: string
  rid: number
  up_mid: number
  up_name: string
  pubdate: number
  reply_count: number
  source: string
}

function videoRow(v: Record<string, any>, source: string): VideoRow {
  const owner = v.owner ?? v.author ?? {}
  const stat = v.stat ?? {}
  return {
    aid: Number(v.aid ?? 0),
    bvid: v.bvid ?? '',
    title: v.title ?? '',
    rid: v.tid ?? v.rid ?? 0,
    up_mid: Number(owner.mid ?? v.mid ?? 0) || 0,
    up_name: owner.name ?? v.author ?? '',
    pubdate: Number(v.pubdate ?? v.created ?? 0),
    reply_count: Number(stat.reply ?? v.reply ?? 0),
    source,
  }
}

export async function popular(s: BiliSession, page = 1): Promise<VideoRow[]> {
  const data = await s.getJson<{ list?: Record<string, any>[] }>(`${API}/x/web-interface/popular`, { ps: 20, pn: page })
  return (data.list ?? []).map((v) => videoRow(v, 'popular'))
}

export async function weeklyLatestNumber(s: BiliSession): Promise<number | null> {
  const data = await s.getJson<{ list?: Array<{ number: number }> }>(`${API}/x/web-interface/popular/series/list`)
  const lst = data.list ?? []
  return lst.length ? Number(lst[0].number) : null
}

export async function weekly(s: BiliSession, signer: WbiSigner, number: number): Promise<VideoRow[]> {
  // series/one 必须 wbi 签名（匿名裸参实测 -352）；series/list 无需签名
  const params = await signer.sign({ number })
  const data = await s.getJson<{ list?: Record<string, any>[] }>(`${API}/x/web-interface/popular/series/one`, params)
  return (data.list ?? []).map((v) => videoRow(v, 'weekly'))
}

export async function region(s: BiliSession, rid: number, page = 1, ps = 20): Promise<VideoRow[]> {
  // 旧 x/dynamic/region 已退役（-400）；newlist（分区最新投稿）是同形替代，响应同为 data.archives
  const data = await s.getJson<{ archives?: Record<string, any>[] }>(`${API}/x/web-interface/newlist`, { rid, ps, pn: page })
  return (data.archives ?? []).map((v) => videoRow(v, 'region'))
}

export async function upVideos(s: BiliSession, signer: WbiSigner, mid: number): Promise<VideoRow[]> {
  const params = await signer.sign({ mid, ps: 30, pn: 1, order: 'pubdate' })
  const data = await s.getJson<{ list?: { vlist?: Record<string, any>[] } }>(`${API}/x/space/wbi/arc/search`, params)
  return (data.list?.vlist ?? []).map((v) => videoRow(v, 'up'))
}

/** 站内热搜词（今日热点）。搜索接口需登录，热词仅作呈现层决策支持。 */
export async function hotSearch(s: BiliSession, limit = 20): Promise<Array<{ keyword: string; show_name: string }>> {
  const data = await s.getJson<{ trending?: { list?: Array<{ keyword?: string; show_name?: string }> } }>(
    `${API}/x/web-interface/search/square`, { limit },
  )
  return (data.trending?.list ?? [])
    .filter((t) => t.keyword)
    .map((t) => ({ keyword: (t.keyword ?? '').trim(), show_name: (t.show_name ?? '').trim() }))
}

/** 分区周榜（排行版）：头部视频评论区是梗浪主战场。 */
export async function rankRegion(s: BiliSession, rid: number): Promise<VideoRow[]> {
  const data = await s.getJson<{ list?: Record<string, any>[] }>(`${API}/x/web-interface/ranking/v2`, { rid, type: 'all' })
  return (data.list ?? []).map((v) => videoRow(v, 'rank'))
}

/**
 * 首页推荐流（自动推送）：发现的主动入口——站方推荐序就是实时热度信号，
 * 不依赖操作员猜关键词（关键词检索降级为梗信息确认工具，surf probe）。
 */
export async function feedRcmd(s: BiliSession, signer: WbiSigner, page = 1, ps = 20): Promise<VideoRow[]> {
  const params = await signer.sign({
    feed_version: 'V3', fresh_type: 4, fresh_day: 1,
    fresh_idx: page, fresh_idx_1h: page, ps, platform: 'web',
  })
  const data = await s.getJson<{ item?: Record<string, any>[] }>(`${API}/x/web-interface/index/top/feed/rcmd`, params)
  const out: VideoRow[] = []
  for (const it of data.item ?? []) {
    if (it.goto !== undefined && it.goto !== null && it.goto !== 'av') continue // 非 av 卡片（直播/广告位）跳过
    const stat = it.stat ?? {}
    const owner = it.owner ?? {}
    out.push(videoRow({
      aid: it.id ?? it.aid,
      bvid: it.bvid ?? '',
      title: it.title ?? '',
      tid: 0,
      owner: { mid: owner.mid ?? 0, name: owner.name ?? '' },
      pubdate: it.pubdate ?? 0,
      stat: { reply: stat.reply ?? 0 },
    }, 'feed'))
  }
  return out
}

/** 相关视频推荐：从已知视频顺藤摸瓜（梗浪跨相关视频传播）。 */
export async function related(s: BiliSession, aid: number): Promise<VideoRow[]> {
  const data = await s.getJson<Record<string, any>[]>(`${API}/x/web-interface/archive/related`, { aid })
  return (Array.isArray(data) ? data : []).map((v) => videoRow(v, 'related'))
}

/** 关键词搜视频（综合排序，需登录态）——热词探测：定位承载梗浪的视频。 */
export async function searchVideos(s: BiliSession, signer: WbiSigner, keyword: string, page = 1): Promise<VideoRow[]> {
  const params = await signer.sign({
    search_type: 'video', keyword, page, page_size: 20, order: 'totalrank',
  })
  const data = await s.getJson<{ result?: Record<string, any>[] }>(`${API}/x/web-interface/wbi/search/type`, params)
  const out: VideoRow[] = []
  for (const it of data.result ?? []) {
    if (!it.aid) continue
    out.push(videoRow({
      aid: it.aid, bvid: it.bvid ?? '',
      title: String(it.title ?? '').replace(/<[^>]+>/g, ''),
      tid: it.tid ?? 0,
      owner: { mid: it.mid ?? 0, name: it.author ?? '' },
      pubdate: it.pubdate ?? 0,
      stat: { reply: it.review ?? 0 },
    }, 'probe'))
  }
  return out
}

export interface ReplyPage {
  replies: Record<string, any>[]
  is_end: boolean
  next: number
}

/** 主评论区。mode: 2=热度序 3=时间序（最新评论=进行中梗浪）。next 是游标（从 0 起）。 */
export async function replyMain(s: BiliSession, aid: number, nextCursor = 0, mode = 2): Promise<ReplyPage> {
  const data = await s.getJson<{ replies?: Record<string, any>[]; cursor?: { is_end?: boolean; next?: number } }>(
    `${API}/x/v2/reply/main`, { type: 1, oid: aid, mode, next: nextCursor },
  )
  return {
    replies: data.replies ?? [],
    is_end: Boolean(data.cursor?.is_end),
    next: Number(data.cursor?.next ?? 0),
  }
}

/** 楼中楼（交互梗配对样本来源）。 */
export async function subReplies(s: BiliSession, aid: number, root: number, page = 1): Promise<Record<string, any>[]> {
  const data = await s.getJson<{ replies?: Record<string, any>[] }>(`${API}/x/v2/reply/reply`, {
    type: 1, oid: aid, root, ps: 20, pn: page,
  })
  return data.replies ?? []
}
