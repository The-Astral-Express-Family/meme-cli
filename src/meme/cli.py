"""meme CLI：7 命令装配（§5）。

agent-facing 硬约束（§5.2）：help 即文档、默认输出=最常用答案、错误即引导、
无结果不是错误、读幂等写显式、稳定三件套、全局 --json 同源。
"""

from __future__ import annotations

import sys

import click

from . import __version__, entries, notes
from .bootstrap import setup
from .config import load_config
from .db import connect
from .errors import MemeError, not_found
from .match.vector import Embedder
from .render import cards, output


class Ctx:
    def __init__(self, cfg, conn, as_json: bool):
        self.cfg = cfg
        self.conn = conn
        self.json = as_json


pass_ctx = click.make_pass_decorator(Ctx)


class MemeGroup(click.Group):
    """MemeError 统一在此转稳定错误码输出——真实 CLI 与测试运行器同一行为。"""

    def invoke(self, ctx):
        import contextlib

        try:
            return super().invoke(ctx)
        except MemeError as e:
            # ctx.obj 建立前（connect/config 失败）也要尊重全局 --json：从根参数读
            as_json = bool((ctx.find_root().params or {}).get("as_json", False)) or \
                bool(ctx.obj and getattr(ctx.obj, "json", False))
            with contextlib.suppress(Exception):
                if ctx.obj is not None:
                    ctx.obj.conn.close()
            sys.exit(output.emit_error(e, as_json))


@click.group(cls=MemeGroup)
@click.version_option(__version__, prog_name="meme")
@click.option("--json", "as_json", is_flag=True, help="输出机器可读 JSON（与人类输出同源）")
@click.option("--db", "db_path", metavar="PATH", help="数据库文件路径（默认 ~/.meme/memes.db 或 $MEME_DB）")
@click.option("--config", "config_path", metavar="PATH", help="配置文件路径（默认查找 ./meme.toml、~/.meme/meme.toml）")
@click.pass_context
def cli(ctx, as_json: bool, db_path: str | None, config_path: str | None):
    """meme —— B站梗百科：采集（surf）、归纳（add）、修订（edit/iterate）、检索（lookup/search/show）、笔记（note）。"""
    setup()
    cfg = load_config(config_path, db_path)
    conn = connect(cfg.db_path)
    ctx.obj = Ctx(cfg, conn, as_json)


# ---------------- surf ----------------

@cli.command(epilog="""示例：
  meme surf                    一轮完整策展：增量获取 + 证据更新 + 四区呈现
  meme --json surf             机器输出：候选队列全量一次给全（不翻页）
  meme surf --more             翻看下一页候选（不重新获取；人类分页用）
  meme surf --focus c_0231     深入单个候选的完整证据
  meme surf --reject c_0003    判断为噪音，显式跳过该候选
  meme surf --reject c_0003,c_0004,c_0005 --ban   批量跳过并把词头沉淀为持久停用词
  meme surf --allow 拉         豁免内置黑名单误杀的词（恢复其候选资格）
  meme surf --probe "我记下了,烧心"  定向搜索探测：追已知梗的当前宿主视频（需登录态）
  meme surf --no-fetch         存量模式：不触网，只呈现并整理已有数据""")
@click.option("--more", "more_", is_flag=True, help="翻页：呈现下一页候选")
@click.option("--focus", metavar="CID", help="深入单个候选（完整证据视图）")
@click.option("--reject", "reject_cids", metavar="CID[,CID...]", help="显式跳过候选（可逗号分隔批量）")
@click.option("--ban", is_flag=True, help="连同 --reject：把候选词头沉淀为持久停用词（信号层永久过滤）")
@click.option("--allow", "allow_kws", default=None, metavar="KW[,KW...]",
              help="豁免词：从停用词（内置/沉淀）中放行，挽救被误杀的真梗")
@click.option("--round", "round_size", type=int, default=None, help="每页呈现条数（默认取配置）")
@click.option("--no-fetch", is_flag=True, help="跳过获取，纯存量呈现（降级模式）")
@click.option("--probe", "probe_kws", default=None, metavar="KW1,KW2",
              help="定向搜索探测梗浪宿主视频（逗号分隔；需登录态：配置 sessdata_env）")
@pass_ctx
def surf(ctx: Ctx, more_: bool, focus: str | None, reject_cids: str | None, ban: bool,
         allow_kws: str | None, round_size: int | None, no_fetch: bool, probe_kws: str | None):
    """执行一轮 B站获取 + 证据更新 + 四区呈现（策展工作台）。"""
    from .surf.run import handle_allow, handle_reject, run_surf

    def _kws(raw: str | None) -> list[str]:
        return [k.strip() for k in raw.split(",") if k.strip()] if raw else []

    probe_extra = _kws(probe_kws)

    if allow_kws:
        allowed = handle_allow(ctx.conn, _kws(allow_kws))
        output.emit("surf", {"allowed": allowed}, ctx.json,
                    f"已豁免 {'、'.join(allowed)}：下一轮起恢复候选资格")
        return
    if reject_cids:
        cids = _kws(reject_cids) or [reject_cids.strip()]
        try:
            done, banned = handle_reject(ctx.conn, cids, ban=ban)
        except KeyError as e:
            raise MemeError("CANDIDATE_NOT_FOUND", f"候选 {e.args[0]} 不存在或已出队",
                            suggestion="用 surf 输出里的 cid。") from None
        note = f"（词头 {'、'.join(banned)} 已沉淀为持久停用词）" if banned else ""
        output.emit("surf", {"rejected": done, "banned": banned}, ctx.json,
                    f"已跳过 {'、'.join(done)}{note}")
        return
    result = run_surf(ctx.conn, ctx.cfg, more=more_, focus=focus, round_size=round_size,
                      no_fetch=no_fetch, probe_extra=probe_extra, full=ctx.json)
    output.emit("surf", result["payload"], ctx.json, result["human"])


# ---------------- add ----------------

@cli.command(epilog="""示例：
  meme add c_0231                        归纳已触发的候选（携带完整证据包，需 DEEPSEEK_API_KEY）
  meme add c_0231 --entry entry.json     操作员亲写词条 JSON 入库（无外部 LLM 调用；
                                         schema 同归纳器输出，backtest 闸门照跑，
                                         未达标报 MEME_BACKTEST_FAIL 供修订，--force 跳过）
  meme add "一眼原神鉴定为云玩家" --ctx "游戏区热评"    收录裸文本（observing 入库）
  meme add c_0234 --kind word            覆盖 triage 类别预判""")
@click.argument("target")
@click.option("--ctx", "ctx_text", help="裸文本的出处/上下文（可选）")
@click.option("--entry", "entry_path", type=click.Path(exists=True), default=None,
              metavar="PATH", help="操作员亲写词条 JSON 文件（跳过外部 LLM，闸门保留）")
@click.option("--force", is_flag=True, help="连同 --entry：backtest 未达标时仍入库（降级纯向量，进审计）")
@click.option("--kind", "force_kind", type=click.Choice(["word", "formula", "format", "interaction", "event", "derived"]),
              help="覆盖类别预判")
@pass_ctx
def add(ctx: Ctx, target: str, ctx_text: str | None, entry_path: str | None,
        force: bool, force_kind: str | None):
    """归纳入库：处理候选 <cid>，或收录裸文本（走 triage→归纳→backtest 闸门）。"""
    import json as _json
    import re as _re

    if entry_path:
        from .induct.inductor import run_add_entry

        with open(entry_path, encoding="utf-8") as f:
            entry_data = _json.load(f)
        if _re.fullmatch(r"c_\d+", target):
            res = run_add_entry(ctx.conn, ctx.cfg, entry_data, cid=target, force=force)
        else:
            res = run_add_entry(ctx.conn, ctx.cfg, entry_data, text=target, force=force)
    else:
        from .induct.inductor import run_add

        if _re.fullmatch(r"c_\d+", target):
            res = run_add(ctx.conn, ctx.cfg, cid=target, ctx=ctx_text, force_kind=force_kind)
        else:
            res = run_add(ctx.conn, ctx.cfg, text=target, ctx=ctx_text, force_kind=force_kind)
    card_text, card_dict = cards.card(res.meme)
    human = f"已入库（observing）：\n{card_text}"
    if res.backtest:
        bt = res.backtest.to_dict()
        human += f"\n  backtest: 命中 {bt['hit_rate']:.0%}（留出 {bt['holdout_size']}）｜误报 {bt['fp_rate']:.1%}（{bt['negatives']} 负例）"
    for w in res.warnings:
        human += f"\n  ⚠ {w}"
    payload = res.to_dict() | {"card": card_dict}
    output.emit("add", payload, ctx.json, human)


# ---------------- iterate ----------------

@cli.command(epilog="""示例：
  meme iterate m_0042                    重归纳：野外新证据 + 旧卡先验 → 修订版
                                         （首轮归纳常有偏差，修订应当常做）
  meme iterate m_0042 --entry entry.json 操作员亲写修订版（无外部 LLM；闸门照跑）
  meme iterate m_0042 --force            backtest 未达标仍更新（matcher 降级纯向量）""")
@click.argument("mid")
@click.option("--entry", "entry_path", type=click.Path(exists=True), default=None,
              metavar="PATH", help="操作员亲写修订版词条 JSON（schema 同 add --entry）")
@click.option("--force", is_flag=True, help="backtest 未达标时仍更新（降级纯向量，进审计）")
@pass_ctx
def iterate(ctx: Ctx, mid: str, entry_path: str | None, force: bool):
    """重归纳词条：收集野外命中+候选新证据，带旧卡先验重走归纳闸门（原位更新）。"""
    from .induct.inductor import run_iterate

    res = run_iterate(ctx.conn, ctx.cfg, mid, entry_path=entry_path, force=force)
    card_text, card_dict = cards.card(res.meme)
    human = f"已修订（{res.meme.id} 保持 {res.meme.state}）：\n{card_text}"
    if res.backtest:
        bt = res.backtest.to_dict()
        human += f"\n  backtest: 命中 {bt['hit_rate']:.0%}｜误报 {bt['fp_rate']:.1%}"
    for w in res.warnings:
        human += f"\n  ⚠ {w}"
    payload = res.to_dict() | {"card": card_dict, "action": "iterate"}
    output.emit("iterate", payload, ctx.json, human)


# ---------------- edit ----------------

@cli.command(epilog="""示例：
  meme edit m_0042 --variant "典中典"          加变体/别名（骨架漂移的吸收）
  meme edit m_0042 --drift "2024:反讽义增强"   追加词义演化分期
  meme edit m_0156 --promote                   observing 提前升格
  meme edit m_0088 --kill --reason "被官方收编后语境已变"
  meme edit m_0088 --revive                    归档复活（先给最小卡）""")
@click.argument("mid")
@click.option("--variant", multiple=True, help="收编新变体/别名（可多次）")
@click.option("--drift", help="追加 drift：'分期: 变化描述'")
@click.option("--promote", is_flag=True, help="observing → active 升格")
@click.option("--kill", is_flag=True, help="主观判死：加速降级")
@click.option("--gist", help="修正释义")
@click.option("--revive", is_flag=True, help="fading/tombstone → active 复活")
@click.option("--reason", default="", help="动作理由（进审计日志）")
@click.option("--source", type=click.Choice(["surf", "lookup", "note", "edit"]), default="edit",
              help="洞察来源（进审计日志）")
@pass_ctx
def edit(ctx: Ctx, mid: str, variant: tuple[str, ...], drift: str | None, promote: bool,
         kill: bool, gist: str | None, revive: bool, reason: str, source: str):
    """修订词条：变体 / drift / 升降格 / 释义 / 复活。全部动作强制记审计。"""
    from . import audit, lifecycle
    from .induct.compile_matcher import validate_and_compile
    from .models import DriftEntry

    m = entries.resolve(ctx.conn, mid)
    if m is None:
        raise not_found(mid, _nearby(ctx, mid))
    actions = []
    if variant:
        for v in variant:
            if v not in m.aliases:
                m.aliases.append(v)
        if m.matcher:
            for p in m.matcher.patterns:
                if p.kind == "lex":
                    p.terms = list(dict.fromkeys(p.terms + list(variant)))
        try:
            if m.matcher:
                m.matcher = validate_and_compile(m.matcher)
        except ValueError as e:
            actions.append(f"⚠ matcher 校验失败保持原样：{e}")
        audit.record(ctx.conn, m.id, "edit_variant", source, {"variants": list(variant), "reason": reason})
        actions.append(f"变体收编：{'、'.join(variant)}")
    if drift:
        period, _, change = drift.partition(":")
        m.drift.append(DriftEntry(period=period.strip(), change=change.strip(), evidence=None))
        audit.record(ctx.conn, m.id, "edit_drift", source, {"drift": drift, "reason": reason})
        actions.append(f"drift 追加：{period.strip()} → {change.strip()}")
    if promote:
        lifecycle.promote(ctx.conn, m, source, reason)
        actions.append("已升格 active")
    if kill:
        lifecycle.kill(ctx.conn, m, source, reason)
        actions.append("已判死（加速降级 fading）")
    if revive:
        lifecycle.revive(ctx.conn, m, source, reason)
        actions.append("已复活（先给最小卡，确认后恢复完整卡）")
    if gist:
        m.card.gist = gist
        audit.record(ctx.conn, m.id, "edit_gist", source, {"gist": gist, "reason": reason})
        actions.append("释义已修正")
    if not actions:
        raise MemeError("MEME_EDIT_NO_ACTION", "未指定任何编辑动作",
                        suggestion="用 --variant/--drift/--promote/--kill/--gist/--revive 之一。")
    entries.save(ctx.conn, m)
    card_text, card_dict = cards.card(m)
    output.emit("edit", {"id": m.id, "actions": actions, "card": card_dict}, ctx.json,
                "\n".join(actions) + "\n" + card_text)


# ---------------- lookup ----------------

@cli.command(epilog="""示例：
  meme lookup "这就是典中典吧"
  meme lookup "急了急了"
  meme lookup "你说得对" --ctx "上句：华强买瓜什么水平" --ctx "本句：你说得对"   # 交互梗需会话上下文
命中即附玩梗卡（释义+用法+禁忌）——一次调用即可接梗，无需再 show。
无命中是合法答案（不是错误），会建议 add --ctx 收录。""")
@click.argument("text")
@click.option("--ctx", "ctx_lines", multiple=True, help="会话上下文行（交互梗需要，可多次）")
@click.option("--bare", is_flag=True, help="精简输出：只列命中不附卡片（批量扫描用）")
@pass_ctx
def lookup(ctx: Ctx, text: str, ctx_lines: tuple[str, ...], bare: bool):
    """识别一段文本中的梗（命中 span + 分层置信度 + 玩梗卡，全本地毫秒级）。"""
    from . import entries as _entries
    from .match.pipeline import lookup as do_lookup

    # 交互梗（tier 3）匹配对象是"最后一行"——待查文本必须作为会话末行参与匹配，
    # --ctx 只提供上文；否则 response 会去匹配 ctx 行，span/excerpt 指向错误文本
    lines = [t for t in ctx_lines if t] + [text]
    hits = do_lookup(ctx.conn, text, lines,
                     vector_threshold=ctx.cfg.retrieval.vector_threshold,
                     embedder=Embedder.get(ctx.cfg.retrieval.embed_model))
    if hits:
        payload_hits = []
        human_lines = []
        for h in hits:
            d = h.to_dict()
            line = (f"✓ {h.meme_id} {h.name} [{h.confidence:.2f} {h.method}]"
                    f" span {h.start}-{h.end} \"{h.excerpt[:24]}\"")
            m = _entries.get(ctx.conn, h.meme_id)
            if m is not None and not bare:
                # 玩梗卡内联：释义 + 前两条用法 + 禁忌（agent 拿到即可接梗）
                card = {
                    "gist": m.card.gist,
                    "usage": m.card.usage[:2],
                    "taboo": m.card.taboo,
                    "aggression": m.card.aggression,
                    "register": m.card.register,
                    "state": m.state,
                }
                d["card"] = card
                line += f"\n    {m.card.gist}"
                for u in m.card.usage[:2]:
                    line += f"\n    · {u}"
                if m.card.taboo:
                    line += f"\n    忌：{m.card.taboo}"
                if m.state == "observing":
                    line += "\n    [observing] 表达使用前先核对"
            payload_hits.append(d)
            human_lines.append(line)
        human = "\n".join(human_lines)
        if any(h.tier == 4 for h in hits):
            human += "\n（含低置信向量命中，建议 show 核对）"
        payload = {"result": "hit", "hits": payload_hits}
    else:
        human = "未知：未识别出已知梗。"
        payload = {"result": "miss",
                   "hits": [],
                   "nearby": _nearby(ctx, text),
                   "suggestion": f"可先 `meme add \"{text[:20]}\" --ctx <出处>` 记一笔（observing 入库）。"}
        human += f"\n建议：{payload['suggestion']}"
    output.emit("lookup", payload, ctx.json, human)  # miss 也是成功（§5.2 第 4 条）


# ---------------- search ----------------

@cli.command(epilog="""示例：
  meme search "书名号讽刺"
  meme search "那个一眼鉴定的梗" --top 3
  meme search "华强" --all          # 包含已归档（tombstone）词条""")
@click.argument("query")
@click.option("--top", type=int, default=None, help="返回条数（默认取配置 8）")
@click.option("--all", "all_", is_flag=True, help="包含归档区词条")
@pass_ctx
def search(ctx: Ctx, query: str, top: int | None, all_: bool):
    """模糊回忆式检索：BM25 + 例句级向量混合（"那个……的梗"式查找）。"""
    from .retrieve.fuse import hybrid_search

    results = hybrid_search(ctx.conn, query, ctx.cfg, top=top, include_archived=all_)
    if not results:
        payload = {"result": "empty", "results": [],
                   "suggestion": "词库可能尚小或该梗未入库：`meme surf` 策展采集，或 `meme add --ctx` 直接收录。"}
        output.emit("search", payload, ctx.json,
                    "无结果：词库中未找到相近词条。\n建议：" + payload["suggestion"])
        return
    human = "\n".join(r["brief"] for r in results)
    payload = {"result": "ok", "query": query,
               "results": [{"id": r["meme"].id, "name": r["meme"].name,
                            "class": r["meme"].class_, "gist": r["meme"].card.gist,
                            "state": r["meme"].state, "score": r["score"]} for r in results]}
    output.emit("search", payload, ctx.json, human)


# ---------------- show ----------------

@cli.command(epilog="""示例：
  meme show m_0042              默认 card（约 100 token，最常用）
  meme show 典 --brief          一行摘要
  meme show m_0042 --full       词源、drift、审计全量""")
@click.argument("ref")
@click.option("--brief", "level", flag_value="brief", help="一行摘要")
@click.option("--card", "level", flag_value="card", default=True, help="知识卡（默认）")
@click.option("--full", "level", flag_value="full", help="全量信息")
@pass_ctx
def show(ctx: Ctx, ref: str, level: str | None):
    """词条分级输出（brief / card / full）。ID 与名字/别名均可解析。"""
    m = entries.resolve(ctx.conn, ref)
    if m is None:
        raise not_found(ref, _nearby(ctx, ref))
    level = level or ctx.cfg.retrieval.default_level
    m = entries.confirm_revival(ctx.conn, m, level)  # 复活确认流（领域层）
    if level == "brief":
        text, d = cards.brief(m)
    elif level == "full":
        text, d = cards.full(m, ctx.conn)
    else:
        text, d = cards.card(m)
    output.emit("show", {"level": level, "meme": d}, ctx.json, text)


# ---------------- note ----------------

@cli.group(name="note", epilog="""示例：
  meme note add m_0042 "疑似新变体，待验证"      # 词条附着笔记
  meme note add --head "急孝" "只在直播区见过"   # 悬挂笔记（词条未建时保住线索）
  meme note list m_0042                          # 按词条列出
  meme note rm 3                                 # 删除""")
@click.pass_context
def note(ctx):
    """笔记增删改查：低信任私有附着物，永不进入 matcher 与 card。"""
    pass


@note.command(name="add", epilog="""示例：
  meme note add m_0042 "疑似与某综艺节目联动，待验证"
  meme note add --head "急孝" "只在直播区见过，等证据"    # 无词条时挂 head
  meme note list m_0042""")
@click.argument("ref", required=False)
@click.argument("content", required=False)
@click.option("--head", help="悬挂笔记的词头（词条尚不存在时用）")
@pass_ctx
def note_add(ctx: Ctx, ref: str | None, content: str | None, head: str | None):
    """添加笔记：meme note add <id|名> "内容"，或 --head 挂悬挂笔记。"""
    if head and ref and not content:
        # `note add --head X "内容"` 只有一个位置参数时绑的是 content
        ref, content = None, ref
    if not content:
        raise MemeError("MEME_NOTE_USAGE", "note add 需要 <id|名> 与 \"内容\"",
                        suggestion='示例：meme note add m_0042 "观察记录"')
    meme_id = None
    if ref:
        m = entries.resolve(ctx.conn, ref)
        if m is None:
            raise not_found(ref, _nearby(ctx, ref))
        meme_id = m.id
    nid = notes.add(ctx.conn, content, meme_id=meme_id, head=head)
    output.emit("note", {"action": "add", "note_id": nid, "meme_id": meme_id, "head": head,
                         "content": content}, ctx.json,
                f"已记 #{nid}" + (f"（{meme_id}）" if meme_id else ""))


@note.command(name="list")
@click.argument("ref", required=False)
@pass_ctx
def note_list(ctx: Ctx, ref: str | None):
    """列出笔记（可按词条过滤）。"""
    meme_id = None
    if ref:
        m = entries.resolve(ctx.conn, ref)
        if m is None:
            raise not_found(ref, _nearby(ctx, ref))
        meme_id = m.id
    items = notes.list_notes(ctx.conn, meme_id)
    human = "\n".join(f"#{n['id']} [{n['meme_id'] or n['head'] or '-'}] {n['content']}"
                      for n in items) or "（无笔记）"
    output.emit("note", {"action": "list", "notes": items}, ctx.json, human)


@note.command(name="show")
@click.argument("note_id", type=int)
@pass_ctx
def note_show(ctx: Ctx, note_id: int):
    """查看单条笔记。"""
    n = notes.get(ctx.conn, note_id)
    if n is None:
        raise MemeError("MEME_NOTE_NOT_FOUND", f"笔记 #{note_id} 不存在")
    output.emit("note", {"action": "show", "note": n}, ctx.json,
                f"#{n['id']} [{n['meme_id'] or n['head'] or '-'}]\n{n['content']}")


@note.command(name="edit")
@click.argument("note_id", type=int)
@click.argument("content")
@pass_ctx
def note_edit(ctx: Ctx, note_id: int, content: str):
    """修改笔记内容。"""
    if not notes.update(ctx.conn, note_id, content):
        raise MemeError("MEME_NOTE_NOT_FOUND", f"笔记 #{note_id} 不存在")
    output.emit("note", {"action": "edit", "note_id": note_id}, ctx.json, f"已改 #{note_id}")


@note.command(name="rm")
@click.argument("note_id", type=int)
@pass_ctx
def note_rm(ctx: Ctx, note_id: int):
    """删除笔记。"""
    if not notes.delete(ctx.conn, note_id):
        raise MemeError("MEME_NOTE_NOT_FOUND", f"笔记 #{note_id} 不存在")
    output.emit("note", {"action": "rm", "note_id": note_id}, ctx.json, f"已删 #{note_id}")


# ---------------- schema ----------------

@cli.command(epilog="""示例：
  meme schema                    完整 schema 文档 + 可抄的最小 entry 示例
  meme schema --json             机器可读 schema（字段/类型/必填）""")
@click.option("--json", "as_json", is_flag=True, help="输出机器可读 schema")
@pass_ctx
def schema(ctx: Ctx, as_json: bool):
    """entry JSON 的字段文档（add --entry / iterate --entry 用）+ 可抄示例。

    subagent 实战反馈：schema 曾只能靠示例文件考古——现在 help 即文档。
    """
    from .induct import prompts

    example = {
        "name": "我软脚了",
        "aliases": ["软脚了"],
        "class": "word",
        "birth_circa": "2024",
        "card": {"gist": "一句话释义（≤60字）", "usage": ["典型用法短句 2-3 条"],
                 "taboo": "翻车场景（可 null）", "register": "圈层（可 null）",
                 "aggression": "低|中|高"},
        "examples": ["代表例句 3-5 条"],
        "matcher": {
            "patterns": [
                {"kind": "lex", "terms": ["字面词", "别名"]},
                {"kind": "skeleton", "tokens": ["一眼", "<ent>", "鉴定为", "<ent>"]},
                {"kind": "interaction", "trigger_terms": ["上句特征词"],
                 "response_terms": ["回应句特征词"],
                 "trigger_tokens": [], "response_tokens": []},
            ],
            "constraints": {"standalone": False, "sentence_final": False,
                            "forbid_inner": False, "forbid_context": [], "require_context": []},
        },
        "lineage_parent": None,
        "lineage_mutation": None,
        "notes": "不确定点自述（进审计不进卡）",
    }
    if as_json:
        output.emit("schema", {"schema_doc": prompts.SCHEMA_DOC, "example": example},
                    True, prompts.SCHEMA_DOC)
        return
    import json as _json

    human = prompts.SCHEMA_DOC + "\n\n## 最小可抄示例\n```json\n" + \
        _json.dumps(example, ensure_ascii=False, indent=2) + "\n```"
    output.emit("schema", {"example": example}, ctx.json, human)


# ---------------- 公共 ----------------

def _nearby(ctx: Ctx, ref: str) -> list[dict]:
    from .retrieve.fuse import hybrid_search

    try:
        rs = hybrid_search(ctx.conn, ref, ctx.cfg, top=3, include_archived=True)
        return [{"id": r["meme"].id, "name": r["meme"].name, "score": r["score"]} for r in rs]
    except Exception:  # noqa: BLE001 - 近似建议尽力而为
        return []



def main() -> None:
    cli(standalone_mode=True)


if __name__ == "__main__":
    main()
