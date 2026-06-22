"""us_sync.py — US 종목 마스터/일봉 동기화 CLI.

사용:
  python -m collector.scripts.us_sync --mode master                  # 마스터만
  python -m collector.scripts.us_sync --mode init --ticker AAPL      # 단일 5y 초기 적재
  python -m collector.scripts.us_sync --mode incremental             # 전체 등록 US 증분
  python -m collector.scripts.us_sync --mode incremental --ticker AAPL
  python -m collector.scripts.us_sync --mode status                  # 마스터 상태 출력
"""

import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import argparse
import json
from datetime import date

from collector import yfinance_us
from collector.log import get_logger

logger = get_logger(__name__)


def main() -> int:
    p = argparse.ArgumentParser(description="US 종목 동기화")
    p.add_argument(
        "--mode",
        required=True,
        choices=["master", "init", "incremental", "status"],
        help="동작 모드",
    )
    p.add_argument("--ticker", default=None, help="단일 종목 (init/incremental)")
    args = p.parse_args()

    if args.mode == "master":
        count = yfinance_us.fetch_master()
        print(json.dumps({"mode": "master", "tickers": count}, ensure_ascii=False))
        return 0

    if args.mode == "init":
        if not args.ticker:
            print("init mode requires --ticker", file=sys.stderr)
            return 2
        inserted = yfinance_us.fetch_ohlcv_5y(args.ticker.upper())
        print(json.dumps({"mode": "init", "ticker": args.ticker.upper(),
                          "inserted": inserted}, ensure_ascii=False))
        return 0

    if args.mode == "incremental":
        if args.ticker:
            inserted = yfinance_us.fetch_ohlcv_incremental(args.ticker.upper())
            print(json.dumps({"mode": "incremental", "ticker": args.ticker.upper(),
                              "inserted": inserted}, ensure_ascii=False))
        else:
            result = yfinance_us.incremental_all_us()
            print(json.dumps({"mode": "incremental_all", "tickers": len(result),
                              "result": result}, ensure_ascii=False))
        return 0

    if args.mode == "status":
        should = yfinance_us.should_sync_master(date.today())
        has = yfinance_us.has_master_data()
        print(json.dumps({"mode": "status", "has_master": has,
                          "should_sync_today": should}, ensure_ascii=False))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
