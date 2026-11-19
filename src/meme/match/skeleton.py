"""骨架层（②）：归一化 token 流上的带槽匹配（formula / format 类，§8.1）。

token 串以 \\x00 连接后编译为正则：字面 token 精确匹配，槽位展开为通配。
命中 span 由 token 偏移映射回原文本。
"""

from __future__ import annotations

import re

from ..detect.skel import normalize_spanned

SEP = "\x00"

_SLOT_PAT = {
    "<num>": re.escape("<num>"),
    "<emo>": re.escape("<emo>"),
    "<url>": re.escape("<url>"),
    "<at>": re.escape("<at>"),
    # <ent>/<any>：吞 1-3 个任意 token（槽内方差大正是 D6 的动机）
    "<ent>": f"[^{SEP}]+(?:{SEP}[^{SEP}]+){{0,2}}",
    "<any>": f"[^{SEP}]+(?:{SEP}[^{SEP}]+){{0,2}}",
}
# 槽位必须在编译表内显式登记：<at> 曾靠"字面量恰好匹配 token 原文"碰巧可用


def compile_tokens(tokens: list[str]) -> re.Pattern:
    parts = []
    for t in tokens:
        if t in _SLOT_PAT:
            parts.append(_SLOT_PAT[t])
        else:
            # 字面量允许穿越 token 边界：jieba 对"鉴定为"可能切成
            # [鉴定,为] 也可能保持整词——字符间允许 0-1 个分隔符，两种都命中
            chars = list(re.escape(ch) for ch in t)
            parts.append(f"{SEP}?".join(chars))
    # 部件间分隔符同样可选：字面量可能结束在 token 中部（"为云"的"为"），
    # 下一部件需能接着同 token 内继续匹配
    return re.compile(f"{SEP}?".join(parts))


def match_skeleton(
    text: str, pattern: re.Pattern
) -> tuple[int, int, str] | None:
    """在原文本上找骨架命中，返回 (start, end, matched_token_text)。"""
    spanned = normalize_spanned(text)
    if not spanned:
        return None
    stream = SEP.join(tok for tok, _, _ in spanned)
    m = pattern.search(stream)
    if not m:
        return None
    # stream 偏移 → token 索引（按 SEP 边界计数）
    tok_start_idx = stream[: m.start()].count(SEP)
    tok_end_idx = stream[: m.end()].count(SEP)
    if tok_end_idx >= len(spanned):
        tok_end_idx = len(spanned) - 1
    s = spanned[tok_start_idx][1]
    e = spanned[tok_end_idx][2]
    matched = text[s:e]
    if not matched.strip():
        return None
    return s, e, matched


def match_tokens_terms(
    text: str, tokens: list[str], terms: list[str]
) -> tuple[int, int, str] | None:
    """tokens 或 terms 二选一的骨架子模式匹配。"""
    if tokens:
        return match_skeleton(text, compile_tokens(tokens))
    if terms:
        for term in sorted(terms, key=len, reverse=True):
            idx = text.find(term)
            if idx != -1:
                return idx, idx + len(term), term
    return None
