# src/services/ GUIDE

| 항목 | 내용 |
|------|------|
| 폴더명 | src/services |
| 목적 | 비즈니스 로직 및 데이터 처리 서비스 |
| 파일 수 | 3개 |
| 수정일 | 2026-06-11 |

---

## 개요

`src/services/` 폴더는 Electron 메인 프로세스의 중간 계층 로직을 담당합니다.
DB 연결(src/db/)과 렌더러(src/renderer/) 사이의 데이터 흐름을 처리합니다.

```
DB (stock_daily 등)
    ↓
src/services/ (데이터 변환 + 계산)
    ↓
main.js IPC 핸들러
    ↓
renderer.js (UI)
```

---

## 포함 파일

### 1. csvImport.js (Step 4)

**목적**: CSV 파일 파싱 및 DB INSERT

| 함수 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `importCsv` | (filePath, ticker) | {success, inserted, duplicates, errors} | CSV 스트림 처리 → INSERT IGNORE |
| `convertDate` | "20140319" | "2014-03-19" | Date 변환 헬퍼 |
| `executeBatchInsert` | (pool, batch, results) | void | 배치 INSERT 실행 |

**핵심 특성**:
- **스트림 방식**: fs.createReadStream + readline
- **배치 크기**: 100행
- **중복 처리**: INSERT IGNORE (기존 데이터 보존)
- **에러 격리**: 한 행 실패 → 다음 행 계속 처리

**호출 경로**:
```
renderer.js [CSV import 버튼]
    ↓ IPC: db:importCsv
main.js ipcMain.handle('db:importCsv')
    ↓
services/csvImport.importCsv()
    ↓ fs.createReadStream + readline
readline 'line' 이벤트 ×N
    ↓
executeBlockInsert() ×(N/100)
    ↓ pool.execute() SQL
DB: INSERT IGNORE stock_daily
    ↓
{success: true, inserted: N, duplicates: M, errors: []}
```

**파일 형식 (ahnlab_daily.csv)**:
```
date,open,high,low,close,volume,change_ratio
20140319,55000,55500,54800,54900,64301,
20140320,54700,55000,53400,53400,122097,-2.732...
```

**주요 설계 결정**:
- ✅ 배치 크기 100: 성능(DB 왕복) vs 메모리(배치당 ~10KB) 균형
- ✅ INSERT IGNORE: 재import 시 중복 자동 필터 (추가 로직 불필요)
- ✅ 스트림 처리: 메모리 효율 (대용량 파일 지원)

**에러 케이스**:
- 파일 없음 → "파일 스트림 에러"
- 날짜 형식 오류 → "잘못된 날짜 형식: XXXXX"
- 숫자 변환 실패 → "숫자 변환 실패: ..."
- DB 연결 끊김 → "배치 INSERT 실패: ER_..."

---

### 2. indicators.js (Step 5)

**목적**: 12개 기술지표 계산

| 지표 | 기간 | 특이사항 |
|------|------|---------|
| MA5/20/60/120 | 5,20,60,120 | 단순평균 |
| 볼린저밴드 | 20, 2σ | **표본분산(N-1) 사용** |
| OBV + OBV MA20 | — | 수급 방향 |
| **RSI** | 14 | **⚠️ Wilder 평활 필수** (단순 EMA X) |
| MACD | 12,26,9 | EMA 초기값 = 단순평균 |
| 스토캐스틱 | 14,3 | K/D 평활 |
| ATR | 14 | **Wilder 평활** |
| CCI | 20 | Typical Price 기반 |
| VWAP | 누적 | 일봉 근사치 (정확도: 중급) |
| 다이버전스 | 5일 간격 | RSI/OBV 피벗 비교 |
| 캔들 패턴 | 1캔들 | 6가지 패턴 인식 |

**핵심 함수**:

```javascript
calculateAll(ohlcvArr, fromDate, toDate)
  └─ 전체 지표 계산 진입점
     ├─ Input-based Paging: fromDate/toDate 범위 필터링
     ├─ calcMA(data, period)
     ├─ calcBB(closes, period, mult)
     ├─ calcOBV(closes, volumes)
     ├─ calcRSI(closes, period)  // ⚠️ Wilder 평활
     ├─ calcMACD(closes, fast, slow, signal)
     ├─ calcEMA(data, period)    // MACD 보조
     ├─ calcStochastic(highs, lows, closes, k, d)
     ├─ calcATR(highs, lows, closes, period)
     ├─ calcCCI(highs, lows, closes, period)
     ├─ calcVWAP(highs, lows, closes, volumes)
     ├─ detectDivergence(closes, rsiValues, obvValues)
     └─ detectCandlePattern(open, high, low, close, prevCandle)
```

**입출력 형식**:

```javascript
// 입력
const ohlcvArr = [
  { date: '2014-03-19', open: 55000, high: 55500, low: 54800, close: 54900, volume: 64301 },
  { date: '2014-03-20', open: 54700, high: 55000, low: 53400, close: 53400, volume: 122097 },
  ...
];

// 출력
const indicators = calculateAll(ohlcvArr, '2014-06-01', '2014-12-31');
// [
//   {
//     date: '2014-06-11',
//     open: 58200,
//     close: 58500,
//     ma5: 58300,
//     ma20: 57800,
//     bbUpper: 60000,
//     bbMiddle: 57800,
//     bbLower: 55600,
//     bbPctB: 0.42,
//     bbWidth: 0.076,
//     obv: 4521000,
//     obvMa20: 4500000,
//     rsi: 62.4,
//     macd: 150,
//     macdSignal: 120,
//     macdHistogram: 30,
//     stochK: 75.2,
//     stochD: 72.5,
//     atr: 450,
//     cci: 85,
//     vwap: 57600,
//     rsiDivergence: null,
//     obvDivergence: null,
//     candlePattern: 'bullish_tail'
//   },
//   ...
// ]
```

**호출 경로**:

```
renderer.js [차트 탭 종목 선택]
    ↓ IPC: db:getStockData(ticker, days)
main.js ipcMain.handle('db:getStockData')
    ↓
SQL: SELECT ... FROM stock_daily ORDER BY trade_date ASC LIMIT 120
    ↓
services/indicators.calculateAll(ohlcvArr)
    ↓ [12개 지표 계산]
결과 배열 반환
    ↓
renderer.js → chart.js 렌더링
```

**Input-Based Paging 설계**:

**오프셋 방식 (금지)**: `LIMIT 100 OFFSET 500`
- 문제: 범위가 애매함 (100개의 어느 부분인가?)
- RSI 같은 지표는 이전 데이터 필요 (오프셋 방식으로 불가능)

**범위 방식 (채택)**: `fromDate='2024-01-01' toDate='2024-12-31'`
- 날짜 범위 명확
- 계산 기준 데이터(이전 35일)를 포함한 후 반환 범위만 필터
- 구현:
  ```javascript
  // 1. 계산: 전체 데이터로 지표 계산 (정확도 보장)
  const results = calculateAll(ohlcvArr);
  
  // 2. 필터: 범위 선택해서 반환
  const filtered = results.filter(r => r.date >= fromDate && r.date <= toDate);
  return filtered;
  ```

**주요 설계 결정**:

| 항목 | 결정 | 이유 |
|------|------|------|
| RSI 평활 | **Wilder 방식** | 정확한 RSI 정의 |
| 볼린저밴드 표준편차 | **표본분산 (N-1)** | 통계학적 권장 관례 |
| MACD 초기값 | **단순평균** | EMA 안정화 |
| 다이버전스 간격 | **최소 5일** | False signal 감소 |
| VWAP 계산 | **일봉 근사 (TP 방식)** | 정확한 VWAP은 분봉 필요 |
| 캔들 패턴 | **6가지 (상위 신뢰도만)** | 과잉 신호 방지 |

---

### 3. aiService.js (Step 9 - 구현 완료)

**목적**: Ollama + Claude API 통합 AI 채팅 서비스.

**주요 함수**:
- `chat({ message, ticker, engine, ohlcvData, onChunk, onDone })` — 채팅 진입점
- `chatWithOllama(messages, onChunk, onDone)` — HTTP NDJSON 스트리밍
- `chatWithClaude(systemPrompt, messages, onChunk, onDone)` — @anthropic-ai/sdk 스트리밍
- `detectMode(close, boxLow, boxHigh, avgPrice, volume, volMa20)` — 6가지 모드 자동 감지
- `buildSystemPrompt({ mode, holdings, stockInfo, latestIndicator })` — 4블록 조합

**Graceful Fallback**: CLAUDE_API_KEY 없으면 안내 메시지 반환 (크래시 없음)

---

## 설계 원칙

### 1. 단일 책임 원칙

하나의 파일 = 하나의 기능

```
csvImport.js   → CSV 파싱
indicators.js  → 지표 계산
aiService.js   → AI 통합
```

### 2. Pure Function

가능한 한 부작용 없이 (DB 쓰기 제외)

```javascript
// ✅ Good
function calcMA(data, period) {
  // input만 사용, 부작용 없음
  return ma;
}

// ❌ Bad
function calcMA(data, period) {
  // DB에 쓰기
  pool.execute('INSERT INTO ...');
  return ma;
}
```

### 3. Input-Based Filtering

오프셋 대신 범위 기반

```javascript
// ✅ Good
calculateAll(ohlcvArr, '2024-01-01', '2024-12-31')

// ❌ Bad
calculateAll(ohlcvArr).slice(100, 200)  // 범위 애매
```

### 4. 에러 격리

한 행 실패 → 계속 진행

```javascript
// ✅ Good
for (const row of batch) {
  try {
    // process
  } catch {
    results.errors.push(...);
    // 계속 진행
  }
}

// ❌ Bad
for (const row of batch) {
  // process (하나 실패하면 전체 중단)
}
```

---

## 메모리 특성

**안랩 10년 데이터 (2,500 거래일)**:
- Raw OHLCV: 2,500 × 7 × 8 bytes = ~140KB
- 지표 계산 결과: 2,500 × 15 지표 × 8 bytes = ~300KB
- 합계: ~540KB

**평가**: Electron에서 메모리 부담 없음. 수십만 행까지도 안전.

---

## 테스트 체크리스트

### csvImport.js 테스트
```
□ ahnlab_daily.csv (2,500행) import
  □ inserted 수 확인 (처음엔 2,500, 재import 시 0)
  □ duplicates 수 확인 (재import 시 2,500)
  □ DB 데이터 샘플 확인: SELECT * FROM stock_daily LIMIT 5

□ 잘못된 CSV 파일 처리
  □ 헤더 행 스킵 확인
  □ 날짜 형식 에러 → errors[] 포함
  □ 숫자 변환 에러 → errors[] 포함

□ 성능 테스트
  □ 10,000행 import 시간 < 30초
```

### indicators.js 테스트
```
□ 지표 계산 수치 검증
  □ RSI: 0~100 범위 확인
  □ MACD: 양수/음수 모두 가능
  □ OBV: 누적값 > 0
  □ BB %B: 0~1 범위 (극단값은 <0 또는 >1 가능)
  □ VWAP: close와 유사 (극단 차이 10% 이상이면 의심)

□ Input-based Paging 검증
  □ calculateAll(arr, '2024-01-01', '2024-12-31')
  □ 반환 배열 date >= '2024-01-01' AND date <= '2024-12-31' 확인
  □ 범위 외 데이터 미포함 확인

□ RSI Wilder 평활 검증
  □ 계산 결과와 TradingView RSI 비교 (±0.5 이내)

□ 다이버전스 감지 검증
  □ 5일 간격 피벗 조건 확인
  □ False signal 비율 < 30% (정성적 평가)
```

---

## 향후 확장

**Phase 2~3**:
- aiService.js 구현 (Ollama/Claude 통합)
- 프롬프트 템플릿 관리

**Phase 4+**:
- FinanceDataReader 자동 수집 연동
- 박스권 자동 탐지 알고리즘 (indicators.js 확장)
- 백테스트 결과 저장

---

*GUIDE.md V1 — 2026-06-11*
*다음: Step 4/5 구현 시 참조*
