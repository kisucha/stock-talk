# scripts/incremental.py — 매일 증분 업데이트 진입점 (cron 호출 대상)
# 실행: cd /opt/stock-collector && ./venv/bin/python -m collector.scripts.incremental
# cron: 30 16 * * 1-5  (평일 16:30 KST, 장마감 후 60분)
# 흐름: 영업일 체크 → DB 헬스체크 → 종목 동기화 → 증분 적재 → 실패 재시도 → 텔레그램 요약
# Exit code: 0=정상, 1=부분실패, 2=전체실패
# 작성일: 2026-06-13

import sys
from datetime import date, datetime

from collector import config, db, krx, ohlcv, tickers
from collector.log import get_logger
from collector.notify import send_telegram

logger = get_logger(__name__)


def main() -> int:
    started_at = datetime.now()
    today = started_at.date()
    logger.info("=== incremental start (%s) ===", today)

    # ① 영업일 체크 (주말/공휴일 자동 종료)
    if config.SKIP_NON_BUSINESS_DAY:
        try:
            if not krx.is_business_day(today):
                logger.info("non-business day → skip")
                # 휴장일은 알림 없이 조용히 종료 (텔레그램 스팸 방지)
                return 0
        except Exception as e:
            # 영업일 체크 실패는 치명적 아님 — 그대로 진행
            logger.warning("business day check failed: %s — continue anyway", e)

    # ② DB 연결 확인
    if not db.ping():
        msg = f"❌ incremental 실패\n사유: DB 연결 불가\n시각: {started_at:%Y-%m-%d %H:%M}"
        logger.error(msg)
        send_telegram(msg)
        return 2

    # ③ 종목 동기화
    try:
        sync_res = tickers.sync_tickers()
    except Exception as e:
        logger.exception("ticker sync crashed")
        send_telegram(f"❌ incremental 실패\n단계: 종목 동기화\n오류: {e}")
        return 2

    # ④ 증분 적재
    try:
        load_res = ohlcv.incremental()
    except Exception as e:
        logger.exception("incremental crashed")
        send_telegram(f"❌ incremental 실패\n단계: 일봉 증분\n오류: {e}")
        return 2

    db.close_conn()

    # ⑤ 결과 요약
    elapsed_min = (datetime.now() - started_at).total_seconds() / 60.0
    status_icon = "⚠️" if load_res.tickers_failed else "✅"
    body = (
        f"{status_icon} 증분 업데이트 ({today})\n"
        f"소요: {elapsed_min:.1f}분\n\n"
        f"[종목]\n{sync_res.summary()}\n\n"
        f"[일봉]\n{load_res.summary()}"
    )
    if load_res.tickers_failed:
        sample = ", ".join(load_res.tickers_failed[:10])
        more = "" if len(load_res.tickers_failed) <= 10 else f" 외 {len(load_res.tickers_failed)-10}건"
        body += f"\n실패 종목: {sample}{more}"

    logger.info(body.replace("\n", " | "))
    send_telegram(body)

    if load_res.tickers_failed:
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        logger.warning("interrupted by user")
        sys.exit(130)
