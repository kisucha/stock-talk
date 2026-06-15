# scripts/init_load.py — 초기 5년치 일괄 적재 진입점
# 실행: cd /opt/stock-collector && ./venv/bin/python -m collector.scripts.init_load
# 흐름: DB 헬스체크 → 종목 동기화 → 5년치 일봉 적재 → 텔레그램 요약
# Exit code: 0=정상, 1=부분실패, 2=전체실패
# 작성일: 2026-06-13

import sys
import time
from datetime import datetime

from collector import config, db, ohlcv, tickers
from collector.log import get_logger
from collector.notify import send_telegram

logger = get_logger(__name__)


def main() -> int:
    started_at = datetime.now()
    logger.info("=== init_load start ===")
    logger.info(config.summary())

    # ① DB 연결 확인
    if not db.ping():
        msg = f"❌ init_load 실패\n사유: DB 연결 불가\n시각: {started_at:%Y-%m-%d %H:%M:%S}"
        logger.error(msg)
        send_telegram(msg)
        return 2

    # ② 종목 동기화
    try:
        sync_res = tickers.sync_tickers()
    except Exception as e:
        logger.exception("ticker sync crashed")
        send_telegram(f"❌ init_load 실패\n단계: 종목 동기화\n오류: {e}")
        return 2

    if sync_res.total_active == 0:
        msg = "❌ init_load 중단: 활성 종목 0개"
        logger.error(msg)
        send_telegram(msg)
        return 2

    # ③ 일봉 적재
    try:
        load_res = ohlcv.init_load()
    except Exception as e:
        logger.exception("init_load crashed")
        send_telegram(f"❌ init_load 실패\n단계: 일봉 적재\n오류: {e}")
        return 2

    db.close_conn()

    # ④ 결과 요약
    elapsed_min = (datetime.now() - started_at).total_seconds() / 60.0
    body = (
        f"✅ init_load 완료\n"
        f"시작: {started_at:%Y-%m-%d %H:%M}\n"
        f"소요: {elapsed_min:.1f}분\n\n"
        f"[종목]\n{sync_res.summary()}\n\n"
        f"[일봉]\n{load_res.summary()}"
    )
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
