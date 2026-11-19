"""交互层（③）：trigger→response 配对，检查会话位置（interaction 类，§8.1）。

配对样本源自楼中楼回复关系；匹配时需要调用方提供 --ctx 会话上文。
"""

from __future__ import annotations

from ..models import PatternSpec
from .skeleton import match_tokens_terms


def match_interaction(
    lines: list[str], pat: PatternSpec
) -> tuple[int, int, str] | None:
    """lines 为按时间序的会话文本（最后一行是待匹配行）。

    命中条件：最后一行匹配 response，且其前 ≤2 行内出现 trigger。
    返回最后一行上的 response span。
    """
    if not lines:
        return None
    last = lines[-1]
    resp = match_tokens_terms(last, pat.response_tokens, pat.response_terms)
    if resp is None:
        return None
    for prev in lines[-3:-1]:
        if match_tokens_terms(prev, pat.trigger_tokens, pat.trigger_terms):
            return resp
    return None
