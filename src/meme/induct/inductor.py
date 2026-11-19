"""入库管线：add（LLM/操作员两路）与 iterate（重归纳）共用一条闸门流水线（§7）。

LLM 负责价值判断的落实，backtest 负责事实判断——两个判断正交（§7 开篇）。
v2 重构：run_add / run_add_entry 曾各自维护一份编译+backtest+修订逻辑（纠偏
期产物）；iterate 需要"带旧卡先验 + 新证据重归纳"，与两者共享同一闸门。
"""

from __future__ import annotations

import json
import random
import sqlite3
from dataclasses import dataclass, field

from .. import audit, candidates, entries
from . import budget
from ..config import Config
from ..errors import MemeError, budget_exceeded, candidate_not_found, llm_call_failed
from ..ids import next_id
from ..match.pipeline import CompiledMatcher
from ..match.vector import Embedder
from ..models import Birth, Card, InductionOutput, Lineage, Meme, UsageSample
from . import prompts
from .backtest import BacktestResult, run_backtest
from .compile_matcher import validate_and_compile
from .llm import WireLLM
from .triage import model_for, triage


@dataclass
class AddResult:
    meme: Meme
    model: str
    backtest: BacktestResult | None
    revisions: int = 0
    matcher_degraded: bool = False
    warnings: list[str] = field(default_factory=list)
    usage_tokens: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.meme.id,
            "name": self.meme.name,
            "class": self.meme.class_,
            "state": self.meme.state,
            "matcher": "compiled" if self.meme.matcher else "vector-only",
            "backtest": self.backtest.to_dict() if self.backtest else None,
            "model": self.model,
            "revisions": self.revisions,
            "warnings": self.warnings,
            "usage_tokens": self.usage_tokens,
        }


def find_duplicate(conn: sqlite3.Connection, out: InductionOutput) -> Meme | None:
    """新词条与库内词条同名/同别名 → 应走 iterate 而非重复入库。"""
    for m in entries.all_memes(conn):
        if m.state == "tombstone":
            continue
        if out.name in m.terms or any(a in m.terms for a in out.aliases):
            return m
    return None


def extract_json(text: str) -> dict:
    """提取 ```json 围栏；退化尝试裸 JSON / 首尾大括号。"""
    if "```json" in text:
        seg = text.split("```json", 1)[1]
        seg = seg.split("```", 1)[0]
        return json.loads(seg.strip())
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    s, e = text.find("{"), text.rfind("}")
    if s != -1 and e > s:
        return json.loads(text[s : e + 1])
    raise llm_call_failed("模型输出中未找到 JSON")


def _pair_texts(conn: sqlite3.Connection, usages: list[UsageSample]) -> list[tuple[str, str]]:
    """楼中楼对话对（interaction 证据）：子评论 → 父评论文本。"""
    pairs = []
    for u in usages:
        if u.parent:
            row = conn.execute(
                "SELECT message FROM lake_comments WHERE rpid=?", (u.parent,)
            ).fetchone()
            if row:
                pairs.append((row["message"], u.text))
    return pairs


def _related_context(conn: sqlite3.Connection, cand) -> tuple[dict | None, list[dict]]:
    parent_card = None
    related_cards = []
    for rel in cand.related if cand else []:  # pydantic 强制转换为 RelatedRef
        rid, rtype = rel.id, rel.type
        m = entries.get(conn, rid)
        if m is None:
            continue
        item = {"id": m.id, "name": m.name, "class": m.class_, "gist": m.card.gist}
        if rtype == "derived":
            parent_card = item
        related_cards.append(item)
    return parent_card, related_cards[:3]


def _evidence_pack(conn: sqlite3.Connection, cand, text: str | None, ctx: str | None) -> dict:
    if cand is not None:
        usages = [{"text": u.text, "rpid": u.rpid} for u in cand.evidence_usages]
        pairs = _pair_texts(conn, cand.evidence_usages)
        for a, b in pairs[:8]:
            usages.append({"text": b, "pair": [a, b]})
        return {
            "head": cand.head,
            "kind": cand.kind_guess,
            "channel": cand.channel,
            "spread": {
                "videos": cand.distinct_videos,
                "ups": cand.distinct_ups,
                "first": cand.first_seen[:10],
                "last": cand.last_seen[:10],
            },
            "z": cand.z_score,
            "usages": usages,
        }
    return {
        "head": (text or "")[:20],
        "kind": "word",
        "channel": "phrase",
        "spread": {"videos": 1, "ups": 1, "first": None, "last": None},
        "z": None,
        "usages": [{"text": text}] + ([{"text": ctx}] if ctx else []),
    }


def _build_holdout(
    conn: sqlite3.Connection, cand, holdout_ratio: float
) -> tuple[list[str], list[list[str] | None]]:
    """留出集构建（§7.4 去污染）：用例 ≥5 条时按比例切出 holdout 文本与其会话上下文。"""
    all_texts = [u.text for u in cand.evidence_usages if u.text.strip()]
    rnd = random.Random(42)
    rnd.shuffle(all_texts)
    n_hold = max(1, int(len(all_texts) * holdout_ratio))
    holdout_texts = all_texts[:n_hold]
    by_text: dict[str, UsageSample] = {}
    for u in cand.evidence_usages:
        if u.text.strip():
            by_text.setdefault(u.text, u)
    holdout_ctx: list[list[str] | None] = []
    for t in holdout_texts:
        u = by_text.get(t)
        parent_msg = None
        if u is not None and u.parent:
            row = conn.execute(
                "SELECT message FROM lake_comments WHERE rpid=?", (u.parent,)
            ).fetchone()
            parent_msg = row["message"] if row else None
        holdout_ctx.append([parent_msg, t] if parent_msg else None)
    return holdout_texts, holdout_ctx


def _gate_and_build(
    conn: sqlite3.Connection,
    cfg: Config,
    out: InductionOutput,
    *,
    base: Meme | None = None,
    positives: list[str] | None = None,
    holdout_texts: list[str] | None = None,
    holdout_ctx: list[list[str] | None] | None = None,
    llm: WireLLM | None = None,
    model: str = "operator",
    strict: bool = False,
    force: bool = False,
) -> tuple[Meme, BacktestResult | None, list[str], int, bool]:
    """共享闸门：matcher 编译 → backtest → 一轮自动修订 → 词条构建。

    base 给定 = iterate（原位更新，保留 id/state/stats）；否则新建 observing。
    strict=True（操作员路径）：backtest 未达标报错而非静默降级（操作员是作者，
    闸门的职责是给修订反馈）；force=True 跳过（纯向量入库，进审计）。
    返回 (meme, backtest, warnings, revisions, matcher_degraded)。
    """
    warnings: list[str] = []
    revisions = 0
    matcher_spec = out.matcher
    if matcher_spec is not None:
        try:
            matcher_spec = validate_and_compile(matcher_spec)
        except ValueError as e:
            if strict:
                raise MemeError(
                    "MEME_MATCHER_COMPILE_FAIL", f"matcher 编译失败：{e}",
                    suggestion="修正 matcher 字段后重试；或删除 matcher 字段（纯向量词条）。")
            matcher_spec = None
            warnings.append(f"matcher 编译失败，降级纯向量：{e}")

    if base is not None:
        meme = base.model_copy(deep=True)
        meme.name, meme.aliases = out.name, out.aliases
        meme.class_ = out.class_
        meme.birth = Birth(circa=out.birth_circa) if out.birth_circa else meme.birth
        meme.card = out.card
        meme.examples = out.examples[:8]
        if out.lineage_parent:
            meme.lineage = Lineage(parent=out.lineage_parent, mutation=out.lineage_mutation)
        meme.matcher = matcher_spec
    else:
        # ID 延迟分配（subagent 实战反馈：backtest 失败曾把 next_id 烧成空洞）——
        # 闸门全过之后才拿号，失败路径零消耗
        meme = Meme(
            id="",
            name=out.name,
            aliases=out.aliases,
            **{"class": out.class_},
            state="observing",
            birth=Birth(circa=out.birth_circa),
            matcher=matcher_spec,
            card=out.card,
            examples=out.examples[:8],
            lineage=Lineage(parent=out.lineage_parent, mutation=out.lineage_mutation),
        )

    bt: BacktestResult | None = None
    if meme.matcher is not None:
        pos = positives if positives is not None else meme.examples
        cm = CompiledMatcher(meme)
        bt = run_backtest(
            conn, meme, cm, pos,
            holdout=cfg.induction.backtest_holdout,
            holdout_texts=holdout_texts or None,
            holdout_ctx=holdout_ctx or None,
            min_hit=cfg.induction.backtest_min_hit,
            max_fp=cfg.induction.backtest_max_fp,
            negatives=cfg.induction.backtest_negatives,
        )
        while not bt.passed and revisions < 1:
            if llm is None:
                break  # 操作员路径无修订轮（LLM 路径专用）
            direction = "loosen" if bt.hit_rate < cfg.induction.backtest_min_hit else "tighten"
            system, user = prompts.build_matcher_revision_prompt(
                meme.matcher.model_dump_json(by_alias=True), direction, bt.missed, bt.false_hits
            )
            raw_text_rev, more = _call(llm, conn, system, user, model)
            revisions += 1
            try:
                revised = validate_and_compile(_parse_matcher(raw_text_rev))
                meme.matcher = revised
                bt = run_backtest(
                    conn, meme, CompiledMatcher(meme), pos,
                    holdout=cfg.induction.backtest_holdout,
                    holdout_texts=holdout_texts or None,
                    holdout_ctx=holdout_ctx or None,
                    min_hit=cfg.induction.backtest_min_hit,
                    max_fp=cfg.induction.backtest_max_fp,
                    negatives=cfg.induction.backtest_negatives,
                )
            except (ValueError, json.JSONDecodeError, MemeError) as e:
                warnings.append(f"修订轮失败：{e}")
                break
        if not bt.passed:
            if strict and not force:
                detail = (f"留出命中 {bt.hit_rate:.0%}（门槛 {cfg.induction.backtest_min_hit:.0%}），"
                          f"误报 {bt.fp_rate:.1%}（门槛 {cfg.induction.backtest_max_fp:.1%}）；"
                          f"漏报 {len(bt.missed)} 例、误报 {len(bt.false_hits)} 例")
                examples = "; ".join(bt.missed[:3] + bt.false_hits[:3])[:200]
                raise MemeError(
                    "MEME_BACKTEST_FAIL", f"backtest 未达标：{detail}。样例：{examples}",
                    suggestion="按漏报/误报样例修订后重试；确认纯向量入库可加 --force。")
            meme.matcher = None
            warnings.append("backtest 未达标，降级为纯向量词条（仍可被 search 检索）")
    degraded = meme.matcher is None and out.matcher is not None
    if not meme.id:  # 延迟分配：闸门全过才拿号
        meme.id = next_id(conn, "m")
    return meme, bt, warnings, revisions, degraded


def run_add(
    conn: sqlite3.Connection,
    cfg: Config,
    cid: str | None = None,
    text: str | None = None,
    ctx: str | None = None,
    force_kind: str | None = None,
    _llm: WireLLM | None = None,
) -> AddResult:
    from ..db import kv_get  # noqa: F401  (保证迁移已发生)

    # 1. 目标解析：候选 或 裸文本（同 head 候选自动合流，§7.1）
    cand = None
    if cid:
        cand = candidates.get(conn, cid)
        if cand is None:
            raise candidate_not_found(cid)
    elif text:
        head = text.strip()[:12]
        cand = candidates.by_head(conn, head)

    kind_override = force_kind or (cand.kind_guess if cand else None)

    # 2. 预算闸门
    if not budget.can_spend(conn, cfg.induction.daily_call_budget):
        queued = budget.enqueue(conn, cid, text or ctx)
        raise budget_exceeded(queued)

    llm = _llm or WireLLM(cfg.induction)
    plan = triage(cand or (text or ""), kind_override)
    model = model_for(plan, cfg.induction)
    ev = _evidence_pack(conn, cand, text, ctx)
    # 留出集去污染（§7.4）：holdout 用例不进归纳提示词，专用于 backtest——
    # 否则 LLM 见过答案再考，命中率虚高、闸门形同虚设。证据不足 5 条时不留出。
    holdout_texts: list[str] = []
    holdout_ctx: list[list[str] | None] = []
    if cand is not None and len(cand.evidence_usages) >= 5:
        holdout_texts, holdout_ctx = _build_holdout(
            conn, cand, cfg.induction.backtest_holdout
        )
        hold = set(holdout_texts)
        ev["usages"] = [u for u in ev["usages"] if u.get("text") not in hold]
    if force_kind:
        ev["kind"] = force_kind
    parent_card, related_cards = _related_context(conn, cand)

    # 3. 归纳（一轮）+ 校验失败修复（一轮）
    system, user = prompts.build_induction_prompt(ev, plan.path, parent_card, related_cards)
    raw_text, tokens = _call(llm, conn, system, user, model)
    out, repair_rounds = _try_parse(raw_text), 0
    if out is None:
        parse_errors = _last_parse_errors
        system, user = prompts.build_repair_prompt(raw_text, parse_errors)
        raw_text2, more = _call(llm, conn, system, user, model)
        tokens += more
        out = _try_parse(raw_text2)
        repair_rounds = 1
        if out is None:
            raise llm_call_failed(
                f"归纳输出两轮未通过校验：{'; '.join(_last_parse_errors)[:300]}"
            )

    # 3.5 重名守卫：同名/同别名词条已存在 → 引导 iterate（防重复入库）
    dup = find_duplicate(conn, out)
    if dup is not None:
        raise MemeError(
            "MEME_DUPLICATE",
            f"词条名/别名与已有词条 {dup.id}（{dup.name}）冲突",
            suggestion=f"用 `meme iterate {dup.id}` 带新证据修订它；确属不同梗请改用不冲突的名字。")

    # 4-5. 共享闸门（编译 → backtest → LLM 修订轮）
    positives = [u["text"] for u in ev["usages"] if u.get("text")] + out.examples
    meme, bt, warnings, revisions, degraded = _gate_and_build(
        conn, cfg, out, positives=positives,
        holdout_texts=holdout_texts, holdout_ctx=holdout_ctx,
        llm=llm, model=model,
    )

    # 6. 向量锚点（例句级，D6）+ 入库
    vectors = _embed_examples(meme, cfg)
    entries.save(conn, meme, vectors)

    # 7. 候选收口 + 审计
    if cand is not None and cand.state != "inducted":
        conn.execute("UPDATE candidates SET state='inducted' WHERE cid=?", (cand.cid,))
        conn.commit()
    audit.record(conn, meme.id, "induct", "add", {
        "model": model,
        "evidence_head": ev["head"],
        "spread": ev["spread"],
        "backtest": bt.to_dict() if bt else None,
        "repair_rounds": repair_rounds,
        "warnings": warnings,
        "inductor_notes": out.notes,
        "usage_tokens": tokens,
    })
    return AddResult(meme, model, bt, repair_rounds, degraded, warnings, tokens)


def _call(llm: WireLLM, conn: sqlite3.Connection, system: str, user: str, model: str) -> tuple[str, int]:
    """一次 LLM 调用，返回 (原始文本, token 数)。解析与校验在外层分步处理。"""
    res = llm.complete(system, user, model=model)
    tokens = res.usage.get("input_tokens", 0) + res.usage.get("output_tokens", 0)
    budget.spend(conn, tokens)
    return res.text, tokens


def _embed_examples(meme: Meme, cfg: Config):
    import numpy as np

    texts = (meme.examples + meme.card.usage)[:10]
    emb = Embedder.get(cfg.retrieval.embed_model)
    vecs = emb.embed(texts) if texts else None
    if vecs is None:
        return []
    return [
        (i, texts[i], int(vecs.shape[1]), v.astype(np.float32).tobytes())
        for i, v in enumerate(vecs)
    ]


_last_parse_errors: list[str] = []


def _try_parse(raw_text: str) -> InductionOutput | None:
    """提取 JSON 围栏 + pydantic 校验；失败时错误进 _last_parse_errors。"""
    global _last_parse_errors
    _last_parse_errors = []
    try:
        raw = extract_json(raw_text)
    except Exception as e:  # noqa: BLE001 - 围栏缺失/JSON 损坏
        _last_parse_errors = [f"输出中未找到可解析 JSON：{e}"]
        return None
    try:
        out = InductionOutput.model_validate(raw)
        if not out.card or not out.card.gist:
            _last_parse_errors.append("card.gist 缺失")
            return None
        return out
    except Exception as e:  # noqa: BLE001 - pydantic 校验错误统一收集
        _last_parse_errors = [str(e)[:500]]
        return None


def _parse_matcher(raw_text: str):
    """修订轮输出 → MatcherSpec（裸 matcher JSON 或完整词条 JSON 均可）。"""
    from ..models import MatcherSpec

    data = extract_json(raw_text)
    if isinstance(data, dict) and "matcher" in data:
        data = data["matcher"]
    return MatcherSpec.model_validate(data)


def run_add_entry(
    conn: sqlite3.Connection,
    cfg: Config,
    entry_data: dict,
    cid: str | None = None,
    text: str | None = None,
    force: bool = False,
) -> AddResult:
    """操作员亲写词条入库（D1：操作员 agent 本身就是 LLM，归纳不需要外部 API key）。

    entry JSON schema 与归纳器输出完全一致（induct/prompts.py SCHEMA_DOC）。
    本地闸门全数保留：pydantic 校验 → matcher 编译 → backtest（共享 _gate_and_build，
    strict=True：未达标报错给修订反馈而非静默降级；--force 显式跳过）。
    """
    cand = None
    if cid:
        cand = candidates.get(conn, cid)
        if cand is None:
            raise candidate_not_found(cid)
    elif text:
        cand = candidates.by_head(conn, text.strip()[:12])

    try:
        out = InductionOutput.model_validate(entry_data)
        if not out.card or not out.card.gist:
            raise ValueError("card.gist 缺失")
    except Exception as e:  # noqa: BLE001 - pydantic/结构错误统一为稳定错误码
        raise MemeError(
            "MEME_ENTRY_INVALID",
            f"词条 JSON 校验失败：{str(e)[:400]}",
            suggestion="schema 与字段说明见 `meme add --help`；matcher 槽位写法见 SCHEMA_DOC。",
        )

    dup = find_duplicate(conn, out)
    if dup is not None:
        raise MemeError(
            "MEME_DUPLICATE",
            f"词条名/别名与已有词条 {dup.id}（{dup.name}）冲突",
            suggestion=f"用 `meme iterate {dup.id} --entry` 修订它；确属不同梗请改用不冲突的名字。")

    positives = out.examples + (
        [u.text for u in cand.evidence_usages if u.text.strip()] if cand else []
    )
    holdout_texts, holdout_ctx = None, None
    if cand is not None and len(cand.evidence_usages) >= 5:
        holdout_texts, holdout_ctx = _build_holdout(
            conn, cand, cfg.induction.backtest_holdout
        )
    meme, bt, warnings, _, degraded = _gate_and_build(
        conn, cfg, out, positives=positives,
        holdout_texts=holdout_texts, holdout_ctx=holdout_ctx,
        strict=True, force=force,
    )

    vectors = _embed_examples(meme, cfg)
    entries.save(conn, meme, vectors)

    if cand is not None and cand.state != "inducted":
        conn.execute("UPDATE candidates SET state='inducted' WHERE cid=?", (cand.cid,))
        conn.commit()
    audit.record(conn, meme.id, "induct", "add", {
        "model": "operator",  # 作者=操作员 agent，无外部 LLM 调用
        "evidence_head": (cand.head if cand else (text or "")[:20]),
        "entry_notes": out.notes,
        "backtest": bt.to_dict() if bt else None,
        "forced_vector_only": bool(force and out.matcher is not None),
    })
    return AddResult(meme, "operator", bt, 0, degraded, warnings, 0)


# ---------------- iterate：带新证据的重归纳（首轮归纳常错，修订必须常做） ----------------


def _collect_iterate_evidence(conn: sqlite3.Connection, meme: Meme) -> dict:
    """迭代证据包：词条当前 matcher 在原始湖的野外命中 + 同头候选证据 + 旧卡先验。"""
    usages: list[dict] = []
    if meme.matcher is not None:
        cm = CompiledMatcher(meme)
        rows = conn.execute(
            "SELECT rpid, oid, message, parent FROM lake_comments ORDER BY rpid DESC LIMIT 4000"
        ).fetchall()
        msg_by_rpid = {r["rpid"]: r["message"] for r in rows}
        seen: set[int] = set()
        for r in rows:
            ctx = None
            if r["parent"]:
                p = msg_by_rpid.get(r["parent"])
                if p:
                    ctx = [p, r["message"]]
            from ..match.pipeline import match_compiled

            hit = match_compiled(cm, r["message"], ctx)
            if hit and r["rpid"] not in seen and len(usages) < 24:
                seen.add(r["rpid"])
                if ctx:
                    usages.append({"text": r["message"], "pair": ctx})
                else:
                    usages.append({"text": r["message"]})
    cand_usages = []
    for term in meme.terms:
        c = candidates.by_head(conn, term)
        if c is not None:
            cand_usages.extend(u.text for u in c.evidence_usages)
    for t in cand_usages[:8]:
        if all(t != u.get("text") for u in usages):
            usages.append({"text": t})
    return {
        "head": meme.name,
        "kind": meme.class_,
        "channel": "iterate",
        "spread": {"videos": 0, "ups": 0, "first": None, "last": None},
        "z": None,
        "usages": usages or [{"text": m} for m in meme.examples[:3]],
    }


def run_iterate(
    conn: sqlite3.Connection,
    cfg: Config,
    mid: str,
    entry_path: str | None = None,
    force: bool = False,
    _llm: WireLLM | None = None,
) -> AddResult:
    """重归纳已有词条：新证据 + 旧卡先验 → 修订版（原位更新，保留 id/state/stats）。

    使用场景（高频）：首轮归纳的释义/类别/匹配器事后被证明有误；野外出现了
    matcher 漏报的新变体；观察期证据从 6 条涨到 30 条后词条该升格细化了。
    - LLM 路径（无 --entry）：野外命中 + 同头候选证据 → 归纳器产出修订版
    - 操作员路径（--entry）：亲写修订版 JSON，旧卡与新证据已由调用方消化
    """
    meme = entries.get(conn, mid)
    if meme is None:
        raise MemeError("MEME_NOT_FOUND", f"未找到词条：{mid}",
                        suggestion="用 `meme search` 找到目标词条 id 后重试。")
    ev = _collect_iterate_evidence(conn, meme)

    if entry_path:
        with open(entry_path, encoding="utf-8") as f:
            entry_data = json.load(f)
        try:
            out = InductionOutput.model_validate(entry_data)
            if not out.card or not out.card.gist:
                raise ValueError("card.gist 缺失")
        except Exception as e:  # noqa: BLE001
            raise MemeError("MEME_ENTRY_INVALID", f"词条 JSON 校验失败：{str(e)[:400]}",
                            suggestion="schema 见 `meme add --help`。")
        model, tokens = "operator", 0
    else:
        if not budget.can_spend(conn, cfg.induction.daily_call_budget):
            raise budget_exceeded(budget.enqueue(conn, None, f"iterate:{mid}"))
        llm = _llm or WireLLM(cfg.induction)
        model = cfg.induction.model
        system, user = prompts.build_iteration_prompt(meme, ev)
        raw_text, tokens = _call(llm, conn, system, user, model)
        out = _try_parse(raw_text)
        if out is None:
            system, user = prompts.build_repair_prompt(raw_text, _last_parse_errors)
            raw_text2, more = _call(llm, conn, system, user, model)
            tokens += more
            out = _try_parse(raw_text2)
            if out is None:
                raise llm_call_failed(
                    f"重归纳输出两轮未通过校验：{'; '.join(_last_parse_errors)[:300]}")

    positives = [u["text"] for u in ev["usages"] if u.get("text")] + out.examples
    old_terms = set(meme.terms)
    meme2, bt, warnings, revisions, degraded = _gate_and_build(
        conn, cfg, out, base=meme, positives=positives,
        llm=None if entry_path else (_llm or WireLLM(cfg.induction)),
        model=model, strict=bool(entry_path), force=force,
    )

    # 语义漂移留痕：释义实质性变化 → drift 自动记一笔（人写分期仍走 edit --drift）
    if meme.card.gist != meme2.card.gist:
        from ..models import DriftEntry

        meme2.drift.append(DriftEntry(
            period=meme2.updated_at[:10],
            change=f"释义修订：{meme.card.gist[:40]} → {meme2.card.gist[:40]}",
            evidence="iterate",
        ))
        meme2.drift = meme2.drift[-8:]
    vectors = _embed_examples(meme2, cfg)
    entries.save(conn, meme2, vectors)

    # 新收编的别名若有对应候选 → 收口
    for t in set(meme2.terms) - old_terms:
        c = candidates.by_head(conn, t)
        if c is not None and c.state != "inducted":
            conn.execute("UPDATE candidates SET state='inducted' WHERE cid=?", (c.cid,))
            conn.commit()

    audit.record(conn, meme2.id, "iterate", "edit", {
        "model": model,
        "evidence_usages": len(ev["usages"]),
        "backtest": bt.to_dict() if bt else None,
        "old_gist": meme.card.gist,
        "new_terms": sorted(set(meme2.terms) - old_terms),
        "warnings": warnings,
        "usage_tokens": tokens,
    })
    return AddResult(meme2, model, bt, revisions, degraded, warnings, tokens)
