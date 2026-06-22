"""yfinance_us.py — 미국 주식 수집기

수집 정책 (2026-06-21 이후):
  1) 마스터(종목 코드 + 이름)는 항상 upfront 적재 — 검색 자동완성 보장
  2) 5년치 일봉은 **관심종목 등록(선택) 시점에만** 1회 적재 (init 모드)
  3) 매일 증분은 **이미 일봉 데이터가 적재된 종목만** 대상
  4) 매월 1일 5년치 일괄 적재 프로세스는 **없음** — 5y는 종목 선택 시에만

책임:
  - fetch_master(): Nasdaq Trader FTP → stock_info에 NASDAQ/NYSE/AMEX 종목 마스터 적재
  - fetch_ohlcv_5y(symbol): yfinance 5년치 일봉 수집 → stock_daily 적재 (관심종목 등록 시 1회)
  - fetch_ohlcv_incremental(symbol): 종목별 MAX(trade_date)+1 ~ 오늘 증분
                                      — 5y 폴백 없음. 일봉 미적재 종목은 0 반환 후 스킵
  - incremental_all_us(): 일봉이 1행 이상 존재하는 USD 종목만 전체 증분 일괄 실행
  - should_sync_master(today): 매월 1일 + 미동기화 시 True

데이터 소스:
  - 종목 마스터: ftp.nasdaqtrader.com:/symboldirectory/nasdaqlisted.txt + otherlisted.txt
  - 일봉: yfinance.Ticker(symbol).history(period=...)

필터(Phase A — 보통주 + ETF):
  - Test Issue == 'Y' 제외
  - "Preferred"/"Warrant"/"Unit"/"Rights"/"Notes" 키워드 포함 종목 제외
  - ETF='Y'는 통과
  - Symbol에 '$' 포함 종목 제외 (preferred class)
"""

import sys

# Windows 콘솔 인코딩 안전 (CLAUDE.md 의무)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from datetime import date, datetime, timedelta
from ftplib import FTP, error_perm
from io import BytesIO
from typing import Dict, List, Optional, Tuple

import pandas as pd

from . import db
from .log import get_logger

logger = get_logger(__name__)

# ============================================================
# 종목 마스터 다운로드
# ============================================================
_FTP_HOST = "ftp.nasdaqtrader.com"
_FTP_DIR = "symboldirectory"

# Security Name에 포함되면 보통주가 아님 — 제외
_EXCLUDE_KEYWORDS = (
    " Preferred",
    " Warrant",
    " Warrants",
    " Right",
    " Rights",
    " Unit",
    " Units",
    " Notes",
    " Depositary",
    " Convertible",
    " Subordinated",
)


def _fetch_ftp_lines(filename: str) -> List[str]:
    """Nasdaq Trader FTP에서 pipe-delimited 파일 다운로드 → 라인 리스트."""
    buf = BytesIO()
    ftp = FTP(_FTP_HOST, timeout=30)
    try:
        ftp.login()
        ftp.cwd(_FTP_DIR)
        ftp.retrbinary(f"RETR {filename}", buf.write)
    finally:
        try:
            ftp.quit()
        except Exception:
            pass
    text = buf.getvalue().decode("utf-8", errors="replace")
    return [ln for ln in text.splitlines() if ln.strip()]


def _is_eligible(security_name: str) -> bool:
    """보통주/ETF 후보 판정 — 제외 키워드 미포함이면 True."""
    if not security_name:
        return False
    for kw in _EXCLUDE_KEYWORDS:
        if kw in security_name:
            return False
    return True


def _parse_nasdaqlisted(lines: List[str]) -> List[Tuple[str, str, str]]:
    """nasdaqlisted.txt 파싱 → [(ticker, name, market='NASDAQ')].
    헤더:
      Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
    """
    if not lines:
        return []
    header = lines[0].split("|")
    try:
        i_sym = header.index("Symbol")
        i_name = header.index("Security Name")
        i_test = header.index("Test Issue")
    except ValueError:
        logger.error("nasdaqlisted header unexpected: %s", header)
        return []

    out: List[Tuple[str, str, str]] = []
    for ln in lines[1:]:
        # 마지막 행은 'File Creation Time:...' 메타데이터 — 파이프 없음
        if "|" not in ln or ln.startswith("File Creation"):
            continue
        cols = ln.split("|")
        if len(cols) < len(header):
            continue
        symbol = cols[i_sym].strip()
        name = cols[i_name].strip()
        test = cols[i_test].strip()
        if not symbol or "$" in symbol or test == "Y":
            continue
        if not _is_eligible(name):
            continue
        out.append((symbol, name, "NASDAQ"))
    return out


def _parse_otherlisted(lines: List[str]) -> List[Tuple[str, str, str]]:
    """otherlisted.txt 파싱 → [(ticker, name, market=NYSE|AMEX|...)].
    헤더:
      ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
    Exchange 코드 매핑:
      N=NYSE, A=AMEX, P=ARCA, Z=BATS, V=IEX
    """
    if not lines:
        return []
    header = lines[0].split("|")
    try:
        i_sym = header.index("ACT Symbol")
        i_name = header.index("Security Name")
        i_exch = header.index("Exchange")
        i_test = header.index("Test Issue")
    except ValueError:
        logger.error("otherlisted header unexpected: %s", header)
        return []

    exch_map = {"N": "NYSE", "A": "AMEX", "P": "ARCA", "Z": "BATS", "V": "IEX"}
    out: List[Tuple[str, str, str]] = []
    for ln in lines[1:]:
        if "|" not in ln or ln.startswith("File Creation"):
            continue
        cols = ln.split("|")
        if len(cols) < len(header):
            continue
        symbol = cols[i_sym].strip()
        name = cols[i_name].strip()
        exch = cols[i_exch].strip()
        test = cols[i_test].strip()
        if not symbol or "$" in symbol or test == "Y":
            continue
        if not _is_eligible(name):
            continue
        market = exch_map.get(exch, "NYSE")  # 기본 NYSE
        out.append((symbol, name, market))
    return out


def fetch_master() -> int:
    """Nasdaq Trader FTP → stock_info에 US 종목 적재 (이미 있으면 name/market 갱신).
    us_master_sync에 동기화 시각 기록. 반환: 적재/갱신 종목 수.
    """
    logger.info("[us-master] FTP download start")
    try:
        ndq = _parse_nasdaqlisted(_fetch_ftp_lines("nasdaqlisted.txt"))
        oth = _parse_otherlisted(_fetch_ftp_lines("otherlisted.txt"))
    except (error_perm, OSError) as e:
        logger.error("[us-master] FTP failure: %s", e)
        return 0

    rows = ndq + oth
    if not rows:
        logger.warning("[us-master] no rows parsed")
        return 0

    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO stock_info (ticker, name, market, currency, is_active, last_synced_at)
            VALUES (%s, %s, %s, 'USD', TRUE, NOW())
            ON DUPLICATE KEY UPDATE
              name = VALUES(name),
              market = VALUES(market),
              currency = 'USD',
              last_synced_at = NOW()
            """,
            rows,
        )
        cur.execute(
            "INSERT INTO us_master_sync (last_synced_at, tickers_count, source) VALUES (NOW(), %s, 'nasdaqtrader_ftp')",
            (len(rows),),
        )
    conn.commit()
    logger.info("[us-master] applied: %d tickers (NASDAQ=%d, OTHER=%d)",
                len(rows), len(ndq), len(oth))
    return len(rows)


# ============================================================
# 일봉 수집 (yfinance)
# ============================================================
def _yf_history(symbol: str, **kwargs) -> Optional[pd.DataFrame]:
    """yfinance 일봉 조회 wrapper. import 지연 + 예외 처리."""
    try:
        import yfinance as yf  # 지연 import — Python 환경 미설치 시 에러 후속 전파
    except ImportError as e:
        logger.error("[yfinance] 미설치: %s. pip install yfinance 필요", e)
        return None
    try:
        df = yf.Ticker(symbol).history(auto_adjust=False, **kwargs)
        return df if df is not None and not df.empty else None
    except Exception as e:
        logger.warning("[yfinance] %s history error: %s", symbol, e)
        return None


def _df_to_rows(df: pd.DataFrame, ticker: str) -> List[Tuple]:
    """yfinance DataFrame → stock_daily INSERT 튜플 리스트.
    yfinance 인덱스는 DatetimeIndex (timezone-aware 가능) — .date()로 변환.
    """
    rows: List[Tuple] = []
    for idx, r in df.iterrows():
        try:
            trade_date = idx.date() if hasattr(idx, "date") else pd.to_datetime(idx).date()
            rows.append((
                ticker,
                trade_date,
                float(r["Open"]),
                float(r["High"]),
                float(r["Low"]),
                float(r["Close"]),
                int(r["Volume"]),
            ))
        except (KeyError, ValueError, TypeError) as e:
            logger.warning("[yfinance] %s row skip: %s", ticker, e)
            continue
    return rows


def _insert_daily(rows: List[Tuple]) -> int:
    """stock_daily INSERT IGNORE — 중복 (ticker, trade_date) 자동 스킵."""
    if not rows:
        return 0
    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT IGNORE INTO stock_daily (ticker, trade_date, open, high, low, close, volume)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            rows,
        )
        affected = cur.rowcount
    conn.commit()
    return affected


def _ensure_stock_info(symbol: str) -> None:
    """stock_info에 ticker 미존재 시 최소 정보(이름=symbol fallback)로 등록.
    yfinance.Ticker.info에서 longName/exchange 추출 시도. 실패해도 symbol로 fallback.
    """
    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM stock_info WHERE ticker = %s", (symbol,))
        if cur.fetchone() is not None:
            return
    # yfinance info 시도 — 차단/실패 시 fallback
    name = symbol
    market = "NASDAQ"
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
        name = info.get("longName") or info.get("shortName") or symbol
        exch = (info.get("exchange") or "").upper()
        if exch in ("NYQ", "NYSE"):
            market = "NYSE"
        elif exch in ("ASE", "AMEX"):
            market = "AMEX"
        elif exch in ("PCX", "ARCA"):
            market = "ARCA"
        elif exch in ("NMS", "NCM", "NGM", "NASDAQ"):
            market = "NASDAQ"
    except Exception as e:
        logger.warning("[yfinance] %s info lookup failed (fallback): %s", symbol, e)
    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO stock_info (ticker, name, market, currency, is_active, last_synced_at)
            VALUES (%s, %s, %s, 'USD', TRUE, NOW())
            ON DUPLICATE KEY UPDATE name = VALUES(name), market = VALUES(market), currency = 'USD'
            """,
            (symbol, name, market),
        )
    conn.commit()
    logger.info("[yfinance] %s auto-registered to stock_info (name=%s, market=%s)",
                symbol, name, market)


def fetch_ohlcv_5y(symbol: str) -> int:
    """5년치 일봉 수집 (등록 시 1회). 반환: 신규 INSERT 행 수.
    stock_info에 미등록 종목은 자동 등록 (FK violation 방지).
    """
    logger.info("[yfinance] %s 5y init", symbol)
    _ensure_stock_info(symbol)
    df = _yf_history(symbol, period="5y")
    if df is None:
        return 0
    rows = _df_to_rows(df, symbol)
    inserted = _insert_daily(rows)
    logger.info("[yfinance] %s 5y inserted=%d", symbol, inserted)
    return inserted


def fetch_ohlcv_incremental(symbol: str) -> int:
    """종목별 MAX(trade_date)+1 ~ 오늘 증분 적재.

    정책 변경 (2026-06-21):
      - 일봉 미적재 종목(MAX(trade_date) IS NULL)은 5y 폴백을 **수행하지 않고** 0 반환 후 스킵.
      - 5년치 초기 적재는 **관심종목 등록 시점에만** fetch_ohlcv_5y로 명시 호출 (init 모드).
      - 자동 5y 폴백 제거 이유: 마스터 적재 직후 incremental_all_us가 1만+ 종목에 대해
        5y를 폭주 호출하는 사고를 방지 (yfinance rate limit, DB 부하, 수십시간 소요).

    stock_info 미존재 시 _ensure_stock_info로 자동 등록 — FK 위반 방지(방어막).
    """
    _ensure_stock_info(symbol)
    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT MAX(trade_date) AS max_d FROM stock_daily WHERE ticker = %s",
            (symbol,),
        )
        row = cur.fetchone()
    max_d = row["max_d"] if row else None
    if max_d is None:
        # 일봉 미적재 — 5y 자동 폴백 금지. 관심종목 등록 시 init 모드로 명시 적재 필요.
        logger.info("[yfinance] %s no daily data — skip (init via --mode init required)", symbol)
        return 0
    start = max_d + timedelta(days=1)
    if start > date.today():
        return 0
    logger.info("[yfinance] %s incremental %s..today", symbol, start)
    df = _yf_history(symbol, start=start.isoformat())
    if df is None:
        return 0
    rows = _df_to_rows(df, symbol)
    inserted = _insert_daily(rows)
    logger.info("[yfinance] %s incremental inserted=%d", symbol, inserted)
    return inserted


def incremental_all_us() -> Dict[str, int]:
    """일봉 1행 이상 적재된 USD 활성 종목만 전체 증분 일괄. 반환: {symbol: inserted}.

    정책 변경 (2026-06-21):
      - 대상: stock_info(currency='USD', is_active=TRUE) AND stock_daily에 1행 이상 존재
      - 일봉 미적재 종목은 대상에서 제외 — 관심종목 등록 시 init 모드로 별도 적재
      - 이중 안전: fetch_ohlcv_incremental 자체도 NULL 시 0 반환하지만,
                  SELECT 단계에서 미리 거름으로써 yfinance API 호출 자체를 차단
    """
    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT si.ticker
              FROM stock_info si
             WHERE si.currency = 'USD'
               AND si.is_active = TRUE
               AND EXISTS (SELECT 1 FROM stock_daily sd WHERE sd.ticker = si.ticker)
             ORDER BY si.ticker
            """
        )
        tickers = [r["ticker"] for r in cur.fetchall()]
    result: Dict[str, int] = {}
    for t in tickers:
        try:
            result[t] = fetch_ohlcv_incremental(t)
        except Exception as e:
            logger.error("[yfinance] %s incremental failed: %s", t, e)
            result[t] = 0
    return result


# ============================================================
# 마스터 갱신 시점 판정
# ============================================================
def should_sync_master(today: Optional[date] = None) -> bool:
    """매월 1일에 us_master_sync.last_synced_at < 이번 달 1일이면 True."""
    if today is None:
        today = date.today()
    if today.day != 1:
        return False
    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT MAX(last_synced_at) AS last_at FROM us_master_sync")
        row = cur.fetchone()
    last_at = row["last_at"] if row else None
    if last_at is None:
        return True
    last_date = last_at.date() if hasattr(last_at, "date") else last_at
    month_start = date(today.year, today.month, 1)
    return last_date < month_start


def has_master_data() -> bool:
    """stock_info에 currency='USD' 레코드 존재 여부 — 첫 부팅 판정용."""
    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM stock_info WHERE currency='USD' LIMIT 1")
        return cur.fetchone() is not None
