# log.py — 통합 로깅 설정
# 책임: TimedRotatingFileHandler로 collector.log를 30일 보관.
# 콘솔(stdout) 핸들러도 함께 부착 — cron stdout 캡처 가능.
# 사용: from collector.log import get_logger; logger = get_logger(__name__)
# 작성일: 2026-06-13

import logging
import sys
from logging.handlers import TimedRotatingFileHandler

from . import config

_INITIALIZED = False
_LOG_FILE = config.LOG_DIR / "collector.log"

# 출력 포맷 — KST 타임존은 시스템 TZ에 의존 (서버 TZ=Asia/Seoul 가정)
_FMT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


def _setup() -> None:
    """루트 로거 1회 초기화. 멱등 보장."""
    global _INITIALIZED
    if _INITIALIZED:
        return

    root = logging.getLogger("collector")
    root.setLevel(getattr(logging, config.LOG_LEVEL, logging.INFO))
    root.propagate = False

    # 중복 핸들러 방지 (리로드 대비)
    for h in list(root.handlers):
        root.removeHandler(h)

    formatter = logging.Formatter(_FMT, datefmt=_DATEFMT)

    # 파일 핸들러: 자정 기준 30일 로테이션
    file_handler = TimedRotatingFileHandler(
        filename=str(_LOG_FILE),
        when="midnight",
        interval=1,
        backupCount=config.LOG_RETENTION_DAYS,
        encoding="utf-8",
        utc=False,
    )
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    # 콘솔 핸들러: stdout (cron이 stderr만 캡처하지 않도록)
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    root.addHandler(console)

    _INITIALIZED = True


def get_logger(name: str) -> logging.Logger:
    """모듈별 로거 발급. 'collector' 네임스페이스 하위로 통일."""
    _setup()
    if name.startswith("collector."):
        return logging.getLogger(name)
    return logging.getLogger(f"collector.{name}")
