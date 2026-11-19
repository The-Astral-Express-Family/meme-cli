"""图片感知哈希（pHash）：图梗发现的纯本地基座（§11 激进缓存）。

发现端不需要图片理解模型——梗图的本质是"跨视频复现"，
64-bit pHash + 汉明距离足以把同源梗图/其加字变体聚成一簇；
理解端（这张图在表达什么）留给 write path 归纳时的多模态 LLM。
"""

from __future__ import annotations

import io

_DCT_N = 32
_M = None  # 懒构建 DCT 矩阵（进程级）


def _dct_matrix(n: int):
    import numpy as np

    global _M
    if _M is not None and _M.shape[0] == n:
        return _M
    k = np.arange(n).reshape(-1, 1)
    i = np.arange(n).reshape(1, -1)
    m = np.cos(np.pi * (2 * i + 1) * k / (2 * n)) * np.sqrt(2.0 / n)
    m[0, :] = np.sqrt(1.0 / n)  # k=0 行正交归一
    _M = m
    return _M


def phash_bytes(data: bytes) -> str | None:
    """图片字节 → 64-bit pHash（16 位 hex）。解析失败返回 None（含动图取首帧由 PIL 处理）。"""
    try:
        from PIL import Image

        import numpy as np

        im = Image.open(io.BytesIO(data))
        im = im.convert("L").resize((_DCT_N, _DCT_N))
        a = np.asarray(im, dtype=np.float64)
        d = _dct_matrix(_DCT_N)
        f = d @ a @ d.T
        block = f[1:9, 1:9].flatten()  # 低频 8x8，去直流
        med = float(np.median(block))
        v = 0
        for x in block:
            v = (v << 1) | (1 if x > med else 0)
        return f"{v:016x}"
    except Exception:  # noqa: BLE001 - 坏图/不支持的格式：跳过不致命
        return None


def hamming(h1: str, h2: str) -> int:
    """两个 pHash hex 的汉明距离。"""
    try:
        return bin(int(h1, 16) ^ int(h2, 16)).count("1")
    except ValueError:
        return 64
