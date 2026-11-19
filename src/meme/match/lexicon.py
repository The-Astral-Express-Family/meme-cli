"""词表层（①）：字面词表匹配 + 位置/语境约束 DSL 检查（§8.1 word 类）。

约束语义：
- forbid_inner：命中不得是更长词语的一部分（按分词判定，非字符邻接——
  "太典了"合法、"古典文学"否决）
- standalone / sentence_final：位置约束，二者启用其一时满足任一即可
  （"单独成句或句尾"，§8.1 对"典"的要求）
"""

from __future__ import annotations

import bisect

import jieba

from ..models import Constraints

SENT_END = "。！？!?…~\n"
SENT_SEP = SENT_END + "，,；;、：: "
# 紧贴梗词的常见胶水字：不算"更长词的一部分"（真典=真+典 合法，古典 否决）
GLUE_BEFORE = set("真太最更还好就是都也不很蛮贼巨真的直接")
GLUE_AFTER = set("了的吧啊呢嘛哦呀")
jieba.setLogLevel(60)


def _token_spans(text: str) -> list[tuple[int, int]]:
    """jieba 分词的字符区间（lcut 无重叠覆盖原文）。"""
    spans = []
    pos = 0
    for tok in jieba.lcut(text):
        spans.append((pos, pos + len(tok)))
        pos += len(tok)
    return spans


def _inside_longer_word(
    text: str, token_spans: list[tuple[int, int]], start: int, end: int
) -> bool:
    for ts, te in token_spans:
        if te <= start or ts >= end:
            continue
        if ts < start:  # 命中起点落在 token 内部
            prefix = text[ts:start]
            if any(ch not in GLUE_BEFORE for ch in prefix):
                return True
        if te > end:  # 命中终点落在 token 内部
            suffix = text[end:te]
            if any(ch not in GLUE_AFTER for ch in suffix):
                return True
    return False


def check_constraints(
    text: str,
    start: int,
    end: int,
    cons: Constraints,
    token_spans: list[tuple[int, int]] | None = None,
    term: str = "",
) -> bool:
    """对一处命中做约束检查。违反任一 → False。"""
    before = text[max(0, start - 1) : start]
    after = text[end : end + 1]
    if cons.forbid_inner:
        if token_spans is None:
            token_spans = _token_spans(text)
        if _inside_longer_word(text, token_spans, start, end):
            return False
    # 位置约束：启用的 standalone / sentence_final 满足其一即可
    pos_ok: list[bool] = []
    if cons.standalone:
        b_ok = (not before) or before in SENT_SEP or before in GLUE_BEFORE
        a_ok = (not after) or after in SENT_SEP or after in GLUE_AFTER
        pos_ok.append(b_ok and a_ok)
    if cons.sentence_final:
        pos_ok.append((not after) or after in SENT_END)
    if pos_ok and not any(pos_ok):
        return False
    if cons.forbid_context or cons.require_context:
        w = cons.context_window
        before_win = text[max(0, start - w) : start]
        after_win = text[end : end + w]
        # forbid 词与命中 span 重叠时，窗口（span 两侧）永远不含完整 forbid 词——
        # 语义陷阱（subagent 实战 8 发探测抓获）：改为检查 forbid 词去掉重叠部分
        # 后的剩余是否出现在窗口（"回答我吗" forbid vs span"回答我" → 查"吗"）
        for f in cons.forbid_context:
            probe = f.replace(term, "", 1) if term and term in f else f
            if not probe:
                continue  # forbid 词整个落在 span 内：恒真陷阱，忽略
            if probe in before_win or probe in after_win:
                return False
        if cons.require_context and not any(
            r and (r in before_win or r in after_win) for r in cons.require_context
        ):
            return False
    return True


def find_terms(
    text: str, terms: list[str], cons: Constraints
) -> tuple[int, int, str] | None:
    """返回第一个通过约束的命中 (start, end, term)。"""
    spans = _token_spans(text) if cons.forbid_inner else None
    for term in sorted(terms, key=len, reverse=True):
        if not term:
            continue
        start = text.find(term)
        while start != -1:
            end = start + len(term)
            if check_constraints(text, start, end, cons, spans, term=term):
                return start, end, term
            start = text.find(term, start + 1)
    return None


def contains_any(text: str, terms: list[str]) -> bool:
    return any(t and t in text for t in terms)
