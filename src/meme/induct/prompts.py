"""归纳提示词：证据包 → 结构化词条 JSON（§7.3）。

DSH wire 协议无原生结构化输出——prompt 约定 JSON 围栏 + 代码侧校验 + 一轮修复。
"""

from __future__ import annotations

import json

SYSTEM = """你是 B站梗百科的归纳器。依据证据（真实用例 + 传播统计）归纳梗词条。
铁律：
1. 只依据证据归纳，不臆测证据外的含义；用例不足以判断的字段填 null。
2. 输出必须是一个 JSON 对象，放在 ```json 围栏中，不要输出任何其他内容。
3. gist 一句话讲清"这是什么梗、怎么用"；taboo 讲清"什么场合用会翻车"。
4. register 描述圈层/语域（如"泛B站、偏男频游戏区"）；aggression ∈ 低|中|高。
5. matcher 是给机器的匹配器，宁窄勿宽：误报（把普通句子认成梗）比漏报更糟。

判梗参考（是一种视角，不是判定模板；与证据冲突时以证据为准）：
梗的载体多样——词、句、公式、格式、交互都可能成立。名词/专名/事件词常只是梗的
宿主而非梗本身（黑称/代称类除外）；判定跟随用例证据：是否被复读、化用、换词复用，
传播广度只是必要条件。同一形状被多种填法复用时考虑 formula；不要为套形状硬造公式。"""

SCHEMA_DOC = """输出 JSON schema（全部字段必填，无内容用 null/[]）：
{
  "name": "词条名（最常见写法）",
  "aliases": ["别名/变体写法"],
  "class": "word|formula|format|interaction|event|derived",
  "birth_circa": "爆发起始，如 \\"2023\\" 或 \\"2023-08\\"（证据不足给年份，再不足给 null）",
  "card": {
    "gist": "一句话释义（≤60字）",
    "usage": ["典型用法短句 2-3 条"],
    "taboo": "禁忌用法/翻车场景（无则 null）",
    "register": "语域/圈层（无则 null）",
    "aggression": "低|中|高"
  },
  "examples": ["代表性例句 3-5 条，取自证据或其最小改写"],
  "matcher": {
    "patterns": [
      {"kind": "lex", "terms": ["字面词", "别名"]},
      {"kind": "skeleton", "tokens": ["一眼", "<ent>", "鉴定为", "<ent>"]},
      {"kind": "interaction", "trigger_terms": ["触发句特征词"], "response_terms": ["回应句特征词"],
       "trigger_tokens": [], "response_tokens": []}
    ],
    "constraints": {
      "standalone": false, "sentence_final": false, "forbid_inner": false,
      "forbid_context": ["命中span附近出现则否决，如 \\"古典\\""], "require_context": []
    }
  },
  "lineage_parent": "父词条 id（derived 时）否则 null",
  "lineage_mutation": "相对父梗的变异点（derived 时）否则 null",
  "notes": "不确定点、证据矛盾处的自述（只进审计日志，不进卡片）"
}
matcher 规则：
- word 类 → 用 lex terms + constraints；单字梗（如"典"）必须加约束防误报：
  forbid_inner=true（不得是更长词的一部分），必要时 standalone 或 sentence_final。
- formula/format 类 → 用 skeleton tokens；槽位：<num>数字、<ent>吞1-3个任意词（实体槽）、
  <emo>表情、<url>链接、<any>任意1-3词。骨架只固定"不变部分"，槽留给可变成分。
- interaction 类 → trigger（上一句特征）+ response（回应句特征），来自楼中楼对话对；
  例句可写成"上句：X 本句：Y"格式，backtest 会自动拆出会话上下文。
- event 类 → lex 名词短语即可，重心放 card（什么场合提它才对味）。
- patterns 可组合多条；constraints 全局作用于该词条。

constraints.forbid_context 精确语义（subagent 黑盒探测校准，照此设计）：
- 检查窗口 = 命中 span 两侧各 12 字（不含 span 内部）；
- forbid 词若与命中词本身重叠（如 forbid"回答我吗" vs 词"回答我"），实际检查的是
  它去掉重叠后的剩余部分（"吗"）是否出现在 span 后——这正是切割"祈使咆哮 vs
  正常疑问句"的用法：forbid ["？","吗","吧","呢","一下","请"] 压掉疑问用法；
- forbid_inner 与 forbid_context 组合覆盖"更长词的一部分"与"同词的非梗语用"两类误报。

backtest 边界（重要，避免虚假安全感）：负例取自原始湖随机采样且不含梗名/别名——
它验证 matcher 的**召回**与对无关文本的**粗误报**，但**不含**"含梗词的非梗用法"
（如"为什么不回答我？"）。这类边界行为必须由操作员自行构造对抗样本用 lookup 验证。"""


def _fmt_usages(usages: list[dict], cap: int = 30) -> str:
    lines = []
    for i, u in enumerate(usages[:cap], 1):
        pair = u.get("pair")
        if pair:
            lines.append(f"{i}. 对话｜上：{pair[0]}\n        下：{pair[1]}")
        else:
            lines.append(f"{i}. {u['text']}")
    return "\n".join(lines) or "（无）"


def build_induction_prompt(
    ev: dict,
    plan_path: str,
    parent_card: dict | None = None,
    related_cards: list[dict] | None = None,
) -> tuple[str, str]:
    kind = ev["kind"]
    head = ev["head"]
    spread = ev.get("spread") or {}
    z = ev.get("z")
    parts = [
        f"# 归纳任务（triage 路径：{plan_path}，类别预判：{kind}）",
        f"## 词头/骨架\n{head}",
        f"## 传播统计\n视频 {spread.get('videos', 0)} 个｜up 主 {spread.get('ups', 0)} 个｜"
        f"z={z if z is not None else '新物(基线不足)'}｜首次 {spread.get('first')}｜最近 {spread.get('last')}",
        "## 用例样本（真实B站评论）",
        _fmt_usages(ev.get("usages") or []),
    ]
    if ev.get("channel") == "skeleton":
        parts.append(
            "\n注意：词头是归一化骨架（token 序列）。<num>/<ent>/<emo>/<url>/<at> 为槽位，"
            "对应可变成分；请从用例中还原真实形状后归纳。"
        )
    if parent_card:
        parts.append(
            "## 父词条（这是衍生梗，只归纳相对父梗的 diff）\n"
            + json.dumps(parent_card, ensure_ascii=False, indent=1)
        )
    if related_cards:
        parts.append(
            "## 库内同形/相近词条（注意区分：是新词条还是已有词条的新用法/变体）\n"
            + json.dumps(related_cards, ensure_ascii=False, indent=1)
        )
    if kind == "word":
        parts.append(
            "\n本任务为词梗轻量归纳：词表 + 别名 + 一句话 gist 为主，"
            "重点设计好防误报约束。"
        )
    parts.append("\n" + SCHEMA_DOC)
    return SYSTEM, "\n\n".join(parts)


def build_iteration_prompt(meme, ev: dict) -> tuple[str, str]:
    """重归纳（iterate）：旧卡是先验不是权威——首轮归纳常有偏差，新证据优先。"""
    import json as _json

    old = {
        "id": meme.id,
        "name": meme.name,
        "aliases": meme.aliases,
        "class": meme.class_,
        "card": meme.card.model_dump(),
        "examples": meme.examples,
        "drift": [d.model_dump() for d in meme.drift],
        "birth_circa": meme.birth.circa,
        "matcher": _json.loads(meme.matcher.model_dump_json(by_alias=True)) if meme.matcher else None,
    }
    user = (
        f"# 重归纳任务：修订词条 {meme.id}\n"
        "该词条此前已归纳过一轮。旧版内容只是先验，不是权威——首轮归纳在证据\n"
        "不足时常有偏差（释义过度概括、类别误判、匹配器漏报变体）。你的任务：\n"
        "1. 逐字段审视旧版与新证据的冲突处，以新证据为准；\n"
        "2. matcher 重点补漏报变体（新用例中旧 matcher 未覆盖的写法）；\n"
        "3. 释义若发生实质变化，在 notes 里说明改了什么、为什么；\n"
        "4. 输出仍是完整词条 JSON（不是 diff）。\n\n"
        f"## 旧版词条\n```json\n{_json.dumps(old, ensure_ascii=False, indent=1)}\n```\n\n"
        f"## 新证据（野外命中 + 同头候选用例）\n{_fmt_usages(ev.get('usages') or [])}\n\n"
        + SCHEMA_DOC
    )
    return SYSTEM, user


def build_repair_prompt(raw_output: str, errors: list[str]) -> tuple[str, str]:
    user = (
        "你上一轮的输出未通过 schema 校验。错误：\n- "
        + "\n- ".join(errors)
        + "\n\n上一轮输出：\n```json\n"
        + raw_output[:8000]
        + "\n```\n请修正后重新输出完整 JSON（同样放 ```json 围栏）。\n\n" + SCHEMA_DOC
    )
    return SYSTEM, user


def build_matcher_revision_prompt(
    matcher_json: str,
    direction: str,  # loosen | tighten
    miss_texts: list[str],
    fp_texts: list[str],
) -> tuple[str, str]:
    if direction == "loosen":
        goal = "留出集命中率不足。请放宽匹配（放宽约束/增加模式/扩大槽位），但不得引入明显误报。"
        cases = "## 漏报用例（当前 matcher 未命中）\n" + "\n".join(f"- {t}" for t in miss_texts[:15])
    else:
        goal = "负例误报率超标。请收紧匹配（加约束/删过宽模式/forbid_context），尽量保住命中。"
        cases = "## 误报负例（普通评论被误命中）\n" + "\n".join(f"- {t}" for t in fp_texts[:15])
    user = (
        f"# matcher 修订任务\n{goal}\n\n## 当前 matcher\n```json\n{matcher_json}\n```\n\n{cases}\n\n"
        "只输出修订后的 matcher JSON（即 {\"patterns\": [...], \"constraints\": {...}} 整体），放 ```json 围栏。\n\n"
        + SCHEMA_DOC
    )
    return SYSTEM, user
