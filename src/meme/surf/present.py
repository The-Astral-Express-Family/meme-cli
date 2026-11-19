"""surf 四区呈现（§6.2）：统计锚随行、关联预标注箭头、衰减只读、欠账提醒。

一行一候选，LLM 的价值判断被数据锚定而非凭空臆测（D8）。
v2：榜首排序改为梗证据分（复读/坍缩/独立成评）优先——泛用词 dv 再高也沉底，
操作员翻页成本从"524 条垃圾里捞"降为"从真梗开始看"。
"""

from __future__ import annotations

from .. import candidates
from ..detect.evidence import meme_features
from ..models import Candidate

KIND_SHORT = {"word": "word", "formula": "formula", "format": "format",
              "interaction": "interaction", "event": "event", "derived": "derived"}
CHANNEL_SHORT = {"phrase": "", "skeleton": "", "image": "图梗", "copy": "复读",
                 "chain": "接龙"}


def order_key(c: Candidate):
    """梗证据分 → 跨视频 → id（稳定序）。"""
    feats = meme_features(c.evidence_usages, c.head)
    return (-feats.meme_score, -c.distinct_videos, c.cid)


def cand_line(c: Candidate, related_names: dict[str, str]) -> str:
    z = f"z={c.z_score:.1f}" if c.z_score is not None else "z=新"
    feats = meme_features(c.evidence_usages, c.head)
    score = f"梗证{feats.meme_score:.1f}" if feats.meme_score >= 0.1 else "泛用"
    flag = " ★可add" if c.state == "triggered" else ""
    rel = ""
    if c.related:
        r = c.related[0]  # pydantic 强制转换为 RelatedRef
        nm = related_names.get(r.id, r.id)
        rid = r.id
        arrow = {"same_form": "同形？", "derived": "衍生？", "related": "相近"}[r.type]
        rel = f"   ← 与 {nm} {arrow}"
    head = c.head if len(c.head) <= 28 else c.head[:27] + "…"
    ch = CHANNEL_SHORT.get(c.channel, "")
    chain = " ⛓" if any(getattr(u, "chain", False) for u in c.evidence_usages) else ""
    return (f"{c.cid} \"{head}\"  {KIND_SHORT.get(c.kind_guess, c.kind_guess)}{ch}{chain}"
            f"  {c.distinct_videos}视频/{c.distinct_ups}up  {z}  {score}{flag}{rel}")


def cand_dict(c: Candidate) -> dict:
    related = [r.model_dump() for r in c.related]  # 恒为 RelatedRef（pydantic 强制）
    return {
        "cid": c.cid,
        "head": c.head,
        "kind_guess": c.kind_guess,
        "channel": c.channel,
        "state": c.state,
        "videos": c.distinct_videos,
        "ups": c.distinct_ups,
        "z": round(c.z_score, 2) if c.z_score is not None else None,
        "surfs_seen": c.surfs_seen,
        "related": related,
    }


def render_zones(zones: dict, page_line: str) -> str:
    counts = zones["counts"]
    out = [f"[新候选 {counts['new']} | 已有梗动态 {counts['dynamics']} | "
           f"衰减 {counts['fading']} | 欠账 {counts['backlog']}]"]
    if zones.get("degraded"):
        out.append(f"⚠ 降级模式：{zones['degraded']}（呈现存量数据，§6.6）")
    if zones.get("hot_keywords"):
        out.append("")
        out.append("── 站内热词（今日热点·决策参考，非候选）──")
        out.append("  " + "｜".join(zones["hot_keywords"][:10]))
    out.append("")
    out.append("判梗参考：梗的载体多样（词/句/公式/格式/交互）；名词与事件词常只是宿主，判定以用例证据为准（复读/化用/换词复用），不套固定模板。")
    out.append("通道图例：骨架=句式模板（固定字+<ent>槽位，同族公式坍缩为同一形状）；图梗=跨视频复现的图片簇（img:开头）；⛓=楼中楼一字接龙拼接。")
    out.append("── 新候选（按爆发强度降序）──")
    if zones["new_candidates"]:
        out.extend(zones["new_candidates"])
    else:
        out.append("（本轮无新候选）")
    out.append("")
    out.append("── 已有梗动态 ──")
    if zones["dynamics"]:
        out.extend(zones["dynamics"])
    else:
        out.append("（无动态）")
    out.append("")
    out.append("── 衰减（只读）──")
    if zones["fading"]:
        out.extend(zones["fading"])
    else:
        out.append("（无）")
    out.append("")
    out.append("── 欠账 ──")
    out.append(zones["backlog_line"])
    out.append("")
    out.append(page_line)
    return "\n".join(out)


def page_footer(page: int, has_more: bool, round_size: int) -> str:
    more = f" | `--more` 翻页（第 {page + 1} 页）" if has_more else ""
    return f"继续: --focus <cid> 深入{more} | 默认结束本轮（每页 {round_size} 条）"


def render_focus(cand: Candidate, videos: list[dict], related: list[dict]) -> str:
    out = [
        f"── 候选 {cand.cid} 完整证据 ──",
        f"词头/骨架：{cand.head}",
        f"类别预判：{cand.kind_guess}（通道 {cand.channel}）｜状态 {cand.state}",
        f"传播：{cand.distinct_videos} 视频 / {cand.distinct_ups} up｜"
        f"z={cand.z_score if cand.z_score is not None else '新'}｜"
        f"跨 {cand.surfs_seen} 轮存活",
    ]
    if related:
        out.append("关联：" + "；".join(
            f"{r['id']}({r['type']},{r['score']}) {r.get('name', '')}" for r in related
        ))
    if videos:
        out.append("来源视频：")
        for v in videos[:5]:
            out.append(f"  - av{v['aid']} 《{v['title'][:30]}》 up:{v.get('up_name', '?')}")
    out.append("用例样本：")
    for u in cand.evidence_usages[:20]:
        if getattr(u, "chain", False):
            pair = "（接龙拼接）"
        elif u.parent:
            pair = f"（楼中楼，父评 {u.parent}）"
        else:
            pair = ""
        out.append(f"  - {u.text}{pair}")
    out.append("")
    out.append(f"决断：`meme add {cand.cid}` 归纳 | `meme note add --head \"{cand.head[:12]}\"` 记疑点 | 跳过等下轮")
    return "\n".join(out)
