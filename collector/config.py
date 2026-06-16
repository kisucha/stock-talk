# config.py — 환경 변수 로드 + 상수 노출
# 책임: .env 로드, 타입 변환, 디폴트 적용. 다른 모듈은 본 파일에서만 환경 변수 참조.
# 작성일: 2026-06-13

import os
import sys
from pathlib import Path

# Windows 콘솔 인코딩 안전 처리 (CLAUDE.md 의무 사항)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from dotenv import load_dotenv

# .env는 collector/ 디렉토리 또는 그 상위 어디든 자동 탐색
_PACKAGE_DIR = Path(__file__).resolve().parent
_ENV_PATH = _PACKAGE_DIR / ".env"
if _ENV_PATH.exists():
    load_dotenv(_ENV_PATH)
else:
    # 상위 디렉토리 .env 탐색 (개발 시 stock-talk/.env 공유 가능)
    load_dotenv()


def _get_str(key: str, default: str = "") -> str:
    """문자열 환경 변수 조회. 미설정 시 default 반환."""
    val = os.getenv(key, default)
    return val.strip() if val else default


def _get_int(key: str, default: int) -> int:
    """정수 환경 변수 조회. 변환 실패 시 default."""
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _get_float(key: str, default: float) -> float:
    """실수 환경 변수 조회. 변환 실패 시 default."""
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _get_bool(key: str, default: bool) -> bool:
    """불리언 환경 변수. 'true'/'1'/'yes' 만 True."""
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in ("true", "1", "yes", "on")


# ============ DB ============
DB_HOST = _get_str("DB_HOST", "127.0.0.1")
DB_PORT = _get_int("DB_PORT", 3306)
DB_USER = _get_str("DB_USER", "root")
DB_PASSWORD = _get_str("DB_PASSWORD", "")
DB_NAME = _get_str("DB_NAME", "stock_analysis")

# ============ 수집 동작 ============
SLEEP_BETWEEN_TICKERS = _get_float("SLEEP_BETWEEN_TICKERS", 0.3)
INIT_YEARS = _get_int("INIT_YEARS", 5)
SKIP_NON_BUSINESS_DAY = _get_bool("SKIP_NON_BUSINESS_DAY", True)
MAX_RETRY = _get_int("MAX_RETRY", 3)

# ============ 로깅 ============
LOG_LEVEL = _get_str("LOG_LEVEL", "INFO").upper()
LOG_RETENTION_DAYS = _get_int("LOG_RETENTION_DAYS", 30)

# ============ KRX 로그인 ============
KRX_ID = _get_str("KRX_ID", "")
KRX_PW = _get_str("KRX_PW", "")

# ============ 텔레그램 ============
TELEGRAM_BOT_TOKEN = _get_str("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = _get_str("TELEGRAM_CHAT_ID", "")
TELEGRAM_ENABLED = bool(TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)

# ============ 경로 ============
LOG_DIR = Path(_get_str("LOG_DIR", str(_PACKAGE_DIR / "logs")))
STATE_DIR = Path(_get_str("STATE_DIR", str(_PACKAGE_DIR / "state")))

# 디렉토리 자동 생성 (개발/배포 양쪽 모두 안전)
LOG_DIR.mkdir(parents=True, exist_ok=True)
STATE_DIR.mkdir(parents=True, exist_ok=True)


def summary() -> str:
    """디버그용 요약 — 비밀번호 마스킹."""
    masked_pw = "***" if DB_PASSWORD else "(empty)"
    return (
        f"[config] DB={DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME} pw={masked_pw} "
        f"sleep={SLEEP_BETWEEN_TICKERS}s years={INIT_YEARS} "
        f"telegram={'on' if TELEGRAM_ENABLED else 'off'} log={LOG_LEVEL}"
    )
