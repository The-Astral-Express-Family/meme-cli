"""向量层：本地 ONNX 小模型（fastembed，无 torch 级依赖，§12.2）+ 暴力余弦。

模型不可用（离线/下载失败）时优雅降级为纯词法，向量层返回不可用标记。
"""

from __future__ import annotations

import sys

import numpy as np


class Embedder:
    """进程级单例。首次 embed 时懒加载模型。"""

    _inst: "Embedder | None" = None
    _warned = False

    def __init__(self, model_name: str):
        self.model_name = model_name
        self._model = None
        self._failed = False

    @classmethod
    def get(cls, model_name: str = "BAAI/bge-small-zh-v1.5") -> "Embedder":
        if cls._inst is None:
            cls._inst = Embedder(model_name)
        return cls._inst

    @property
    def available(self) -> bool:
        return not self._failed and self._load()

    def _load(self) -> bool:
        if self._model is not None:
            return True
        if self._failed:
            return False
        try:
            from fastembed import TextEmbedding

            self._model = TextEmbedding(model_name=self.model_name)
            return True
        except Exception as e:  # noqa: BLE001 - 下载失败/无网络/依赖缺失一律降级
            self._failed = True
            if not Embedder._warned:
                Embedder._warned = True
                print(
                    f"meme: 向量模型不可用（{type(e).__name__}），向量层降级为纯词法检索",
                    file=sys.stderr,
                )
            return False

    def embed(self, texts: list[str]) -> np.ndarray | None:
        """返回 L2 归一化的 (n, dim) 矩阵；不可用时返回 None。"""
        if not texts:
            return np.zeros((0, 1), dtype=np.float32)
        if not self.available:
            return None
        try:
            vecs = np.array(list(self._model.embed(texts)), dtype=np.float32)
        except Exception:  # noqa: BLE001
            self._failed = True
            return None
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return vecs / norms
