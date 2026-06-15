| 항목 | 내용 |
|------|------|
| 문서명 | collector/ 폴더 가이드 |
| 버전 | V1 |
| 날짜 | 2026-06-13 |
| 작성자 | Claude Opus 4.7 |
| 문서 유형 | 폴더 GUIDE |
| 사용 모델 | claude-opus-4-7 |

# collector/ — 한국 주식 일봉 수집기

원격 Linux 서버(192.168.20.80)에서 단독 실행되는 Python 수집기.
Electron 앱과 무관 — 동일 MariaDB만 공유.

## 파일별 책임

| 파일 | 책임 |
|------|------|
| `__init__.py` | 패키지 마커 + 버전 |
| `config.py` | `.env` 로드, 환경 상수 노출 |
| `log.py` | `collector.log` 로깅 (30일 로테이션) |
| `notify.py` | 텔레그램 알림 (graceful skip) |
| `db.py` | pymysql 싱글톤 + 트랜잭션 헬퍼 |
| `krx.py` | pykrx 래퍼 + 재시도(3회 지수 백오프) |
| `tickers.py` | `stock_info` 동기화 (신규/변경/폐지) |
| `ohlcv.py` | `stock_daily` 적재 (init/incremental/retry_failed) |
| `scripts/init_load.py` | 진입점 — 초기 5년치 일괄 |
| `scripts/incremental.py` | 진입점 — 매일 증분 (cron) |

## 실행 진입점

```bash
# 초기 1회 (5년치 ~3~5시간)
./venv/bin/python -m collector.scripts.init_load

# 매일 증분 (cron 호출 대상)
./venv/bin/python -m collector.scripts.incremental
```

## 의존 모듈 호출 순서

```
scripts.init_load / scripts.incremental
        │
        ├─ config (env 로드)
        ├─ log    (로깅 초기화)
        ├─ db     (DB 연결/ping)
        ├─ krx    (pykrx 래퍼)
        ├─ tickers.sync_tickers()
        ├─ ohlcv.init_load() / ohlcv.incremental()
        └─ notify.send_telegram(요약)
```

## 검증 명령 (서버에서)

```bash
# 환경 변수 확인
./venv/bin/python -c "from collector import config; print(config.summary())"

# DB 연결만 테스트
./venv/bin/python -c "from collector import db; print('OK' if db.ping() else 'FAIL')"

# 종목 동기화만 단독 실행
./venv/bin/python -c "from collector import tickers; print(tickers.sync_tickers().summary())"

# 단일 종목 일봉 1개월 테스트
./venv/bin/python -c "
from datetime import date, timedelta
from collector import krx
today = date.today()
df = krx.get_ohlcv('053800', today - timedelta(days=30), today)
print(df.tail())
"

# 텔레그램 전송 테스트
./venv/bin/python -c "from collector.notify import send_telegram; print(send_telegram('테스트 메시지'))"
```

## 로그 위치

```
collector/logs/collector.log        (현재)
collector/logs/collector.log.YYYY-MM-DD  (로테이션 백업, 30일)
```

## 실패 종목 큐

```
collector/state/failed_tickers.json
```

`retry_failed()` 함수로 단독 재시도 가능. 다음 cron 실행 시 자동 청소.

## 설계 결정 요약

| 결정 | 사유 |
|------|------|
| DB 호스트 `127.0.0.1` 기본값 | 동일 서버 실행 — 네트워크 우회로 안정성 ↑ |
| `INSERT IGNORE` + UNIQUE 인덱스 | 중복 처리 단순화. 부분 적재 안전 |
| 종목 간 0.3초 sleep | KRX rate limit 회피 — 차단 사례 보고 있음 |
| 단일 트랜잭션 (종목 단위) | 실패 시 종목별 격리 — 다른 종목 영향 없음 |
| 텔레그램 graceful skip | 토큰 누락 시에도 수집은 계속 — 알림은 보조 |
| `is_active=FALSE`로 폐지 표시 | 히스토리 보존 + FK 위반 방지 |
| 휴장일 cron 무알림 종료 | 텔레그램 스팸 방지 |

## CLAUDE.md 준수 사항

- 파일 헤더 주석: 모든 파일 포함 ✓
- Python 인코딩 안전: `config.py`에서 `sys.stdout.reconfigure` 처리 ✓
- 단일 책임: 파일당 1개 모듈 책임 ✓
- 한글 주석: 변수/함수 의도 명시 ✓
- 파라미터 바인딩: SQL에 `%s` 플레이스홀더만 사용 (SQL Injection 방지) ✓
- 예외 처리: 외부 호출(pykrx/requests/DB)은 모두 try/except ✓
