/**
 * 插件配置：cordis.yml（Schemastery 校验 + 默认值）取代 Python 版 meme.toml。
 * 环境变量约定与 DSH 生态一致：MEME_DB（库路径）、DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL
 * （wire 归纳路径）、BILI_SESSDATA（由 sessdata_env 指定名的登录态）。
 */
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const ENV_DB = 'MEME_DB'
export const ENV_API_KEY = 'DEEPSEEK_API_KEY'
export const ENV_BASE_URL = 'DEEPSEEK_BASE_URL'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

export interface FetchConfig {
  popular_pages: number
  weekly: boolean
  feed: boolean
  feed_pages: number
  regions: number[]
  region_pages: number
  rank_regions: number[]
  related_of_top: number
  hot_words: boolean
  ups: number[]
  videos_per_round: number
  comments_per_video: number
  reply_pages_per_video: number
  latest_pages_per_video: number
  max_per_source: number
  subreply_pages_per_root: number
  max_comment_age_days: number
  max_video_age_days: number
  sessdata_env: string
  probe_keywords: number
  subreply_roots: number
  comment_images_per_round: number
  delay_min: number
  delay_max: number
  timeout: number
}

export interface InductionConfig {
  model: string
  small_model: string
  reasoning_effort: string
  max_tokens: number
  daily_call_budget: number
  backtest_holdout: number
  backtest_min_hit: number
  backtest_max_fp: number
  backtest_negatives: number
  api_key_env: string
  base_url_env: string
}

export interface RetrievalConfig {
  default_level: string
  round_size: number
  search_top: number
  vector_threshold: number
  rrf_k: number
  embed_model: string
}

export interface LifecycleConfig {
  trigger_rounds: number
  trigger_videos: number
  trigger_z: number
  trigger_videos_alt: number
  trigger_fresh_videos: number
  trigger_meme_score: number
  promote_rounds: number
  fade_window_days: number
  fade_drop: number
  tombstone_ratio: number
  candidate_expire_rounds: number
  backlog_alert: number
}

export interface Config {
  db_path?: string
  credentials_file?: string
  llm_provider?: string
  fetch?: Partial<FetchConfig>
  induction?: Partial<InductionConfig>
  retrieval?: Partial<RetrievalConfig>
  lifecycle?: Partial<LifecycleConfig>
  detect?: { generic_extra?: string[] }
}

const DEFAULT_FETCH: FetchConfig = {
  popular_pages: 1,
  weekly: true,
  feed: true,
  feed_pages: 2,
  regions: [119],
  region_pages: 1,
  rank_regions: [],
  related_of_top: 0,
  hot_words: true,
  ups: [],
  videos_per_round: 15,
  comments_per_video: 200,
  reply_pages_per_video: 3,
  latest_pages_per_video: 0,
  max_per_source: 0,
  subreply_pages_per_root: 1,
  max_comment_age_days: 30,
  max_video_age_days: 0,
  sessdata_env: '',
  probe_keywords: 0,
  subreply_roots: 5,
  comment_images_per_round: 20,
  delay_min: 0.8,
  delay_max: 1.5,
  timeout: 15,
}

const DEFAULT_INDUCTION: InductionConfig = {
  model: 'deepseek-flash',
  small_model: 'deepseek-flash',
  reasoning_effort: 'low',
  max_tokens: 8192,
  daily_call_budget: 40,
  backtest_holdout: 0.3,
  backtest_min_hit: 0.7,
  backtest_max_fp: 0.02,
  backtest_negatives: 1000,
  api_key_env: ENV_API_KEY,
  base_url_env: ENV_BASE_URL,
}

const DEFAULT_RETRIEVAL: RetrievalConfig = {
  default_level: 'card',
  round_size: 10,
  search_top: 8,
  vector_threshold: 0.6,
  rrf_k: 60,
  embed_model: 'BAAI/bge-small-zh-v1.5',
}

const DEFAULT_LIFECYCLE: LifecycleConfig = {
  trigger_rounds: 2,
  trigger_videos: 4,
  trigger_z: 4,
  trigger_videos_alt: 8,
  trigger_fresh_videos: 5,
  trigger_meme_score: 0.45,
  promote_rounds: 2,
  fade_window_days: 90,
  fade_drop: 0.5,
  tombstone_ratio: 0.1,
  candidate_expire_rounds: 6,
  backlog_alert: 10,
}

const num = (fallback: number) => Schema.number().default(fallback)
const bool = (fallback: boolean) => Schema.boolean().default(fallback)
const str = (fallback: string) => Schema.string().default(fallback)
const list = (fallback: number[]) => Schema.array(Schema.number()).default(fallback)

/** Schemastery schema：Cordis 加载时校验配置并补默认值。 */
export const Config = Schema.object({
  db_path: Schema.string().role('path').description('SQLite 库路径，默认 ~/.meme/memes.db（$MEME_DB 覆盖）'),
  credentials_file: Schema.string().description('meme login 写出的登录态文件，默认 ~/.meme/credentials.json'),
  llm_provider: Schema.string().description('LLM 路径归纳用的 harness provider 路由（默认自动取第一个可用 provider）'),
  fetch: Schema.object({
    popular_pages: num(DEFAULT_FETCH.popular_pages),
    weekly: bool(DEFAULT_FETCH.weekly),
    feed: bool(DEFAULT_FETCH.feed),
    feed_pages: num(DEFAULT_FETCH.feed_pages),
    regions: list(DEFAULT_FETCH.regions),
    region_pages: num(DEFAULT_FETCH.region_pages),
    rank_regions: list(DEFAULT_FETCH.rank_regions),
    related_of_top: num(DEFAULT_FETCH.related_of_top),
    hot_words: bool(DEFAULT_FETCH.hot_words),
    ups: list(DEFAULT_FETCH.ups),
    videos_per_round: num(DEFAULT_FETCH.videos_per_round),
    comments_per_video: num(DEFAULT_FETCH.comments_per_video),
    reply_pages_per_video: num(DEFAULT_FETCH.reply_pages_per_video),
    latest_pages_per_video: num(DEFAULT_FETCH.latest_pages_per_video),
    max_per_source: num(DEFAULT_FETCH.max_per_source),
    subreply_pages_per_root: num(DEFAULT_FETCH.subreply_pages_per_root),
    max_comment_age_days: num(DEFAULT_FETCH.max_comment_age_days),
    max_video_age_days: num(DEFAULT_FETCH.max_video_age_days),
    sessdata_env: str(DEFAULT_FETCH.sessdata_env),
    probe_keywords: num(DEFAULT_FETCH.probe_keywords),
    subreply_roots: num(DEFAULT_FETCH.subreply_roots),
    comment_images_per_round: num(DEFAULT_FETCH.comment_images_per_round),
    delay_min: num(DEFAULT_FETCH.delay_min),
    delay_max: num(DEFAULT_FETCH.delay_max),
    timeout: num(DEFAULT_FETCH.timeout),
  }).description('B站采样框'),
  induction: Schema.object({
    model: str(DEFAULT_INDUCTION.model),
    small_model: str(DEFAULT_INDUCTION.small_model),
    reasoning_effort: str(DEFAULT_INDUCTION.reasoning_effort),
    max_tokens: num(DEFAULT_INDUCTION.max_tokens),
    daily_call_budget: num(DEFAULT_INDUCTION.daily_call_budget),
    backtest_holdout: num(DEFAULT_INDUCTION.backtest_holdout),
    backtest_min_hit: num(DEFAULT_INDUCTION.backtest_min_hit),
    backtest_max_fp: num(DEFAULT_INDUCTION.backtest_max_fp),
    backtest_negatives: num(DEFAULT_INDUCTION.backtest_negatives),
    api_key_env: str(DEFAULT_INDUCTION.api_key_env),
    base_url_env: str(DEFAULT_INDUCTION.base_url_env),
  }).description('归纳器与 backtest 闸门'),
  retrieval: Schema.object({
    default_level: str(DEFAULT_RETRIEVAL.default_level),
    round_size: num(DEFAULT_RETRIEVAL.round_size),
    search_top: num(DEFAULT_RETRIEVAL.search_top),
    vector_threshold: num(DEFAULT_RETRIEVAL.vector_threshold),
    rrf_k: num(DEFAULT_RETRIEVAL.rrf_k),
    embed_model: str(DEFAULT_RETRIEVAL.embed_model),
  }).description('检索与呈现'),
  lifecycle: Schema.object({
    trigger_rounds: num(DEFAULT_LIFECYCLE.trigger_rounds),
    trigger_videos: num(DEFAULT_LIFECYCLE.trigger_videos),
    trigger_z: num(DEFAULT_LIFECYCLE.trigger_z),
    trigger_videos_alt: num(DEFAULT_LIFECYCLE.trigger_videos_alt),
    trigger_fresh_videos: num(DEFAULT_LIFECYCLE.trigger_fresh_videos),
    trigger_meme_score: num(DEFAULT_LIFECYCLE.trigger_meme_score),
    promote_rounds: num(DEFAULT_LIFECYCLE.promote_rounds),
    fade_window_days: num(DEFAULT_LIFECYCLE.fade_window_days),
    fade_drop: num(DEFAULT_LIFECYCLE.fade_drop),
    tombstone_ratio: num(DEFAULT_LIFECYCLE.tombstone_ratio),
    candidate_expire_rounds: num(DEFAULT_LIFECYCLE.candidate_expire_rounds),
    backlog_alert: num(DEFAULT_LIFECYCLE.backlog_alert),
  }).description('候选与词条状态机阈值'),
  detect: Schema.object({
    generic_extra: Schema.array(Schema.string()).default([]),
  }).description('检测层停用词扩展'),
})

/** 展平后的运行时配置（全部字段就位）。 */
export interface ResolvedConfig {
  dbPath: string
  credentialsFile: string
  llmProvider: string
  fetch: FetchConfig
  induction: InductionConfig
  retrieval: RetrievalConfig
  lifecycle: LifecycleConfig
  genericExtra: string[]
}

export function defaultDbPath(): string {
  return join(homedir(), '.meme', 'memes.db')
}

export function resolveConfig(raw: Config = {}): ResolvedConfig {
  const envDb = process.env[ENV_DB]
  return {
    dbPath: envDb || raw.db_path || defaultDbPath(),
    credentialsFile: raw.credentials_file || join(homedir(), '.meme', 'credentials.json'),
    llmProvider: raw.llm_provider || '',
    fetch: { ...DEFAULT_FETCH, ...raw.fetch },
    induction: { ...DEFAULT_INDUCTION, ...raw.induction },
    retrieval: { ...DEFAULT_RETRIEVAL, ...raw.retrieval },
    lifecycle: { ...DEFAULT_LIFECYCLE, ...raw.lifecycle },
    genericExtra: raw.detect?.generic_extra ?? [],
  }
}

/** meme login 写出的登录态。 */
export interface BiliCredentials {
  sessdata: string
  bili_jct?: string
  dede_user_id?: string
  buvid3?: string
  mid?: number
  uname?: string
  saved_at: string
}

export function readCredentials(file: string): BiliCredentials | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BiliCredentials
  } catch {
    return null
  }
}

/** 登录态解析：凭证文件 > sessdata_env 环境变量。 */
export function resolveSessdata(cfg: ResolvedConfig): string {
  const cred = readCredentials(cfg.credentialsFile)
  if (cred?.sessdata) return cred.sessdata
  return cfg.fetch.sessdata_env ? process.env[cfg.fetch.sessdata_env] || '' : ''
}
