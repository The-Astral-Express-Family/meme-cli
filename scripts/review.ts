/**
 * 候选池审查列表：pending/triggered 候选按 score v2 广泛列出（含语义标记与用例样本），
 * 供操作员逐条判定真梗。在库的临时副本上运行，不改真实库。
 *
 * 用法：npx tsx scripts/review.ts [--top 150] [--per-channel 40] [--samples 2]
 * 选集 = 全局 top N ∪ 每通道 top K（图梗/复读等小通道不被固定表达刷掉）；
 * 语义标记（泛回应?/弱模板?/虚词核?）对选集全量计算，等价于呈现层富化。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, kvGet } from '../src/db.ts'
import { loadConfig } from '../src/config.ts'
import { allActive } from '../src/candidates.ts'
import { isAwake } from '../src/lifecycle.ts'
import { scoreCandidate, type ScoreFlags } from '../src/detect/evidence.ts'
import { semanticFlags } from '../src/detect/semantics.ts'
import type { Candidate } from '../src/models.ts'

const args = process.argv.slice(2)
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const topN = Number(flag('--top', '150'))
const perChannel = Number(flag('--per-channel', '40'))
const samplesN = Number(flag('--samples', '2'))

const cfg = loadConfig()
const tmpDir = mkdtempSync(join(tmpdir(), 'meme-review-'))
const tmpDb = join(tmpDir, 'review.db')
copyFileSync(cfg.dbPath, tmpDb)
for (const ext of ['-wal', '-shm']) {
  if (existsSync(cfg.dbPath + ext)) copyFileSync(cfg.dbPath + ext, tmpDb + ext)
}

const db = connect(tmpDb)
// 与 surf 呈现同口径：末次证据超过存活窗口的 pending 候选休眠（新证据唤醒）
const currentRound = Number(kvGet(db, 'surf_round', '0') || 0)
const cands = allActive(db).filter((c) =>
  c.state === 'triggered' || (c.state === 'pending' && isAwake(c, currentRound, cfg.lifecycle.surf_survive_rounds)))
const base = cands.map((c) => ({ c, base: scoreCandidate(db, c).score }))
  .sort((a, b) => b.base - a.base || b.c.distinct_videos - a.c.distinct_videos || (a.c.cid < b.c.cid ? -1 : 1))

const picked = new Map<string, Candidate>()
for (const c of cands) if (c.state === 'triggered') picked.set(c.cid, c) // 触发候选全量纳入
for (const s of base.slice(0, topN)) picked.set(s.c.cid, s.c)
const byChannel = new Map<string, typeof base>()
for (const s of base) {
  const arr = byChannel.get(s.c.channel) ?? []
  arr.push(s)
  byChannel.set(s.c.channel, arr)
}
for (const arr of byChannel.values()) {
  for (const s of arr.slice(0, perChannel)) picked.set(s.c.cid, s.c)
}

const flagMap = new Map<string, ScoreFlags>()
for (const c of picked.values()) flagMap.set(c.cid, await semanticFlags(db, cfg, c))

const FLAG_TXT = { response_generic: '泛回应?', praise_generic: '泛夸?', weak_template: '弱模板?', all_function_core: '虚词核?' } as const
function flagTxt(f: ScoreFlags | undefined): string {
  if (!f) return ''
  return Object.keys(FLAG_TXT).filter((k) => (f as never)[k as never] === true)
    .map((k) => FLAG_TXT[k as keyof typeof FLAG_TXT]).join(' ')
}

const flagged = [...picked.values()].map((c) => ({
  c,
  score: scoreCandidate(db, c, flagMap.get(c.cid) ?? {}).score,
})).sort((a, b) => b.score - a.score || b.c.distinct_videos - a.c.distinct_videos || (a.c.cid < b.c.cid ? -1 : 1))

function samplesOf(c: Candidate, n: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of [...c.evidence_usages].sort((a, b) => a.text.length - b.text.length)) {
    const key = u.text.replace(/\s/g, '').slice(0, 10)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(u.text)
    if (out.length >= n) break
  }
  return out
}

const CH_LABEL: Record<string, string> = { phrase: '固定表达', skeleton: '公式模板', copy: '整句复读', image: '图梗' }
console.log(`候选池 pending/triggered 共 ${cands.length}；本列表选 ${picked.size}（全局 top ${topN} ∪ 每通道 top ${perChannel}），语义标记已对选集全量计算`)

function printCand({ c, score }: { c: Candidate; score: number }, showSamples: boolean): void {
  const b = c.z_score !== null ? `b=${Math.round(c.z_score)}` : 'b=新'
  const star = c.state === 'triggered' ? ' ★' : ''
  const flags = flagTxt(flagMap.get(c.cid))
  const scoreTxt = score >= 0.1 ? `梗证${score.toFixed(1)}` : '泛用'
  console.log(`  ${c.cid}${star} "${c.head.slice(0, 48)}" ${c.kind_guess} ${c.distinct_videos}视/${c.distinct_ups}up ${b} ${scoreTxt}${flags ? ' ' + flags : ''} 轮${c.surfs_seen}`)
  if (showSamples) {
    for (const s of samplesOf(c, samplesN)) console.log(`      · ${s.slice(0, 60)}`)
  } else {
    for (const s of samplesOf(c, samplesN)) console.log(`      · ${s}`)
  }
}

// 触发候选单列一节（★ = 已过自动触发门，等待操作员收录判断）
const triggered = flagged.filter((x) => x.c.state === 'triggered')
console.log(`\n══ ★ 已触发（跨轮自动过门，${triggered.length} 条）══`)
for (const x of triggered) printCand(x, x.c.channel !== 'image')

for (const ch of ['phrase', 'skeleton', 'copy', 'image']) {
  const items = flagged.filter((x) => x.c.channel === ch && x.c.state !== 'triggered')
  const poolN = (byChannel.get(ch) ?? []).length
  if (!poolN) continue
  console.log(`\n══ ${CH_LABEL[ch]}（${ch}）池内 ${poolN}，列出 ${items.length} ══`)
  for (const x of items) printCand(x, ch !== 'image')
}

// 封禁复核（永久封禁 + 定期复核）：封禁词近 7 天在日聚合中的出现量。
// 零出现 = 词已自然从评论区消退（惰性封禁，拦截不到任何东西）——可考虑
// `meme allow 词` 移除；有出现 = 封禁仍在持续拦截噪音，保留。
const bans = JSON.parse(kvGet(db, 'generic_auto', '[]') || '[]') as string[]
if (bans.length) {
  const weekCut = new Date(Date.now() - 6 * 86400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const cut = `${weekCut.getFullYear()}-${p(weekCut.getMonth() + 1)}-${p(weekCut.getDate())}`
  const phraseQ = db.prepare('SELECT COALESCE(SUM(cnt),0) AS s FROM phrase_daily WHERE phrase=? COLLATE NOCASE AND day>=?')
  const skelQ = db.prepare('SELECT COALESCE(SUM(cnt),0) AS s FROM skel_daily WHERE skel=? COLLATE NOCASE AND day>=?')
  const rows = bans.map((w) => ({
    w,
    cnt: ((phraseQ.get(w, cut) as { s: number }).s as number) + ((skelQ.get(w, cut) as { s: number }).s as number),
  })).sort((a, b) => a.cnt - b.cnt)
  console.log(`\n══ 封禁复核（${bans.length} 个封禁词，按近期出现量升序）══`)
  for (const r of rows) {
    console.log(`  "${r.w}"  近7天出现 ${r.cnt}${r.cnt === 0 ? '   ← 惰性封禁（词已消退），可 allow 移除' : ''}`)
  }
}

db.close()
rmSync(tmpDir, { recursive: true, force: true })
