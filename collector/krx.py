# krx.py — pykrx 호출 래퍼
# 책임: 종목 목록/일봉 조회 + 재시도(3회, 지수 백오프).
# pykrx의 KRX 직접 호출은 가끔 일시적 실패 — 재시도로 신뢰성 확보.
# 작성일: 2026-06-13

import time
from datetime import date, datetime, timedelta
from typing import Callable, List, Optional, Tuple, TypeVar

import pandas as pd
from pykrx import stock

# FinanceDataReader — 토요일/공휴일에도 동작하는 종목 마스터 소스.
# pykrx의 get_market_ticker_list가 주말에 KRX endpoint 응답을 받지 못하는
# 한계를 우회하기 위해 1차 소스로 사용.
try:
    import FinanceDataReader as fdr
    _FDR_AVAILABLE = True
except ImportError:
    _FDR_AVAILABLE = False

from . import config
from .log import get_logger

logger = get_logger(__name__)

T = TypeVar("T")

# KRX 첫 영업일은 1956년이지만 안전 마진. 데이터 조회 실패 방지용 하한.
_MIN_DATE = date(2000, 1, 1)


def _retry(fn: Callable[[], T], desc: str, max_attempts: Optional[int] = None) -> Optional[T]:
    """지수 백오프 재시도. 실패 시 None.
    max_attempts 미지정 시 config.MAX_RETRY 사용. 가벼운 호출(종목명 등)은 1로 단축.
    """
    attempts = max_attempts if max_attempts is not None else config.MAX_RETRY
    delay = 1.0
    last_err: Optional[Exception] = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:
            last_err = e
            if attempts > 1:
                logger.warning(
                    "pykrx %s attempt %d/%d failed: %s",
                    desc, attempt, attempts, e,
                )
            if attempt < attempts:
                time.sleep(delay)
                delay *= 2
    logger.error("pykrx %s gave up after %d attempts: %s",
                 desc, attempts, last_err)
    return None


def _fmt(d: date) -> str:
    """pykrx 표준 날짜 포맷 YYYYMMDD."""
    return d.strftime("%Y%m%d")


def get_recent_business_day(base: Optional[date] = None) -> date:
    """기준일 이전(포함)의 가장 최근 영업일.
    pykrx.get_nearest_business_day_in_a_week 활용. 종목 목록 기준일 등에 사용.
    KRX API 응답 실패 시 폴백: 주말이면 직전 금요일, 평일이면 어제.
    """
    target = base or date.today()
    result = _retry(
        lambda: stock.get_nearest_business_day_in_a_week(_fmt(target)),
        f"get_nearest_business_day({target})",
        max_attempts=1,  # 미래 날짜는 KRX 응답 자체가 빈 케이스 많음 — fast-fail
    )
    if result:
        return datetime.strptime(result, "%Y%m%d").date()

    # 폴백: 주말 → 직전 금요일, 평일 → 어제
    fallback = target
    if target.weekday() == 5:        # 토요일
        fallback = target - timedelta(days=1)
    elif target.weekday() == 6:      # 일요일
        fallback = target - timedelta(days=2)
    elif target.weekday() == 0:      # 월요일 새벽이면 직전 금요일이 마지막
        fallback = target - timedelta(days=3)
    else:
        fallback = target - timedelta(days=1)
    return fallback


def is_business_day(target: date) -> bool:
    """target이 영업일인지 단순 판정.
    KRX API는 미래 날짜에 응답이 불안정 → 요일 기반으로 1차 판정.
    공휴일은 OHLCV 빈 응답으로 자연스럽게 0건 처리되므로 별도 체크 안 함.
    """
    # 월=0 ... 일=6
    return target.weekday() < 5


def get_all_tickers_with_names() -> List[Tuple[str, str, str]]:
    """KOSPI + KOSDAQ 전종목을 종목명 포함하여 반환.
    Returns: [(ticker, name, market), ...]. market='KOSPI' 또는 'KOSDAQ'.
    1차: FinanceDataReader (주말에도 동작, 종목명 포함).
    2차: pykrx 폴백 (개별 종목명 조회 — 느림).
    """
    out: List[Tuple[str, str, str]] = []

    if _FDR_AVAILABLE:
        for mkt in ("KOSPI", "KOSDAQ"):
            try:
                df = fdr.StockListing(mkt)
                if df is None or df.empty:
                    logger.warning("FDR StockListing(%s) returned empty", mkt)
                    continue
                # FDR 컬럼: Code, Name (다른 컬럼은 무시)
                for _, row in df.iterrows():
                    code = str(row.get("Code") or "").strip()
                    name = str(row.get("Name") or "").strip()
                    if not code or not name:
                        continue
                    # 한국 종목 코드는 6자리 — 정규화
                    code = code.zfill(6)
                    out.append((code, name, mkt))
                logger.info("FDR fetched %d tickers from %s", len(df), mkt)
            except Exception as e:
                logger.error("FDR StockListing(%s) failed: %s", mkt, e)
        if out:
            return out

    # pykrx 폴백 — 평일에만 신뢰성 확보됨
    logger.warning("falling back to pykrx for ticker list")
    ref_date = _fmt(get_recent_business_day())
    for mkt in ("KOSPI", "KOSDAQ"):
        tickers = _retry(
            lambda m=mkt: stock.get_market_ticker_list(ref_date, market=m),
            f"get_market_ticker_list({mkt})",
        )
        if not tickers:
            logger.error("ticker list empty for %s", mkt)
            continue
        for t in tickers:
            t = str(t)
            name = get_ticker_name(t) or ""
            if not name:
                continue
            out.append((t, name, mkt))
    return out


def get_all_tickers(target: Optional[date] = None) -> List[Tuple[str, str]]:
    """레거시 호환 — (ticker, market) 튜플만 반환."""
    return [(t, m) for (t, _n, m) in get_all_tickers_with_names()]


def get_ticker_name(ticker: str) -> Optional[str]:
    """종목명 조회. 실패 시 None.
    종목명 조회는 매우 잦고 실패율이 낮으므로 fast-fail (재시도 1회)
    — 3,000 종목 처리 시 누적 대기 폭증을 막는다.
    """
    name = _retry(
        lambda: stock.get_market_ticker_name(ticker),
        f"get_market_ticker_name({ticker})",
        max_attempts=1,
    )
    if not name or not isinstance(name, str):
        return None
    return name.strip()


def get_ohlcv(ticker: str, from_date: date, to_date: date) -> Optional[pd.DataFrame]:
    """일봉 OHLCV 조회.
    Returns: 한글 컬럼 DataFrame(시가/고가/저가/종가/거래량/등락률) 또는 None.
    빈 결과(휴장/상장 전)는 빈 DataFrame 반환 — None과 구분.
    """
    if from_date < _MIN_DATE:
        from_date = _MIN_DATE
    if to_date < from_date:
        return pd.DataFrame()

    df = _retry(
        lambda: stock.get_market_ohlcv_by_date(_fmt(from_date), _fmt(to_date), ticker),
        f"get_market_ohlcv_by_date({ticker},{from_date}..{to_date})",
    )
    if df is None:
        return None
    if df.empty:
        return df
    # 인덱스가 DatetimeIndex — date 컬럼으로 평탄화
    df = df.reset_index().rename(columns={"날짜": "trade_date"})
    return df
