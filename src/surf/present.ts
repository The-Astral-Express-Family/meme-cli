/**
 * surf 四区呈现（v0.12）：统计锚随行、关联预标注箭头、衰减区、欠账提醒。
 * 一行一候选，agent 的价值判断被数据锚定而非凭空臆测。
 * 排序 = score v2（复读/坍缩/广度/显著性/边界熵 − 语义负面标记）。
 * 页面条目做语义富化（泛回应?/泛夸?/弱模板? 标记）供操作 agent 判定参考。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Candidate } from '../models.ts'
import type { ResolvedConfig } from '../config.ts'
import { lifetimeCount, memeScore, scoreCandidate, type ScoreFlags } from '../detect/evidence.ts'
import { semanticFlags } from '../detect/semantics.ts'

const CHANNEL_SHORT: Record<string, string> = {
  phrase: '', skeleton: '公式', image: '图梗', copy: '复读',
}

const FLAG_SHORT: Record<keyof ScoreFlags, string> = {
  response_generic: '泛回应?',
  praise_generic: '泛夸?',
  weak_template: '弱模板?',
  all_function_core: '虚词核?',
}

/** score v2 排序键：分数 → 跨视频 → id（稳定序）。 */
export function orderKey(db: DatabaseSync, c: Candidate): [number, number, string] {
  const score = scoreCandidate(db, c).score
  return [-score, -c.distinct_videos, c.cid]
}

/** 模板词头的填充示例（"<X>启动〔原神/疯狂水世界〕"）：从用例里抽槽内材料。 */
function fillingHint(c: Candidate): string {
  if (!c.head.includes('<')) return ''
  const lits = c.head.split(' ').filter((t) => t && !t.startsWith('<'))
  if (!lits.length) return ''
  const fills = new Set<string>()
  for (const u of c.evidence_usages) {
    let pos = -1
    for (const lit of lits) {
      const idx = u.text.indexOf(lit, pos < 0 ? 0 : pos)
      if (idx < 0) {
        pos = -2
        break
      }
      if (pos >= 0 && idx > pos) fills.add(u.text.slice(pos, Math.min(idx, pos + 8)))
      pos = idx + lit.length
    }
    if (pos >= 0 && pos < u.text.length) fills.add(u.text.slice(pos, pos + 8))
    if (pos === -2 && lits.length === 1) {
      // 单字面段模板（<X>启动 类）：填充 = 字面前材料
      const idx = u.text.indexOf(lits[0])
      if (idx > 0) fills.add(u.text.slice(Math.max(0, idx - 8), idx))
    }
  }
  const arr = [...fills].filter((f) => f.trim()).slice(0, 3)
  return arr.length ? `〔${arr.join('/')}〕` : ''
}

export function candLine(db: DatabaseSync, c: Candidate, relatedNames: Map<string, string>, flags: ScoreFlags | null = null, qualified = c.state === 'triggered'): string {
  const zTxt = c.z_score !== null ? `b=${Math.round(c.z_score)}` : 'b=新'
  const r = scoreCandidate(db, c, flags ?? {})
  const score = r.score >= 0.1 ? `梗证${r.score.toFixed(1)}` : '泛用'
  const flagTxt = flags ? [...Object.keys(flags)].filter((k) => (flags as never)[k as never] === true).map((k) => FLAG_SHORT[k as keyof ScoreFlags]).join('') : ''
  const flagShow = flagTxt ? ` ${flagTxt}` : ''
  const flag = qualified ? ' ★待判断' : ''
  let rel = ''
  if (c.related.length) {
    const r0 = c.related[0]
    const nm = relatedNames.get(r0.id) ?? r0.id
    const arrow = ({ same_form: '同形？', derived: '衍生？', related: '相近' } as Record<string, string>)[r0.type]
    rel = `   ← 与 ${nm} ${arrow}`
  }
  const head = c.head.length <= 24 ? c.head : c.head.slice(0, 23) + '…'
  const hint = fillingHint(c)
  const ch = CHANNEL_SHORT[c.channel] ?? ''
  const chain = c.evidence_usages.some((u) => u.chain) ? ' ⛓' : ''
  return `${c.cid} "${head}"${hint}  ${c.kind_guess}${ch}${chain}  ${c.distinct_videos}视频/${c.distinct_ups}up  ${zTxt}  ${score}${flagShow}${flag}${rel}`
}

export function candDict(db: DatabaseSync, c: Candidate, flags: ScoreFlags | null = null, qualified = c.state === 'triggered'): Record<string, unknown> {
  const r = scoreCandidate(db, c, flags ?? {})
  return {
    cid: c.cid,
    head: c.head,
    kind_guess: c.kind_guess,
    channel: c.channel,
    state: c.state,
    qualified_now: qualified,
    videos: c.distinct_videos,
    ups: c.distinct_ups,
    burst: c.z_score !== null ? Math.round(c.z_score) : null,
    score: Math.round(r.score * 100) / 100,
    meme_score: Math.round(memeScore(r.features) * 1000) / 1000,
    n_usages: r.features.n_usages,
    lifetime_volume: c.channel === 'image' ? c.distinct_videos : lifetimeCount(db, c.head, c.channel),
    features: {
      copy_pairs: r.features.copy_pairs,
      skel_top_share: Math.round(r.features.skel_top_share * 100) / 100,
      standalone_rate: Math.round(r.features.standalone_rate * 100) / 100,
      usage_text_share: Math.round(r.features.usage_text_share * 100) / 100,
      n_usages: r.features.n_usages,
      keyness: r.keyness !== null ? Math.round(r.keyness * 10) / 10 : null,
      boundary_entropy: r.boundary_entropy !== null ? Math.round(r.boundary_entropy * 100) / 100 : null,
    },
    flags: r.flags,
    surfs_seen: c.surfs_seen,
    related: c.related,
  }
}

/** 页面条目语义富化：给 top 条目算语义标记（嵌入调用，仅对渲染条目付出成本）。 */
export async function enrichFlags(
  db: DatabaseSync, cfg: ResolvedConfig, items: Candidate[],
): Promise<Map<string, ScoreFlags>> {
  const map = new Map<string, ScoreFlags>()
  for (const c of items.slice(0, 40)) {
    try {
      map.set(c.cid, await semanticFlags(db, cfg, c))
    } catch {
      // 单条语义失败不拖垮呈现
    }
  }
  return map
}

export function renderZones(zones: Record<string, any>, pageLine: string): string {
  const counts = zones.counts
  const reapTxt = counts.reap ? ` | 清理 ${counts.reap}` : ''
  const claimedTxt = zones.claimed ? ` | 群聊 ${zones.claimed}` : ''
  const out = [
    `[当前过门 ${counts.new} | 已有梗动态 ${counts.dynamics} | 衰减 ${counts.fading}${reapTxt}${claimedTxt}]`,
  ]
  if (zones.degraded) out.push(`⚠ 降级模式：${zones.degraded}（呈现存量数据）`)
  if (zones.hot_keywords?.length) {
    out.push('', '── 站内热词（今日热点·决策参考，非候选）──', '  ' + zones.hot_keywords.slice(0, 10).join('｜'))
  }
  out.push(
    '',
    '判梗参考：梗的载体多样（词/句/公式/格式/交互）；名词与事件词常只是宿主，判定以用例证据为准（复读/化用/换词复用），不套固定模板。',
    '通道图例：公式=带槽句式模板（<X>槽位，<ent>为内部可变段）；图梗=跨视频复现的图片簇（img:开头）；复读=整句字面复读；⛓=楼中楼一字接龙拼接。',
    '标记：泛回应?=与客套词表语义近邻（是的/来啦类，触发被否决）｜泛夸?=与通用夸赞词近邻（可爱/好看类，排序罚分，真梗也可能带——按形成时间判据人工复核）｜弱模板?=槽填充语义近同（数量词槽）｜虚词核?=字面全为功能词。',
    '── 当前过门条目（★只表示待人工判断）──',
  )
  out.push(...(zones.new_candidates.length ? zones.new_candidates : ['（本轮无新候选）']))
  out.push('', '── 已有梗动态 ──')
  out.push(...(zones.dynamics.length ? zones.dynamics : ['（无动态）']))
  out.push('', '── 衰减（只读）──')
  out.push(...(zones.fading.length ? zones.fading : ['（无）']))
  out.push('', '── 判定提示 ──', zones.backlog_line, '', pageLine)
  return out.join('\n')
}

export function pageFooter(page: number, hasMore: boolean, roundSize: number): string {
  const more = hasMore ? ` | check --page ${page + 1}` : ''
  return `继续: check --focus <cid> 深入${more} | 默认结束本轮（每页 ${roundSize} 条）`
}

export function renderFocus(
  cand: Candidate,
  videos: Array<{ aid: number; title: string; up_name?: string }>,
  related: Array<{ id: string; type: string; score: number; name?: string }>,
  parentTexts: Map<number, string> = new Map(),
): string {
  const zTxt = cand.z_score !== null ? cand.z_score : '新'
  const out = [
    `── 候选 ${cand.cid} 完整证据 ──`,
    `词头/骨架：${cand.head}`,
    `类别预判：${cand.kind_guess}（通道 ${cand.channel}）｜状态 ${cand.state}`,
    `传播：${cand.distinct_videos} 视频 / ${cand.distinct_ups} up｜burst=${zTxt}｜跨 ${cand.surfs_seen} 轮存活`,
  ]
  if (related.length) {
    out.push('关联：' + related.map((r) => `${r.id}(${r.type},${r.score}) ${r.name ?? ''}`).join('；'))
  }
  if (videos.length) {
    out.push('来源视频：')
    for (const v of videos.slice(0, 5)) {
      out.push(`  - av${v.aid} 《${v.title.slice(0, 30)}》 up:${v.up_name ?? '?'}`)
    }
  }
  // 用例分组：字面复读（与词头同文）与变体分开列，模板候选给出填充。
  // 两侧同规整化：去槽位标记 + 去标点空白（词头侧此前误用字符类删槽，
  // 会把 e/n/t 等字母也删掉，拉丁词头如 nb 被剥成 b）
  const strip = (t: string): string => t.replace(/<[^>]+>/g, '').replace(/[\s，。！？；：、…—～·“”‘’()（）【】\[\].!?;:'"]/g, '')
  const headNorm = strip(cand.head)
  const bare = cand.evidence_usages.filter((u) => strip(u.text) === headNorm)
  const rest = cand.evidence_usages.filter((u) => !bare.includes(u))
  out.push('用例样本：')
  for (const u of bare.slice(0, 10)) {
    const pair = u.chain ? '（接龙拼接）' : u.parent ? '（楼中楼）' : ''
    out.push(`  - ${u.text}${pair}`)
    if (u.parent > 0 && parentTexts.has(u.parent)) out.push(`     父评：${parentTexts.get(u.parent)}`)
  }
  for (const u of rest.slice(0, 12)) {
    const pair = u.chain ? '（接龙拼接）' : u.parent ? '（楼中楼）' : ''
    out.push(`  - ${u.text}${pair}`)
    if (u.parent > 0 && parentTexts.has(u.parent)) out.push(`     父评：${parentTexts.get(u.parent)}`)
  }
  out.push('', `决断：add --cid ${cand.cid} 亲写 entry | note add --head 记疑点 | 跳过等下轮`)
  return out.join('\n')
}
