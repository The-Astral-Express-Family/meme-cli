"""证据更新管线（§6.1 第 2 步）：纯统计、零 LLM、跨轮次累积（D3）。

五通道并进（v2 重构，教训见 exp/replay.py 基线：入榜召回 6/39、榜首全泛用词、
6 轮 720 候选触发 0）：

- phrase   短语通道（word 类）：轮内轻门槛创建 + cand_video 跨轮累积。
           真梗轮内频率低（"难绷"每轮 1-2 次）但跨轮稳定——门槛必须低到
           "轮内 2 次/2 视频"即可立户，跨轮合流靠既有候选的 1 次再现。
- copy     复读通道（v2 新增）：归一化整句跨视频重复。"梗=被复读的表达"的
           最直接证据（"警钟长鸣"×3 视频）。回复为主的复读 → interaction 预判。
- skeleton 骨架通道（formula/format）：单掩码变体跨文本坍缩。字面门槛从
           "≥2 个 token"降为"字面字符数 ≥2"——"赢麻了/亏麻了/输麻了"经功能字
           合并后是单 token "麻了"，旧门槛把 "X麻了" 公式全族拒之门外。
- image    图梗通道：pHash 跨视频聚类（重复即梗）。
- chain    一字接龙：楼中楼短消息拼接为虚拟文本，走普通通道，标记 chain。

泛用词治理从手工黑名单（三轮实战膨胀至 300+ 仍失守）改为统计判别：
GENERIC 只保留零梗义语法虚词；泛用实词（"决赛/版本/不行"）允许入榜，
由 evidence.meme_features（复读/坍缩/独立成评）在**排序与触发**层压制——
它们的用例句句不同，meme_score ≈ 0，沉底且永不触发。
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

import jieba

from .. import candidates, lake
from ..config import Config
from ..match.pipeline import vector_nearest
from ..match.vector import Embedder
from ..models import RelatedRef, UsageSample
from . import ngram
from .burst import z_score as calc_z
from .evidence import meme_features, norm_text
from .imgphash import hamming as img_hamming
from .skel import skeleton_variants

# 语法虚词核心表（零梗义争议；泛用实词不入列——交给统计判别，见模块 docstring）
GENERIC = {
    # 代词/助词/语气/介连
    "的", "了", "是", "在", "有", "没", "很", "都", "也", "就", "还", "和", "跟",
    "与", "或", "但", "被", "把", "让", "给", "对", "从", "向", "到", "着", "过",
    "吧", "呢", "吗", "呀", "哦", "嘛", "么", "哈", "嘿", "哪", "谁", "我", "你",
    "他", "她", "它", "咱", "们", "这", "那",
    # 高频虚词组合
    "没有", "不了", "这是", "还有", "起来", "好像", "之前", "的是", "是什么",
    "了吗", "了吧", "的时候", "是不是", "也是", "都是", "不会", "不能", "完全",
    "一个", "什么", "怎么", "还是", "然后", "如果", "就是", "不是", "这样", "那样",
    "真的", "可能", "应该", "其实", "确实", "现在", "时候", "知道", "觉得",
    # 评论区礼仪/灌水（v1 实战沉淀 + v2 真网轮次复核：语义明确有界的类别，
    # 非"打地鼠"——这些是 B站评论生态的固定客套，永不构成梗）
    "沙发", "前排", "第一", "打卡", "来了", "支持", "厉害", "大佬", "好活",
    "期待更新", "收藏了", "点赞", "投币", "一键三连", "三连", "关注了",
    "干货满满", "支持up", "支持up主", "做得真不错", "视频做得真不错",
    "质量很高", "质量很高收藏了", "喜欢这个系列", "继续更新", "催更",
}

MIN_OCCUR = 2  # 轮内最低出现次数（v2：3→2；跨轮累积由候选合流承担）
MIN_VIDEOS = 2  # 轮内跨视频门槛（视频内梗降一档不入队）
MAX_DF_RATIO = 0.35  # 出现在超过此比例评论中的短语视为泛用词
# 客套成分检测（subagent 实战反馈）：复读信号对礼貌性刷词（"视频做得真不错"
# 跨视频复读）同样成立，但它们永不是梗。短语分词后 ≥ETIQUETTE_RATIO 落在
# 客套词表内 → 不入榜。客套词表与 GENERIC 分开维护：GENERIC 拦语法词，
# 这里拦"成分"——含任意真内容词的短语不受影响。
ETIQUETTE_WORDS = {
    "支持", "厉害", "大佬", "好活", "期待", "更新", "收藏", "点赞", "投币",
    "三连", "一键三连", "关注", "订阅", "干货", "满满", "不错", "加油",
    "喜欢", "这个", "视频", "做的", "做得", "真不错", "高质量", "质量",
    "很高", "有趣", "用心", "辛苦", "感谢", "谢谢", "分享", "学习", "受教",
    "前排", "沙发", "打卡", "来", "催更", "继续", "下次", "一定", "有钱",
    "必赚", " Star", "star", " up", "up", "主",
}
ETIQUETTE_RATIO = 0.6
# 复读通道：归一化文本长度窗口（太短=表情/单词噪音；太长=新闻粘贴）
COPY_MIN_LEN = 4
COPY_MAX_LEN = 48
# 骨架通道门槛：变体必须复现于 ≥2 种不同文本、≥2 视频、字面字符 ≥2
SKELETON_MIN_TEXTS = 2
SK_TEXT_SAMPLE = 6
TOP_SKELS = 60
REOPEN_HEAD_LIMIT = 5000  # 既有候选合流循环的保险丝


def _head_tag(ph: str) -> str:
    """短语首 token 的词性（仅对通过前序闸门的短语调用，量级约百/轮）。"""
    import jieba.posseg as pseg

    try:
        first = next(iter(pseg.lcut(ph)), None)
        return first.flag if first is not None else "x"
    except Exception:  # noqa: BLE001
        return "x"


@dataclass
class SignalsResult:
    scanned: int = 0  # 文本单元数（真实评论 + 接龙拼接虚拟文本）
    phrase_candidates: int = 0
    skeleton_candidates: int = 0
    copy_candidates: int = 0
    image_candidates: int = 0
    triggered: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "phrase_candidates": self.phrase_candidates,
            "skeleton_candidates": self.skeleton_candidates,
            "copy_candidates": self.copy_candidates,
            "image_candidates": self.image_candidates,
            "triggered": self.triggered,
        }


def _generic_set(conn: sqlite3.Connection, cfg: Config) -> set[str]:
    """三级停用词：内置 GENERIC ∪ toml [detect].generic_extra ∪ 运行时 kv generic_auto（--ban 沉淀）；
    kv generic_allow（--allow）为豁免表。"""
    import json as _json

    from ..db import kv_get

    s = set(GENERIC)
    extra = getattr(getattr(cfg, "detect", None), "generic_extra", None) or []
    s.update(extra)
    try:
        s.update(_json.loads(kv_get(conn, "generic_auto", "[]") or "[]"))
    except _json.JSONDecodeError:
        pass
    try:
        s -= set(_json.loads(kv_get(conn, "generic_allow", "[]") or "[]"))
    except _json.JSONDecodeError:
        pass
    return s


def _bump_daily(conn: sqlite3.Connection, table: str, key: str, day: str, cnt: int, videos: int) -> None:
    conn.execute(
        f"INSERT INTO {table} VALUES(?,?,?,?) ON CONFLICT({'phrase' if table=='phrase_daily' else 'skel'},day) "
        "DO UPDATE SET cnt=cnt+excluded.cnt, videos=MAX(videos, excluded.videos)",
        (key, day, cnt, videos),
    )


def _update_related(conn: sqlite3.Connection, cand, embedder: Embedder | None, cfg: Config) -> None:
    """三级关联预计算（§6.3）：词表→same_form；骨架→derived；向量→related。"""
    from .. import entries

    rels: list[RelatedRef] = []
    memes = entries.all_memes(conn)
    head_tokens = set(cand.head.split()) if cand.channel == "skeleton" else {cand.head}
    for m in memes:
        if m.state == "tombstone":
            continue
        if cand.channel in ("phrase", "copy"):
            for t in m.terms:
                if t == cand.head:
                    rels.append(RelatedRef(id=m.id, type="same_form", score=0.95)); break
                if len(t) >= 1 and len(cand.head) >= 2 and t in cand.head:
                    rels.append(RelatedRef(id=m.id, type="same_form", score=0.8)); break
                if len(cand.head) >= 1 and len(t) >= 2 and cand.head in t:
                    rels.append(RelatedRef(id=m.id, type="same_form", score=0.8)); break
        else:
            if m.matcher is None:
                continue
            for p in m.matcher.patterns:
                lits = {t for t in (p.tokens or []) if not t.startswith("<")}
                if lits and head_tokens and (len(lits & head_tokens) / max(len(lits | head_tokens), 1)) >= 0.5:
                    rels.append(RelatedRef(id=m.id, type="derived", score=0.7)); break
    if embedder is not None and embedder.available and cand.evidence_usages:
        text = cand.evidence_usages[-1].text
        for mid, score in vector_nearest(conn, text, embedder, topk=3):
            if score >= 0.55 and all(r.id != mid for r in rels):
                rels.append(RelatedRef(id=mid, type="related", score=round(score, 3)))
    cand.related = [r.model_dump() for r in rels[:5]]


def _refresh_z(conn: sqlite3.Connection, cand) -> None:
    table = "phrase_daily" if cand.channel in ("phrase", "copy") else "skel_daily"
    col = "phrase" if cand.channel in ("phrase", "copy") else "skel"
    z, _ = calc_z(conn, table, col, cand.head)
    cand.z_score = z


def _collect_units(comments: list) -> list[dict]:
    """文本单元：真实评论 + 楼中楼短消息拼接（接龙的优雅实现，D8）。"""
    units: list[dict] = []
    for c in comments:
        msg = c["message"]
        if not msg:
            continue
        units.append({"text": msg, "aid": c["oid"], "rpid": c["rpid"], "root": c["root"],
                      "parent": c["parent"], "mid": c["mid"], "ctime": c["ctime"], "chain": False})
    by_root: dict[int, list] = defaultdict(list)
    for c in comments:
        if c["root"]:
            by_root[c["root"]].append(c)
    CHAIN_MIN_RUN = 2  # 连续 ≥2 条短消息即拼接
    for sibs in by_root.values():
        sibs.sort(key=lambda c: c["ctime"])
        runs, run = [], []
        for c in sibs:
            if 0 < len(c["message"].strip()) <= 2:
                run.append(c)
            else:
                if len(run) >= CHAIN_MIN_RUN:
                    runs.append(run)
                run = []
        if len(run) >= CHAIN_MIN_RUN:
            runs.append(run)
        for run in runs:
            units.append({"text": "".join(c["message"].strip() for c in run),
                          "aid": run[0]["oid"], "rpid": run[0]["rpid"], "root": run[0]["root"],
                          "parent": run[0]["parent"], "mid": run[-1]["mid"],
                          "ctime": run[-1]["ctime"], "chain": True})
    return units


def update_signals(conn: sqlite3.Connection, cfg: Config, round_id: int) -> SignalsResult:
    res = SignalsResult()
    comments = lake.comments_for_round(conn, round_id)
    if not comments:
        return res
    units = _collect_units(comments)
    res.scanned = len(units)
    day = date.today().isoformat()
    up_map = lake.up_mid_map(conn)
    embedder = Embedder.get(cfg.retrieval.embed_model)

    # ---- 短语通道：轮内轻门槛立户 + 既有候选 1 次再现即合流 ----
    ph_cnt: dict[str, int] = defaultdict(int)
    ph_videos: dict[str, set[int]] = defaultdict(set)
    ph_docs: dict[str, set[int]] = defaultdict(set)
    per_comment: list[tuple[dict, list[str]]] = []  # 分词一次，多处复用
    for u in units:
        msg = u["text"]
        msg_phrases = ngram.phrases(msg)
        per_comment.append((u, msg_phrases))
        for ph in msg_phrases:
            ph_cnt[ph] += 1
            ph_videos[ph].add(u["aid"])
            ph_docs[ph].add(u["rpid"])
    n = len(units)
    generic = _generic_set(conn, cfg)
    use_df_filter = n >= 50

    def _admitted(p: str) -> bool:
        """结构性入榜判定：≥3 字豁免（长短语自选择性强）；≤2 字需要内容头或高频低 df。"""
        if len(p) >= 3:
            if not (ngram._is_content(_head_tag(p)) or ph_cnt[p] >= 3):
                return False
        elif not (ngram._is_content(_head_tag(p)) and ph_cnt[p] >= MIN_OCCUR):
            return False
        # 客套成分检测：纯客套组合（支持up主/视频做得真不错）复读再多也不是梗
        toks = [t for t in jieba.lcut(p) if t.strip()]
        if toks and sum(1 for t in toks if t in ETIQUETTE_WORDS) / len(toks) >= ETIQUETTE_RATIO:
            return False
        return True

    base = [
        p for p in ph_cnt
        if ph_cnt[p] >= MIN_OCCUR
        and len(ph_videos[p]) >= MIN_VIDEOS
        and p not in generic
        and (not use_df_filter or len(ph_docs[p]) / n <= MAX_DF_RATIO)
        and _admitted(p)
    ]
    # 注：不做同句 gram 折叠——复读句的子 gram（"哥操作/操作干净"）会入榜，
    # 但 head 感知的证据评分（copy_pairs 只算近似独立成评的复读）使它们
    # meme_score ≈ 0 自然沉底；折叠曾误杀"绷"（叠用句）与"灵笼第二季"（子短语）。
    ranked_set = set(base)
    ph_usages: dict[str, list[UsageSample]] = defaultdict(list)
    for u, msg_phrases in per_comment:
        for ph in msg_phrases:
            if ph in ranked_set and len(ph_usages[ph]) < 6:
                ph_usages[ph].append(
                    UsageSample(text=u["text"], aid=u["aid"], rpid=u["rpid"], root=u["root"],
                                parent=u["parent"], mid=u["mid"], ctime=u["ctime"],
                                chain=u["chain"])
                )
    for ph in base:
        cand = candidates.upsert_from_signal(
            conn, head=ph, channel="phrase", kind_guess="word", usages=ph_usages.get(ph, []),
            video_pairs=[(aid, up_map.get(aid, 0)) for aid in ph_videos[ph]], day=day,
            round_id=round_id,
        )
        _refresh_z(conn, cand)
        _update_related(conn, cand, embedder, cfg)
        candidates.save(conn, cand)
        res.phrase_candidates += 1
    # 短语总账：全部 cnt≥1 短语进日聚合（后缀家族检测的账本——族员常单轮低频，
    # 不入榜也要留痕，否则 "X麻了" 家族永远凑不齐 3 人）
    for ph, cnt in ph_cnt.items():
        _bump_daily(conn, "phrase_daily", ph, day, cnt, len(ph_videos[ph]))
    # 既有候选本轮再现（1 次即合流：跨轮累积的另一半，v2 核心修复）
    seen_heads = set(base)
    existing = candidates.all_active(conn)
    existing_by_head = {(c.head, c.channel): c for c in existing}
    for u, msg_phrases in per_comment:
        for ph in msg_phrases:
            key = (ph, "phrase")
            if ph in seen_heads or key not in existing_by_head or ph in generic:
                continue
            cand = existing_by_head[key]
            if cand.last_round == round_id:
                continue
            candidates.upsert_from_signal(
                conn, head=ph, channel="phrase", kind_guess=cand.kind_guess,
                usages=[UsageSample(text=u["text"], aid=u["aid"], rpid=u["rpid"],
                                    root=u["root"], parent=u["parent"], mid=u["mid"],
                                    ctime=u["ctime"], chain=u["chain"])],
                video_pairs=[(u["aid"], up_map.get(u["aid"], 0))], day=day, round_id=round_id,
            )
            seen_heads.add(ph)
        if len(seen_heads) > REOPEN_HEAD_LIMIT:
            break

    # ---- 后缀能产性合成：赢麻了/亏麻了/输麻了 各自 dv 低，但同后缀家族是
    # 形态学能产性信号（X麻了/X哭了/X完了）——合成 "<X>后缀" 公式候选，
    # 让归纳器一次看到全族证据（否则只看单个变体，首轮归纳必错一半）。
    # 族员检测跨轮：当前轮 ph_cnt ∪ 历史 phrase_daily 头（族员常分散在各轮）。
    # 闸门：≥3 个族员、家族累计 dv≥4、后缀用例以句尾/独立收束为主
    # （"X麻了"常收尾，"X时候"常在句中——后者不是梗公式）。
    SUFFIX_MIN_FAMILY = 3
    SUFFIX_MIN_CROSS_MEMBERS = 2  # 族内自身跨视频（SUM(videos)≥2）的成员数下限
    # 第一步：从总账（本轮全量 + phrase_daily 历史）收集各后缀的族员
    fam_by_suf: dict[str, set[str]] = defaultdict(set)
    vids_by_phrase: dict[str, int] = defaultdict(int)
    for p in ph_cnt:
        if len(p) >= 3:
            fam_by_suf[p[-2:]].add(p)
    for r in conn.execute(
        "SELECT phrase, SUM(videos) v FROM phrase_daily GROUP BY phrase"
    ):
        p = r["phrase"]
        if len(p) >= 3 and "<" not in p:
            fam_by_suf[p[-2:]].add(p)
            vids_by_phrase[p] += int(r["v"])
    for p, vids in ph_videos.items():
        if p in fam_by_suf.get(p[-2:], set()):
            vids_by_phrase[p] = max(vids_by_phrase.get(p, 0), len(vids))

    def _family_fires(suf: str) -> bool:
        fam = fam_by_suf.get(suf, set())
        if len(fam) < SUFFIX_MIN_FAMILY:
            return False
        # X 短（≤2 字）：族员长度贴近后缀本身，长族员是普通宾语搭配不是公式
        if not any(len(p) <= len(suf) + 2 for p in fam):
            return False
        cross = sum(1 for p in fam if vids_by_phrase.get(p, 0) >= MIN_VIDEOS)
        return cross >= SUFFIX_MIN_CROSS_MEMBERS

    firing = {s for s in fam_by_suf if _family_fires(s)}
    # 第二步：单遍重扫本轮文本，为触发家族收集用例（避免每后缀全量重扫）
    fam_usages_by_suf: dict[str, list[UsageSample]] = defaultdict(list)
    end_final_by_suf: dict[str, int] = defaultdict(int)
    fam_phrase_set = {p for s in firing for p in fam_by_suf[s]}
    for u, msg_phrases in per_comment:
        hit_sufs = {p[-2:] for p in msg_phrases if p in fam_phrase_set}
        if not hit_sufs:
            continue
        sample = UsageSample(text=u["text"], aid=u["aid"], rpid=u["rpid"], root=u["root"],
                             parent=u["parent"], mid=u["mid"], ctime=u["ctime"],
                             chain=u["chain"])
        tail = u["text"].rstrip()[-3:]
        for suf in hit_sufs:
            fam_usages_by_suf[suf].append(sample)
            if tail.endswith(suf) or tail.endswith(suf + "。") or tail.endswith(suf + "！"):
                end_final_by_suf[suf] += 1
    # 第三步：过闸的家族合成 "<X>后缀" 公式候选
    for suf in sorted(firing):
        fam = fam_by_suf[suf]
        fam_usages = fam_usages_by_suf.get(suf, [])
        end_final = end_final_by_suf.get(suf, 0)
        all_vids: set[int] = set()
        for p in fam:
            all_vids |= ph_videos.get(p, set())
        if not fam_usages or end_final / len(fam_usages) < 0.5:
            continue
        head = f"<X>{suf}"
        cand = candidates.upsert_from_signal(
            conn, head=head, channel="skeleton", kind_guess="formula",
            usages=fam_usages[:6],
            video_pairs=[(aid, up_map.get(aid, 0)) for aid in all_vids], day=day,
            round_id=round_id,
        )
        _bump_daily(conn, "skel_daily", head, day, len(fam_usages), len(all_vids))
        _refresh_z(conn, cand)
        _update_related(conn, cand, embedder, cfg)
        candidates.save(conn, cand)
        res.skeleton_candidates += 1

    # ---- 复读通道：归一化整句跨视频重复（"梗=被复读"的最直接证据）----
    copy_groups: dict[str, list[dict]] = defaultdict(list)
    for u in units:
        k = norm_text(u["text"])
        if COPY_MIN_LEN <= len(k) <= COPY_MAX_LEN:
            copy_groups[k].append(u)
    for k, us in copy_groups.items():
        vids = {u["aid"] for u in us}
        if len(vids) < MIN_VIDEOS or len(us) < MIN_OCCUR:
            continue
        # 客套整句复读（"视频做得真不错"跨视频粘贴）不是梗：成分检测拦截
        toks = [t for t in jieba.lcut(k) if t.strip()]
        if toks and sum(1 for t in toks if t in ETIQUETTE_WORDS) / len(toks) >= ETIQUETTE_RATIO:
            continue
        # 回复为主的复读 → 交互梗预判（楼中楼对就是 interaction 证据）
        reply_ratio = sum(1 for u in us if u["parent"]) / len(us)
        kind_guess = "interaction" if reply_ratio >= 0.5 else "word"
        # 同头 phrase 候选已存在 → 复读证据并入该候选（不另立户）；
        # 回复为主的复读把 kind_guess 升级为 interaction（楼中楼对是配对证据）
        head = k[:24]
        channel = "copy"
        row = conn.execute(
            "SELECT kind_guess FROM candidates WHERE head=? AND channel='phrase' "
            "AND state IN ('pending','triggered')", (head,)
        ).fetchone()
        if row is not None:
            channel = "phrase"
            if kind_guess == "word":
                kind_guess = row["kind_guess"]
        cand = candidates.upsert_from_signal(
            conn, head=head, channel=channel, kind_guess=kind_guess,
            usages=[UsageSample(text=u["text"], aid=u["aid"], rpid=u["rpid"], root=u["root"],
                                parent=u["parent"], mid=u["mid"], ctime=u["ctime"],
                                chain=u["chain"]) for u in us[:6]],
            video_pairs=[(aid, up_map.get(aid, 0)) for aid in vids], day=day, round_id=round_id,
        )
        _bump_daily(conn, "phrase_daily", k[:24], day, len(us), len(vids))
        _refresh_z(conn, cand)
        _update_related(conn, cand, embedder, cfg)
        candidates.save(conn, cand)
        res.copy_candidates += 1

    # ---- 骨架通道 ----
    sk_cnt: dict[str, int] = defaultdict(int)
    sk_videos: dict[str, set[int]] = defaultdict(set)
    sk_texts: dict[str, set[str]] = defaultdict(set)  # 出现过的不同文本（复制粘贴判别）
    sk_usages: dict[str, list[UsageSample]] = defaultdict(list)
    for u in units:
        msg = u["text"]
        if not msg:
            continue
        for sk in skeleton_variants(msg):
            sk_cnt[sk] += 1
            sk_videos[sk].add(u["aid"])
            if len(sk_texts[sk]) < SK_TEXT_SAMPLE:
                sk_texts[sk].add(msg)
            sk_usages[sk].append(UsageSample(text=msg, aid=u["aid"], rpid=u["rpid"],
                                             root=u["root"], parent=u["parent"], mid=u["mid"],
                                             ctime=u["ctime"], chain=u["chain"]))

    def _literal_chars(s: str) -> int:
        return sum(len(t) for t in s.split() if not t.startswith("<"))

    sk_ranked = sorted(
        (s for s in sk_cnt
         if len(sk_texts[s]) >= SKELETON_MIN_TEXTS and len(sk_videos[s]) >= MIN_VIDEOS
         and _literal_chars(s) >= 2),
        key=lambda s: -sk_cnt[s],
    )[:TOP_SKELS]
    for sk in sk_ranked:
        kind = "format" if ("《" in sk or "》" in sk) else "formula"
        cand = candidates.upsert_from_signal(
            conn, head=sk, channel="skeleton", kind_guess=kind,
            usages=sk_usages[sk][:6],
            video_pairs=[(aid, up_map.get(aid, 0)) for aid in sk_videos[sk]], day=day,
            round_id=round_id,
        )
        _bump_daily(conn, "skel_daily", sk, day, sk_cnt[sk], len(sk_videos[sk]))
        _refresh_z(conn, cand)
        _update_related(conn, cand, embedder, cfg)
        candidates.save(conn, cand)
        res.skeleton_candidates += 1

    # ---- 图片通道（重复即梗）：pHash 汉明聚类，复现的图 → image 候选 ----
    IMG_HAMMING_MAX = 8
    new_imgs = conn.execute(
        "SELECT i.rpid, i.url, i.phash, c.oid, c.mid, c.ctime FROM lake_comment_images i "
        "JOIN lake_comments c ON c.rpid=i.rpid WHERE i.round_id=? AND i.phash IS NOT NULL",
        (round_id,),
    ).fetchall()
    if new_imgs:
        reps: list[tuple[str, str]] = []
        for r in conn.execute("SELECT head FROM candidates WHERE channel='image'"):
            h = r["head"].removeprefix("img:")
            if h:
                reps.append((r["head"], h))
        for im in new_imgs:
            ph = im["phash"]
            match_head = next(
                (head for head, h in reps if img_hamming(ph, h) <= IMG_HAMMING_MAX), None
            )
            if match_head is None:
                match_head = f"img:{ph}"
                reps.append((match_head, ph))
            cand = candidates.upsert_from_signal(
                conn, head=match_head, channel="image", kind_guess="word",
                usages=[UsageSample(text=f"[图片] {im['url']}", aid=im["oid"], rpid=im["rpid"],
                                    mid=im["mid"], ctime=im["ctime"])],
                video_pairs=[(im["oid"], up_map.get(im["oid"], 0))], day=day,
                round_id=round_id,
            )
            _update_related(conn, cand, embedder, cfg)
            candidates.save(conn, cand)
            res.image_candidates += 1

    conn.commit()
    return res
