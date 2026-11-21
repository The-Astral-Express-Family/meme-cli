/**
 * 配置：单源 ~/.meme/config.json（JSON，snake_case）。
 * CLI 是独立进程读不到 harness profile 的 cordis 配置——本文件是唯一配置面。
 * 环境变量仅作临时覆盖（MEME_DB）。归纳不需要外部 LLM——操作员 agent 亲写词条，
 * backtest 等闸门全部本地运行，配置里没有凭证类字段。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemeError } from './errors.ts'

export const ENV_DB = 'MEME_DB'

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
  probe_keywords: number
  subreply_roots: number
  comment_images_per_round: number
  delay_min: number
  delay_max: number
  timeout: number
}

export interface BacktestConfig {
  /** 留出集占比（去污染：留出用例不进任何提示词/库外反馈）。 */
  holdout: number
  min_hit: number
  max_fp: number
  negatives: number
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
  backtest?: Partial<BacktestConfig>
  retrieval?: Partial<RetrievalConfig>
  lifecycle?: Partial<LifecycleConfig>
  detect?: { generic_extra?: string[] }
}

const DEFAULT_FETCH: FetchConfig = {
  popular_pages: 2,
  weekly: true,
  feed: true,
  feed_pages: 3,
  regions: [119],
  region_pages: 2,
  rank_regions: [],
  related_of_top: 0,
  hot_words: true,
  ups: [],
  videos_per_round: 30,
  comments_per_video: 300,
  reply_pages_per_video: 3,
  latest_pages_per_video: 0,
  max_per_source: 0,
  subreply_pages_per_root: 1,
  max_comment_age_days: 30,
  max_video_age_days: 0,
  probe_keywords: 0,
  subreply_roots: 5,
  comment_images_per_round: 40,
  delay_min: 0.8,
  delay_max: 1.5,
  timeout: 15,
}

const DEFAULT_BACKTEST: BacktestConfig = {
  holdout: 0.3,
  min_hit: 0.7,
  max_fp: 0.02,
  negatives: 1000,
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
  backtest: BacktestConfig
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
    backtest: { ...DEFAULT_BACKTEST, ...raw.backtest },
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

/** `meme config init` 的模板：全默认值展开。 */
export function configTemplate(): string {
  return JSON.stringify({
    db_path: '',
    credentials_file: '',
    fetch: { ...DEFAULT_FETCH },
    backtest: { ...DEFAULT_BACKTEST },
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
  /** Cookie 刷新用的票据（后续做会话续期用）。 */
  refresh_token?: string
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

/** 登录态唯一来源：meme login 写出的凭证文件。 */
export function resolveSessdata(cfg: ResolvedConfig): string {
  return readCredentials(cfg.credentialsFile)?.sessdata ?? ''
}
