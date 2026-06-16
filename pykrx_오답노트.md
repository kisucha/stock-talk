# pykrx 오답노트

| 항목 | 내용 |
|------|------|
| 문서명 | pykrx 반복 오류 사례집 |
| 버전 | V1 |
| 날짜 | 2026-06-16 |
| 작성자 | Claude Sonnet 4.6 |
| 문서 유형 | 오답노트 / 디버깅 참조 |
| 사용 모델 | claude-sonnet-4-6 |

> 이 파일은 pykrx / KRX 데이터 수집 시 자주 발생하는 오류를 기록한 참조 문서다.
> 새 오류 발생 시 맨 아래에 추가하고, 디버깅 전에 반드시 검토한다.

---

## 오류 1: get_market_ohlcv_by_ticker — KRX 로그인 필요

### 증상
```
KRX 로그인 실패: KRX_ID 또는 KRX_PW 환경 변수가 설정되지 않았습니다.
Error occurred in get_market_ohlcv_by_ticker: Expecting value: line 1 column 1 (char 0)
None of [Index(['시가', '고가', '저가', '종가'], dtype='object')] are in the [columns]
```
데이터 0건, 종목 0건.

### 원인
`pykrx.stock.get_market_ohlcv_by_ticker(date, market)` = **배치 API** (특정 날짜의 전종목 일괄 조회).
KRX 데이터 포털(data.krx.co.kr) 로그인 없으면 KRX API가 빈 body 반환 → JSON 파싱 실패.

`pykrx.stock.get_market_ohlcv_by_date(from, to, ticker)` = **단건 API** (특정 종목의 기간 조회).
로그인 없어도 정상 작동.

### 두 API 비교

| API | 방식 | KRX 로그인 | 속도 |
|-----|------|-----------|------|
| `get_market_ohlcv_by_ticker(date, market)` | 배치 (전종목/1일) | **필요** | 빠름 (2호출/일) |
| `get_market_ohlcv_by_date(from, to, ticker)` | 단건 (1종목/기간) | 불필요 | 느림 (~28분/2768종목) |

### 해결
KRX 계정 없으면 → `get_market_ohlcv_by_date` 기반 종목별 순회로 교체.
KRX 계정 있으면 → `stock.krx_login(KRX_ID, KRX_PW)` 후 배치 사용.

### 적용 파일
`collector/ohlcv.py` — `incremental()` 함수를 배치→단건 방식으로 전환 (2026-06-16).

---

## 오류 2: 글로벌 MAX(trade_date) 기반 증분 → 일부 종목 누락

### 증상
```
[incremental] 채울 구간 없음 (last=2026-06-16, today=2026-06-16)
```
일부 종목(예: 안랩)은 June 12까지만 있는데 증분이 아무 것도 안 함.

### 원인
`SELECT MAX(trade_date) FROM stock_daily` — 전체 테이블 최댓값.
일부 종목이 앞서 있으면 글로벌 MAX가 today가 되어 `from_d > today` → 전체 스킵.

### 해결
```sql
SELECT ticker, MAX(trade_date) AS last_d FROM stock_daily GROUP BY ticker
```
종목별 last_date를 1회 쿼리로 일괄 조회 후 개별 `from_d` 계산.

```python
def _range(t: str) -> Tuple[date, date]:
    last = last_dates.get(t)
    if last is None:
        return (fallback_from, today)
    return (last + timedelta(days=1), today)
```

### 적용 파일
`collector/ohlcv.py` — `incremental()` 글로벌 MAX → 종목별 MAX 전환 (2026-06-16).

---

## 빠른 진단 체크리스트

1. `KRX 로그인 실패` 메시지 → 배치 API 사용 불가, 단건 API로 전환
2. `Expecting value: line 1 column 1 (char 0)` → KRX API 빈 응답 (로그인 문제)
3. `채울 구간 없음` 인데 일부 종목 누락 → 글로벌 MAX 대신 종목별 MAX 사용
4. 수집 완료 후 특정 종목만 오래된 날짜 → 해당 종목 `_last_trade_date` 확인
