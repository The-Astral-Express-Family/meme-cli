/**
 * 三级输出：brief 一行 / card ≈100 token（默认）/ full 显式请求。
 * card 是整个系统最重要的工件——90% 的使用场景只需要这一张卡。
 * 遗忘 = 压缩：fading 缩卡、tombstone 最小卡。每个渲染函数同时给出 (人类文本, dict)。
 */
import type { DatabaseSync } from 'node:sqlite'
import * as audit from '../audit.ts'
import type { Json, Meme } from '../models.ts'

export const KIND_CN: Record<string, string> = {
  word: '词梗', formula: '公式梗', format: '格式梗',
  interaction: '交互梗', event: '事件梗', derived: '衍生梗',
}

const kindCn = (k: string) => KIND_CN[k] ?? k

export function brief(m: Meme): [string, Record<string, Json>] {
  const aggression = m.card.aggression ?? '-'
  const d = {
    id: m.id, name: m.name, class: m.class, class_cn: kindCn(m.class),
    gist: m.card.gist, aggression, state: m.state,
  }
  const text = `${m.id} ${m.name} | ${d.class_cn} | ${m.card.gist} | 攻击性${aggression} | ${m.state}`
  return [text, d]
}

/** tombstone / 待确认复活：最小卡（ID + 名字 + 一行释义 + 归档指针）。 */
function minimal(m: Meme): [string, Record<string, Json>] {
  const hint = '记得但记不全：确认活跃后自动恢复完整卡（再次命中或 edit revive）'
  const d = { id: m.id, name: m.name, gist: m.card.gist, state: m.state, minimal: true, hint }
  const text = `${m.id} ${m.name} | ${m.state === 'tombstone' ? '已归档' : m.state} | ${m.card.gist}\n  ${hint}`
  return [text, d]
}

export function card(m: Meme): [string, Record<string, Json>] {
  if (m.state === 'tombstone' || m.revived_pending) return minimal(m)
  const lines = [`${m.id} ${m.name}（${kindCn(m.class)}）`]
  if (m.aliases.length) lines.push(`  又名：${m.aliases.slice(0, 5).join('、')}`)
  lines.push(`  ${m.card.gist}`)
  const usage = m.state !== 'fading' ? m.card.usage.slice(0, 3) : m.card.usage.slice(0, 1)
  for (const u of usage) lines.push(`  · ${u}`)
  const extras: string[] = []
  if (m.card.taboo) extras.push(`忌:${m.card.taboo}`)
  if (m.card.register) extras.push(`域:${m.card.register}`)
  if (m.card.aggression) extras.push(`攻击性:${m.card.aggression}`)
  if (extras.length) lines.push('  ' + extras.join(' | '))
  if (m.state === 'observing') lines.push('  [observing] 观察期词条：可安全用于理解，表达使用前先 full 核对')
  if (m.state === 'fading') lines.push('  [fading] 衰减中：例句已压缩，完整内容 full')
  const d = {
    id: m.id, name: m.name, class: m.class, state: m.state,
    aliases: m.aliases, gist: m.card.gist,
    usage, taboo: m.card.taboo, register: m.card.register, aggression: m.card.aggression,
  }
  return [lines.join('\n'), d]
}

export function full(m: Meme, db?: DatabaseSync): [string, Record<string, Json>] {
  const [text, d0] = card(m)
  const d = { ...d0 } as Record<string, Json>
  const lines = [text, '']
  const parentTxt = m.lineage.parent ? `｜父梗 ${m.lineage.parent}（${m.lineage.mutation}）` : ''
  lines.push(`  词源：约 ${m.birth.circa ?? '未知'}${parentTxt}`)
  lines.push(`  匹配器：${m.matcher ? '已编译' : '纯向量'}${m.matcher ? `（${m.matcher.patterns.length} 模式）` : ''}`)
  if (m.examples.length) {
    lines.push('  例句：')
    for (const e of (m.state !== 'fading' ? m.examples : m.examples.slice(1))) lines.push(`    - ${e}`)
  }
  if (m.drift.length) {
    lines.push('  词义演化：')
    for (const dr of m.drift) {
      lines.push(`    - ${dr.period}: ${dr.change}${dr.evidence ? `（证据 ${dr.evidence}）` : ''}`)
    }
  }
  lines.push(
    `  统计：近30天日均 ${m.stats.wild_freq_30d.toFixed(2)}｜峰值 ${m.stats.peak_freq.toFixed(2)}`
    + `｜最近出现 ${m.stats.last_seen ?? '未观测'}`,
  )
  d.birth_circa = m.birth.circa
  d.lineage = m.lineage
  d.matcher = m.matcher ? 'compiled' : null
  d.examples = m.examples
  d.drift = m.drift
  d.stats = m.stats
  if (db) {
    const logs = audit.forMeme(db, m.id)
    d.audit = logs as unknown as Json // payload 是任意 JSON（审计自由载荷）
    lines.push('  审计：' + (logs.length ? '' : '（无记录）'))
    for (const a of logs.slice(-10)) lines.push(`    - ${a.ts.slice(0, 19)} ${a.action}(${a.source})`)
  }
  return [lines.join('\n'), d]
}
