# ohlcv.py — 일봉 데이터 적재
# 책임: stock_daily 테이블에 종목별 OHLCV 누적.
# 모드:
#   init_load(years=5)  — 활성 종목 전체에 대해 5년치 일괄 적재
#   incremental()       — 종목별 MAX(trade_date)+1일 ~ 오늘 증분
# 실패 종목은 state/failed_tickers.json에 누적 → 1회 재시도.
# 작성일: 2026-06-13

import json
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

import pandas as pd

from . import config, db, krx
from .log import get_logger
from .tickers import get_active_tickers

logger = get_logger(__name__)

_FAILED_FILE = config.STATE_DIR / "failed_tickers.json"

# 종목당 진행 보고 간격
_PROGRESS_EVERY = 100

# pykrx OHLCV 컬럼명 (한글 — pykrx 표준)
_COL_OPEN = "시가"
_COL_HIGH = "고가"
_COL_LOW = "저가"
_COL_CLOSE = "종가"
_COL_VOLUME = "거래량"


@dataclass
class LoadResult:
    """일봉 적재 결과 집계."""
    tickers_processed: int = 0
    rows_inserted: int = 0
    tickers_no_data: int = 0
    tickers_failed: List[str] = field(default_factory=list)
    elapsed_sec: float = 0.0

    def summary(self) -> str:
        return (
            f"일봉 적재: 종목 {self.tickers_processed} / "
            f"신규행 {self.rows_inserted} / 데이터없음 {self.tickers_no_data} / "
            f"실패 {len(self.tickers_failed)} / 소요 {self.elapsed_sec:.1f}s"
        )


def _save_failed(tickers: List[str]) -> None:
    """실패 종목 큐 저장."""
    try:
        _FAILED_FILE.write_text(
            json.dumps({"tickers": tickers, "saved_at": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as e:
        logger.warning("failed_tickers write error: %s", e)


def _load_failed() -> List[str]:
    """이전 실패 종목 큐 로드. 파일 없으면 빈 리스트."""
    if not _FAILED_FILE.exists():
        return []
    try:
        data = json.loads(_FAILED_FILE.read_text(encoding="utf-8"))
        tickers = data.get("tickers", [])
        return [str(t) for t in tickers if isinstance(t, (str, int))]
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("failed_tickers read error: %s", e)
        return []


def _clear_failed() -> None:
    """실패 큐 초기화."""
    try:
        if _FAILED_FILE.exists():
            _FAILED_FILE.unlink()
    except OSError:
        pass


def _last_trade_date(ticker: str) -> Optional[date]:
    """종목별 DB에 적재된 가장 마지막 거래일. 없으면 None."""
    row = db.fetch_one(
        "SELECT MAX(trade_date) AS last_d FROM stock_daily WHERE ticker = %s",
        (ticker,),
    )
    if not row:
        return None
    val = row.get("last_d")
    if isinstance(val, date):
        return val
    if val is None:
        return None
    # 일부 드라이버는 문자열 반환
    try:
        return date.fromisoformat(str(val))
    except ValueError:
        return None


def _df_to_rows(ticker: str, df: pd.DataFrame) -> List[tuple]:
    """OHLCV DataFrame → (ticker, trade_date, open, high, low, close, volume) 튜플 리스트.
    NaN/None 행은 제외. 정수 변환 (CLAUDE.md 스키마: INT/BIGINT).
    """
    rows: List[tuple] = []
    for _, r in df.iterrows():
        trade_d = r.get("trade_date")
        if pd.isna(trade_d):
            continue
        if hasattr(trade_d, "date"):
            trade_d = trade_d.date()
        try:
            row = (
                ticker,
                trade_d,
                int(r[_COL_OPEN]),
                int(r[_COL_HIGH]),
                int(r[_COL_LOW]),
                int(r[_COL_CLOSE]),
                int(r[_COL_VOLUME]),
            )
        except (ValueError, TypeError, KeyError):
            # 상장 첫날 등 누락 값 — skip
            continue
        rows.append(row)
    return rows


def _insert_rows(rows: List[tuple]) -> int:
    """INSERT IGNORE 배치. 중복은 UNIQUE(ticker,trade_date)로 무시.
    Returns: 실제 신규 삽입 행수.
    """
    if not rows:
        return 0
    sql = """
        INSERT IGNORE INTO stock_daily
            (ticker, trade_date, open, high, low, close, volume)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """
    return db.executemany(sql, rows)


def _collect_one(ticker: str, from_d: date, to_d: date) -> Tuple[bool, int]:
    """단일 종목 수집 + 적재.
    Returns: (성공 여부, 신규 행수). 데이터 없음도 성공으로 간주.
    """
    df = krx.get_ohlcv(ticker, from_d, to_d)
    if df is None:
        return (False, 0)
    if df.empty:
        return (True, 0)
    rows = _df_to_rows(ticker, df)
    if not rows:
        return (True, 0)
    try:
        inserted = _insert_rows(rows)
        return (True, inserted)
    except Exception as e:
        logger.error("DB insert failed for %s: %s", ticker, e)
        return (False, 0)


def _process_tickers(
    tickers: List[str],
    range_fn,
    label: str,
) -> LoadResult:
    """공통 수집 루프.
    range_fn(ticker) -> (from_date, to_date) — 종목별 수집 범위 결정.
    """
    result = LoadResult()
    started = time.monotonic()
    failed: List[str] = []

    total = len(tickers)
    logger.info("[%s] start: %d tickers", label, total)

    for idx, ticker in enumerate(tickers, start=1):
        from_d, to_d = range_fn(ticker)
        if from_d > to_d:
            # 이미 최신 — 신규 수집할 구간 없음
            result.tickers_processed += 1
            continue

        ok, inserted = _collect_one(ticker, from_d, to_d)
        if ok:
            result.tickers_processed += 1
            if inserted == 0:
                result.tickers_no_data += 1
            else:
                result.rows_inserted += inserted
        else:
            failed.append(ticker)

        if idx % _PROGRESS_EVERY == 0:
            logger.info(
                "[%s] progress %d/%d (inserted=%d, failed=%d)",
                label, idx, total, result.rows_inserted, len(failed),
            )

        # KRX rate limit 보호
        time.sleep(config.SLEEP_BETWEEN_TICKERS)

    # 실패 종목 1회 재시도
    if failed:
        logger.info("[%s] retrying %d failed tickers", label, len(failed))
        still_failed: List[str] = []
        for ticker in failed:
            from_d, to_d = range_fn(ticker)
            if from_d > to_d:
                continue
            ok, inserted = _collect_one(ticker, from_d, to_d)
            if ok:
                result.tickers_processed += 1
                result.rows_inserted += inserted
                if inserted == 0:
                    result.tickers_no_data += 1
            else:
                still_failed.append(ticker)
            time.sleep(config.SLEEP_BETWEEN_TICKERS)
        result.tickers_failed = still_failed
    else:
        result.tickers_failed = []

    if result.tickers_failed:
        _save_failed(result.tickers_failed)
    else:
        _clear_failed()

    result.elapsed_sec = time.monotonic() - started
    logger.info("[%s] %s", label, result.summary())
    return result


def init_load(years: Optional[int] = None) -> LoadResult:
    """초기 5년치 일괄 적재. 활성 종목 전체 대상.
    1회성 부트스트랩 가정 — 부분 적재 상태가 있더라도 5년 전체 범위를 다시 훑어
    누락 구간을 보장한다. 중복은 INSERT IGNORE + UNIQUE(ticker,trade_date)로 무시.
    """
    years = years if years is not None else config.INIT_YEARS
    today = date.today()
    base_from = today - timedelta(days=365 * years + years // 4)  # 윤년 보정

    tickers = get_active_tickers()

    def _range(_t: str) -> Tuple[date, date]:
        return (base_from, today)

    return _process_tickers(tickers, _range, "init_load")


def incremental() -> LoadResult:
    """증분 적재 — 종목별 마지막 적재일 기준 개별 범위 계산 (KRX 로그인 불필요).
    글로벌 MAX 대신 종목별 MAX(trade_date)를 사용해 누락 종목을 정확히 채운다.
    소요: 영업일 1일치 기준 2768종목 × ~0.6s ≈ 28분.
    """
    today = date.today()

    # DB 전체가 비어있으면 init_load 권장
    row = db.fetch_one("SELECT COUNT(*) AS cnt FROM stock_daily")
    if not row or row.get("cnt", 0) == 0:
        logger.warning("[incremental] DB 비어있음 → init_load 권장")
        return LoadResult()

    # 종목별 마지막 적재일 일괄 조회 (쿼리 1회로 최소화)
    raw_rows = db.fetch_all(
        "SELECT ticker, MAX(trade_date) AS last_d FROM stock_daily GROUP BY ticker"
    )
    last_dates: Dict[str, date] = {}
    for r in raw_rows:
        val = r.get("last_d")
        if val is None:
            continue
        if isinstance(val, date):
            last_dates[r["ticker"]] = val
        else:
            try:
                last_dates[r["ticker"]] = date.fromisoformat(str(val))
            except ValueError:
                pass

    # 신규 상장 등 DB에 없는 종목 폴백 시작일
    fallback_from = today - timedelta(days=365 * config.INIT_YEARS)

    logger.info("[incremental] 종목별 증분 시작 (today=%s, 적재이력 %d종목)", today, len(last_dates))

    tickers = get_active_tickers()

    def _range(t: str) -> Tuple[date, date]:
        last = last_dates.get(t)
        if last is None:
            return (fallback_from, today)
        return (last + timedelta(days=1), today)

    return _process_tickers(tickers, _range, "incremental")


def retry_failed() -> LoadResult:
    """이전 실패 종목 큐만 재시도. 단독 실행/디버그용."""
    today = date.today()
    fallback_from = today - timedelta(days=365 * config.INIT_YEARS)
    tickers = _load_failed()
    if not tickers:
        logger.info("retry_failed: queue empty")
        return LoadResult()

    def _range(_t: str) -> Tuple[date, date]:
        last = _last_trade_date(_t)
        if last is None:
            return (fallback_from, today)
        return (last + timedelta(days=1), today)

    return _process_tickers(tickers, _range, "retry_failed")
