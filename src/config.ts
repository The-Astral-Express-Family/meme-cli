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
  /** 触发所需的最少存活轮数（跨轮证据下限）。 */
  trigger_rounds: number
  /** 词类（phrase）触发的终身绝对出现次数，不限轮数。 */
  trigger_videos: number
  /** 结构通道（copy/skeleton）触发的终身绝对出现次数；image 改用跨视频数。 */
  trigger_videos_alt: number
  /** 图梗（image）触发的跨视频数；pHash 簇重复即信号，独立于文本体量线。 */
  trigger_images: number
  /** 触发特征分门（memeScore：复读/坍缩/独立成评的纯统计分）。 */
  trigger_meme_score: number
  /** 候选存活窗口（轮）：末次证据超过该轮数则休眠（不评估、不呈现，新证据唤醒）；
   * 休眠且从未达体量线的候选直接删除（低价值早清）。 */
  surf_survive_rounds: number
  /** 候选死亡（天）：末次证据超过该天数删除——pending/triggered 一视同仁，inducted 豁免。 */
  candidate_death_days: number
  /** 原始湖轮次留存（轮）：0 = 不清理（开发期默认，保护可重审历史）；部署期设 7，
   * 每轮删除该轮数之前的评论/视频/评论图片。代价：更早历史不可重审。 */
  surf_retention_rounds: number
  promote_rounds: number
  fade_window_days: number
  fade_drop: number
  tombstone_ratio: number
  backlog_alert: number
}

/**
 * QQ 群聊 bot（内置桥接）配置。qq 段存在且 app_id/app_secret 齐备才启动 bot；
 * 不配 = 纯 B站用户，行为与过去完全一致。凭据从 QQ 开放平台控制台（q.qq.com）取。
 */
export interface QQConfig {
  app_id: string
  app_secret: string
  /** 群聊是否需要 @bot 才进 agent 会话。采集不受影响：所有群消息（含非 @）都进梗池。 */
  require_mention: boolean
  /** 允许的群 OpenID 白名单；空 = 全部接收。 */
  group_allow: string[]
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
  qq?: Partial<QQConfig>
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
  // 新视频补抓最新页：热度页沉淀的多是旧评论，进行中的梗浪在最新页
  latest_pages_per_video: 1,
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
  // 次数线校准（2026-11-22 真实湖敏感度实测，操作员确认 5 偏低）：10/15 下
  // 队列 ~95 条可逐条裁决；已确认真梗全部次数 ≥7 且当时已 triggered，零损失。
  // 纯次数分不开单容器话术热点（做出来 50 次/dv2 类）——热点治理走 --ban 沉淀。
  trigger_videos: 10,
  trigger_videos_alt: 15,
  trigger_images: 8,
  // 独立成评口径修正后，其单独贡献上限为 0.5；门槛提高到 0.7，要求重复/坍缩等第二类证据。
  // 真实池敏感性：0.45 会放行约 2175 条体量达标候选，0.7 约 169 条（2026-11-25）。
  trigger_meme_score: 0.7,
  surf_survive_rounds: 7,
  candidate_death_days: 28,
  surf_retention_rounds: 0,
  promote_rounds: 2,
  fade_window_days: 90,
  fade_drop: 0.5,
  tombstone_ratio: 0.1,
  backlog_alert: 10,
}

const DEFAULT_QQ: QQConfig = {
  app_id: '',
  app_secret: '',
  require_mention: true,
  group_allow: [],
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
  qq: QQConfig
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
    qq: { ...DEFAULT_QQ, ...raw.qq },
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
    qq: { ...DEFAULT_QQ },
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
