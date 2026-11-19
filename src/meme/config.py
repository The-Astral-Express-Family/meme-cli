"""配置：内置默认值 + meme.toml 覆盖 + 环境变量（§12.3）。

默认值均为设计文档标注的"可配置建议值"；O2/O3/O4 项待首周实测校准。
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_NAME = "meme.toml"
ENV_DB = "MEME_DB"
ENV_CONFIG = "MEME_CONFIG"
# DSH 生态环境变量约定（与 deepseek-harness 适配器一致）
ENV_API_KEY = "DEEPSEEK_API_KEY"
ENV_BASE_URL = "DEEPSEEK_BASE_URL"
DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic"


def _load_dotenv() -> None:
    """轻量 .env 支持：cwd → 包仓库根 → ~/.meme/。已存在的环境变量不覆盖。"""
    for p in (Path.cwd() / ".env",
              Path(__file__).resolve().parents[2] / ".env",
              Path.home() / ".meme" / ".env"):
        try:
            if not p.is_file():
                continue
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and v and k not in os.environ:
                    os.environ[k] = v
        except OSError:
            continue


@dataclass
class FetchConfig:
    popular_pages: int = 1  # 热门榜单拉取页数（每页 20 视频）
    weekly: bool = True  # 每周必看
    feed: bool = True  # 首页推荐流（自动推送）：发现的主动入口，登录态个性化（匿名也可用）
    feed_pages: int = 2  # 推荐流拉取页数（每页约 12-20 视频，推荐序即站方热度信号）
    regions: list[int] = field(default_factory=lambda: [119])  # 高梗浓度分区：鬼畜=119
    region_pages: int = 1  # 每个分区拉取页数（每页 20 视频）
    rank_regions: list[int] = field(default_factory=list)  # 分区周榜（头部视频=梗浪主战场）
    related_of_top: int = 0  # 顺藤摸瓜：取湖内评论最多的 N 个视频的相关推荐
    hot_words: bool = True  # 站内热搜词进呈现（决策支持；搜索接口需登录故不作采样源）
    ups: list[int] = field(default_factory=list)  # 目标 up 主 mid 列表
    videos_per_round: int = 15  # 每轮 surf 采样视频上限
    comments_per_video: int = 200  # 每视频评论拉取上限（含楼中楼）
    reply_pages_per_video: int = 3  # 主评论热度页数上限
    latest_pages_per_video: int = 0  # 最新排序页数（mode=3，进行中梗浪的信号源）
    max_per_source: int = 0  # 单一数据源的视频配额上限（0=不限制，防单源霸占配额）
    subreply_pages_per_root: int = 1  # 每条根评论的楼中楼页数上限
    max_comment_age_days: int = 30  # 评论年龄闸门：ctime 早于该天数的评论不入湖（0=不过滤）
    max_video_age_days: int = 0  # 视频年龄闸门：只采发布 N 天内的视频（0=不过滤；近期梗在近期视频）
    sessdata_env: str = ""  # 登录态环境变量名（如 BILI_SESSDATA）：解锁搜索探测与完整评论区；空=匿名
    probe_keywords: int = 0  # 热词探测数：用登录态搜索热词对应的梗浪宿主视频（需 sessdata_env）
    subreply_roots: int = 5  # 每视频补全楼中楼的根评论数（交互梗配对样本）
    comment_images_per_round: int = 20  # 每轮下载并 pHash 的评论图片上限（图梗发现，0=关闭）
    delay_min: float = 0.8  # 请求间隔下限（秒）
    delay_max: float = 1.5  # 请求间隔上限（秒）
    timeout: float = 15.0


@dataclass
class InductionConfig:
    model: str = "deepseek-flash"  # DSH 模型 ID 直通
    small_model: str = "deepseek-flash"  # triage 轻量任务（word 类 gist）
    reasoning_effort: str = "low"  # off|low|high|max
    max_tokens: int = 8192
    daily_call_budget: int = 40  # 归纳日预算（调用次数）
    backtest_holdout: float = 0.3
    backtest_min_hit: float = 0.7
    backtest_max_fp: float = 0.02
    backtest_negatives: int = 1000
    api_key_env: str = ENV_API_KEY  # 凭证环境变量名
    base_url_env: str = ENV_BASE_URL

    def api_key(self) -> str | None:
        return os.environ.get(self.api_key_env) or None

    def base_url(self) -> str:
        return os.environ.get(self.base_url_env) or DEFAULT_BASE_URL


@dataclass
class RetrievalConfig:
    default_level: str = "card"  # brief|card|full
    round_size: int = 10  # surf 每页呈现预算（O3 待校准）
    search_top: int = 8
    vector_threshold: float = 0.60  # 向量兜底命中下限（余弦）
    rrf_k: int = 60
    embed_model: str = "BAAI/bge-small-zh-v1.5"


@dataclass
class LifecycleConfig:
    trigger_rounds: int = 2  # 触发归纳：跨轮次数下限（O2）
    trigger_videos: int = 4  # 跨不相干视频数下限（v2 实测校准：8→4，每轮仅 ~20 视频）
    trigger_z: float = 4.0  # 爆发 z 值下限（O2）
    trigger_videos_alt: int = 8  # 无爆发但视频数达到此值也触发（v2：15→8）
    trigger_fresh_videos: int = 5  # 新物（z 无基线）跨视频数达到此值即触发（v2 新增）
    trigger_meme_score: float = 0.45  # 梗性证据分下限（复读/坍缩/独立成评，v2 新增；真实湖校准）
    promote_rounds: int = 2  # observing→active 连续野外轮数
    fade_window_days: int = 90
    fade_drop: float = 0.5  # 窗口内频率下降比例阈值
    tombstone_ratio: float = 0.1  # 衰减至峰值比例以下 → tombstone
    candidate_expire_rounds: int = 6  # O4：多少轮未触发自动 rejected
    backlog_alert: int = 10  # 欠账提醒阈值（O3）


@dataclass
class DetectConfig:
    """检测层扩展配置。"""
    generic_extra: list[str] = field(default_factory=list)  # toml 级停用词（内置 GENERIC 之外）


@dataclass
class Config:
    db_path: Path = field(default_factory=lambda: Path.home() / ".meme" / "memes.db")
    fetch: FetchConfig = field(default_factory=FetchConfig)
    induction: InductionConfig = field(default_factory=InductionConfig)
    retrieval: RetrievalConfig = field(default_factory=RetrievalConfig)
    lifecycle: LifecycleConfig = field(default_factory=LifecycleConfig)
    detect: DetectConfig = field(default_factory=DetectConfig)

    def to_dict(self) -> dict:
        return {
            "db_path": str(self.db_path),
            "fetch": vars(self.fetch),
            "induction": {k: v for k, v in vars(self.induction).items()},
            "retrieval": vars(self.retrieval),
            "lifecycle": vars(self.lifecycle),
        }


def _find_config_file(explicit: str | None) -> Path | None:
    if explicit:
        p = Path(explicit)
        if not p.exists():
            raise FileNotFoundError(f"配置文件不存在：{p}")
        return p
    env = os.environ.get(ENV_CONFIG)
    if env:
        p = Path(env)
        if not p.exists():
            raise FileNotFoundError(f"MEME_CONFIG 指向的配置文件不存在：{p}")
        return p
    for cand in (Path.cwd() / CONFIG_NAME, Path.home() / ".meme" / CONFIG_NAME):
        if cand.exists():
            return cand
    return None


def load_config(explicit_config: str | None = None, explicit_db: str | None = None) -> Config:
    _load_dotenv()
    cfg = Config()
    path = _find_config_file(explicit_config)
    if path is not None:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
        for section, target in (
            ("fetch", cfg.fetch),
            ("induction", cfg.induction),
            ("retrieval", cfg.retrieval),
            ("lifecycle", cfg.lifecycle),
            ("detect", cfg.detect),
        ):
            if isinstance(raw.get(section), dict):
                for k, v in raw[section].items():
                    if hasattr(target, k):
                        setattr(target, k, v)
        if isinstance(raw.get("db"), dict) and raw["db"].get("path"):
            cfg.db_path = Path(raw["db"]["path"]).expanduser()
    # 环境变量与显式 flag 优先级：flag > env > toml > 默认
    env_db = os.environ.get(ENV_DB)
    if env_db:
        cfg.db_path = Path(env_db).expanduser()
    if explicit_db:
        cfg.db_path = Path(explicit_db).expanduser()
    return cfg
