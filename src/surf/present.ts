/**
 * surf 四区呈现：统计锚随行、关联预标注箭头、衰减只读、欠账提醒。
 * 一行一候选，agent 的价值判断被数据锚定而非凭空臆测。
 * 榜首排序 = 梗证据分（复读/坍缩/独立成评）优先——泛用词 dv 再高也沉底。
 */
import type { Candidate } from '../models.ts'
import { memeFeatures, memeScore } from '../detect/evidence.ts'

const CHANNEL_SHORT: Record<string, string> = {
  phrase: '', skeleton: '', image: '图梗', copy: '复读', chain: '接龙',
}

/** 梗证据分 → 跨视频 → id（稳定序）。 */
export function orderKey(c: Candidate): [number, number, string] {
  const feats = memeFeatures(c.evidence_usages, c.head)
  return [-memeScore(feats), -c.distinct_videos, c.cid]
}

export function candLine(c: Candidate, relatedNames: Map<string, string>): string {
  const z = c.z_score !== null ? `z=${c.z_score.toFixed(1)}` : 'z=新'
  const feats = memeFeatures(c.evidence_usages, c.head)
  const score = memeScore(feats) >= 0.1 ? `梗证${memeScore(feats).toFixed(1)}` : '泛用'
  const flag = c.state === 'triggered' ? ' ★可add' : ''
  let rel = ''
  if (c.related.length) {
    const r = c.related[0]
    const nm = relatedNames.get(r.id) ?? r.id
    const arrow = ({ same_form: '同形？', derived: '衍生？', related: '相近' } as Record<string, string>)[r.type]
    rel = `   ← 与 ${nm} ${arrow}`
  }
  const head = c.head.length <= 28 ? c.head : c.head.slice(0, 27) + '…'
  const ch = CHANNEL_SHORT[c.channel] ?? ''
  const chain = c.evidence_usages.some((u) => u.chain) ? ' ⛓' : ''
  return `${c.cid} "${head}"  ${c.kind_guess}${ch}${chain}  ${c.distinct_videos}视频/${c.distinct_ups}up  ${z}  ${score}${flag}${rel}`
}

export function candDict(c: Candidate): Record<string, unknown> {
  return {
    cid: c.cid,
    head: c.head,
    kind_guess: c.kind_guess,
    channel: c.channel,
    state: c.state,
    videos: c.distinct_videos,
    ups: c.distinct_ups,
    z: c.z_score !== null ? Math.round(c.z_score * 100) / 100 : null,
    surfs_seen: c.surfs_seen,
    related: c.related,
  }
}

export function renderZones(zones: Record<string, any>, pageLine: string): string {
  const counts = zones.counts
  const out = [
    `[新候选 ${counts.new} | 已有梗动态 ${counts.dynamics} | 衰减 ${counts.fading} | 欠账 ${counts.backlog}]`,
  ]
  if (zones.degraded) out.push(`⚠ 降级模式：${zones.degraded}（呈现存量数据）`)
  if (zones.hot_keywords?.length) {
    out.push('', '── 站内热词（今日热点·决策参考，非候选）──', '  ' + zones.hot_keywords.slice(0, 10).join('｜'))
  }
  out.push(
    '',
    '判梗参考：梗的载体多样（词/句/公式/格式/交互）；名词与事件词常只是宿主，判定以用例证据为准（复读/化用/换词复用），不套固定模板。',
    '通道图例：骨架=句式模板（固定字+<ent>槽位，同族公式坍缩为同一形状）；图梗=跨视频复现的图片簇（img:开头）；⛓=楼中楼一字接龙拼接。',
    '── 新候选（按爆发强度降序）──',
  )
  out.push(...(zones.new_candidates.length ? zones.new_candidates : ['（本轮无新候选）']))
  out.push('', '── 已有梗动态 ──')
  out.push(...(zones.dynamics.length ? zones.dynamics : ['（无动态）']))
  out.push('', '── 衰减（只读）──')
  out.push(...(zones.fading.length ? zones.fading : ['（无）']))
  out.push('', '── 欠账 ──', zones.backlog_line, '', pageLine)
  return out.join('\n')
}

export function pageFooter(page: number, hasMore: boolean, roundSize: number): string {
  const more = hasMore ? ` | more=true 翻页（第 ${page + 1} 页）` : ''
  return `继续: focus=<cid> 深入${more} | 默认结束本轮（每页 ${roundSize} 条）`
}

export function renderFocus(
  cand: Candidate,
  videos: Array<{ aid: number; title: string; up_name?: string }>,
  related: Array<{ id: string; type: string; score: number; name?: string }>,
): string {
  const zTxt = cand.z_score !== null ? cand.z_score : '新'
  const out = [
    `── 候选 ${cand.cid} 完整证据 ──`,
    `词头/骨架：${cand.head}`,
    `类别预判：${cand.kind_guess}（通道 ${cand.channel}）｜状态 ${cand.state}`,
    `传播：${cand.distinct_videos} 视频 / ${cand.distinct_ups} up｜z=${zTxt}｜跨 ${cand.surfs_seen} 轮存活`,
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
  out.push('用例样本：')
  for (const u of cand.evidence_usages.slice(0, 20)) {
    const pair = u.chain ? '（接龙拼接）' : u.parent ? `（楼中楼，父评 ${u.parent}）` : ''
    out.push(`  - ${u.text}${pair}`)
  }
  out.push('', `决断：meme_add 归纳 ${cand.cid} | meme_note 记疑点 | 跳过等下轮`)
  return out.join('\n')
}
