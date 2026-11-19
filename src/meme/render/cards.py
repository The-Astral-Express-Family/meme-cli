"""三级输出（§10.1）：brief 一行 / card ≈100 token（默认）/ full 显式请求。

card 是整个系统最重要的工件——90% 的使用场景只需要这一张卡。
遗忘 = 压缩：fading 缩卡、tombstone 最小卡（§9.2）。
人机同源：每个渲染函数同时给出 (人类文本, dict)。
"""

from __future__ import annotations

from .. import audit
from ..models import Meme

KIND_CN = {"word": "词梗", "formula": "公式梗", "format": "格式梗",
           "interaction": "交互梗", "event": "事件梗", "derived": "衍生梗"}


def brief(m: Meme) -> tuple[str, dict]:
    d = {
        "id": m.id, "name": m.name, "class": m.class_, "class_cn": KIND_CN.get(m.class_, m.class_),
        "gist": m.card.gist, "aggression": m.card.aggression or "-", "state": m.state,
    }
    text = (f"{m.id} {m.name} | {d['class_cn']} | {m.card.gist}"
            f" | 攻击性{d['aggression']} | {m.state}")
    return text, d


def _minimal(m: Meme) -> tuple[str, dict]:
    """tombstone / 待确认复活：最小卡（ID + 名字 + 一行释义 + 归档指针）。"""
    d = {"id": m.id, "name": m.name, "gist": m.card.gist, "state": m.state,
         "minimal": True,
         "hint": "记得但记不全：确认活跃后自动恢复完整卡（再次命中或 edit --revive）"}
    text = (f"{m.id} {m.name} | {'已归档' if m.state == 'tombstone' else m.state}"
            f" | {m.card.gist}\n  {d['hint']}")
    return text, d


def card(m: Meme, conn=None) -> tuple[str, dict]:
    if m.state == "tombstone" or m.revived_pending:
        return _minimal(m)
    lines = [f"{m.id} {m.name}（{KIND_CN.get(m.class_, m.class_)}）"]
    if m.aliases:
        lines.append(f"  又名：{'、'.join(m.aliases[:5])}")
    lines.append(f"  {m.card.gist}")
    usage = m.card.usage[:3] if m.state != "fading" else m.card.usage[:1]
    for u in usage:
        lines.append(f"  · {u}")
    extras = []
    if m.card.taboo:
        extras.append(f"忌:{m.card.taboo}")
    if m.card.register:
        extras.append(f"域:{m.card.register}")
    if m.card.aggression:
        extras.append(f"攻击性:{m.card.aggression}")
    if extras:
        lines.append("  " + " | ".join(extras))
    if m.state == "observing":
        lines.append("  [observing] 观察期词条：可安全用于理解，表达使用前先 --full 核对")
    if m.state == "fading":
        lines.append("  [fading] 衰减中：例句已压缩，完整内容 --full")
    d = {
        "id": m.id, "name": m.name, "class": m.class_, "state": m.state,
        "aliases": m.aliases, "gist": m.card.gist,
        "usage": usage, "taboo": m.card.taboo, "register": m.card.register,
        "aggression": m.card.aggression,
    }
    return "\n".join(lines), d


def full(m: Meme, conn=None) -> tuple[str, dict]:
    text, d = card(m)
    lines = [text, ""]
    lines.append(f"  词源：约 {m.birth.circa or '未知'}"
                 + (f"｜父梗 {m.lineage.parent}（{m.lineage.mutation}）" if m.lineage.parent else ""))
    lines.append(f"  匹配器：{'已编译' if m.matcher else '纯向量'}"
                 + (f"（{len(m.matcher.patterns)} 模式）" if m.matcher else ""))
    if m.examples:
        lines.append("  例句：")
        ex = m.examples if m.state != "fading" else m.examples[:1]
        for e in ex:
            lines.append(f"    - {e}")
    if m.drift:
        lines.append("  词义演化：")
        for dr in m.drift:
            lines.append(f"    - {dr.period}: {dr.change}" + (f"（证据 {dr.evidence}）" if dr.evidence else ""))
    lines.append(f"  统计：近30天日均 {m.stats.wild_freq_30d:.2f}｜峰值 {m.stats.peak_freq:.2f}"
                 f"｜最近出现 {m.stats.last_seen or '未观测'}")
    d = dict(d)
    d["birth_circa"] = m.birth.circa
    d["lineage"] = m.lineage.model_dump()
    d["matcher"] = ("compiled" if m.matcher else None)
    d["examples"] = m.examples
    d["drift"] = [x.model_dump() for x in m.drift]
    d["stats"] = m.stats.model_dump()
    if conn is not None:
        logs = audit.for_meme(conn, m.id)
        d["audit"] = logs
        lines.append("  审计：" + ("" if logs else "（无记录）"))
        for a in logs[-10:]:
            lines.append(f"    - {a['ts'][:19]} {a['action']}({a['source']})")
    return "\n".join(lines), d
