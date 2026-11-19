"""matcher 编译与校验：归纳描述 → 可执行匹配器（§7.3、§8）。"""

from __future__ import annotations

from ..match.skeleton import compile_tokens
from ..models import MatcherSpec, PatternSpec

VALID_SLOTS = {"<num>", "<ent>", "<emo>", "<url>", "<at>", "<any>"}


def _literal_count(tokens: list[str]) -> int:
    """非空且非槽位的字面 token 数。纯槽位模式会匹配一切文本，等价于无模式。"""
    return sum(1 for t in tokens if t.strip() and not (t.startswith("<") and t.endswith(">")))


def validate_and_compile(spec: MatcherSpec) -> MatcherSpec:
    """校验模式合法性并试编译；不合法抛 ValueError（上游降级为纯向量词条）。"""
    if not spec.patterns:
        raise ValueError("patterns 为空")
    for p in spec.patterns:
        if p.kind == "lex":
            if not [t for t in p.terms if t and t.strip()]:
                raise ValueError("lex 模式缺少非空 terms")
            p.terms = [t.strip() for t in p.terms if t and t.strip()]
        elif p.kind == "skeleton":
            p.tokens = [t for t in p.tokens if t and t.strip()]
            if not p.tokens:
                raise ValueError("skeleton 模式缺少 tokens")
            if _literal_count(p.tokens) < 1:
                raise ValueError("skeleton 模式需至少一个字面 token（纯槽位会匹配一切）")
            for t in p.tokens:
                if t.startswith("<") and t not in VALID_SLOTS:
                    raise ValueError(f"未知槽位 {t}")
            compile_tokens(p.tokens)  # 试编译
        elif p.kind == "interaction":
            p.trigger_terms = [t for t in p.trigger_terms if t and t.strip()]
            p.response_terms = [t for t in p.response_terms if t and t.strip()]
            p.trigger_tokens = [t for t in p.trigger_tokens if t and t.strip()]
            p.response_tokens = [t for t in p.response_tokens if t and t.strip()]
            has_trigger = bool(p.trigger_terms) or _literal_count(p.trigger_tokens) >= 1
            has_response = bool(p.response_terms) or _literal_count(p.response_tokens) >= 1
            if not (has_trigger and has_response):
                raise ValueError("interaction 模式需要非空且含字面的 trigger 与 response")
            if p.trigger_tokens:
                compile_tokens(p.trigger_tokens)
            if p.response_tokens:
                compile_tokens(p.response_tokens)
        else:
            raise ValueError(f"未知模式类型 {p.kind}")
    for f in spec.constraints.forbid_context + spec.constraints.require_context:
        if not f.strip():
            raise ValueError("约束词表含空串")
    return spec
