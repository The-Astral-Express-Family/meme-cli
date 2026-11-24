/** 采样框编排：热门 + 每周必看 + 推荐流 + 高梗浓度分区 + 目标 up。获取与呈现解耦：任何获取失败只降级、不阻塞 surf。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import type { FetchConfig } from '../config.ts'
import { nowIso } from '../models.ts'
import * as bili from './bilibili.ts'
import { BiliSession, FetchError } from './http.ts'
import { WbiSigner } from './wbi.ts'
import { phashBytes } from '../detect/imgphash.ts'

export class FetchResult {
  new_videos = 0
  new_comments = 0
  old_skipped = 0
  degraded = false
  reason: string | null = null
  hot_keywords: string[] = []
  probed: string[] = [] // 实际执行搜索探测的关键词
  sources_ok: string[] = []
  sources_failed: string[] = []

  toDict(): Record<string, unknown> {
    return {
      new_videos: this.new_videos, new_comments: this.new_comments,
      old_skipped: this.old_skipped, degraded: this.degraded, reason: this.reason,
      hot_keywords: this.hot_keywords, probed: this.probed,
      sources_ok: this.sources_ok, sources_failed: this.sources_failed,
    }
  }
}

async function collectVideos(
  session: BiliSession, res: FetchResult, cfg: FetchConfig, db: DatabaseSync,
): Promise<bili.VideoRow[]> {
  const videos: bili.VideoRow[] = []
  let signer: WbiSigner | null = null
  const getSigner = () => (signer ??= new WbiSigner(session))

  const grab = async (source: string, fn: () => Promise<bili.VideoRow[]>) => {
    try {
      const rows = await fn()
      videos.push(...rows)
      res.sources_ok.push(source)
      console.error(`meme: fetch: ${source} ✓ ${rows.length} 条`)
    } catch (e) {
      const code = e instanceof FetchError ? e.code : (e instanceof Error ? e.constructor.name : String(e))
      res.sources_failed.push(`${source}:${code}`) // 单源失败不拖垮整轮
      console.error(`meme: fetch: ${source} ✗ ${code}`)
    }
  }

  await grab('popular', async () => {
    const out: bili.VideoRow[] = []
    for (let p = 1; p <= Math.max(cfg.popular_pages, 0); p++) {
      out.push(...await bili.popular(session, p))
    }
    return out
  })
  if (cfg.weekly) {
    await grab('weekly', async () => {
      const n = await bili.weeklyLatestNumber(session)
      return n ? bili.weekly(session, getSigner(), n) : []
    })
  }
  if (cfg.feed) {
    await grab('feed', async () => {
      const out: bili.VideoRow[] = []
      for (let p = 1; p <= Math.max(cfg.feed_pages, 2); p++) {
        out.push(...await bili.feedRcmd(session, getSigner(), p))
      }
      return out
    })
  }
  for (const rid of cfg.regions) {
    await grab(`region:${rid}`, async () => {
      const out: bili.VideoRow[] = []
      for (let p = 1; p <= Math.max(cfg.region_pages, 0); p++) {
        out.push(...await bili.region(session, rid, p))
      }
      return out
    })
  }
  for (const rid of cfg.rank_regions) {
    await grab(`rank:${rid}`, () => bili.rankRegion(session, rid))
  }
  if (cfg.related_of_top) {
    // QQ 群占位行（负数 aid）不是 B站视频，不能当顺藤摸瓜的种子
    const hosts = (db.prepare("SELECT aid FROM lake_videos WHERE source != 'qq' ORDER BY reply_count DESC LIMIT ?")
      .all(cfg.related_of_top) as Row[]).map((r) => r.aid as number)
    for (const aid of hosts) {
      await grab(`related:${aid}`, () => bili.related(session, aid)) // 顺藤摸瓜
    }
  }
  for (const mid of cfg.ups) {
    await grab(`up:${mid}`, () => bili.upVideos(session, getSigner(), mid))
  }
  if (cfg.hot_words) {
    // 热词是呈现层信号，不是视频源——单独入 res
    try {
      res.hot_keywords = (await bili.hotSearch(session, 15)).map((k) => k.keyword)
      res.sources_ok.push('hot_search')
    } catch (e) {
      const code = e instanceof FetchError ? e.code : (e instanceof Error ? e.constructor.name : String(e))
      res.sources_failed.push(`hot_search:${code}`)
    }
  }
  return videos
}

function insertVideo(db: DatabaseSync, v: bili.VideoRow, roundId: number): void {
  db.prepare(
    'INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source,round_id) '
    + 'VALUES(?,?,?,?,?,?,?,?,?,?,?) '
    + 'ON CONFLICT(aid) DO UPDATE SET reply_count=excluded.reply_count, fetched_at=excluded.fetched_at, round_id=excluded.round_id',
  ).run(v.aid, v.bvid, v.title, v.rid, v.up_mid, v.up_name, v.pubdate, v.reply_count, nowIso(), v.source, roundId)
}

/** 提取一条评论的图片：(url, w, h)。真实字段是 content.pictures（实探校准）。 */
export function replyImages(reply: Record<string, any>): Array<[string, number, number]> {
  const content = reply.content ?? {}
  const out: Array<[string, number, number]> = []
  for (const img of content.pictures ?? content.image ?? []) {
    if (typeof img !== 'object' || img === null) continue
    const url = img.img_src ?? img.image_url ?? img.url ?? ''
    if (url) out.push([url, Number(img.img_width ?? 0), Number(img.img_height ?? 0)])
  }
  return out
}

/** 内容寻址写入，返回是否为新评论。min_ctime 之前的远古评论不入湖（近期性闸门）。 */
export function insertComment(
  db: DatabaseSync, r: Record<string, any>, aid: number, roundId: number, minCtime = 0,
): boolean {
  const ctime = Number(r.ctime ?? 0)
  if (minCtime && ctime && ctime < minCtime) return false
  const res = db.prepare(
    'INSERT OR IGNORE INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id) '
    + 'VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    Number(r.rpid), aid, Number(r.root ?? 0), Number(r.parent ?? 0),
    Number(r.mid ?? 0), r.content?.message ?? '', ctime, Number(r.like ?? 0), nowIso(), roundId,
  )
  return res.changes > 0
}

/** 拉取一个视频的评论（含楼中楼），返回 [新增数, 超龄跳过数, 图片评论]。 */
export async function fetchVideoComments(
  db: DatabaseSync, session: BiliSession, aid: number, cfg: FetchConfig, roundId: number,
  isNewVideo: boolean, minCtime = 0,
): Promise<[number, number, Array<[number, string, number, number]>]> {
  let added = 0
  let skippedOld = 0
  const rootsNeedingSub: Array<[number, number]> = [] // [rpid, likes]
  const imgComments: Array<[number, string, number, number]> = [] // 图梗原料

  // 直插一条评论——root/parent 以 API 返回为准（交互梗配对依赖真实链）
  const insert = (reply: Record<string, any>): boolean => {
    if (insertComment(db, reply, aid, roundId, minCtime)) {
      added += 1
      for (const [url, w, h] of replyImages(reply)) {
        imgComments.push([Number(reply.rpid), url, w, h])
      }
      return true
    }
    if (minCtime) {
      const ctime = Number(reply.ctime ?? 0)
      if (ctime && ctime < minCtime) skippedOld += 1
    }
    return false
  }

  /** 按给定排序爬 pages 页；insert 内部做内容寻址去重与年龄闸门。 */
  const crawl = async (mode: number, pages: number) => {
    let cursor = 0 // reply/main 的 next 是游标，从 0 起
    for (let i = 0; i < pages; i++) {
      const out = await bili.replyMain(session, aid, cursor, mode)
      if (!out.replies.length) break
      let newInPage = 0
      for (const r of out.replies) {
        if (insert(r)) newInPage += 1
        for (const sub of r.replies ?? []) insert(sub)
        const rcount = Number(r.rcount ?? 0)
        if (rcount > (r.replies?.length ?? 0)) rootsNeedingSub.push([Number(r.rpid), Number(r.like ?? 0)])
      }
      if (added >= cfg.comments_per_video) break
      // 增量式：老视频热度页收益低（前页已覆盖且多为旧评），新视频翻到 is_end
      if (mode === 2 && !isNewVideo && newInPage === 0) break
      if (out.is_end) break
      const nxt = out.next || 0
      if (nxt <= cursor) break // 游标不前进 → 防死循环
      cursor = nxt
    }
  }

  const maxPages = isNewVideo ? cfg.reply_pages_per_video : 1
  await crawl(2, maxPages) // 热度页（高赞沉淀层）
  if (cfg.latest_pages_per_video && added < cfg.comments_per_video) {
    await crawl(3, cfg.latest_pages_per_video) // 最新页（进行中梗浪，天然满足近期性闸门）
  }
  // 楼中楼补全：取点赞最高的少量根评论，控制请求预算
  rootsNeedingSub.sort((a, b) => b[1] - a[1])
  const subRoots = Math.max(cfg.subreply_roots, 0)
  const subPages = Math.max(cfg.subreply_pages_per_root || 1, 1)
  for (const [rpid] of rootsNeedingSub.slice(0, subRoots)) {
    if (added >= cfg.comments_per_video) break
    for (let pg = 1; pg <= subPages; pg++) {
      let subs: Record<string, any>[]
      try {
        subs = await bili.subReplies(session, aid, rpid, pg)
      } catch {
        break
      }
      if (!subs.length) break
      for (const sub of subs) insert(sub)
    }
  }
  return [added, skippedOld, imgComments]
}

/** 下载评论图片并计算 pHash 入库（图梗发现原料）。URL 内容寻址，跨视频去重。 */
export async function fetchCommentImages(
  db: DatabaseSync, session: BiliSession,
  imgComments: Array<[number, string, number, number]>, roundId: number, cap: number,
): Promise<number> {
  if (cap <= 0 || !imgComments.length) return 0
  const seenUrls = new Set(
    (db.prepare('SELECT url FROM lake_comment_images').all() as Row[]).map((r) => r.url as string),
  )
  let n = 0
  const ins = db.prepare(
    'INSERT OR IGNORE INTO lake_comment_images(rpid,url,phash,width,height,round_id) VALUES(?,?,?,?,?,?)',
  )
  for (const [rpid, url, w, h] of imgComments) {
    if (n >= cap) break
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    let data: Uint8Array
    try {
      data = await session.getBytes(url)
    } catch (e) {
      console.error(`meme: fetch: 图片下载失败 ${url.slice(0, 60)}（${e instanceof Error ? e.constructor.name : e}）`) // 单图失败不拖垮轮次
      continue
    }
    const ph = await phashBytes(data)
    ins.run(rpid, url, ph, w, h, roundId)
    n += 1
  }
  return n
}

/** 执行一轮增量获取。任何网络失败 → degraded=true，存量照常出内容。probeExtra：操作员定向探测词，优先于热词。 */
export async function runFetch(
  db: DatabaseSync, cfg: FetchConfig, roundId: number, sessdata = '',
  probeExtra: string[] = [], signal?: AbortSignal,
): Promise<FetchResult> {
  const res = new FetchResult()
  const session = new BiliSession(cfg.delay_min, cfg.delay_max, cfg.timeout, sessdata, signal)
  const videos = await collectVideos(session, res, cfg, db)
  if ((probeExtra.length || cfg.probe_keywords) && !sessdata) {
    console.error('meme: fetch: 搜索探测需要登录态（运行 meme auth login），本轮跳过')
  }
  if (sessdata && (probeExtra.length || cfg.probe_keywords)) {
    // 搜索探测：登录态搜索关键词，定位承载梗浪的视频。定向词全量探测；热词按预算截断
    const signer = new WbiSigner(session)
    const base = [...new Set(probeExtra)]
    const budget = Math.max(cfg.probe_keywords - base.length, 0)
    const kws = [...base]
    for (const k of res.hot_keywords) {
      if (kws.length >= base.length + budget) break
      if (!kws.includes(k)) kws.push(k)
    }
    for (const kw of kws) {
      try {
        videos.push(...await bili.searchVideos(session, signer, kw))
        res.sources_ok.push(`probe:${kw.slice(0, 12)}`)
      } catch (e) {
        const code = e instanceof FetchError ? e.code : (e instanceof Error ? e.constructor.name : String(e))
        res.sources_failed.push(`probe:${kw.slice(0, 12)}:${code}`) // 单词失败不拖垮探测
      }
    }
    res.probed = kws
  }
  if (!videos.length && res.sources_failed.length && !res.sources_ok.length) {
    res.degraded = true
    res.reason = `全部数据源失败：${res.sources_failed.slice(0, 3).join(', ')}`
    return res
  }
  await pickAndCrawl(db, session, cfg, videos, roundId, res)
  if (res.old_skipped) {
    console.error(`meme: fetch: 已按近期性闸门跳过 ${res.old_skipped} 条超过 ${cfg.max_comment_age_days} 天的远古评论`)
  }
  if (!res.sources_ok.length && res.new_videos === 0 && res.new_comments === 0) {
    res.degraded = true
    res.reason ??= '无可用新视频（数据源失败或全部近期已爬）'
  }
  return res
}

/** 去重 + 排序（发现优先级：probe > feed > rank > 新视频 > 已知）+ 单源配额 + 逐视频爬评论。 */
async function pickAndCrawl(
  db: DatabaseSync, session: BiliSession, cfg: FetchConfig,
  videos: bili.VideoRow[], roundId: number, res: FetchResult,
): Promise<void> {
  const seen = new Map<number, bili.VideoRow>()
  for (const v of videos) {
    if (v.aid && !seen.has(v.aid)) seen.set(v.aid, v)
  }
  const staleDays = 3
  const cutoff = new Date(Date.now() - staleDays * 86400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const cutoffIso = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}T${p(cutoff.getHours())}:${p(cutoff.getMinutes())}:${p(cutoff.getSeconds())}`
  const freshRows = new Map(
    (db.prepare('SELECT aid, fetched_at FROM lake_videos WHERE fetched_at >= ?').all(cutoffIso) as Row[])
      .map((r) => [r.aid as number, r]),
  )
  const known = new Set((db.prepare('SELECT aid FROM lake_videos').all() as Row[]).map((r) => r.aid as number))
  const maxVage = cfg.max_video_age_days || 0
  const minPub = maxVage ? Math.floor(Date.now() / 1000) - maxVage * 86400 : 0

  const tierOf = (v: bili.VideoRow): number => {
    if (v.source === 'probe') return 0 // 定向确认
    if (v.source === 'feed') return 1 // 自动推送，发现主动入口
    if (v.source === 'rank') return 2 // 周榜枢纽
    return known.has(v.aid) ? 4 : 3
  }
  const cap = Math.max(cfg.max_per_source, 0) // 单源配额封顶：防头部源霸占配额，饿死顺藤摸瓜簇
  const picked: bili.VideoRow[] = []
  const perSource = new Map<string, number>()
  const sorted = [...seen.values()].sort(
    (a, b) => tierOf(a) - tierOf(b) || b.reply_count - a.reply_count || a.aid - b.aid,
  )
  for (const v of sorted) {
    if (freshRows.has(v.aid)) continue // 近期爬过的跳过
    if (minPub && v.pubdate && v.pubdate < minPub) continue // 视频年龄闸门：近期梗长在近期视频上
    const src = v.source.split(':')[0]
    if (cap && (perSource.get(src) ?? 0) >= cap) continue
    picked.push(v)
    perSource.set(src, (perSource.get(src) ?? 0) + 1)
    if (picked.length >= cfg.videos_per_round) break
  }
  const minCtime = cfg.max_comment_age_days > 0
    ? Math.floor(Date.now() / 1000) - cfg.max_comment_age_days * 86400
    : 0
  let imgBudget = cfg.comment_images_per_round
  for (const v of picked) {
    const isNew = !known.has(v.aid)
    insertVideo(db, v, roundId)
    if (isNew) res.new_videos += 1
    try {
      const [added, skipped, imgComments] = await fetchVideoComments(db, session, v.aid, cfg, roundId, isNew, minCtime)
      res.new_comments += added
      res.old_skipped += skipped
      if (imgBudget > 0 && imgComments.length) {
        imgBudget -= await fetchCommentImages(db, session, imgComments, roundId, imgBudget)
      }
    } catch (e) {
      if (e instanceof FetchError) {
        console.error(`meme: fetch: 视频 ${v.aid} 评论失败（${e.code}），跳过`)
        continue
      }
      throw e
    }
  }
}
