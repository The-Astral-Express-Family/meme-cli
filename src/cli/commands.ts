/**
 * CLI 命令定义与执行体：旧工具层 execute 体平移，去 defineTool/openOut 外壳。
 * 输出契约：run() 返回 { payload, human }——payload 上 stdout（单行 JSON），
 * human 上 stderr（人读文本）。领域错误以 MemeError 抛出，main 统一转 JSON。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { confirmRevival, get as getMeme, resolve } from '../entries.ts'
import { MemeError, notFound } from '../errors.ts'
import type { Json } from '../models.ts'
import { lookup as doLookup } from '../match/pipeline.ts'
import { getEmbedder } from '../match/vector.ts'
import { hybridSearch } from '../retrieve/fuse.ts'
import { addResultToDict, runAddEntry, runIterate } from '../induct/inductor.ts'
import { validateAndCompile } from '../induct/compileMatcher.ts'
import * as audit from '../audit.ts'
import * as cards from '../render/cards.ts'
import * as entries from '../entries.ts'
import * as notes from '../notes.ts'
import * as lifecycle from '../lifecycle.ts'
import { configTemplate, configFile } from '../config.ts'
import { checkAuthStatus, runLogin } from '../login.ts'
import { handleAllow, handleBan, runCheck, runSurf } from '../surf/run.ts'
import { ingestGroupMessages } from '../lake.ts'
import type { CmdSpec, Parsed } from './parser.ts'
import { UsageError } from './parser.ts'
import { nearby, type Runtime } from './runtime.ts'

export interface CmdOut {
  /** 结构化结果：上 stdout（agent 消费）。 */
  payload: Record<string, Json>
  /** 人读文本：上 stderr。 */
  human: string
}

export interface CmdDef extends CmdSpec {
  run: (p: Parsed, rt: Runtime) => Promise<CmdOut>
}

// ---- flag 取值助手（parseArgs 已保证形状） ----

const s = (p: Parsed, k: string): string | undefined => {
  const v = p.flags[k]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
const b = (p: Parsed, k: string): boolean => p.flags[k] === true
const n = (p: Parsed, k: string): number | undefined => {
  const v = p.flags[k]
  return typeof v === 'number' ? v : undefined
}
const sv = (p: Parsed, k: string): string[] => {
  const v = p.flags[k]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return typeof v === 'string' ? [v] : []
}

const SOURCES = ['surf', 'lookup', 'note', 'edit'] as const
const LEVELS = ['brief', 'card', 'full'] as const

const backtestLine = (bt: { hit_rate: number; holdout_size?: number; fp_rate: number; negatives?: number } | null): string => {
  if (!bt) return ''
  return `\n  backtest: 命中 ${Math.round(bt.hit_rate * 100)}%${bt.holdout_size !== undefined ? `（留出 ${bt.holdout_size}）` : ''}`
    + `｜误报 ${(bt.fp_rate * 100).toFixed(1)}%${bt.negatives !== undefined ? `（${bt.negatives} 负例）` : ''}`
}

/** entry 文件加载：--entry-file（主） / --entry-json（内联）二选一，必给——归纳由操作员亲写，无外部归纳器。 */
function loadEntry(p: Parsed): unknown {
  const file = s(p, 'entry-file')
  const inline = s(p, 'entry-json')
  if (file && inline) throw new UsageError('--entry-file 与 --entry-json 只能给一个')
  if (!file && !inline) {
    throw new UsageError('需要 --entry-file <词条JSON文件>（主通道）或 --entry-json <内联JSON>——归纳由操作员亲写：先看 check --focus / show --level full 的证据再写 entry')
  }
  let raw = inline
  if (file) {
    try {
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      throw new MemeError('MEME_ENTRY_INVALID', `entry 文件不可读：${file}（${e instanceof Error ? e.message : e}）`, '确认路径存在且可读；agent 建议先写文件再 meme add --entry-file <绝对路径>。')
    }
  }
  try {
    return JSON.parse(raw!) as unknown
  } catch (e) {
    throw new MemeError('MEME_ENTRY_INVALID', `entry JSON 解析失败：${e instanceof Error ? e.message : e}`, '确认内容是完整 JSON（无尾逗号、无注释）。')
  }
}

// ---- read path ----

async function runLookup(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const text = p._[0] ?? ''
  if (!text) throw new UsageError('meme lookup 需要一个待识别文本参数（以 -- 结尾可传 "-开头" 的文本）')
  // 交互梗（tier 3）匹配对象是"最后一行"——待查文本必须作为会话末行参与匹配
  const lines = [...sv(p, 'ctx').filter(Boolean), text]
  const hits = await doLookup(
    rt.db(), text, lines,
    rt.cfg.retrieval.vector_threshold, getEmbedder(rt.cfg.retrieval.embed_model),
  )
  const payloadHits: Record<string, Json>[] = []
  const humanLines: string[] = []
  for (const h of hits) {
    const d: Record<string, Json> = {
      meme_id: h.meme_id, name: h.name, class: h.class,
      span: [h.start, h.end], excerpt: h.excerpt.slice(0, 24),
      tier: h.tier, confidence: Math.round(h.confidence * 1000) / 1000, method: h.method,
    }
    const m = getMeme(rt.db(), h.meme_id)
    if (m && !b(p, 'bare')) {
      // 玩梗卡内联：释义 + 前两条用法 + 禁忌（agent 拿到即可接梗）
      d.card = {
        gist: m.card.gist, usage: m.card.usage.slice(0, 2), taboo: m.card.taboo,
        aggression: m.card.aggression, register: m.card.register, state: m.state,
      }
      let line = `✓ ${h.meme_id} ${h.name} [${h.confidence.toFixed(2)} ${h.method}] span ${h.start}-${h.end} "${h.excerpt.slice(0, 24)}"`
      line += `\n    ${m.card.gist}`
      for (const u of m.card.usage.slice(0, 2)) line += `\n    · ${u}`
      if (m.card.taboo) line += `\n    忌：${m.card.taboo}`
      if (m.state === 'observing') line += '\n    [observing] 表达使用前先核对'
      humanLines.push(line)
    } else {
      humanLines.push(`✓ ${h.meme_id} ${h.name} [${h.confidence.toFixed(2)} ${h.method}]`)
    }
    payloadHits.push(d)
  }
  if (hits.length) {
    let human = humanLines.join('\n')
    if (hits.some((h) => h.tier === 4)) human += '\n（含低置信向量命中，建议 meme show 核对）'
    return { payload: { result: 'hit', hits: payloadHits }, human }
  }
  const suggestion = `确认是梗后写 entry 文件再 meme add --entry-file <f>（observing 入库），或 meme note add --head 记录疑点。`
  return {
    payload: { result: 'miss', hits: [], nearby: await nearby(rt, text), suggestion },
    human: `未知：未识别出已知梗。\n建议：${suggestion}`,
  }
}

async function runSearch(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const query = p._[0] ?? ''
  if (!query) throw new UsageError('meme search 需要一个查询参数')
  const results = await hybridSearch(rt.db(), query, rt.cfg.retrieval, {
    top: n(p, 'top'), includeArchived: b(p, 'all'),
  })
  if (!results.length) {
    const suggestion = '词库可能尚小或该梗未入库：meme surf 策展采集，或写 entry 文件后 meme add --entry-file 直接收录。'
    return { payload: { result: 'empty', results: [], suggestion }, human: `无结果：词库中未找到相近词条。\n建议：${suggestion}` }
  }
  return {
    payload: {
      result: 'ok', query,
      results: results.map((r) => ({
        id: r.meme.id, name: r.meme.name, class: r.meme.class,
        gist: r.meme.card.gist, state: r.meme.state, score: r.score,
      })),
    },
    human: results.map((r) => r.brief).join('\n'),
  }
}

async function runShow(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const ref = p._[0] ?? ''
  if (!ref) throw new UsageError('meme show 需要一个词条 id/名字参数')
  const db = rt.db()
  let m = resolve(db, ref)
  if (!m) throw notFound(ref, await nearby(rt, ref))
  const level = s(p, 'level') ?? rt.cfg.retrieval.default_level
  if (!LEVELS.includes(level as typeof LEVELS[number])) {
    throw new UsageError(`--level 只接受 brief/card/full，得到 "${level}"`)
  }
  m = confirmRevival(db, m, level) // 复活确认流（领域层）
  const [textOut, d] = level === 'brief' ? cards.brief(m) : level === 'full' ? cards.full(m, db) : cards.card(m)
  return { payload: { level, meme: d }, human: textOut }
}

// ---- write path ----

async function runAddCmd(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const db = rt.db()
  const entry = loadEntry(p)
  const text = s(p, 'text')
  const res = await runAddEntry(db, rt.cfg, entry, {
    cids: sv(p, 'cid'), text, force: b(p, 'force'),
    match_aliases: b(p, 'match-aliases'), holdout_texts: sv(p, 'holdout-text'),
  })
  const [cardText, cardDict] = cards.card(res.meme)
  let human = `已入库（observing）：\n${cardText}${backtestLine(res.backtest)}`
  for (const w of res.warnings) human += `\n  ⚠ ${w}`
  return { payload: { ...addResultToDict(res), card: cardDict }, human }
}

async function runIterateCmd(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const mid = p._[0] ?? ''
  if (!mid) throw new UsageError('meme iterate 需要 <mid> 参数')
  const entry = loadEntry(p)
  const res = await runIterate(rt.db(), rt.cfg, mid, {
    entry, force: b(p, 'force'), cids: sv(p, 'cid'), text: s(p, 'text'),
    match_aliases: b(p, 'match-aliases'), holdout_texts: sv(p, 'holdout-text'),
  })
  const [cardText, cardDict] = cards.card(res.meme)
  let human = `已修订（${res.meme.id} 保持 ${res.meme.state}）：\n${cardText}${backtestLine(res.backtest)}`
  for (const w of res.warnings) human += `\n  ⚠ ${w}`
  return { payload: { ...addResultToDict(res), card: cardDict, action: 'iterate' }, human }
}

async function runEdit(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const db = rt.db()
  const mid = p._[0] ?? ''
  if (!mid) throw new UsageError('meme edit 需要 <mid> 参数')
  const m = entries.resolve(db, mid)
  if (!m) throw notFound(mid, await nearby(rt, mid))
  const source = (s(p, 'source') ?? 'edit') as audit.AuditSource
  if (s(p, 'source') && !SOURCES.includes(s(p, 'source') as typeof SOURCES[number])) {
    throw new UsageError(`--source 只接受 ${SOURCES.join('/')}，得到 "${s(p, 'source')}"`)
  }
  const reason = s(p, 'reason') ?? ''
  const variants = sv(p, 'variant')
  const actions: string[] = []
  if (variants.length) {
    for (const v of variants) if (!m.aliases.includes(v)) m.aliases.push(v)
    if (m.matcher) {
      for (const pat of m.matcher.patterns) {
        if (pat.kind === 'lex') pat.terms = [...new Set([...pat.terms, ...variants])]
      }
      try {
        m.matcher = validateAndCompile(m.matcher)
      } catch (e) {
        actions.push(`⚠ matcher 校验失败保持原样：${e instanceof Error ? e.message : e}`)
      }
    }
    audit.record(db, m.id, 'edit_variant', source, { variants, reason })
    actions.push(`变体收编：${variants.join('、')}`)
  }
  const drift = s(p, 'drift')
  if (drift) {
    const idx = drift.indexOf(':')
    const period = drift.slice(0, idx).trim()
    const change = drift.slice(idx + 1).trim()
    m.drift = [...m.drift, { period, change, evidence: null }]
    audit.record(db, m.id, 'edit_drift', source, { drift, reason })
    actions.push(`drift 追加：${period} → ${change}`)
  }
  if (b(p, 'promote')) {
    lifecycle.promote(db, m, source, reason)
    actions.push('已升格 active')
  }
  if (b(p, 'kill')) {
    lifecycle.kill(db, m, source, reason)
    actions.push('已判死（加速降级 fading）')
  }
  if (b(p, 'revive')) {
    lifecycle.revive(db, m, source, reason)
    actions.push('已复活（先给最小卡，确认后恢复完整卡）')
  }
  const gist = s(p, 'gist')
  if (gist) {
    m.card.gist = gist
    audit.record(db, m.id, 'edit_gist', source, { gist, reason })
    actions.push('释义已修正')
  }
  if (!actions.length) {
    throw new UsageError('未指定任何编辑动作：用 --variant/--drift/--promote/--kill/--gist/--revive 之一')
  }
  entries.save(db, m)
  const [cardText, cardDict] = cards.card(m)
  return { payload: { id: m.id, actions }, human: actions.join('\n') + '\n' + cardText }
}

// ---- surf / note / config ----

async function runBanCmd(p: Parsed, rt: Runtime): Promise<CmdOut> {
  if (!p._.length) throw new UsageError('meme ban 需要一个或多个精确词头')
  const banned = handleBan(rt.db(), p._)
  return {
    payload: { banned, scope: 'exact-normalized-head' },
    human: `已精确封禁：${banned.join('、')}（不做子串或语义家族封禁）`,
  }
}

async function runAllowCmd(p: Parsed, rt: Runtime): Promise<CmdOut> {
  if (!p._.length) throw new UsageError('meme allow 需要一个或多个精确词头')
  const allowed = handleAllow(rt.db(), p._)
  return { payload: { allowed }, human: `已解除精确封禁：${allowed.join('、')}` }
}

async function runCheckCmd(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const result = await runCheck(rt.db(), rt.cfg, {
    focus: s(p, 'focus'), page: n(p, 'page'), roundSize: n(p, 'round-size'),
  })
  return { payload: result.payload as Record<string, Json>, human: result.human }
}

async function runSurfCmd(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const result = await runSurf(rt.db(), rt.cfg, {
    roundSize: n(p, 'round-size'),
    noFetch: b(p, 'no-fetch'),
    probe: sv(p, 'probe'),
    full: true, // agent 输出一次给全量候选（不翻页）
  })
  return { payload: result.payload as Record<string, Json>, human: result.human }
}

async function runNote(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const db = rt.db()
  const action = p._[0] ?? ''
  if (action === 'add') {
    const content = s(p, 'content')
    if (!content) throw new UsageError('meme note add 需要 --content，及 --ref <mid> 或 --head <词头>')
    let memeId: string | null = null
    const ref = s(p, 'ref')
    if (ref) {
      const m = entries.resolve(db, ref)
      if (!m) throw notFound(ref, await nearby(rt, ref))
      memeId = m.id
    }
    const head = s(p, 'head') ?? null
    const nid = notes.add(db, content, memeId, head)
    return {
      payload: { action: 'add', note_id: nid, meme_id: memeId, head, content },
      human: `已记 #${nid}${memeId ? `（${memeId}）` : ''}`,
    }
  }
  if (action === 'list') {
    let memeId: string | null = null
    const ref = s(p, 'ref')
    if (ref) {
      const m = entries.resolve(db, ref)
      if (!m) throw notFound(ref, await nearby(rt, ref))
      memeId = m.id
    }
    const items = notes.listNotes(db, memeId)
    return {
      payload: { action: 'list', notes: items },
      human: items.map((x) => `#${x.id} [${x.meme_id ?? x.head ?? '-'}] ${x.content}`).join('\n') || '（无笔记）',
    }
  }
  const noteId = n(p, 'note-id')
  if (noteId === undefined) throw new UsageError('note show/edit/rm 需要 --note-id')
  if (action === 'show') {
    const x = notes.get(db, noteId)
    if (!x) throw new MemeError('MEME_NOT_FOUND', `笔记 #${noteId} 不存在`)
    return { payload: { action: 'show', note: x }, human: `#${x.id} [${x.meme_id ?? x.head ?? '-'}]\n${x.content}` }
  }
  if (action === 'edit') {
    if (!notes.update(db, noteId, s(p, 'content') ?? '')) {
      throw new MemeError('MEME_NOT_FOUND', `笔记 #${noteId} 不存在`)
    }
    return { payload: { action: 'edit', note_id: noteId }, human: `已改 #${noteId}` }
  }
  if (action === 'rm') {
    if (!notes.remove(db, noteId)) throw new MemeError('MEME_NOT_FOUND', `笔记 #${noteId} 不存在`)
    return { payload: { action: 'rm', note_id: noteId }, human: `已删 #${noteId}` }
  }
  throw new UsageError('未知 note 动作：add|list|show|edit|rm')
}

async function runConfig(p: Parsed, _rt: Runtime): Promise<CmdOut> {
  const action = p._[0] ?? ''
  if (action !== 'init') throw new UsageError('meme config 只支持 init（写出 ~/.meme/config.json 模板）')
  const file = configFile()
  if (existsSync(file)) {
    throw new MemeError('MEME_CONFIG_EXISTS', `配置文件已存在：${file}`, '直接编辑它；或删除后重新 init。')
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, configTemplate(), { mode: 0o600 })
  return { payload: { written: file }, human: `已写出配置模板：${file}（字段全默认，按需改 db_path/fetch/backtest 等）` }
}

// ---- ingest（QQ 群聊消息批量入池，内置 bot 桥接的落库端） ----

interface IngestMsg {
  msg_id?: unknown
  group?: unknown
  group_name?: unknown
  sender?: unknown
  sender_name?: unknown
  content?: unknown
  ts_ms?: unknown
}

async function runIngestCmd(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const file = s(p, 'file')
  let rawText: string
  if (file) {
    rawText = readFileSync(file, 'utf8')
  } else {
    rawText = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      process.stdin.on('data', (c: Buffer) => chunks.push(c))
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      process.stdin.on('error', reject)
    })
  }
  let arr: unknown
  try {
    arr = JSON.parse(rawText)
  } catch (e) {
    throw new MemeError('MEME_INGEST_INVALID', `消息 JSON 解析失败：${e instanceof Error ? e.message : e}`, '传 JSON 数组文件或用 --file。')
  }
  if (!Array.isArray(arr)) {
    throw new MemeError('MEME_INGEST_INVALID', '消息载荷必须是 JSON 数组', '[{msg_id, group, sender, content, ts_ms?}, ...]')
  }
  const msgs = (arr as IngestMsg[])
    .map((m) => ({
      msg_id: typeof m.msg_id === 'string' ? m.msg_id : '',
      group: typeof m.group === 'string' ? m.group : '',
      group_name: typeof m.group_name === 'string' && m.group_name ? m.group_name : undefined,
      sender: typeof m.sender === 'string' ? m.sender : '',
      sender_name: typeof m.sender_name === 'string' && m.sender_name ? m.sender_name : undefined,
      content: typeof m.content === 'string' ? m.content : '',
      ts_ms: typeof m.ts_ms === 'number' && Number.isFinite(m.ts_ms) ? m.ts_ms : undefined,
    }))
    .filter((m) => m.msg_id && m.group && m.content.trim())
  const res = ingestGroupMessages(rt.db(), msgs)
  return {
    payload: { ingested: { inserted: res.inserted, duplicates: res.duplicates, skipped: arr.length - msgs.length } },
    human: `群聊消息入池：新增 ${res.inserted}，重复跳过 ${res.duplicates}（round_id=0，下一轮 surf 开局认领）`,
  }
}

// ---- auth（仿 gh auth：login/status/logout） ----

async function runAuth(p: Parsed, rt: Runtime): Promise<CmdOut> {
  const action = p._[0] ?? ''
  const credentials = s(p, 'credentials') ?? rt.cfg.credentialsFile
  if (action === 'login') {
    const out = await runLogin({
      credentialsFile: credentials,
      port: n(p, 'port'),
      timeoutMs: n(p, 'timeout') !== undefined ? n(p, 'timeout')! * 1000 : undefined,
      openBrowser: !b(p, 'no-browser'),
    })
    if (!out.ok) {
      throw new MemeError('MEME_AUTH_FAILED', out.error ?? '登录失败', '重新运行 meme auth login 扫码；二维码 180s 有效，超时自动换新。')
    }
    return {
      payload: { ok: true, uname: out.uname ?? null, mid: out.mid ?? null, credentials_file: credentials },
      human: `登录成功：${out.uname ?? '未知用户'}${out.mid ? ` (uid ${out.mid})` : ''}——surf 的 probe 探测与完整评论区已解锁`,
    }
  }
  if (action === 'status') {
    const st = await checkAuthStatus(credentials)
    let human: string
    if (st.valid === true) {
      const days = st.saved_at ? Math.max(0, Math.floor((Date.now() - new Date(st.saved_at).getTime()) / 86400_000)) : null
      human = `✓ 已登录：${st.uname ?? '未知用户'}${st.mid ? ` (uid ${st.mid})` : ''}——凭证有效`
        + (days !== null ? `（保存于 ${days === 0 ? '今天' : `${days} 天前`}）` : '')
        + '；probe 探测/完整评论区/feed 可用'
    } else if (st.valid === false) {
      human = `✗ 登录态已失效——${st.note}。请在终端跑 meme auth login 重新扫码`
    } else {
      human = `✗ 未登录（${st.note}）——B站获取将匿名降级（无搜索探测、评论区不全）。请在终端跑 meme auth login 扫码`
    }
    const payload: Record<string, Json> = {
      credentials_file: st.credentials_file,
      file_exists: st.file_exists,
      sessdata_present: st.sessdata_present,
      valid: st.valid,
      uname: st.uname ?? null,
      mid: st.mid ?? null,
      saved_at: st.saved_at ?? null,
      note: st.note ?? null,
    }
    if (st.valid !== true) {
      payload.suggestion = '请用户在终端跑 meme auth login 扫码；之后用 meme auth status 确认'
    }
    return { payload, human }
  }
  if (action === 'logout') {
    if (!existsSync(credentials)) {
      return { payload: { removed: false, credentials_file: credentials }, human: '本就未登录（无凭证文件）' }
    }
    unlinkSync(credentials)
    return { payload: { removed: true, credentials_file: credentials }, human: `已删除登录态：${credentials}` }
  }
  throw new UsageError(`未知 auth 动作 "${action || '(空)'}"：login|status|logout`)
}

// ---- 命令表 ----

export const COMMANDS: Record<string, CmdDef> = {
  lookup: {
    name: 'lookup',
    args: '<text>',
    desc: '识别一段文本里的 B站梗：命中返回玩梗卡（释义/用法/禁忌/攻击性），无命中是合法答案。交互梗需 --ctx 会话上文',
    opts: {
      ctx: { type: 'string', multiple: true, desc: '会话上文行（按时间序；待查文本作末行参与匹配）' },
      bare: { type: 'boolean', desc: '精简输出：只列命中不附卡片' },
    },
    run: runLookup,
  },
  search: {
    name: 'search',
    args: '<query>',
    desc: '模糊回忆式检索梗库（BM25 + 例句向量混合，RRF 融合）："那个……的梗叫什么来着"',
    opts: {
      top: { type: 'number', desc: '返回条数（默认 8）' },
      all: { type: 'boolean', desc: '包含归档区词条' },
    },
    run: runSearch,
  },
  show: {
    name: 'show',
    args: '<ref>',
    desc: '词条分级输出：brief 一行 / card 玩梗卡（默认）/ full 全量（词源/演化/审计）。ID 与名字/别名均可解析',
    opts: {
      level: { type: 'string', desc: 'brief|card|full（默认 card）' },
    },
    run: runShow,
  },
  add: {
    name: 'add',
    args: '--entry-file F | --entry-json J',
    desc: '收录新梗：操作员亲写词条 JSON。--cid 可重复，--text 精确/唯一解析，--holdout-text 提供独立留出，--match-aliases 可选开启别名匹配；重名引导 iterate',
    opts: {
      cid: { type: 'string', multiple: true, desc: '候选 id（可重复）：候选用例并入 backtest 正例并收口候选' },
      text: { type: 'string', desc: '候选词头或包含候选的文本：先精确、再唯一前缀/包含解析，多义时要求 --cid' },
      'match-aliases': { type: 'boolean', desc: '把非槽位 aliases 合并进 lex matcher（交互梗除外）；默认 aliases 仅作元数据' },
      'holdout-text': { type: 'string', multiple: true, desc: '显式留出例句（可重复）；交互梗可用“上句：X 本句：Y”' },
      'entry-file': { type: 'string', desc: '词条 JSON 文件路径（主通道，必给其一）' },
      'entry-json': { type: 'string', desc: '词条 JSON 内联（短 entry）' },
      force: { type: 'boolean', desc: 'backtest 未达标仍入库（纯向量降级，进审计）' },
    },
    run: runAddCmd,
  },
  iterate: {
    name: 'iterate',
    args: '<mid> --entry-file F | --entry-json J',
    desc: '修订词条：带新证据亲写修订版（原位更新，保留 id/state/stats；释义实质变化自动记 drift）。高频操作——首轮归纳常有偏差',
    opts: {
      'entry-file': { type: 'string', desc: '修订版词条 JSON 文件（必给其一）' },
      'entry-json': { type: 'string', desc: '修订版词条 JSON 内联' },
      cid: { type: 'string', multiple: true, desc: '关联候选 id（可重复）：并入独立证据并在成功后精确收口' },
      text: { type: 'string', desc: '候选词头或包含候选的文本（唯一匹配时解析）' },
      'match-aliases': { type: 'boolean', desc: '把非槽位 aliases 合并进 lex matcher（交互梗除外）' },
      'holdout-text': { type: 'string', multiple: true, desc: '显式留出例句（可重复）；交互梗可用“上句：X 本句：Y”' },
      force: { type: 'boolean', desc: 'backtest 未达标仍更新；恢复 matcher 缺独立证据时也可显式绕过（进审计）' },
    },
    run: runIterateCmd,
  },
  edit: {
    name: 'edit',
    args: '<mid>',
    desc: '轻量修订：收编变体 / 追加词义演化 / 升降格 / 修释义 / 复活。全部动作强制记审计',
    opts: {
      variant: { type: 'string', multiple: true, desc: '收编新变体/别名（骨架漂移的吸收）' },
      drift: { type: 'string', desc: '追加词义演化：\'分期: 变化描述\'' },
      gist: { type: 'string', desc: '修正释义' },
      promote: { type: 'boolean', desc: 'observing → active 升格' },
      kill: { type: 'boolean', desc: '主观判死：加速降级' },
      revive: { type: 'boolean', desc: 'fading/tombstone → active 复活（先给最小卡）' },
      reason: { type: 'string', desc: '动作理由（进审计日志）' },
      source: { type: 'string', desc: '洞察来源：surf|lookup|note|edit（默认 edit）' },
    },
    run: runEdit,
  },
  ban: {
    name: 'ban',
    args: '<head...>',
    desc: '精确封禁词头（跨 phrase/copy/skeleton/image）；只匹配归一化完整词头，不做子串或语义家族封禁',
    opts: {},
    run: runBanCmd,
  },
  allow: {
    name: 'allow',
    args: '<head...>',
    desc: '精确解除封禁，并恢复被该封禁压住的候选资格',
    opts: {},
    run: runAllowCmd,
  },
  check: {
    name: 'check',
    args: '',
    desc: '只读查看当前窗口内过触发门的条目：不推进轮次、不认领 QQ、不收割、不写 kv、不改候选状态',
    opts: {
      focus: { type: 'string', desc: '深入单个候选的完整证据（含父评文本）' },
      page: { type: 'number', desc: '页码（从 0 开始）' },
      'round-size': { type: 'number', desc: '每页条数（默认取配置）' },
    },
    run: runCheckCmd,
  },
  surf: {
    name: 'surf',
    args: '',
    desc: '一轮策展：获取（除非 --no-fetch）→ 证据更新 → 状态重算 → 呈现当前过门条目。一轮数分钟，bash 调用给 timeout 或 run_in_background',
    opts: {
      'round-size': { type: 'number', desc: '每页呈现条数（默认取配置）' },
      'no-fetch': { type: 'boolean', desc: '不联网获取，但仍执行一轮：认领群聊、更新证据、重算状态与收割' },
      probe: { type: 'string', multiple: true, desc: '定向搜索探测词（需 meme login 登录态）' },
    },
    run: runSurfCmd,
  },
  ingest: {
    name: 'ingest',
    args: '[--file F]',
    desc: '群聊消息批量入池（内置 bot 桥接的落库端，也可手工喂数据）：JSON 数组 [{msg_id, group, sender, content, ts_ms?}]。静默写原始湖（round_id=0），下一轮 surf 开局认领并与 B站采集一并计算',
    opts: {
      file: { type: 'string', desc: '消息 JSON 文件路径（缺省读 stdin）' },
    },
    run: runIngestCmd,
  },
  note: {
    name: 'note',
    args: '<action>',
    desc: '低信任笔记 add|list|show|edit|rm：永不进入 matcher 与 card。词条未建时可挂 --head（悬挂笔记）',
    opts: {
      ref: { type: 'string', desc: '词条 id/名（add/list 用）' },
      head: { type: 'string', desc: '悬挂笔记的词头（词条尚不存在时）' },
      content: { type: 'string', desc: '笔记内容（add/edit 用）' },
      'note-id': { type: 'number', desc: '笔记 id（show/edit/rm 用）' },
    },
    run: runNote,
  },
  config: {
    name: 'config',
    args: '<action>',
    desc: '配置管理：init 写出 ~/.meme/config.json 模板（全默认值展开）',
    opts: {},
    run: runConfig,
  },
  auth: {
    name: 'auth',
    args: '<action>',
    desc: 'B站登录态管理（仿 gh auth）：login 弹浏览器扫码；status 查登录态（凭证存在性 + nav 实测有效性，surf 前先查）；logout 删除登录态',
    opts: {
      credentials: { type: 'string', desc: '凭证文件路径（默认 ~/.meme/credentials.json）' },
      port: { type: 'number', desc: 'login：本地回调页端口（默认随机）' },
      timeout: { type: 'number', desc: 'login：等待扫码超时秒数（默认 180）' },
      'no-browser': { type: 'boolean', desc: 'login：不自动弹浏览器（手动访问打印出的地址）' },
    },
    run: runAuth,
  },
}
