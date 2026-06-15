| 항목 | 내용 |
|------|------|
| 문서명 | 데이터 수집 파이프라인 설계 |
| 버전 | V1 |
| 날짜 | 2026-06-13 |
| 작성자 | Claude Opus 4.7 |
| 문서 유형 | 설계 문서 (Step 2 — 데이터 수집기) |
| 사용 모델 | claude-opus-4-7 |

---

# 1. 목표

KOSPI + KOSDAQ 전체 종목의 일봉 데이터를 원격 MariaDB 서버(192.168.20.80)에 자동 적재한다.
초기 5년치 일괄 적재 + 매일 평일 증분 업데이트.

---

# 2. 사용자 결정 사항 (확정)

| 항목 | 결정 |
|------|------|
| 수집 범위 | KOSPI + KOSDAQ 전체 (ETF/우선주/스팩 포함, ~3,000+ 종목) |
| 기간 | 최근 5년 |
| 트리거 | 원격 Linux 서버 cron |
| 실행 위치 | 원격 서버 직접 실행 (Electron 무관) |

---

# 3. 실행 환경

| 항목 | 값 |
|------|-----|
| 호스트 | 192.168.20.80 (Linux, MariaDB 동일 서버) |
| Python | 3.10 이상 |
| 주요 패키지 | pykrx, pymysql, python-dotenv |
| 패키지 격리 | 전용 venv (`/opt/stock-collector/venv`) |
| 실행 사용자 | 전용 system 계정 (예: `stockbot`) |
| 시간대 | KST (Asia/Seoul) |

---

# 4. 디렉토리 구조 (서버측)

```
/opt/stock-collector/
├── .env                          # DB 접속 정보 (chmod 600)
├── .env.example
├── requirements.txt
├── venv/                         # Python 가상환경
├── collector/
│   ├── __init__.py
│   ├── config.py                 # .env 로드 + 상수
│   ├── db.py                     # pymysql 연결 + 헬퍼
│   ├── krx.py                    # pykrx 래퍼 (재시도 포함)
│   ├── tickers.py                # 종목 목록 → stock_info 동기화
│   ├── ohlcv.py                  # 일봉 수집 → stock_daily INSERT
│   └── log.py                    # RotatingFileHandler 로깅
├── scripts/
│   ├── init_load.py              # 초기 5년치 일괄 적재
│   └── incremental.py            # 매일 증분 (cron 호출 대상)
├── logs/
│   └── collector.log             # 30일 로테이션
└── state/
    └── failed_tickers.json       # 실패 종목 재시도 큐
```

---

# 5. 처리 흐름

## 5-1. 1단계 — 종목 목록 수집 (tickers.py)

| 작업 | 내용 |
|------|------|
| API 호출 | `stock.get_market_ticker_list(date, market="KOSPI")` + `"KOSDAQ"` 각각 |
| 종목명 조회 | `stock.get_market_ticker_name(ticker)` |
| 시장 구분 | KOSPI / KOSDAQ |
| 신규 종목 | `INSERT IGNORE stock_info (ticker, name, market) VALUES (...)` |
| 종목명 변경 | name 차이 시 UPDATE |
| 상장 폐지 | DB에 있는데 pykrx 응답 없음 → `is_active=FALSE` (스키마 추가 필요) |
| 휴장일 | pykrx 빈 응답 시 직전 영업일로 재호출 (`get_previous_business_day`) |

## 5-2. 2단계 — 일봉 수집 (ohlcv.py)

| 모드 | 동작 |
|------|------|
| init (최초 1회) | 각 ticker마다 `get_market_ohlcv_by_date(from, to, ticker)`. from = today−5년, to = today |
| incremental (매일) | `SELECT MAX(trade_date)` → from = MAX+1일, to = today. MAX 없으면 5년 전부터 (신규 상장) |

| 항목 | 처리 |
|------|------|
| 컬럼 매핑 | 시가→open, 고가→high, 저가→low, 종가→close, 거래량→volume. `등락률`은 저장 안 함 |
| Rate limit | 종목 사이 `time.sleep(0.3)` (KRX 차단 회피) |
| 배치 INSERT | 종목 단위 `executemany` + `INSERT IGNORE` |
| 실패 처리 | 종목별 try/except, `failed_tickers.json` 누적, 1회 재시도 |
| 진행 로그 | 100종목마다 진행률 INFO |

## 5-3. 3단계 — DB 저장 (db.py)

| 항목 | 처리 |
|------|------|
| 연결 | pymysql, charset utf8mb4, autocommit=False |
| 재연결 | 실행 전 `ping(reconnect=True)` |
| INSERT 방식 | `INSERT IGNORE INTO stock_daily (...) VALUES (...)` — UNIQUE(ticker,trade_date) 활용 |
| 트랜잭션 | 종목 단위 commit. 실패 시 롤백 + 로그 |
| FK 순서 | stock_info 먼저, stock_daily 다음 |

## 5-4. 4단계 — 증분 실행 (incremental.py)

| 단계 | 내용 |
|------|------|
| ① 영업일 체크 | 오늘이 휴장이면 종료 |
| ② 종목 목록 동기화 | tickers.py 실행 |
| ③ 종목별 증분 수집 | ohlcv.py incremental 모드 |
| ④ 실패 재시도 | failed_tickers.json 비우기 |
| ⑤ 요약 로그 | 신규 N행, 성공/실패 카운트, 소요시간 |
| ⑥ exit code | 0=정상, 1=부분 실패, 2=전체 실패 |

---

# 6. cron 등록

```
30 16 * * 1-5 cd /opt/stock-collector && ./venv/bin/python -m scripts.incremental >> logs/cron.log 2>&1
```

- 16:30 KST (장마감 15:30 + 데이터 안정화 60분)
- 평일만 (월~금)
- stdout/stderr는 `cron.log`, 앱 로그는 `collector.log`

---

# 7. 스키마 변경 제안 (선택)

상장 폐지 종목 관리를 위해 stock_info 확장 권장:

| 컬럼 | 타입 | 용도 |
|------|------|------|
| `is_active` | BOOLEAN DEFAULT TRUE | 거래 가능 여부 |
| `listed_date` | DATE NULL | 상장일 |
| `delisted_date` | DATE NULL | 폐지일 |
| `last_synced_at` | TIMESTAMP | 마지막 동기화 시각 |

→ 추가 시 `ALTER TABLE stock_info ADD COLUMN ...` 마이그레이션 필요.
→ 추가 안 하면: 폐지 종목도 stock_info에 남고 stock_daily에 새 데이터만 안 들어옴 (FK 위반 없음).

**사용자 결정 필요.**

---

# 8. 부하 추정

## 초기 적재 (1회성)

| 항목 | 값 |
|------|-----|
| 종목 수 | ~3,000 |
| 종목당 행수 | ~1,250 (5년 영업일) |
| 총 행수 | ~3,750,000 |
| 종목당 시간 | 3~5초 (API + sleep 0.3초) |
| 전체 시간 | 약 3~5시간 |
| DB 저장 시간 | ~10분 (네트워크 의존) |

## 증분 (매일)

| 항목 | 값 |
|------|-----|
| 종목당 행수 | 1 행 |
| 종목당 시간 | ~0.5초 |
| 전체 시간 | 약 25~30분 |
| 신규 행수 | ~3,000 |

---

# 9. 환경 변수 (.env)

```
DB_HOST=127.0.0.1            # 동일 서버이므로 로컬
DB_PORT=3306
DB_USER=stock_collector       # 전용 계정 권장 (root 사용 자제)
DB_PASSWORD=<별도 관리>
DB_NAME=stock_analysis
SLEEP_BETWEEN_TICKERS=0.3
INIT_YEARS=5
LOG_LEVEL=INFO
```

→ `DB_HOST`는 서버 로컬 실행이므로 `127.0.0.1`이 안전. root 대신 수집 전용 계정 권장.

---

# 10. 엣지 케이스 정리

| 상황 | 처리 |
|------|------|
| 주말/공휴일 cron | 평일 cron이므로 발동 안 함. 발동돼도 영업일 체크 후 종료 |
| 신규 상장 종목 | stock_info INSERT → 상장일부터 일봉 수집 |
| 상장 폐지 | is_active=FALSE 마킹 (스키마 확장 시) / 일봉만 정지 |
| pykrx 일시 오류 | 종목별 try/except → failed_tickers 기록 → 1회 재시도 |
| DB 연결 끊김 | `ping(reconnect=True)` |
| 종목명 변경 | UPDATE stock_info SET name=... |
| 액면분할 | pykrx 수정주가 미반영 — 현 단계 보류 (향후 별도 정정 스크립트) |
| ETF/우선주 | market 컬럼만으론 구별 어려움 — 향후 `instrument_type` 컬럼 추가 검토 |

---

# 11. 보안

| 항목 | 조치 |
|------|------|
| .env 파일 | `chmod 600`, root 또는 stockbot만 읽기 |
| DB 계정 | 수집 전용 `stock_collector` — INSERT/SELECT/UPDATE만, DROP 불가 |
| cron 로그 | 비밀번호 stdout 금지 — config.py에서 에러 메시지에 절대 노출 안 함 |
| SQL Injection | 모든 쿼리 파라미터 바인딩 (`%s` placeholder, 문자열 포맷 금지) |

---

# 12. 미결 항목 (사용자 검토 필요)

| # | 항목 |
|---|------|
| 1 | stock_info에 is_active/listed_date/delisted_date/last_synced_at 컬럼 추가? (권장: 예) |
| 2 | DB 계정 — root 그대로 사용? 또는 `stock_collector` 신규 생성? (권장: 신규 생성) |
| 3 | 초기 적재 — 한 번에 5년치? 또는 1년씩 5회 분할? (권장: 한 번에, 야간 실행) |
| 4 | cron 시각 — 16:30 KST? (장마감 + 60분) |
| 5 | 실패 알림 — 이메일/없음? (권장: 1단계 로그만, 추후 확장) |
| 6 | 로그 보관 — 30일 로테이션? |
| 7 | Python venv 위치 — `/opt/stock-collector/venv` OK? 다른 경로 선호? |
| 8 | 서버에 Python 3.10+ 설치 상태 확인 필요 |
| 9 | 수집 전용 system 계정(`stockbot`) 생성 권한 보유? |

---

# 13. 다음 단계

1. 미결 항목 12개 결정
2. 본 문서 V2로 개정 (결정 사항 반영)
3. 사용자 `구현해줘` 트리거 입력
4. 서버 환경 셋업 (venv, requirements.txt 설치)
5. tickers.py 단독 실행 → stock_info 채우기 검증
6. ohlcv.py 1~2 종목 테스트 → 전체 적재
7. cron 등록 → 다음 영업일 증분 확인
