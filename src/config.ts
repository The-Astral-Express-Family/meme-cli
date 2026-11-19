/**
 * 配置：单源 ~/.meme/config.json（JSON，snake_case，与旧 cordis.yml 字段同形）。
 * CLI 是独立进程读不到 harness profile 的 cordis 配置——本文件是唯一配置面。
 * 环境变量仅作临时覆盖；注意 harness 会剥离 agent shell 里的密钥类变量，
 * 归纳凭证（induction.api_key）应写进配置文件而不是环境变量。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemeError } from './errors.ts'

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
  /** wire 直连凭证（优先）；空回落 $DEEPSEEK_API_KEY。 */
  api_key?: string
  /** wire 端点（优先）；空回落 $DEEPSEEK_BASE_URL 再回落官方 anthropic 端点。 */
  base_url?: string
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

/** config.json 的原始形状（全部可选）。 */
export interface Config {
  db_path?: string
  credentials_file?: string
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

/** 展平后的运行时配置（全部字段就位）。 */
export interface ResolvedConfig {
  dbPath: string
  credentialsFile: string
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
    fetch: { ...DEFAULT_FETCH, ...raw.fetch },
    induction: { ...DEFAULT_INDUCTION, ...raw.induction },
    retrieval: { ...DEFAULT_RETRIEVAL, ...raw.retrieval },
    lifecycle: { ...DEFAULT_LIFECYCLE, ...raw.lifecycle },
    genericExtra: raw.detect?.generic_extra ?? [],
  }
}

export function configFile(): string {
  return join(homedir(), '.meme', 'config.json')
}

/**
 * 读 config.json（可缺省）并展开默认值。文件损坏是硬错误：
 * 配置错误静默回默认会掩盖用户意图，不如当场报清楚。
 */
export function loadConfig(file: string = configFile()): ResolvedConfig {
  let raw: Config = {}
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Config
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new MemeError(
        'MEME_CONFIG_INVALID',
        `配置文件解析失败：${file}（${e instanceof Error ? e.message : e}）`,
        '修正该 JSON 或删除文件回到全默认；字段说明见 README。',
      )
    }
  }
  return resolveConfig(raw)
}

/** `meme config init` 的模板：全默认值展开，api_key 留空待填。 */
export function configTemplate(): string {
  return JSON.stringify({
    db_path: '',
    credentials_file: '',
    fetch: { ...DEFAULT_FETCH },
    induction: { ...DEFAULT_INDUCTION, api_key: '', base_url: '' },
    retrieval: { ...DEFAULT_RETRIEVAL },
    lifecycle: { ...DEFAULT_LIFECYCLE },
    detect: { generic_extra: [] },
  }, null, 2) + '\n'
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
