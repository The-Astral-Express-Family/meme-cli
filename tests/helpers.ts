/** 测试夹具：临时库、假 fetcher、matcher 构造 helper。全部离线（MEME_EMBED_OFF=1 见 vitest.config）。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach } from 'vitest'
import { connect, type Row } from '../src/db.ts'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { FetchResult } from '../src/fetch/sampler.ts'
import type { Constraints, MatcherSpec, Meme, PatternSpec } from '../src/models.ts'

const tmpDirs: string[] = []
const openDbs: Array<ReturnType<typeof connect>> = []

function cleanup(): void {
  // Windows 上 WAL 文件持有句柄：先关连接再删临时目录（失败则留给系统临时目录自清理）
  for (const db of openDbs) {
    try { db.close() } catch { /* 已关闭 */ }
  }
  openDbs.length = 0
}

// 每个测试结束就释放连接，避免临时库句柄跨测试堆积；afterAll 只做兜底清目录
afterEach(cleanup)
afterAll(() => {
  cleanup()
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 句柄延迟释放 */ }
  }
})

/** 临时目录里的独立测试库配置。 */
export function makeCfg(overrides: Record<string, unknown> = {}): { cfg: ResolvedConfig; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meme-test-'))
  tmpDirs.push(dir)
  const dbPath = join(dir, 'test.db')
  const cfg = resolveConfig({ ...overrides } as never)
  return { cfg: { ...cfg, dbPath }, dbPath }
}

export function openDb(cfg: ResolvedConfig): ReturnType<typeof connect> {
  const db = connect(cfg.dbPath)
  openDbs.push(db)
  return db
}

export function fakeFetchRound(
  newComments = 0, videos = 0, degraded = false, reason: string | null = null,
) {
  return async (_db: unknown, _cfg: unknown, _roundId: number, _sessdata: string, probe: string[] = []) => {
    const res = new FetchResult()
    res.new_comments = newComments
    res.new_videos = videos
    res.degraded = degraded
    res.reason = reason
    res.probed = [...probe]
    return res
  }
}

/** 直灌原始湖（绕过网络），并登记视频元数据（junk 标题，需要真标题时自行覆盖）。
 * 多轮 seed 用不同 rpidBase 防冲突。aids 给定时按 zip 语义截断。 */
export function seedComments(
  db: ReturnType<typeof connect>, texts: string[], aids?: number[], roundId = 1, daysAgo = 0, rpidBase = 50000,
): void {
  const groupSize = Math.max(Math.floor(texts.length / 3), 1)
  const finalAids = aids ?? texts.map((_, i) => 1001 + Math.floor(i / groupSize))
  const n = aids ? Math.min(texts.length, aids.length) : texts.length
  const ts = new Date()
  const p = (n2: number) => String(n2).padStart(2, '0')
  const iso = `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())}T${p(ts.getHours())}:${p(ts.getMinutes())}:${p(ts.getSeconds())}`
  const insC = db.prepare(
    'INSERT OR IGNORE INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
  )
  const insV = db.prepare(
    'INSERT OR IGNORE INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source,round_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  )
  for (let i = 0; i < n; i++) {
    const aid = finalAids[i]
    insC.run(rpidBase + i, aid, 0, 0, 9000 + i, texts[i], Math.floor(Date.now() / 1000) - daysAgo * 86400, i, iso, roundId)
    insV.run(aid, `BV${i}`, '', 119, 7000 + (aid % 5), `up${aid % 5}`, 0, 100, iso, 'test', roundId)
  }
}

export type { Row }

// ---- matcher 构造 helper（原在 test-matchers.test.ts 内导出；移到夹具避免
//      .test.ts 文件互相 import 导致 describe 块被重复注册）----

export const constraints = (o: Partial<Constraints> = {}): Constraints => ({
  standalone: false, sentence_final: false, forbid_inner: false,
  forbid_context: [], require_context: [], context_window: 12, ...o,
})

/** PatternSpec 字段全量填充（zod 输出类型要求六数组齐全）。 */
export const pattern = (p: Partial<PatternSpec> & { kind: PatternSpec['kind'] }): PatternSpec => ({
  terms: [], tokens: [], trigger_terms: [], trigger_tokens: [], response_terms: [], response_tokens: [],
  ...p,
})

export const matcher = (patterns: PatternSpec[], cons?: Constraints): MatcherSpec => ({
  patterns, constraints: cons ?? constraints(),
})

export function makeMeme(overrides: Partial<Meme> & { matcher?: MatcherSpec | null }): Meme {
  return {
    id: 'm_0001', name: '典', aliases: ['典中典'], class: 'word',
    lineage: { parent: null, mutation: null }, platform: ['bilibili'], state: 'observing',
    birth: { circa: null }, matcher: overrides.matcher ?? null,
    card: { gist: '单字反讽"经典"', usage: [], taboo: null, register: null, aggression: null },
    examples: [], drift: [], stats: { wild_freq_30d: 0, peak_freq: 0, last_seen: null, last_matched_round: 0 },
    wild_rounds: [], revived_pending: 0, created_at: 'x', updated_at: 'x',
    ...overrides,
  }
}

export function noEmbed() {
  return { available: false, dim: null, embed: async () => null } as never
}
