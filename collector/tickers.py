# tickers.py — stock_info 테이블 동기화
# 책임: pykrx 종목 목록을 DB와 비교 → 신규 INSERT, 종목명 변경 UPDATE,
#       사라진 종목 is_active=FALSE + delisted_date 마킹.
# 작성일: 2026-06-13

from dataclasses import dataclass
from datetime import date
from typing import Dict, List, Tuple

from . import db, krx
from .log import get_logger

logger = get_logger(__name__)


@dataclass
class SyncResult:
    """동기화 결과 집계 — 텔레그램 요약/로그용."""
    inserted: int = 0          # 신규 등록 종목
    name_updated: int = 0      # 종목명 변경
    delisted: int = 0          # 상장 폐지로 마킹
    reactivated: int = 0       # 재상장(or 일시 누락 복귀)
    failed_names: int = 0      # 종목명 조회 실패
    total_active: int = 0      # 현재 활성 종목 수

    def summary(self) -> str:
        return (
            f"종목 동기화: 신규 {self.inserted} / 명변경 {self.name_updated} / "
            f"폐지 {self.delisted} / 복귀 {self.reactivated} / "
            f"활성 {self.total_active} / 실패 {self.failed_names}"
        )


def _fetch_db_state() -> Dict[str, dict]:
    """DB의 현재 stock_info 상태를 dict로 반환. key=ticker.
    KR(KOSPI/KOSDAQ) 종목만 로드 — 폐지 루프가 USD 종목을 잘못 비활성화하는 사고 방지.
    USD 종목은 yfinance_us.fetch_master가 별도로 관리한다.
    """
    rows = db.fetch_all(
        "SELECT ticker, name, market, is_active FROM stock_info "
        "WHERE currency = 'KRW' OR currency IS NULL"
    )
    return {r["ticker"]: r for r in rows}


def sync_tickers() -> SyncResult:
    """KOSPI+KOSDAQ 전체 종목 목록 동기화.
    1) pykrx에서 현재 종목 목록 수집
    2) DB 상태와 비교
    3) 신규/변경/폐지 처리
    """
    result = SyncResult()
    today = date.today()

    # ① 외부 종목 목록 + 종목명을 한 번에 수집
    external = krx.get_all_tickers_with_names()
    if not external:
        logger.error("ticker sync aborted: external source returned no data")
        return result

    # ticker → (name, market) 사전화 (중복 코드는 마지막 값 유지)
    ext_tickers: Dict[str, Tuple[str, str]] = {}
    for ticker, name, market in external:
        if not ticker or not name:
            result.failed_names += 1
            continue
        ext_tickers[ticker] = (name, market)

    # ② DB 상태
    db_state = _fetch_db_state()

    # ③ 신규/변경/복귀 처리
    inserts: List[tuple] = []   # (ticker, name, market, last_synced_at)
    name_updates: List[tuple] = []  # (name, ticker)
    reactivates: List[tuple] = []   # (ticker,)

    for ticker, (name, market) in ext_tickers.items():
        existing = db_state.get(ticker)
        if existing is None:
            inserts.append((ticker, name, market))
        else:
            if existing["name"] != name:
                name_updates.append((name, ticker))
            if not existing["is_active"]:
                reactivates.append((ticker,))

    # ④ 폐지 처리: DB에 있으나 외부 목록에서 사라진 종목
    delistings: List[tuple] = []
    for ticker, row in db_state.items():
        if row["is_active"] and ticker not in ext_tickers:
            delistings.append((today, ticker))

    # ⑤ DB 반영 — 단일 트랜잭션으로 atomic 처리
    with db.transaction() as conn:
        with conn.cursor() as cur:
            if inserts:
                cur.executemany(
                    """
                    INSERT INTO stock_info (ticker, name, market, is_active, last_synced_at)
                    VALUES (%s, %s, %s, TRUE, NOW())
                    ON DUPLICATE KEY UPDATE
                      name           = VALUES(name),
                      market         = VALUES(market),
                      is_active      = TRUE,
                      last_synced_at = NOW()
                    """,
                    inserts,
                )
                result.inserted = cur.rowcount

            if name_updates:
                cur.executemany(
                    "UPDATE stock_info SET name = %s, last_synced_at = NOW() WHERE ticker = %s",
                    name_updates,
                )
                result.name_updated = len(name_updates)

            if reactivates:
                cur.executemany(
                    """
                    UPDATE stock_info
                       SET is_active = TRUE,
                           delisted_date = NULL,
                           last_synced_at = NOW()
                     WHERE ticker = %s
                    """,
                    reactivates,
                )
                result.reactivated = len(reactivates)

            if delistings:
                cur.executemany(
                    """
                    UPDATE stock_info
                       SET is_active = FALSE,
                           delisted_date = %s,
                           last_synced_at = NOW()
                     WHERE ticker = %s
                    """,
                    delistings,
                )
                result.delisted = len(delistings)

            # 마지막 동기화 시각은 KR 활성 종목 전체에 일괄 표시 (USD는 yfinance_us 담당)
            cur.execute(
                "UPDATE stock_info SET last_synced_at = NOW() "
                "WHERE is_active = TRUE AND (currency = 'KRW' OR currency IS NULL)"
            )

    # ⑥ 활성 종목 수 집계 (KR 한정 — USD는 별도 카운트)
    row = db.fetch_one(
        "SELECT COUNT(*) AS c FROM stock_info "
        "WHERE is_active = TRUE AND (currency = 'KRW' OR currency IS NULL)"
    )
    result.total_active = int(row["c"]) if row else 0

    logger.info(result.summary())
    return result


def get_active_tickers() -> List[str]:
    """현재 활성 종목 ticker 리스트. 일봉 수집 대상."""
    rows = db.fetch_all(
        "SELECT ticker FROM stock_info WHERE is_active = TRUE ORDER BY ticker"
    )
    return [r["ticker"] for r in rows]
