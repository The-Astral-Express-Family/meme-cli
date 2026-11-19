"""骨架归一化与单槽掩码变体（D5）。"""

from meme.detect.skel import normalize, skeleton_hash, skeleton_variants


def test_slots_normalized():
    toks = normalize("这有 3 个 [doge] 和 https://b23.tv/abc 以及 @某人 的链接")
    assert "<num>" in toks
    assert "<emo>" in toks
    assert "<url>" in toks
    assert "<at>" in toks


def test_skeleton_variant_collapses_entities():
    a = skeleton_variants("一眼原神鉴定为云玩家")
    b = skeleton_variants("一眼华为鉴定为遥遥领先")
    # 成对槽掩码后两条文本坍缩到同一骨架（功能字"为"已并入后随槽）
    shared = set(a) & set(b)
    assert any("一眼" in s and "鉴定" in s and "<ent>" in s for s in shared)


def test_skeleton_hash_stable():
    assert skeleton_hash("一眼 <ent> 鉴定为 <ent>") == skeleton_hash("一眼 <ent> 鉴定为 <ent>")


def test_spanned_offsets_cover_text():
    from meme.detect.skel import normalize_spanned

    text = "一眼原神，鉴定为 3a 玩家"
    spanned = normalize_spanned(text)
    for tok, s, e in spanned:
        if not tok.startswith("<"):
            assert text[s:e] == tok


def test_ngram_phrases_filters_punct_and_funcwords():
    from meme.detect.ngram import phrases

    out = phrases("这个视频真的太好笑了，泪目")
    assert "太好笑" in out or "太好笑了" in out or any("笑" in p for p in out)
    assert all("，" not in p for p in out)
