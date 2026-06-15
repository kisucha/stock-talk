# AI 주식 분석 시스템 — RESEARCH.md

| 항목 | 내용 |
|------|------|
| 문서명 | AI 주식 분석 시스템 심층 연구 보고서 |
| 버전 | V3 |
| 날짜 | 2026-06-15 |
| 작성자 | Claude Sonnet 4.6 (서브에이전트 9개 병렬 연구 통합) |
| 문서 유형 | 기술 연구 보고서 (RESEARCH.md) |
| 사용 모델 | claude-sonnet-4-6 |

> **용도**: 구현 시작 전 참조 기준 문서. 설계 결정 근거, 기술 선택 이유, 알고리즘 상세, 주의사항 모두 포함. 코딩 시 반드시 먼저 읽는다.

---

## 목차

1. [프로젝트 개요 및 전략 철학](#1-프로젝트-개요-및-전략-철학)
2. [시스템 아키텍처](#2-시스템-아키텍처)
3. [확정된 환경 정보](#3-확정된-환경-정보)
4. [기술 스택 상세 분석](#4-기술-스택-상세-분석)
5. [데이터베이스 설계](#5-데이터베이스-설계)
6. [CSV Import 처리](#6-csv-import-처리)
7. [기술적 지표 계산 알고리즘](#7-기술적-지표-계산-알고리즘)
8. [AI 시스템 프롬프트 설계](#8-ai-시스템-프롬프트-설계)
9. [Chart.js 차트 구성](#9-chartjs-차트-구성)
10. [Electron UI 레이아웃 및 IPC](#10-electron-ui-레이아웃-및-ipc)
11. [데이터 흐름 파이프라인](#11-데이터-흐름-파이프라인)
12. [잠재 문제 및 주의사항](#12-잠재-문제-및-주의사항)
13. [개발 로드맵 및 구현 순서](#13-개발-로드맵-및-구현-순서)
14. [Electron IPC 스트리밍 패턴](#14-electron-ipc-스트리밍-패턴)
15. [npm 패키지 정확한 버전 목록](#15-npm-패키지-정확한-버전-목록)
16. [FinanceDataReader + Python 연동](#16-financedatareader--python-연동)
17. [박스권 자동 탐지 알고리즘](#17-박스권-자동-탐지-알고리즘)
18. [Windows 알람 기능 구현](#18-windows-알람-기능-구현)
19. [실시간 데이터 소스 대안](#19-실시간-데이터-소스-대안)
20. [실시간 거래 기능 개요 및 설계 철학](#20-실시간-거래-기능-개요-및-설계-철학)
21. [키움 OpenAPI+ 상세](#21-키움-openapi-상세)
22. [Electron 차일드 윈도우 아키텍처](#22-electron-차일드-윈도우-아키텍처)
23. [DB 스키마 확장 (실시간 거래)](#23-db-스키마-확장-실시간-거래)
24. [실시간 데이터 흐름 파이프라인](#24-실시간-데이터-흐름-파이프라인)
25. [실시간 화면 UI 설계](#25-실시간-화면-ui-설계)
26. [실시간 거래 보안 및 주의사항](#26-실시간-거래-보안-및-주의사항)
27. [실시간 거래 개발 로드맵](#27-실시간-거래-개발-로드맵)

---

## 1. 프로젝트 개요 및 전략 철학

### 1.1 시스템 목적

박스권 종목의 기술적 분석을 AI와 대화하듯 수행하는 Windows 데스크탑 앱.
안랩(053800.KQ)처럼 장기 박스권을 유지하며 이슈 발생 시 급등하는 종목을 발굴하고,
오후 12시 퇴근 후 오후장에서 진입 타이밍을 판단하는 것이 핵심 사용 시나리오다.

### 1.2 투자 전략 5원칙

| 원칙 | 내용 | 시스템 반영 |
|------|------|-----------|
| 손절 없는 박스권 매매 | 박스권 확인된 종목만, 하단 매수 후 무기한 보유 | MODE 3 위기관리 모드 |
| 분할 매수 | 2~3회 나눠 진입, 평균 단가 관리 | MODE 1 매수탐색 모드의 1차/2차 진입가 |
| 이슈 대기 | 정치/보안 이슈 발생 시 박스권 상단 돌파 기대 | MODE 4 이슈추격 모드 |
| 오후장 집중 | 오전 변동성 소화 후 12시 이후 진입 | UI 설계 방향 |
| 일봉+단기봉 | 일봉으로 구역 설정, 15분봉으로 타이밍 정밀화 | 차트 탭 설계 |

### 1.3 안랩(053800) 이슈 히스토리

| 연도 | 이슈 | 시작가 | 고점 | 상승률 |
|------|------|--------|------|--------|
| 2017 | 안철수 대선 출마 | 53,700원 | 149,000원 | +178% |
| 2022 | 대선 출마 + 합당 | 66,700원 | 218,500원 | +228% |
| 2025 | 정치 이슈 | 60,100원 | 116,700원 | +94% |

### 1.4 실제 사용 시나리오 (오후장 루틴)

**점심 퇴근 직후 (12:00~12:15)**
1. 오전 흐름 확인 (일봉 + 30분봉)
2. 오늘 가격이 매수 구역인지 확인
3. 오후 시나리오 2개 머릿속에 정리

**오후 모니터링 (12:15~15:30)**
- 15분봉 or 30분봉 체크
- 매수 구역 + 양봉 + 거래량 조건 충족 시 진입

---

## 2. 시스템 아키텍처

### 2.1 전체 네트워크 구조

```
┌─────────────────────────────────────────────────────────┐
│                    로컬 네트워크                          │
│                                                         │
│  [사용자 PC — Electron 앱]                               │
│  ├─ 차트 뷰 (Chart.js 3패널)                            │
│  ├─ AI 채팅창 (스트리밍 응답)                            │
│  └─ 종목 관리 (종목 목록, CSV import)                   │
│        │                    ↑                           │
│        └── SQL (mysql2) ────┘                           │
│        │                                               │
│  [Linux 서버 — MariaDB 14]                              │
│  ├─ stock_info     (종목 기본 정보 + 박스권)             │
│  ├─ stock_daily    (일봉 OHLCV)                         │
│  ├─ user_holdings  (보유 현황)                          │
│  └─ chat_history   (AI 대화 기록)                       │
│                                                         │
│  [사용자 PC — Ollama]                                    │
│  └─ gemma4:12b (localhost:11434) ← 일상 분석 (무료)     │
│                                                         │
└─────────────────────────────────────────────────────────┘
         │
  [인터넷]
  └─ Claude API (Anthropic) ← 중요 매수 판단 (건당 15~30원)
```

### 2.2 AI 이중 엔진 구조

| 구분 | 엔진 | 사용 시점 | 맥락 유지 | 예상 비용 |
|------|------|----------|----------|---------|
| 기본 | Ollama (gemma4:12b) | 일상 조회, 지표 요약, 현황 분석 | 최근 10턴 | 무료 (전기세만) |
| 고급 | Claude (claude-sonnet-4-6) | 실제 매수 결정, 이슈 분석, 이례적 패턴 | 최근 20턴 | ~20원/회 |

### 2.3 Electron 내부 구조

```
main.js (메인 프로세스)
├── BrowserWindow 생성 + 보안 설정
├── ipcMain.handle() 핸들러 등록 (단일 반환용)
├── ipcMain.on() 핸들러 등록 (스트리밍 응답용)
├── mysql2 pool 관리 (DB 접속)
└── Ollama/Claude API 호출 + 청크 포워딩

preload.js (컨텍스트 브릿지)
├── contextBridge.exposeInMainWorld('appAPI', ...)
└── 렌더러에 안전한 API 노출만 허용

src/renderer/ (렌더러 프로세스 — UI)
├── index.html   — 3영역 레이아웃
├── renderer.js  — IPC 호출 + 이벤트 처리
├── chart.js     — Chart.js 초기화 및 갱신
└── styles.css   — 다크 테마
```

---

## 3. 확정된 환경 정보

### 3.1 확정 사항

| 항목 | 값 | 비고 |
|------|-----|------|
| Ollama 모델 | `gemma4:12b` | RTX 5060 Ti 16GB에서 실행 중 |
| DB 호스트 | `192.169.20.80` | ⚠️ 비표준 IP — 아래 주의사항 참고 |
| DB 포트 | `3306` | MariaDB 기본 포트 |
| DB 계정 | `root` | 전용 계정 생성 권장 |
| DB 이름 | `stock_analysis` | 생성 필요 |
| Node.js (로컬) | `v24.15.0` | Electron 메인 프로세스 |
| Node.js (서버) | `v20.20.2` | FinanceDataReader 스크립트용 (4단계) |
| Claude 모델 | `claude-sonnet-4-6` | 확정 |
| Electron | `v42.4.0` | Node 24.15.0 완전 호환 |

### 3.2 ✅ IP 주소 확인 완료

`192.169.20.80` — ping 응답 확인. 정상 접근 가능한 서버.
RFC 1918 표준 대역(192.168.x.x)은 아니지만 실제 내부망 주소로 운용 중.
별도 VPN/사설망 구성으로 추정. 연결 신뢰 가능.

**⚠️ 주의**: 표준 사설 IP가 아니므로 외부 노출 시 주의 (방화벽 확인 권장)

### 3.3 ✅ Ollama 모델 확인 완료

`ollama list` 실행 결과:

| 모델 | ID | 크기 | 비고 |
|------|----|------|------|
| `gemma4:12b` | 4eb23ef187e2 | **7.6 GB** | ✅ **기본 AI 엔진 확정** |
| `exaone3.5:2.4b` | 13644fc3d28e | 1.6 GB | 경량 모델 (백업용) |
| `gpt-oss:120b-cloud` | 569662207105 | - | 클라우드 기반 대형 모델 |
| `qwen3-coder:480b-cloud` | e30e45586389 | - | 클라우드 기반 코딩 특화 |
| `gemma4:31b-cloud` | c382fbfbc73b | - | 클라우드 기반 대형 Gemma |

**`gemma4:12b` 확정** — 로컬 실행, VRAM 7.6GB, RTX 5060 Ti 16GB에서 여유 있게 실행.

**클라우드 모델 활용 가능성** (참고):
- `gemma4:31b-cloud`: 31B 파라미터 — `gemma4:12b`보다 정확도 높을 가능성
- `gpt-oss:120b-cloud`: 120B 파라미터 — 고급 분석용 Ollama 대안 검토 가능
- 클라우드 모델은 외부 API 호출 → 응답 속도/비용 별도 확인 필요

---

## 4. 기술 스택 상세 분석

### 4.1 Electron + Node.js v24.15.0

**호환성**: Node.js v24.15.0 ↔ Electron v42.4.0 완전 호환.

**BrowserWindow 필수 보안 설정**:
```
contextIsolation: true     ← 필수 (메인/렌더러 프로세스 격리)
nodeIntegration: false     ← 필수 (렌더러에서 Node.js 직접 접근 차단)
sandbox: true              ← 권장
enableRemoteModule: false  ← 필수
```

**mysql2 사용 시 핵심 원칙**: 렌더러 프로세스에서 mysql2 직접 import 불가.
반드시 메인 프로세스 → IPC → 렌더러 구조로 분리.

**electron-builder Windows 패키징**:
- mysql2 v3.22.5는 순수 JavaScript 구현 → native binding 없음
- `asarUnpack` 설정 **불필요** (sqlite3 등 native C++ 모듈과 달리)
- 기본 설정으로 정상 패키징됨

### 4.2 mysql2 + MariaDB 14 원격 연결

**호환성**: MariaDB는 MySQL 프로토콜 완전 구현 → mysql2 별도 설정 없이 동작.

**연결 풀 핵심 설정**:

| 옵션 | 권장값 | 이유 |
|------|--------|------|
| `connectionLimit` | 10 | 동시 쿼리 5~10개면 충분 |
| `waitForConnections` | true | 연결 부족 시 에러 대신 대기 |
| `connectTimeout` | 15000 | 원격 연결은 15초 권장 |
| `timezone` | '+09:00' | 한국 시간대 (KST) — 일봉 날짜 오류 방지 필수 |
| `dateStrings` | ['DATE'] | DATE 컬럼을 문자열 YYYY-MM-DD로 반환 |
| `multipleStatements` | false | SQL injection 방지 |
| `enableKeepAlive` | true | 유휴 연결 유지 |

**MariaDB 14 특이사항**:
- strict mode 기본 활성화 → 빈 문자열 INT 삽입 불가
- `ON DUPLICATE KEY UPDATE ... AS new` 문법 지원 (MySQL 8+ 호환)

**주요 에러 코드 처리**:

| 코드 | 원인 | 대응 |
|------|------|------|
| `ECONNREFUSED` | DB 서버 미응답 | ping 테스트, 방화벽 3306 포트 확인 |
| `ER_ACCESS_DENIED_ERROR` | 인증 실패 | .env 비밀번호 확인, MariaDB 계정 권한 확인 |
| `ER_BAD_DB_ERROR` | DB 미존재 | `CREATE DATABASE stock_analysis` 실행 |
| `ETIMEDOUT` | 네트워크 지연 | connectTimeout 증가, 네트워크 상태 확인 |
| `ER_DUP_ENTRY` | UNIQUE 제약 위반 | CSV import는 INSERT IGNORE 사용 |

**INSERT IGNORE vs ON DUPLICATE KEY UPDATE**:
- 프로젝트 채택: `INSERT IGNORE` — 재import 시 기존 데이터 보존
- 데이터 갱신이 필요한 경우: `ON DUPLICATE KEY UPDATE` 사용

### 4.3 Ollama API (gemma4:12b)

**주요 엔드포인트**:

| 엔드포인트 | 메서드 | 용도 |
|-----------|--------|------|
| `POST /api/chat` | POST | 대화형 채팅 (스트리밍 지원) |
| `POST /api/generate` | POST | 단순 텍스트 생성 |
| `GET /api/tags` | GET | 설치된 모델 목록 |
| `POST /api/tokenize` | POST | 정확한 토큰 수 계산 |

**스트리밍 응답 처리**: Server-Sent Events (line-delimited JSON)
- `done: false` → 토큰 청크 (`message.content` 추출)
- `done: true` → 완료 (`total_duration`, `prompt_eval_count` 등 메타데이터 포함)

**gemma4:12b 특성**:
- VRAM: ~8~9GB (int8 양자화 기준)
- 응답 속도: RTX 5060 Ti 16GB에서 약 50 토큰/초
- 컨텍스트 길이: 4,096 토큰 (기본), 32K (확장 버전)
- 한국어: 기본 이해/생성 우수, 금융 전문 용어는 시스템 프롬프트로 보완 필요

**컨텍스트 관리** (4K 제한):
- 시스템 프롬프트: ~1,000~1,500 토큰
- 지표 데이터 [D]: ~500 토큰
- 개인 컨텍스트 [C]: ~300 토큰
- 대화 히스토리 10턴: ~2,000 토큰

### 4.4 Claude API (claude-sonnet-4-6)

**API 구조**:
- 엔드포인트: `POST https://api.anthropic.com/v1/messages`
- 시스템 프롬프트: `system` 파라미터 (messages 배열과 별도 — Ollama와 다름)
- SDK: `@anthropic-ai/sdk` v0.104.1 권장

**비용 계산** (claude-sonnet-4-6 기준):
- Input: $3 / 1M 토큰 ≈ 0.003원/토큰
- Output: $15 / 1M 토큰 ≈ 0.015원/토큰
- 1회 분석 (input 1,000 + output 500 토큰): 약 10~15원
- 하루 20회 × 15원 × 30일 = 약 9,000원/월

**에러 처리**:

| 상태 코드 | 원인 | 대응 |
|----------|------|------|
| 401 | API 키 오류 | .env CLAUDE_API_KEY 확인 |
| 429 | Rate limit | `Retry-After` 헤더 참고 후 대기 |
| 413 | 페이로드 초과 | 대화 히스토리 축소 |
| 500 | 서버 에러 | 지수 백오프로 재시도 |

---

## 5. 데이터베이스 설계

### 5.1 stock_info 테이블 (종목 기본 정보)

```sql
CREATE TABLE stock_info (
  ticker      VARCHAR(20)  PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  market      VARCHAR(20),
  box_low     INT,          -- 박스권 하단 (수동 설정)
  box_high    INT,          -- 박스권 상단 (수동 설정)
  note        TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 초기 데이터
INSERT INTO stock_info (ticker, name, market, box_low, box_high)
VALUES ('053800', '안랩', 'KOSDAQ', 51000, 70000);
```

**설계 의도**:
- `box_low`, `box_high`: AI 모드 자동 선택의 기준점. 수동 설정 필수.
- `note`: 종목 특이사항 (예: "안철수 관련주 / 보안주")

### 5.2 stock_daily 테이블 (일봉 OHLCV)

```sql
CREATE TABLE stock_daily (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ticker      VARCHAR(20)  NOT NULL,
  trade_date  DATE         NOT NULL,
  open        INT          NOT NULL,
  high        INT          NOT NULL,
  low         INT          NOT NULL,
  close       INT          NOT NULL,
  volume      BIGINT       NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ticker_date (ticker, trade_date),
  INDEX idx_ticker_date (ticker, trade_date)
);
```

**설계 의도**:
- `UNIQUE KEY (ticker, trade_date)`: CSV 재import 시 중복 자동 처리
- `INDEX idx_ticker_date`: 기간별 조회 성능 최적화
- 가격 컬럼 INT: 한국 주식 가격은 원(₩) 단위 정수
- `volume` BIGINT: 대형주 거래량은 INT 초과 가능

### 5.3 user_holdings 테이블 (보유 현황)

```sql
CREATE TABLE user_holdings (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  ticker          VARCHAR(20)  NOT NULL,
  avg_price       INT,
  quantity        INT,
  available_cash  INT,
  strategy        TEXT,
  horizon         TEXT,
  expected_issue  TEXT,
  split_plan      TEXT,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker)
);
```

**AI 컨텍스트 주입 매핑**:

| DB 컬럼 | AI 프롬프트 [C] 변수 | 계산식 |
|---------|---------------------|--------|
| avg_price | `{avg_price}` | 직접 조회 |
| quantity | `{quantity}` | 직접 조회 |
| avg_price × quantity | `{eval_amount}` | 앱에서 계산 |
| (close - avg_price) × quantity | `{pnl}` | 앱에서 계산 |
| available_cash | `{available_cash}` | 직접 조회 |
| stock_info.box_low | `{box_low}` | JOIN |
| stock_info.box_high | `{box_high}` | JOIN |

**split_plan 컬럼 JSON 형식**:

```json
{
  "plan": [
    {
      "order": 1,
      "price_range": [54000, 55000],
      "amount": 2000000,
      "shares_estimated": 37,
      "condition": "거래량 양봉 확인 후"
    },
    {
      "order": 2,
      "price_range": [51000, 52000],
      "amount": 2000000,
      "shares_estimated": 39,
      "condition": "2024년 전저점 근처, 지지 확인"
    }
  ],
  "reserve": {
    "amount": 1000000,
    "purpose": "이슈 추가 or 예상치 못한 하락 대비"
  }
}
```

**실제 사례 (현재 안랩 보유 현황)**:
- avg_price: 61,500원
- quantity: 341주 (2,100만원 투자)
- 현재가: ~56,000원 (-8.9%)
- available_cash: 500만원 (추가 분할 매수용)

### 5.4 chat_history 테이블 (AI 대화 기록)

```sql
CREATE TABLE chat_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ticker      VARCHAR(20),
  role        ENUM('user','assistant') NOT NULL,
  content     TEXT         NOT NULL,
  engine      ENUM('ollama','claude') DEFAULT 'ollama',
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticker_created (ticker, created_at)
);
```

**맥락 조회 쿼리 패턴**:
```sql
-- Ollama용: 최근 10턴
SELECT role, content, engine FROM chat_history
WHERE ticker = '053800'
ORDER BY created_at DESC
LIMIT 20;   -- 10턴 = user 10 + assistant 10 = 20행

-- Claude용: 최근 20턴
SELECT role, content, engine FROM chat_history
WHERE ticker = '053800'
ORDER BY created_at DESC
LIMIT 40;   -- 20턴 = 40행
```

### 5.5 테이블 관계도

```
stock_info (종목 마스터)
    │ PK: ticker
    │
    ├──→ stock_daily.ticker     (일봉 데이터)
    ├──→ user_holdings.ticker   (보유 현황)
    └──→ chat_history.ticker    (대화 기록)

stock_info.box_low, box_high ──→ AI 모드 자동 선택 기준
user_holdings.avg_price, quantity ──→ AI [C] 개인 컨텍스트 주입
stock_daily ──→ 지표 계산 소스 ──→ AI [D] 실시간 지표 주입
chat_history ──→ 대화 맥락 유지 (10턴/20턴)
```

---

## 6. CSV Import 처리

### 6.1 ahnlab_daily.csv 형식

```
date,open,high,low,close,volume,change_ratio
20140319,55000,55500,54800,54900,64301,
20140320,54700,55000,53400,53400,122097,-2.73224043715847
...
```

### 6.2 컬럼 매핑

| CSV 컬럼 | 형식 | DB 컬럼 | 변환 |
|---------|------|---------|------|
| date | YYYYMMDD (숫자) | trade_date (DATE) | "20140319" → "2014-03-19" |
| open | 정수 | open (INT) | 직접 |
| high | 정수 | high (INT) | 직접 |
| low | 정수 | low (INT) | 직접 |
| close | 정수 | close (INT) | 직접 |
| volume | 정수 | volume (BIGINT) | 직접 |
| change_ratio | 소수 | — | **저장 안 함** (재계산 가능) |

### 6.3 Date 변환 방법

```
"20140319" → 문자열 슬라이싱
year  = str.slice(0, 4)  // "2014"
month = str.slice(4, 6)  // "03"
day   = str.slice(6, 8)  // "19"
result = `${year}-${month}-${day}`  // "2014-03-19"
```

### 6.4 Import 처리 흐름

```
사용자: [CSV import] 버튼 클릭
  → dialog.showOpenDialog (파일 선택)
  → IPC: db:importCsv (파일 경로 전달)
  → main.js: csvImport.js 호출
    1. fs.createReadStream + readline
    2. 헤더 행 스킵
    3. 각 행 파싱: date 변환, 타입 변환
    4. 배치 INSERT IGNORE (100행 단위)
    5. 완료 후 결과 반환 (성공 N행, 중복 M행)
  → 렌더러: 완료 메시지 표시
```

### 6.5 배치 INSERT 패턴

성능 최적화를 위해 100행 단위 배치 처리:
```sql
INSERT IGNORE INTO stock_daily
  (ticker, trade_date, open, high, low, close, volume)
VALUES
  (?, ?, ?, ?, ?, ?, ?),
  (?, ?, ?, ?, ?, ?, ?),
  ...  (100행)
```

---

## 7. 기술적 지표 계산 알고리즘

### 7.1 최소 필요 데이터 포인트

| 지표 | 최소 | 권장 | 이유 |
|------|------|------|------|
| MA5 | 5 | 60 | 5일 이동평균 |
| MA20 (볼린저밴드) | 20 | 60 | 20일 이동평균 + 표준편차 |
| RSI(14) | 28 | 60 | 초기 14일 단순평균 + Wilder 평활 수렴 |
| MACD | 35 | 60 | EMA26 안정화에 35일 필요 |
| 스토캐스틱(14) | 17 | 60 | K(14) + D(3) |
| ATR(14) | 15 | 60 | 14일 Wilder 평균 |
| VWAP | 1 | 60 | 당일부터 누적 계산 |
| **통합 권장** | **35** | **60** | 모든 지표 안정화 |

**조회 쿼리 (최근 120일)**:
```sql
SELECT trade_date, open, high, low, close, volume
FROM stock_daily
WHERE ticker = ?
ORDER BY trade_date ASC
LIMIT 120;
```

### 7.2 OBV (On-Balance Volume)

**계산식**:
```
OBV[0] = 0
OBV[t] = OBV[t-1] + volume[t]   (close[t] > close[t-1])
OBV[t] = OBV[t-1] - volume[t]   (close[t] < close[t-1])
OBV[t] = OBV[t-1]               (close[t] = close[t-1])
```

**OBV MA20**: OBV 값의 20일 단순이동평균

**판단 기준**:
- OBV > OBV MA20: 수급 유입 → 매수세 우위
- OBV < OBV MA20: 수급 이탈 → 매도세 우위

**OBV 불리시 다이버전스 감지**:
- 조건: 가격 저점 하락 + OBV 저점 상승 (또는 횡보)
- 감지 알고리즘: 최근 N개 국소 최저값 비교 (5일 이상 간격)

### 7.3 볼린저밴드 (Bollinger Bands)

**계산식**:
```
MA20 = sum(close[i-19..i]) / 20

표준편차 σ = sqrt( sum((close[j] - MA20)^2 for j in [i-19..i]) / 19 )
             ← 표본분산(N-1) 사용 권장

BB_upper = MA20 + 2σ
BB_lower = MA20 - 2σ

%B = (close - BB_lower) / (BB_upper - BB_lower)
     0 = 하단, 0.5 = 중심, 1 = 상단

밴드폭(Bandwidth) = (BB_upper - BB_lower) / MA20
```

**판단 기준**:
- %B < 0.05: 하단 근처 → 과매도 경계
- %B > 0.95: 상단 근처 → 과매수 경계
- 밴드폭 수축 (스퀴즈): 큰 움직임 예고

### 7.4 RSI (Relative Strength Index, 14일)

**핵심**: Wilder 평활 방식 사용 — 단순 EMA와 다름.

**계산 단계**:
```
1단계 (초기값, 처음 14일):
   avg_gain_0 = sum(상승폭 14개) / 14   ← 단순평균
   avg_loss_0 = sum(하락폭 14개) / 14   ← 단순평균

2단계 (이후, Wilder 평활):
   avg_gain[t] = (avg_gain[t-1] × 13 + gain[t]) / 14
   avg_loss[t] = (avg_loss[t-1] × 13 + loss[t]) / 14

RSI = 100 - (100 / (1 + avg_gain / avg_loss))

gain[t] = max(close[t] - close[t-1], 0)
loss[t] = max(close[t-1] - close[t], 0)
avg_loss = 0일 때: RSI = 100
```

**⚠️ 주의**: 많은 구현이 단순 EMA를 쓰지만 정확한 RSI는 Wilder 평활 필수.

**판단 기준**:
- RSI < 30: 과매도 → 반등 가능성 증가
- RSI > 70: 과매수 → 조정 가능성 증가

**RSI 다이버전스 감지**:
- 일반 불리시: 가격 저점 낮아짐 + RSI 저점 높아짐 → 하락 약화 ★★★★
- 히든 불리시: 가격 저점 높아짐 + RSI 저점 낮아짐 → 상승 지속 ★★★★★

### 7.5 MACD

**계산식**:
```
EMA(n)[t] = close[t] × k + EMA(n)[t-1] × (1-k)
where k = 2 / (n + 1)

EMA12 = EMA(12)
EMA26 = EMA(26)
MACD = EMA12 - EMA26
Signal = EMA(9) of MACD
Histogram = MACD - Signal
```

**초기값**: 첫 번째 EMA 값 = 해당 기간 단순이동평균

**판단 기준**:
- MACD > 0 + Signal 상향 돌파 (골든크로스): 강한 상승 신호
- MACD < 0 + Signal 하향 돌파 (데드크로스): 하락 신호

### 7.6 스토캐스틱 (14, 3, 3)

```
K = (close - min(low, 14일)) / (max(high, 14일) - min(low, 14일)) × 100
D = SMA(K, 3)
```

**판단 기준**:
- K < 20: 과매도
- K > 80: 과매수
- K가 D를 상향 돌파 + K < 20: 매수 신호

### 7.7 ATR (Average True Range, 14일)

```
True Range[t] = max(
    high[t] - low[t],
    |high[t] - close[t-1]|,
    |low[t] - close[t-1]|
)

ATR[0] = 첫 14일 TR의 단순평균
ATR[t] = (ATR[t-1] × 13 + TR[t]) / 14  ← Wilder 평활
```

**활용**:
- 손절폭 = ATR × 1.5~2.0
- 목표가 = 진입가 + ATR × 3.0

### 7.8 CCI (Commodity Channel Index, 20일)

```
전형가격(TP) = (high + low + close) / 3
TP_MA20 = SMA(TP, 20)
평균편차(MAD) = SMA(|TP - TP_MA20|, 20)

CCI = (TP - TP_MA20) / (0.015 × MAD)
```

**판단 기준**:
- CCI > +100: 과매수
- CCI < -100: 과매도

### 7.9 이동평균 (MA)

```
MA_n[t] = sum(close[t-n+1..t]) / n
```

| MA | 기간 | 용도 |
|----|------|------|
| MA5 | 5일 | 단기 추세 |
| MA20 | 20일 | 볼린저밴드 중심, 중기 추세 |
| MA60 | 60일 | 중장기 추세 |
| MA120 | 120일 | 장기 추세 기준선 |

**정배열**: MA5 > MA20 > MA60 > MA120 → 강한 상승 추세

### 7.10 캔들 패턴 감지

| 패턴 | 조건 | 신뢰도 |
|------|------|--------|
| **아래꼬리 양봉** | close > open + 아래꼬리 > 몸통×2 + 거래량 증가 | ★★★★★ |
| **강세장악형** | 전일 close < 전일 open + 당일 open < 전일 close + 당일 close > 전일 open | ★★★★★ |
| **망치형** | 아래꼬리 > 몸통×2 + 위꼬리 < 몸통×0.5 | ★★★★ |
| **저점 갭업** | open > 전일 close + close > open | ★★★★ |
| **도지** | \|close - open\| < (high - low) × 0.1 | ★★★ |

**몸통 크기**: `abs(close - open)`
**아래꼬리**: `min(open, close) - low`
**위꼬리**: `high - max(open, close)`

### 7.11 VWAP (Volume Weighted Average Price)

**일봉 기반 VWAP의 한계**:
- 정확한 VWAP은 분봉(틱) 단위 계산 필요
- 일봉은 단 4개 값(OHLC)만 제공 → 근사치로 계산

**일봉 근사치 계산 (Typical Price 방식)**:
```
TP[t] = (high[t] + low[t] + close[t]) / 3  ← Typical Price

누적_VWAP[t] = sum(TP[i] × volume[i] for i in [0..t])
             / sum(volume[i] for i in [0..t])
```

**판단 기준**:
- close > VWAP: 매수세 우위 (현재가가 평균 매매가보다 높음)
- close < VWAP: 매도세 우위
- VWAP은 당일(intraday) 매매 기준선 — 일봉 근사치는 중기 흐름 참고용

---

## 8. AI 시스템 프롬프트 설계

### 8.1 4블록 조합 구조

```
최종 AI 입력 = [A] + [B] + [C] + [D]

[A] 기본 프롬프트 (고정)
    ├─ 역할 정의 (10년 경력 박스권 전문 트레이더)
    ├─ 분석 철학 (수급 우선, 불확실성 명시, 감정매매 경계)
    ├─ 답변 형식 (한국어, 수치 필수, 시나리오 A/B 제시)
    └─ 면책 사항

[B] 상황별 모드 프롬프트 (동적 — 6가지 중 자동 선택)
    ├─ MODE 1: 매수탐색 (현재가 박스권 하단 ±7% 이내)
    ├─ MODE 2: 익절관리 (현재가 박스권 상단 ±7% 이내)
    ├─ MODE 3: 위기관리 (현재가 박스권 하단 이탈)
    ├─ MODE 4: 이슈추격 (박스권 상단 이탈 + 거래량 2배↑)
    ├─ MODE 5: 리커버리 (평가손실 ≥ -10%)
    └─ MODE 6: 일반분석 (기본값)

[C] 개인 컨텍스트 (동적 — user_holdings + stock_info JOIN 조회)
    ├─ 매입단가, 보유수량, 평가손익
    ├─ 가용자금, 박스권 설정
    └─ 투자 전략, 기대 이슈, 분할 매수 계획

[D] 실시간 지표 데이터 (동적 — stock_daily 최근 60일 계산)
    ├─ 가격: 현재가(최신 close), 전일 대비, 고저
    ├─ 추세: MA5/20/60/120, MACD
    ├─ 수급: OBV, OBV MA20, 거래량 비율, VWAP
    ├─ 변동성: BB 상단/중심/하단, %B, 밴드폭, ATR
    ├─ 모멘텀: RSI, 스토캐스틱, CCI
    ├─ 다이버전스: RSI/OBV 다이버전스 상태
    └─ 캔들 패턴: 최근 캔들 유형
```

**⚠️ "현재가" 정의**: Phase 1~3에서는 실시간 시세 API 없음. DB의 가장 최근 stock_daily.close가 "현재가". 사용자가 수동으로 CSV import 후 분석하는 구조.

### 8.2 AI 모드 자동 선택 로직

```
입력: close (최신 close), box_low, box_high, avg_price, volume, vol_ma20

LOWER_ZONE = box_low × 1.07
UPPER_ZONE = box_high × 0.93
ISSUE_THRESHOLD = vol_ma20 × 2.0
LOSS_THRESHOLD = avg_price × 0.90

if close <= LOWER_ZONE AND close >= box_low:
    → MODE 1 (매수탐색)
elif close >= UPPER_ZONE AND close <= box_high:
    → MODE 2 (익절관리)
elif close < box_low:
    → MODE 3 (위기관리)
elif close > box_high AND volume >= ISSUE_THRESHOLD:
    → MODE 4 (이슈추격)
elif avg_price > 0 AND close <= LOSS_THRESHOLD:
    → MODE 5 (리커버리)
else:
    → MODE 6 (일반분석)
```

### 8.3 Claude API 전환 감지 조건

Ollama가 아래 키워드 감지 시 Claude 전환 제안:
- "들어가도 돼", "사야 해", "매수해야", "지금 살까"
- "진입 여부", "매수 결정"

전환 제안 UI: `[Ollama로 계속] [Claude API로 전환 (약 20원)]`

### 8.4 토큰 관리 전략

| 구분 | Ollama | Claude API |
|------|--------|-----------|
| 대화 기록 | 최근 10턴 (~2,000 토큰) | 최근 20턴 (~3,500 토큰) |
| 지표 데이터 | 핵심 5개 지표만 (~300 토큰) | 전체 12개 지표 (~800 토큰) |
| 예상 총합 | ~3,000 토큰/회 | ~5,500 토큰/회 |

**맥락 초기화 조건**:
1. 종목 변경 → 자동 초기화
2. '새 대화 시작' 버튼 클릭 → 수동 초기화
3. 마지막 대화로부터 24시간 경과 → 자동 초기화

### 8.5 AI 응답 형식 규칙

AI가 반드시 지켜야 할 답변 형식 (시스템 프롬프트 [A]에 포함):

**필수 요소**:
1. 수치 포함 (예: RSI 34.2, BB %B 0.04, OBV 411,757)
2. 근거 명시 (예: "OBV가 MA20을 회복하지 못하고 있어 수급이 약세입니다")
3. 시나리오 A/B 제시
4. 다음 확인 포인트 제시

**응답 표준 형식**:
```
[지표 요약]
- 현재가: {close}원 (전일 대비 {change}%)
- OBV: {값} (MA20: {값}) → {해석}
- RSI: {값} → {해석}
- BB %B: {값} → {해석}

[현재 모드: MODE {N}]
{모드별 핵심 분석}

[시나리오 A — 상승 시]
조건: ... → 대응: ... → 목표: ...

[시나리오 B — 하락 시]
조건: ... → 대응: ... → 지지선: ...

[추천 액션]
{구체적 행동 제안 + 조건}
```

### 8.6 AI 대화 시나리오 4가지

**시나리오 A: 일상 분석 (MODE 6, Ollama)**
```
사용자: "안랩 오늘 상태 어때?"
AI: "현재가 56,000원, RSI 34.2로 과매도 근접. OBV가 MA20을 하회 중으로
     수급이 약합니다. 박스권 하단(51,000원)까지 5.4% 여유.
     현재는 관망 구간이며, 53,000~54,000원대 접근 시 분할 1차 매수 검토 가능합니다."
```

**시나리오 B: 진입 타이밍 판단 (Claude 전환 제안)**
```
사용자: "지금 들어가도 될까?"
AI(Ollama): "매수 판단에 가까운 질문입니다. 보다 정밀한 분석을 위해
            Claude API로 전환하시겠습니까? (약 20원)
            [Ollama로 계속] [Claude로 전환]"
AI(Claude): "현재 상황: MODE 1 매수탐색 발동 (현재가 54,200원, 박스권 하단 ±7%).
            [시나리오 A] 거래량 양봉 확인 시 → 1차 진입 200만원
            [시나리오 B] 52,000원 이탈 시 → 진입 보류, 51,000원 재확인"
```

**시나리오 C: 물림 상태 리커버리 (MODE 5)**
```
사용자: "61,500원에 물렸는데 어떻게 해야 해?"
AI: "현재 평가손실 -8.9% (MODE 5 리커버리). 박스권은 유효합니다.
     분할 매수 계획대로 54,000원 접근 시 2차 추가 매수 실행 여부 판단.
     [시나리오 A] 평균 단가 낮추기: 54,000원에 200만원 추가 시 평균 58,500원
     [시나리오 B] 그대로 홀딩: 박스권 유지 + 이슈 대기"
```

**시나리오 D: 이슈 발생 (MODE 4)**
```
사용자: "안철수 대선 출마 뉴스 떴어!"
AI: "MODE 4 이슈추격 발동. 과거 이슈 시 +94~+228% 전례.
     거래량 평균의 {배수}배 확인. 현재 박스권 상단(70,000원) 돌파 여부 모니터링.
     [시나리오 A] 70,000원 돌파 시 → 보유 유지, 10만원 단위 트레일링
     [시나리오 B] 거래량 감소 + 70,000원 저항 시 → 일부 익절 고려"
```

---

## 9. Chart.js 차트 구성

### 9.1 플러그인 의존성 (확정 버전)

| 패키지 | 확정 버전 | 역할 |
|--------|----------|------|
| `chart.js` | `^4.5.1` | 기본 차트 라이브러리 |
| `chartjs-chart-financial` | `^0.2.1` | 캔들스틱/OHLC 차트 |
| `chartjs-plugin-annotation` | `^3.1.0` | 박스권 수평선 오버레이 |

### 9.2 3패널 구성 방법

**권장: 3개 독립 Canvas**

```html
<div class="chart-container">
  <canvas id="chart-price" height="300"></canvas>  <!-- 캔들 + BB + MA -->
  <canvas id="chart-obv"   height="120"></canvas>  <!-- OBV + OBV MA20 -->
  <canvas id="chart-rsi"   height="100"></canvas>  <!-- RSI + 30/70 기준선 -->
</div>
```

### 9.3 캔들 데이터 형식

```javascript
// chartjs-chart-financial 데이터 형식
{
  x: new Date('2026-06-11'),  // Date 객체 필수
  o: 56500,  // open
  h: 57200,  // high
  l: 55800,  // low
  c: 56000,  // close
}
```

### 9.4 색상 팔레트 (다크 테마)

| 요소 | HEX |
|------|-----|
| 배경 | `#1a1a2e` |
| 양봉 | `#00ff88` |
| 음봉 | `#ff4444` |
| BB 상/하단 | `rgba(100, 150, 255, 0.5)` |
| BB 중심 (MA20) | `#888888` |
| OBV 라인 | `#44ff88` |
| OBV MA20 | `#ff8800` |
| RSI 라인 | `#ffff00` |
| RSI 30선 | `#44ff44` (점선) |
| RSI 70선 | `#ff4444` (점선) |
| 박스권 상단 | `rgba(255, 100, 100, 0.7)` (점선) |
| 박스권 하단 | `rgba(100, 255, 100, 0.7)` (점선) |

---

## 10. Electron UI 레이아웃 및 IPC

### 10.1 메인 레이아웃 구조

```
┌─────────────────────────────────────────────────────────┐
│ 상단 툴바: [종목선택▼] [기간: 60/120/전체▼] [Ollama/Claude] │
├──────────────┬──────────────────────────────────────────┤
│ 좌측 패널     │ 우측 메인 영역                             │
│ (200px 고정) │                                          │
│              │ [탭: 차트 | AI 채팅 | 종목 스캔]           │
│ [종목 목록]   │                                          │
│ - 안랩 053800│  [차트 탭]                                │
│              │    ├─ Canvas: 캔들+BB+MA (300px)         │
│ [+ 종목 추가] │    ├─ Canvas: OBV (120px)                │
│              │    └─ Canvas: RSI (100px)                │
│ [데이터 입력] │                                          │
│ [CSV import] │  [AI 채팅 탭]                             │
│              │    ├─ 대화창 (스크롤 가능)                │
│ [보유 현황]   │    └─ [메시지 입력] [전송] [새 대화]       │
│              │                                          │
│              │  [종목 스캔 탭]                           │
│              │    ├─ 조건 설정 패널                      │
│              │    └─ 결과 목록                          │
└──────────────┴──────────────────────────────────────────┘
```

### 10.2 오후장 모니터링 특화 UI

오후장(12:00~15:30) 집중 모니터링 지원 요소:

| UI 요소 | 설명 |
|---------|------|
| 현재 시간 표시 | 상단 바에 `12:35 오후장` 표시 |
| 매수 조건 체크리스트 | "매수구역 진입 ✓ / 양봉 ✓ / 거래량 ↑ ✗" 형태 |
| 마지막 업데이트 시각 | CSV import 시각 표시 ("데이터 기준: 6/11 15:30") |
| 타임존 표시 | KST 기준 명시 |

### 10.3 보유 현황 입력 폼

```
[보유 현황] 패널 (좌측 하단 or 별도 다이얼로그)
┌──────────────────────────────────────────────┐
│ 종목: 안랩 (053800)                          │
│                                              │
│ 매입단가:   [61,500]원                       │
│ 보유수량:   [341]주                          │
│ 가용자금:   [5,000,000]원                    │
│                                              │
│ 투자전략:   [박스권 하단 분할 매수]           │
│ 기대이슈:   [안철수 정치 행보]               │
│ 목표기간:   [6개월~1년]                      │
│                                              │
│ 분할 매수 계획:                              │
│  1차: [54,000~55,000]원 [200]만원            │
│  2차: [51,000~52,000]원 [200]만원            │
│  예비: [100]만원                             │
│                                              │
│            [저장]  [취소]                    │
└──────────────────────────────────────────────┘
```

IPC 채널: `db:updateHoldings(holdingsObj)` → split_plan은 JSON.stringify 후 저장

### 10.4 IPC 채널 상세

| 채널명 | 방향 | 파라미터 | 반환 |
|--------|------|---------|------|
| `db:getStockData` | renderer→main | `{ticker, days}` | OHLCV 배열 |
| `db:importCsv` | renderer→main | `{filePath, ticker}` | `{success, count, duplicates}` |
| `db:addTicker` | renderer→main | `{ticker, name, market, boxLow, boxHigh}` | `{success}` |
| `db:getHoldings` | renderer→main | `{ticker}` | holdings 객체 |
| `db:updateHoldings` | renderer→main | holdings 객체 | `{success}` |
| `ai:chat` | renderer→main | `{message, ticker, engine}` | (스트리밍 전용 채널 사용) |
| `ai:switchEngine` | renderer→main | `{engine: 'ollama'\|'claude'}` | `{success}` |
| `dialog:openFile` | renderer→main | — | 파일 경로 문자열 |
| `ai:chunk` | main→renderer | `{content, done}` | (이벤트) |
| `ai:done` | main→renderer | `{totalDuration, tokens}` | (이벤트) |

### 10.5 종목 스캔 결과 화면 (5단계)

```
[종목 스캔 탭]
┌──────────────────────────────────────────────────────────┐
│ [조건 설정]                                              │
│  52주 고저가 비율 < [2.0]배  박스권 체류율 > [60]%       │
│  시가총액 [500억] ~ [1조]원  [스캔 시작] [초기화]        │
├──────────────────────────────────────────────────────────┤
│ 결과: 23개 종목 발견 (2026-06-11 기준)                    │
│                                                          │
│ 종목명    | 현재가  | 52주고/저       | 박스권        | 거래량 |
│ 안랩      | 56,000 | 48,500/65,900  | 51,000/70,000 | 42,411 |
│ ...       |        |                |               |        │
│                                                          │
│ [상세 분석] → 클릭 시 차트 탭 전환 + AI 분석 시작         │
└──────────────────────────────────────────────────────────┘
```

### 10.6 preload.js contextBridge 설계

```javascript
// 안전하게 노출할 API 전체 목록
contextBridge.exposeInMainWorld('appAPI', {
  // DB
  getStockData:    (ticker, days)     => ipcRenderer.invoke('db:getStockData', ticker, days),
  importCsv:       (filePath, ticker) => ipcRenderer.invoke('db:importCsv', filePath, ticker),
  addTicker:       (info)             => ipcRenderer.invoke('db:addTicker', info),
  getHoldings:     (ticker)           => ipcRenderer.invoke('db:getHoldings', ticker),
  updateHoldings:  (holdings)         => ipcRenderer.invoke('db:updateHoldings', holdings),
  // AI (스트리밍)
  sendChat:        (msg, ticker, eng) => ipcRenderer.send('ai:chat', msg, ticker, eng),
  onAiChunk:       (callback)         => ipcRenderer.on('ai:chunk', (_, data) => callback(data)),
  onAiDone:        (callback)         => ipcRenderer.on('ai:done', (_, stats) => callback(stats)),
  removeAiListeners: ()               => {
    ipcRenderer.removeAllListeners('ai:chunk');
    ipcRenderer.removeAllListeners('ai:done');
  },
  switchEngine:    (engine)           => ipcRenderer.invoke('ai:switchEngine', engine),
  // 파일
  openFileDialog:  ()                 => ipcRenderer.invoke('dialog:openFile'),
});
```

---

## 11. 데이터 흐름 파이프라인

### 11.1 차트 렌더링 파이프라인

```
[사용자: 종목 선택]
      ↓
IPC: db:getStockData(ticker, 120)
      ↓
main.js → pool.execute('SELECT ... FROM stock_daily ORDER BY trade_date ASC LIMIT 120')
      ↓
raw OHLCV 배열 반환 (120개 행)
      ↓
indicators.js.calculate(ohlcvArr)
  ├─ calcMA(5, 20, 60, 120)
  ├─ calcBB(20, 2)             → {upper, middle, lower, pctB, width}
  ├─ calcOBV()                  → {obv, obvMa20}
  ├─ calcRSI(14)               → {rsi} (Wilder 방식)
  ├─ calcMACD(12, 26, 9)       → {macd, signal, histogram}
  ├─ calcStochastic(14, 3)     → {k, d}
  ├─ calcATR(14)               → {atr}
  ├─ calcCCI(20)               → {cci}
  ├─ calcVWAP()                → {vwap}
  ├─ detectDivergence()        → {rsiDiv, obvDiv}
  └─ detectCandlePattern()     → {pattern}
      ↓
chart.js.render(ohlcvArr, indicators)
```

### 11.2 AI 채팅 파이프라인 (스트리밍)

```
[사용자: 메시지 입력]
      ↓
renderer.js → ipcRenderer.send('ai:chat', message, ticker, engine)
      ↓
main.js ipcMain.on('ai:chat', ...) 핸들러
1. user_holdings + stock_info 조회 → [C] 개인 컨텍스트 생성
2. indicators.calculate(최근 60일) → [D] 지표 데이터 생성
3. currentMode = detectMode(...)   → [B] 모드 선택
4. systemPrompt = [A] + [B] + [C] + [D]
5. chatHistory = DB에서 최근 N턴 조회
6. AI API 호출 (스트리밍 fetch)
      ↓
[청크 수신 루프]
→ event.reply('ai:chunk', {content: "...", done: false})  (각 토큰마다)
→ event.reply('ai:done', {tokens, duration})               (완료 시)
      ↓
7. 완료 후 DB: INSERT INTO chat_history (user + assistant 두 행)
```

### 11.3 메모리 효율

안랩 10년 데이터 (~2,500 거래일):
- OHLCV raw: 2,500 × 7 × 8 bytes = ~140KB
- 지표 계산 결과: 2,500 × 15 지표 × 8 bytes = ~300KB
- Chart.js 렌더링 데이터: ~100KB
- **합계: ~540KB** — Electron에서 전혀 문제 없음

---

## 12. 잠재 문제 및 주의사항

### 12.1 보안 위험

| 위험도 | 항목 | 대응 방법 |
|--------|------|---------|
| HIGH | .env 파일 git 커밋 | .gitignore에 .env 추가 필수 |
| HIGH | DB 비밀번호 코드 하드코딩 | 반드시 .env에서만 로드 |
| HIGH | nodeIntegration: true 설정 | false로 유지, preload 경유 |
| MED | SQL injection | pool.execute() + 파라미터 바인딩 사용 |
| MED | Claude API 무한 호출 루프 | 비용 추적 + 일일 한도 설정 고려 |
| MED | root 계정 직접 사용 | 전용 계정(stock_user) 생성 권장 |
| LOW | CSV 데이터 검증 누락 | import 전 숫자 형식, 날짜 형식 검증 |

### 12.2 기술적 주의사항

| 항목 | 문제 | 해결 |
|------|------|------|
| RSI 계산 | 단순 EMA 사용 시 값 부정확 | Wilder 평활 방식 필수 |
| MACD 초기값 | EMA 초기값 미처리 시 초반 값 틀림 | 단순평균으로 초기값 설정 |
| 볼린저밴드 σ | 모분산 vs 표본분산 | 표본분산(N-1) 사용 |
| timezone | DB/앱 시간대 불일치 시 날짜 오류 | timezone: '+09:00' 설정 |
| 캔들 차트 | Chart.js 기본 미지원 | chartjs-chart-financial 필수 |
| mysql2 asarUnpack | 불필요 (순수 JS) | 기본 설정으로 패키징 가능 |
| gemma4:12b | 모델 태그 실존 여부 불명확 | `ollama list` 확인 |
| DB IP | 192.169.20.80 비표준 | 연결 전 ping 테스트 필수 |
| IPC 스트리밍 | ipcMain.handle은 단일 반환 | ipcMain.on + event.reply 패턴 사용 |

### 12.3 다이버전스 감지의 한계

- 국소 최저값 간격 조건: 최소 5 거래일 이상
- False Signal 비율 높음 — AI 프롬프트에서 "보조 신호" 명시 필요
- 거래량 확인 조건 병행 필요

---

## 13. 개발 로드맵 및 구현 순서

### 13.1 전체 로드맵

| 단계 | 내용 | 예상 기간 | 상태 |
|------|------|---------|------|
| 1단계 | Electron 구조 + DB 연결 + CSV import + 기본 차트 | 1주 | **설계 완료** |
| 2단계 | AI 채팅 연동 (Ollama) + 시스템 프롬프트 | 1~2주 | 대기 |
| 3단계 | Claude API 연동 + 엔진 전환 UI | 1주 | 대기 |
| 4단계 | FinanceDataReader 자동 수집 (Python, 서버 v20) | 1~2주 | 대기 |
| 5단계 | 박스권 종목 스캔 (KRX 전 종목) | 2주 | 대기 |
| 6단계 | 가격 도달 알람 | 1주 | 대기 |
| 7단계 | 백테스트 | 2~3주 | 대기 |

### 13.2 1단계 세부 구현 순서 (Step 1~8)

| Step | 파일 | 내용 | 검증 방법 |
|------|------|------|---------|
| 1 | `package.json`, `main.js`, `preload.js` | Electron 기본 구조, BrowserWindow | 앱 실행 확인 |
| 2 | `src/db/connection.js`, `.env` | mysql2 연결 풀, DB 접속 테스트 | ping + 접속 성공 확인 |
| 3 | `src/db/init.sql` | 4개 테이블 DDL 실행 | SHOW TABLES 확인 |
| 4 | `src/services/csvImport.js` | CSV 파싱 + INSERT IGNORE | DB에서 데이터 확인 |
| 5 | `src/services/indicators.js` | OBV/BB/RSI/MACD/VWAP 계산 | 수치 검증 |
| 6 | `src/renderer/index.html`, `styles.css` | 3영역 레이아웃, 다크 테마 | UI 렌더링 확인 |
| 7 | `src/renderer/chart.js` | Chart.js 3패널 | 차트 표시 확인 |
| 8 | `src/renderer/renderer.js` + IPC 연결 | 전체 데이터 흐름 연결 | 종목 선택 → 차트 표시 end-to-end |

### 13.3 구현 전 확인 체크리스트

```
✅ ping 192.169.20.80             — 응답 확인 완료
✅ ollama list                    — gemma4:12b 7.6GB 존재 확인
✅ node --version                 — v24.15.0 확인
✅ Claude API 키                  — 보유 확인
⬜ MariaDB stock_analysis DB      — 미생성. Step 2 직후 init.sql 실행 필요
⬜ DB root 계정 원격 접속 허용    — 방화벽 3306 포트 확인 (접속 테스트로 검증)
⬜ .env 파일 생성                  — Step 2에서 생성
⬜ .gitignore에 .env 추가         — Step 1에서 생성
⬜ npm 패키지 설치                 — Step 1에서 npm install
```

---

## 14. Electron IPC 스트리밍 패턴

### 14.1 핵심 원칙

**ipcMain.handle()**: 단일 반환만 지원 → **스트리밍 불가**
**ipcMain.on() + event.reply()**: 다중 메시지 전송 가능 → **스트리밍 전용**

```
Ollama /api/chat (SSE 스트리밍)
  ↓ fetch + readline
main.js (ipcMain.on)
  ↓ event.reply('ai:chunk', ...) × N번
  ↓ event.reply('ai:done', ...)   × 1번
preload.js (contextBridge)
  ↓ ipcRenderer.on 래핑 + cleanup 반환
renderer.js
  ↓ 청크 수신 → DOM 업데이트 (텍스트 누적)
```

### 14.2 Ollama 스트리밍 응답 형식

각 청크 JSON 구조:
```
{
  "model": "gemma4:12b",
  "created_at": "ISO8601",
  "message": {
    "role": "assistant",
    "content": "텍스트 조각"
  },
  "done": false
}
```

최종 청크 (`done: true`):
```
{
  "done": true,
  "total_duration": 3421837000,
  "prompt_eval_count": 1247,
  "eval_count": 412
}
```

### 14.3 메모리 누수 방지

ipcRenderer.on()은 누적 등록되므로 정리 필수:

```
패턴:
preload.js에서 onAiChunk(callback) 호출 시 → 리스너 등록
채팅 시작 전: removeAiListeners() 호출로 기존 리스너 제거
채팅 완료 후: 자동 정리 or removeAiListeners() 호출
```

### 14.4 contextBridge 전송 가능 타입

- ✅ String, Number, Boolean, Object, Array, Error, Promise
- ❌ Symbol (드롭됨)
- ❌ Function (proxy로 래핑됨 — 직접 함수 전달 가능하나 보안 주의)

---

## 15. npm 패키지 정확한 버전 목록

### 15.1 확정 패키지 스택

```json
{
  "dependencies": {
    "electron": "^42.4.0",
    "mysql2": "^3.22.5",
    "chart.js": "^4.5.1",
    "chartjs-chart-financial": "^0.2.1",
    "chartjs-plugin-annotation": "^3.1.0",
    "@anthropic-ai/sdk": "^0.104.1",
    "dotenv": "^17.4.2"
  },
  "devDependencies": {
    "electron-builder": "^26.15.2"
  }
}
```

### 15.2 패키지별 주요 정보

| 패키지 | 버전 | Node 요구사항 | 특이사항 |
|--------|------|-------------|---------|
| electron | 42.4.0 | Node 24 완전 호환 | 2026-06-09 최신 |
| mysql2 | 3.22.5 | 0.8+ | 순수 JS, asarUnpack 불필요 |
| chart.js | 4.5.1 | — | v4.x 필수 (financial 플러그인 요구) |
| chartjs-chart-financial | 0.2.1 | — | chart.js ^4.0.0 필요 |
| chartjs-plugin-annotation | 3.1.0 | — | chart.js ^4.0.0 필요 |
| @anthropic-ai/sdk | 0.104.1 | Node 20+ | 스트리밍 지원 |
| dotenv | 17.4.2 | Node 12+ | .env 로드 |
| electron-builder | 26.15.2 | — | Windows NSIS 패키저 |

### 15.3 .env.example 전체 내용

```
# 원격 MariaDB 접속 정보
DB_HOST=192.169.20.80
DB_PORT=3306
DB_USER=root
DB_PASSWORD=여기에입력
DB_NAME=stock_analysis

# Ollama API (로컬)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:12b

# Claude API (Anthropic)
CLAUDE_API_KEY=여기에입력
CLAUDE_MODEL=claude-sonnet-4-6

# 앱 설정
MAX_HISTORY_OLLAMA=20
MAX_HISTORY_CLAUDE=40
```

---

## 16. FinanceDataReader + Python 연동

### 16.1 FinanceDataReader 기본 정보

- 설치: `pip install finance-datareader`
- Python 요구사항: 3.8+ (서버 환경 Node v20.20.2와 공존)
- 데이터 소스: KRX 공식 + Yahoo Finance 혼합
- 반환 형식: pandas DataFrame (컬럼: Open, High, Low, Close, Volume, Change)

### 16.2 주요 사용 방법

```
# 특정 종목 일봉 조회
fdr.DataReader('053800', '2024-01-01')

# KRX 전 종목 목록 (KOSPI + KOSDAQ)
fdr.StockListing('KRX')
  반환 컬럼: ticker(6자리), name, market, status

# 기간 지정
fdr.DataReader('053800', '2024-01-01', '2024-12-31')
```

### 16.3 Rate Limit 주의사항

- Yahoo Finance 기반 데이터: HTTP 429 발생 가능 (IP 기반 제한, 24시간 유지)
- 대량 수집 시: 요청 간 1초 이상 지연 필수
- KRX 전 종목 (~2,000개) 수집: 최소 30~40분 소요 예상

### 16.4 Node.js → Python 연동 방식

**spawn 방식** (권장 — 스트림 기반, 메모리 효율):
```
Node.js main.js
  → child_process.spawn('python', [script, JSON.stringify(args)])
  → Python stdout 읽기 (UTF-8 명시 필요)
  → JSON.parse(stdout)
  → DB INSERT
```

**인코딩 주의**:
- Node.js 측: spawn 옵션에 `env: { PYTHONIOENCODING: 'utf-8' }` 추가
- Python 측: `sys.stdout.reconfigure(encoding='utf-8', errors='replace')` 필수

**Python 스크립트 위치**: `scripts/fetch_stock_data.py`

### 16.5 스케줄링 계획 (4단계)

| 스케줄 | 주기 | 내용 |
|--------|------|------|
| 일봉 수집 | 평일 16:00 (장 마감 후) | 보유 종목 일봉 자동 수집 → DB INSERT IGNORE |
| 전 종목 스캔 | 주 1회 (일요일) | KRX 전 종목 박스권 재평가 |
| 앱 실행 시 | 앱 시작 | 최근 데이터 누락 여부 확인 + 자동 수집 트리거 |

**거래일 판단**: 주말 자동 필터 (FinanceDataReader가 처리) + KRX 공휴일 리스트 별도 관리

### 16.6 가상환경 경로 처리 (Windows)

```
venv 경로: scripts/venv/Scripts/python.exe (Windows)
spawn 호출 시 절대 경로 사용:
  const pythonPath = path.join(__dirname, 'scripts', 'venv', 'Scripts', 'python.exe')
```

---

## 17. 박스권 자동 탐지 알고리즘

### 17.1 박스권 정의 기준

| 조건 | 기준값 | 의미 |
|------|--------|------|
| 52주 고저가 비율 | 최고가 / 최저가 < 2.0배 | 과도한 변동성 제외 |
| 박스권 체류율 | 특정 구간 ±10% 내 체류 60% 이상 | 안정적 박스권 유지 |
| 하단 반등 성공률 | 하단 터치 후 5% 이상 반등 확률 > 65% | 하단 지지력 검증 |
| 시가총액 | 500억 ~ 1조원 | 유동성 확보 |
| 이슈 급등 히스토리 | 과거 3년 내 2배 이상 상승 이력 | 이슈 발생 시 폭발력 |

### 17.2 복합 탐지 알고리즘 (권장)

**3단계 필터**:
```
1단계: Donchian Channel (60일)로 상/하단 자동 계산
   box_high = max(high, 60거래일)
   box_low  = min(low,  60거래일)
   변동폭 = (box_high - box_low) / box_low

2단계: 볼린저밴드 폭(Bandwidth) < 0.15
   bandwidth = (BB_upper - BB_lower) / MA20
   수렴 조건: bandwidth < 0.15 → 박스권 강화 신호

3단계: ATR < 평균 ATR × 0.7
   저변동성 확인 → 박스권 안정화
```

**판정**:
- 3단계 모두 통과 → "박스권 확정"
- 2단계 통과 → "박스권 후보"
- 1단계만 통과 → "탐색 중"

### 17.3 stock_info 자동 업데이트

박스권 탐지 후 DB 업데이트:
```sql
UPDATE stock_info
SET box_low = ?, box_high = ?
WHERE ticker = ?;
```

**주의**: 자동 탐지 값은 참고용. 최종 박스권 설정은 사용자 수동 확인 후 저장.

---

## 18. Windows 알람 기능 구현

### 18.1 Electron Notification API

Windows 10/11 네이티브 알림 완전 지원:

```
알림 방식:
1. Windows 토스트 알림 (Electron 내장 Notification API)
2. 시스템 트레이 + 알림 조합
3. 앱 최소화 상태에서도 알림 발송 가능 ✓
```

**필수 초기화**:
```
app.setAppUserModelId(process.execPath)  // main.js app 'ready' 이전
```

### 18.2 가격 모니터링 백그라운드 루프

```
모니터링 주기:
- 평일 09:00~15:30: 60초
- 시장 외 시간: 300초
- 주말: 비활성화

체크 조건:
1. DB에서 최신 close 조회
2. user_holdings의 분할 매수 가격대와 비교
3. 조건 충족 시 Windows 알림 발송
```

### 18.3 알람 유형

| 알람 유형 | 발동 조건 | 알림 내용 |
|---------|---------|---------|
| 매수구역 진입 | 현재가 ≤ 분할 1차 진입가 | "안랩 54,000원 도달 — 1차 매수 검토" |
| 박스권 하단 이탈 | 현재가 < box_low | "안랩 박스권 하단 이탈! 51,000원 붕괴" |
| 이슈 추격 발동 | close > box_high + volume 2배↑ | "안랩 박스권 상단 돌파 + 거래량 급증!" |
| 가격 도달 | 사용자 설정 목표가 | "안랩 사용자 설정 알람: {가격}원 도달" |

---

## 19. 실시간 데이터 소스 대안

### 19.1 Phase 1~3 현재 방식

**CSV 수동 Import** — 실시간 없음.
- "현재가" = DB 최신 stock_daily.close (사용자가 CSV import한 시점)
- 장중 실시간 분석 불가 (Phase 4 이전)

### 19.2 ✅ 확정된 데이터 소스 전략

사용자 선택: **yfinance + PyKRX (무료)**

| 소스 | 방식 | 비용 | 안정성 | 용도 |
|------|------|------|--------|------|
| **FinanceDataReader** | Python pip | 무료 | ★★★★ | 일봉 자동 수집 (기본) |
| **PyKRX** | Python pip | 무료 | ★★★★ | KRX 공식 데이터, 종목 목록 |
| **yfinance** | Python pip | 무료 | ★★★ | 보조 데이터, 053800.KQ |
| ~~KIS Open API~~ | ~~공식~~ | ~~무료~~ | ~~★★★★★~~ | ~~제외~~ |

### 19.3 ✅ 단계별 확정 전략

| 단계 | 데이터 소스 | 비고 |
|------|-----------|------|
| Phase 1~3 | CSV 수동 Import | 기본 분석 충분 |
| Phase 4 | FinanceDataReader (일봉 자동 수집) | 매일 16:00 자동 실행, INSERT IGNORE |
| Phase 5 | PyKRX (전 종목 목록) + FinanceDataReader (개별 종목 지표 계산) | 박스권 스캔 |
| Phase 6 | yfinance 실시간 근사 + PyKRX 실시간 시세 | 알람 트리거용 |

### 19.4 PyKRX 특이사항

```
pip install pykrx

# 전 종목 목록 (KOSPI + KOSDAQ)
from pykrx import stock
tickers = stock.get_market_ticker_list(market='ALL')

# 특정 종목 일봉 OHLCV
df = stock.get_market_ohlcv('20240101', '20241231', '053800')
컬럼: 시가, 고가, 저가, 종가, 거래량

# 실시간 시세 (당일)
df = stock.get_market_ohlcv_by_ticker(date='20260611')
```

**장점**: KRX 공식 데이터 — 수정주가, 거래정지 정보 포함
**주의**: 대량 요청 시 IP 차단 가능 → 요청 간 0.5초 지연 권장

### 19.5 ✅ 확인 완료 요약

| # | 항목 | 결과 |
|---|------|------|
| 1 | DB 서버 접근 | ✅ ping 응답 (192.169.20.80) |
| 2 | Ollama 모델 | ✅ gemma4:12b 7.6GB 존재 |
| 3 | stock_analysis DB | ⬜ 미생성 → Step 3에서 init.sql로 생성 |
| 4 | Claude API 키 | ✅ 보유 |
| 5 | 실시간 데이터 소스 | ✅ yfinance + PyKRX 무료 사용 확정 |

---

*V2 업데이트: 서브에이전트 6개 병렬 연구 결과 통합 (설계문서 재분석 + 기술 스택 갭 연구 + FinanceDataReader/박스권/알람 연구)*
*추가된 내용: VWAP 알고리즘, IPC 스트리밍 패턴, npm 확정 버전, AI 응답 형식, split_plan JSON, 오후장 UI, 보유현황 폼, FinanceDataReader, 박스권 탐지, 알람 구현, 실시간 데이터 대안*
*코딩 시작 전 이 문서를 먼저 읽고, 구현 중 참조 기준으로 활용한다.*

---

## 20. 실시간 거래 기능 개요 및 설계 철학

### 20.1 추가 기능 범위

실시간 거래 기능은 기존 분석 앱에 **키움증권 OpenAPI+**를 연동하여 모의투자 매매를 지원한다.
한번에 모든 것을 구현하지 않고, 이번에는 **큰 테두리(아키텍처 설계)**만 확정한다.

**핵심 방향**:
1. 실시간 관련 기능은 **차일드 모달 화면**으로 표시
2. 메인 화면 상단에 **실시간 거래 전용 버튼/메뉴** 추가
3. 실시간 창이 열리면 메인 화면에 **계좌 요약 패널 + 보유 종목** 표시
4. 모든 수동/자동 거래는 본 앱으로 진행
5. **초기에는 모의 투자 계좌로만 운영** (실계좌 연동 추후)

### 20.2 모의 투자 계좌 정보

| 항목 | 값 | 비고 |
|------|-----|------|
| 증권사 | 키움증권 (Kiwoom Securities) | - |
| 계좌번호 | `812451811` | 모의투자 계좌 |
| 계좌 비밀번호 | `0000` | 모의투자 기본값 |
| 환경변수 | `KIWOOM_ACCOUNT_NO=812451811` | .env에만 저장 |

### 20.3 키움 OpenAPI+ 아키텍처 개요

키움 OpenAPI+(KHOpenAPI.ocx)는 **Win32 COM/ActiveX 기반** API로, HTTP 엔드포인트가 없다.
Electron(Node.js)에서 직접 호출 불가 → **Python 브릿지 프로세스**가 필수.

**전체 아키텍처**:
```
[Electron App — main.js]
    ↓ child_process.spawn
[Python 브릿지 — bridge.py (Flask + pykiwoom)]
    ↓ COM 호출
[Kiwoom OpenAPI+ OCX (KHOpenAPI.ocx)]
    ↓ 네트워크
[키움 서버 — 모의투자]
```

**통신 방식**:

| 방향 | 프로토콜 | 용도 |
|------|---------|------|
| Electron → Python | HTTP (localhost:5001) | 명령 전달 (주문, 조회) |
| Python → Electron | SSE (Server-Sent Events) | 실시간 이벤트 Push |

**설치 요건** (앱 실행 PC에 필요):
- 키움증권 OpenAPI+ 설치 (KHOpenAPI.ocx 등록)
- Python 3.8+ 설치 및 PATH 등록
- `pip install pykiwoom flask`
- Windows 전용 (COM/ActiveX 기반)

> ⚠️ 독립 실행 exe 빌드 불가: Python 런타임 + Kiwoom OCX가 별도 설치되어야 함.
> 이 앱은 운영 PC에 키움 OpenAPI+가 설치된 것을 전제로 동작한다.

---

## 21. 키움 OpenAPI+ 상세

### 21.1 Python 브릿지 (bridge.py) 구조

```
bridge.py
├── Flask 앱 (HTTP 서버, 포트 5001)
├── pykiwoom Kiwoom() 객체
├── SSE 이벤트 큐 (실시간 데이터 → Electron 전달)
└── 이벤트 핸들러
    ├── OnEventConnect   → 로그인 결과
    ├── OnReceiveTrData  → TR 조회 응답 (계좌/잔고/미체결)
    ├── OnReceiveRealData → 실시간 시세/호가
    └── OnReceiveChejanData → 체결 통보
```

### 21.2 Python 브릿지 HTTP API

| 엔드포인트 | 메서드 | 기능 |
|-----------|--------|------|
| `/status` | GET | 브릿지 상태 확인 |
| `/login` | POST | CommConnect() 로그인 팝업 실행 |
| `/account` | GET | OPW00004 계좌 평가현황 |
| `/holdings` | GET | 보유 종목 목록 |
| `/unfilled` | GET | 미체결 주문 조회 |
| `/filled` | GET | 체결 내역 조회 |
| `/order/buy` | POST | 매수 주문 SendOrder |
| `/order/sell` | POST | 매도 주문 SendOrder |
| `/order/cancel` | POST | 주문 취소 |
| `/realtime/subscribe` | POST | 종목 실시간 구독 SetRealReg |
| `/realtime/events` | GET | SSE 실시간 이벤트 스트림 |

### 21.3 Flask + pykiwoom 스레딩 아키텍처

pykiwoom은 PyQt5.QAxContainer 기반이므로 **Qt 이벤트 루프가 반드시 별도 스레드**에서 실행되어야 한다.
CommConnect(block=True)는 로그인 완료까지 완전히 블로킹하므로 메인 Flask 스레드에서 직접 호출 불가.

**검증된 스레드 모델**:
```
메인 스레드 (Flask HTTP 서버)
    ├── GET/POST 엔드포인트 처리
    ├── SSE 이벤트 스트림
    └── request_queue → KiwoomWorker에 작업 전달
                        ↓ (queue.Queue, 스레드 안전)
워커 스레드 (KiwoomWorker: QThread)
    ├── QApplication 생성
    ├── Kiwoom() 인스턴스
    ├── CommConnect(block=True)
    ├── OnReceiveTrData 콜백 처리
    ├── OnReceiveRealData 콜백 처리
    └── OnReceiveChejanData 콜백 처리
                        ↓ (response_queue / sse_queue)
메인 스레드 (Flask)
    ├── 동기 응답: response_queue에서 결과 수신
    └── SSE 스트림: sse_queue에서 실시간 이벤트 Push
```

**핵심 원칙**:
- pykiwoom 객체는 반드시 QThread 내부에서 생성 및 사용
- Flask 핸들러에서 kiwoom 직접 호출 금지 → queue로만 전달
- SSE는 Flask Generator에서 sse_queue.get() 블로킹으로 구현
- 서버 대안: FastAPI + asyncio (qasync 라이브러리로 완전 비동기 지원 가능)

> 대안 라이브러리: **KOAPY** (grpc 기반, REST API 래퍼 제공, 더 현대적)
> `pip install koapy` — 단, 러닝커브가 높음. 이 프로젝트는 pykiwoom 기준.

### 21.4 인증 체계 (로그인)

**로그인 흐름**:
```
main.js → HTTP POST localhost:5001/login
  ↓
bridge.py: KiwoomWorker.request_queue.put({action: 'login'})
  ↓
KiwoomWorker: kiwoom.CommConnect(block=True)
  ↓ (키움 로그인 팝업이 화면에 표시됨 — 사용자 직접 입력)
사용자: 키움증권 ID / PW 입력 + 모의투자 서버 선택
  ↓
OnEventConnect(err_code=0) → 로그인 성공
GetLoginInfo("GetServerGubun") == "0" → 모의투자 확인
  ↓
response_queue → Flask 응답: {success: true, account_no: "812451811", server: "mock"}
  ↓
main.js: sharedState.loggedIn = true
```

> 키움 OpenAPI+ 로그인은 반드시 GUI 팝업 방식.
> 프로그래밍으로 ID/PW 자동 입력은 키움 약관 위반 — 사용자가 직접 입력.
> OnEventConnect 에러코드: 0=성공, 100=사용자정보교환실패, 101=서버접속실패, 102=버전처리실패

### 21.5 핵심 TR 코드

**계좌 조회**:

| TR코드 | 기능 | 주요 출력 |
|--------|------|----------|
| `OPW00004` | 계좌평가현황 | 예수금, 총평가금액, 총손익, 보유종목 목록 |
| `OPWK00015` | 계좌수익률 | 총수익률(%) |
| `OPW00018` | 미체결 주문 | 미체결 주문 목록 |

**OPW00004 SetInputValue 입력 키**:

| 입력 키 | 값 예시 | 비고 |
|--------|--------|------|
| `계좌번호` | `"812451811"` | 모의투자 계좌 |
| `비밀번호` | `"0000"` | 모의투자 기본값 |
| `조회구분` | `"1"` | 0=추정자산, 1=실제자산 |
| `상장폐지조회구분` | `"0"` | 0=포함 안 함 |

**OPW00004 output2 (보유종목) 주요 필드**:

| GetCommData 키 | DB 컬럼 | 비고 |
|--------------|---------|------|
| `종목번호` | ticker | 6자리 코드 (`"A053800"` 접두사 제거 필요) |
| `종목명` | stock_name | 참고용 |
| `보유수량` | quantity | 정수 |
| `평균단가` | avg_price | 원 (매입단가 아님) |
| `현재가` | current_price | 원 (음수=하한가 → abs() 처리) |
| `평가금액` | eval_amount | 원 |
| `평가손익` | pnl_amount | 원 |
| `평가손익율(%)` | pnl_rate | % |

> ⚠️ `종목번호` 반환값이 `"A053800"` 형태일 수 있음. `lstrip('A')` 또는 `[-6:]`로 순수 코드 추출.

**OPW00004 output1 (계좌 요약) 주요 필드**:

| GetCommData 키 | 의미 |
|--------------|------|
| `예수금` | 현금 잔액 |
| `D+2추정예수금` | 결제 후 예수금 |
| `유가증권평가금액` | 주식 총 평가금액 |
| `총평가금액` | 예수금 + 주식 평가 |
| `총평가손익금액` | 전체 손익 |
| `총수익률(%)` | 전체 수익률 |

**OPW00018 SetInputValue 입력 키 (미체결 조회)**:

| 입력 키 | 값 예시 | 비고 |
|--------|--------|------|
| `계좌번호` | `"812451811"` | |
| `비밀번호` | `"0000"` | |
| `조회구분` | `"1"` | 1=미체결 |

OPW00018 output 주요 필드: `주문번호`, `종목번호`, `종목명`, `주문수량`, `미체결수량`, `주문가격`, `주문구분`, `주문시간`

### 21.6 주문 실행 (SendOrder)

**파라미터 정의**:
```
kiwoom.SendOrder(
  sRQName,    # 요청명 (임의 문자열, 콜백 식별용)
  sScreenNo,  # 화면번호 (4자리 문자열 "0101" 등)
  sAccNo,     # 계좌번호 "812451811"
  nOrderType, # 1=매수, 2=매도, 3=매수취소, 4=매도취소, 5=매수정정, 6=매도정정
  sCode,      # 종목코드 "053800"
  nQty,       # 수량 (정수)
  nPrice,     # 단가 (지정가=가격, 시장가=0)
  sHogaGb,    # "00"=지정가, "03"=시장가, "05"=조건부지정가, "06"=최유리지정가
  sOrgOrderNo # 원주문번호 (신규="", 취소/정정=원번호)
)
```

반환값: **0 = 전송 성공** (서버 접수 성공), 음수 = 실패 에러코드
실제 주문번호: `SendOrder` 반환값이 아닌 **OnReceiveChejanData의 FID 9001**에서 수신

**주문유형 매핑**:

| nOrderType | 기능 |
|-----------|------|
| 1 | 매수 |
| 2 | 매도 |
| 3 | 매수 취소 |
| 4 | 매도 취소 |
| 5 | 매수 정정 |
| 6 | 매도 정정 |

**호가구분 (sHogaGb)**:

| 코드 | 의미 | 모의투자 확인 |
|------|------|------------|
| `"00"` | 지정가 | ✅ 동작 확인 |
| `"03"` | 시장가 | ✅ 동작 확인 |
| `"05"` | 조건부지정가 | KOA Studio 확인 필요 |
| `"06"` | 최유리지정가 | KOA Studio 확인 필요 |

> 속도 제한: SendOrder 1초에 최대 5회 — 초과 시 에러 코드 반환

### 21.7 실시간 데이터 (SetRealReg)

**구독 등록**:
```
kiwoom.SetRealReg(
  "0201",             # 화면번호 (4자리, 다른 용도 화면번호와 중복 금지)
  "053800;005930",    # 종목코드 세미콜론(;) 구분 복수 가능
  "10;11;12;13;27;28",# FID 목록 (세미콜론 구분)
  "0"                 # 0=기존해제+신규등록, 1=기존유지+추가등록
)
```

구독 해제: `kiwoom.SetRealRemove("0201")` — 특정 화면 해제
전체 해제: `kiwoom.SetRealRemoveAll()` — 모든 구독 해제

**화면번호 관리 권장**:
- 관심종목 실시간 시세: `"0201"`
- 호가창: `"0202"`
- 잔고 실시간: `"0203"`
- 한 화면번호당 최대 100종목 (초과 시 일부 누락)

**주요 FID 목록 — 주식체결 (sRealType="주식체결")**:

| FID | 데이터 | 비고 |
|-----|--------|------|
| `10` | 현재가 | 음수=하한가 → abs() 처리 |
| `11` | 전일대비 | |
| `12` | 등락율(%) | |
| `13` | 누적거래량 | |
| `14` | 시가 | |
| `15` | 고가 | |
| `16` | 저가 | |
| `20` | 체결시간 | HHMMSS 형식 |

**주요 FID 목록 — 주식호가잔량 (sRealType="주식호가잔량")**:

| FID | 데이터 | FID | 데이터 |
|-----|--------|-----|--------|
| `27` | 최우선매도호가 | `28` | 최우선매수호가 |
| `41` | 매도호가1 | `51` | 매수호가1 |
| `42` | 매도호가2 | `52` | 매수호가2 |
| `43` | 매도호가3 | `53` | 매수호가3 |
| `44` | 매도호가4 | `54` | 매수호가4 |
| `45` | 매도호가5 | `55` | 매수호가5 |
| `46` | 매도잔량1 | `56` | 매수잔량1 |
| `47` | 매도잔량2 | `57` | 매수잔량2 |
| `48` | 매도잔량3 | `58` | 매수잔량3 |
| `49` | 매도잔량4 | `59` | 매수잔량4 |
| `50` | 매도잔량5 | `60` | 매수잔량5 |

**GetCommRealData 사용법**:
```
price_str = kiwoom.GetCommRealData(sCode, 10)   # FID 10 = 현재가
price = abs(int(price_str))                      # 음수(하한가) 처리
```

**sRealType 종류**:

| sRealType | 설명 |
|----------|------|
| `주식체결` | 현재가·거래량·등락률 |
| `주식호가잔량` | 매도/매수 호가 5단계 + 잔량 |
| `주식우선호가` | 최우선 매도·매수 호가 1단계 |

### 21.8 체결 통보 (OnReceiveChejanData)

주문 접수/체결/잔고 변경 시 자동 콜백. `kiwoom.GetCommRealData("", FID)`로 값 조회.

**sGubun 구분**:

| sGubun | 의미 | 발생 시점 |
|--------|------|---------|
| `"0"` | 주문체결통보 | 주문 접수·체결 시 |
| `"1"` | 잔고통보 | 체결 후 보유 변동 시 |
| `"3"` | 특수신호 | 기타 |

**sGubun="0" 주문체결 주요 FID**:

| FID | 의미 | 비고 |
|-----|------|------|
| `9001` | 주문번호 | kiwoom_order_no에 저장 |
| `9002` | 체결번호 | |
| `9003` | 원주문번호 | 취소/정정 시 원번호 |
| `302` | 종목명 | |
| `10` | 체결가 | |
| `900` | 미체결수량 | 0이면 완전 체결 |
| `901` | 주문유형 | "매수", "매도" |

**sGubun="1" 잔고통보 주요 FID**:

| FID | 의미 |
|-----|------|
| `910` | 보유수량 |
| `911` | 보유금액 (평가금액) |
| `912` | 평균단가 |
| `913` | 손익금액 |
| `914` | 손익율(%) |

---

## 22. Electron 차일드 윈도우 아키텍처

### 22.1 창 구조

```
mainWindow (메인 프로세스 — main.js)
├── 기존 분석 화면 (index.html)
│   ├── 상단 헤더에 [실시간 거래] 버튼 추가
│   └── 차일드 창 열림 시 계좌 요약 패널 노출
│
└── childWindow (차일드 창 — 실시간 거래)
    ├── parent: mainWindow
    ├── modal: false (독립 조작 가능)
    ├── 크기: 800 × 900px
    └── 위치: 메인 창 우측에 배치
```

**차일드 창 생성 패턴**:
```
mainBounds = mainWindow.getBounds()
childWindow = new BrowserWindow({
  parent: mainWindow,
  modal: false,
  width: 800,
  height: 900,
  x: mainBounds.x + mainBounds.width + 10,
  y: mainBounds.y,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
})
childWindow.loadFile('src/renderer/realtrading.html')
```

**차일드 창 닫힘 처리**:
```
childWindow.on('closed')
  → childWindow = null
  → mainWindow.webContents.send('real:windowStateChange', {state:'closed'})
  → SSE 연결 해제 (Python 브릿지 이벤트 스트림 종료)
  → SetRealRemoveAll() 구독 정리
```

### 22.2 전역 공유 상태 (main.js)

```
sharedState = {
  bridgeConnected: false,     // Python 브릿지 연결 상태
  bridgePort: 5001,           // 브릿지 HTTP 포트
  bridgeProcess: null,        // child_process 참조
  loggedIn: false,            // 키움 로그인 완료 여부
  accountNo: '812451811',     // KIWOOM_ACCOUNT_NO 환경변수
  isMock: true,               // KIWOOM_IS_MOCK 환경변수
  subscriptions: new Set(),   // 구독 중인 종목 코드
  priceCache: new Map()       // ticker → {price, change, volume, ts}
}
```

### 22.3 브로드캐스트 함수

실시간 시세는 메인 창과 차일드 창 양쪽에 전달:
```
broadcastToAllWindows(channel, data)
  ├── mainWindow.webContents.send(channel, data)  // 메인 계좌 패널 갱신
  └── childWindow.webContents.send(channel, data) // 거래 화면 시세 갱신
```

### 22.4 추가 IPC 채널 목록

| 채널명 | 방향 | 기능 |
|--------|------|------|
| `real:openWindow` | renderer→main | 실시간 거래 창 열기 |
| `real:login` | child→main | 키움 로그인 (브릿지 POST /login) |
| `real:getAccount` | child→main | 계좌 잔고 조회 (브릿지 GET /account) |
| `real:getHoldings` | child→main | 보유 종목 조회 (브릿지 GET /holdings) |
| `real:subscribe` | child→main | 종목 실시간 구독 시작 |
| `real:unsubscribe` | child→main | 종목 구독 해제 |
| `real:orderBuy` | child→main | 매수 주문 (브릿지 POST /order/buy) |
| `real:orderSell` | child→main | 매도 주문 (브릿지 POST /order/sell) |
| `real:cancelOrder` | child→main | 주문 취소 |
| `real:getOrders` | child→main | 미체결 주문 조회 |
| `real:getExecutions` | child→main | 체결 내역 조회 |
| `real:onQuote` | main→renderer+child | 실시간 시세 이벤트 (push) |
| `real:onExecution` | main→child | 내 주문 체결 통보 (push) |
| `real:windowStateChange` | main→renderer | 창 열림/닫힘 알림 |

---

## 23. DB 스키마 확장 (실시간 거래)

### 23.1 신규 테이블 목록

| 테이블 | 목적 |
|--------|------|
| `kiwoom_config` | 계좌 설정 (모의/실투, 화면번호 등) |
| `trading_orders` | 주문 이력 (매수/매도, 체결 상태) |
| `trading_account` | 일별 계좌 스냅샷 (예수금, 평가금액, 손익) |
| `realtime_watchlist` | 실시간 구독 관심종목 목록 |

> OpenAPI+는 OAuth 토큰 없음 — `kiwoom_credentials` 테이블 불필요.
> 로그인 세션은 Python 브릿지 프로세스가 COM 객체로 유지.

### 23.2 kiwoom_config 테이블

| 컬럼 | 타입 | 내용 |
|------|------|------|
| id | INT AUTO_INCREMENT PK | - |
| account_no | VARCHAR(20) | `812451811` |
| is_mock | TINYINT(1) DEFAULT 1 | 1=모의투자, 0=실투 |
| bridge_port | INT DEFAULT 5001 | 브릿지 HTTP 포트 |
| screen_no_base | VARCHAR(4) DEFAULT '0101' | 키움 화면번호 기본값 |
| updated_at | TIMESTAMP ON UPDATE | 갱신 시각 |

### 23.3 trading_orders 테이블

| 컬럼 | 타입 | 내용 |
|------|------|------|
| id | INT AUTO_INCREMENT PK | - |
| account_no | VARCHAR(10) | 계좌번호 |
| ticker | VARCHAR(20) FK→stock_info | 종목코드 |
| order_type | ENUM('buy','sell') | 주문 유형 |
| order_qty | INT | 주문 수량 |
| order_price | INT | 주문 단가 (시장가=0) |
| kiwoom_order_no | VARCHAR(20) UNIQUE | 키움 주문번호 (OnReceiveChejanData FID 9001) |
| status | ENUM('submitted','pending','partial','filled','cancelled') | 상태 |
| exec_qty | INT DEFAULT 0 | 체결 수량 |
| exec_price | INT DEFAULT 0 | 체결 단가 |
| exec_amount | BIGINT DEFAULT 0 | 체결 금액 |
| commission | INT DEFAULT 0 | 수수료 |
| is_paper | TINYINT(1) | 모의/실투 구분 |
| created_at | TIMESTAMP | 주문 시각 |
| updated_at | TIMESTAMP ON UPDATE | 체결/취소 시각 |

**손익 계산 공식**:
- 매수: `손익 = (현재가 - exec_price) × exec_qty - commission`
- 매도: `손익 = (exec_price - 매입단가) × exec_qty - commission - tax`

### 23.4 trading_account 테이블

| 컬럼 | 타입 | 내용 |
|------|------|------|
| id | INT AUTO_INCREMENT PK | - |
| account_no | VARCHAR(10) | 계좌번호 |
| deposit | BIGINT | 예수금 (OPW00004 `예수금`) |
| eval_total | BIGINT | 총 평가금액 (`총평가금액`) |
| eval_stock | BIGINT | 유가증권 평가금액 |
| cash | BIGINT | 가용 현금 |
| pnl_today | BIGINT | 당일 손익 |
| pnl_total | BIGINT | 누적 손익 (`총평가손익금액`) |
| rate_of_return | DECIMAL(8,4) | 수익률 (`총수익률(%)`) |
| is_paper | TINYINT(1) | 모의/실투 구분 |
| snapshot_at | TIMESTAMP | 스냅샷 시각 |
UNIQUE KEY: `(account_no, DATE(snapshot_at))`

### 23.5 realtime_watchlist 테이블

| 컬럼 | 타입 | 내용 |
|------|------|------|
| id | INT AUTO_INCREMENT PK | - |
| ticker | VARCHAR(20) FK→stock_info | 종목코드 |
| display_order | INT DEFAULT 0 | 표시 순서 |
| alert_price_high | INT | 고가 알람 기준 |
| alert_price_low | INT | 저가 알람 기준 |
| alert_volume_ratio | DECIMAL(5,2) | 거래량 배수 알람 (예: 2.0 = 평균 2배) |
| is_active | TINYINT(1) DEFAULT 1 | 활성 여부 |
| created_at | TIMESTAMP | - |
UNIQUE KEY: `(ticker)`

### 23.6 user_holdings_realtime 테이블 (신규)

기존 user_holdings(수동 입력용)은 유지. 실시간 키움 데이터는 별도 테이블로 관리.

**선택지 A: user_holdings_realtime 신규 테이블 (권장)**
- 기존 코드 영향 없음
- OPW00004 잔고 조회 후 자동 동기화
- 렌더러에서 LEFT JOIN으로 통합 표시

**키움 OpenAPI+ OPW00004 → user_holdings_realtime 매핑**:

| GetCommData 키 | DB 컬럼 | 비고 |
|--------------|---------|------|
| `종목번호` | ticker | FK → stock_info (접두사 'A' 제거 필요) |
| `보유수량` | quantity | 정수 |
| `평균단가` | avg_price | 원 (주의: '매입단가' 아님) |
| `현재가` | current_price | 원 (음수=하한가, abs() 처리) |
| `평가금액` | eval_amount | 원 |
| `평가손익` | pnl_amount | 원 |
| `평가손익율(%)` | pnl_rate | % (주의: '수익률(%)' 아님) |

---

## 24. 실시간 데이터 흐름 파이프라인

### 24.1 실시간 시세 수신 흐름

```
키움 서버
  ↓ (OnReceiveRealData 콜백 — 주식체결)
bridge.py — pykiwoom 이벤트 핸들러
  ↓ SSE 이벤트 큐에 push (type:'quote', data:{ticker, price, change, volume})
main.js — SSE 리스너 (GET /realtime/events)
  ↓ sharedState.priceCache 업데이트 (메모리)
broadcastToAllWindows('real:onQuote', {ticker, price, change, volume})
  ├─ mainWindow → 계좌 패널 보유 종목 현재가 갱신
  └─ childWindow → 관심종목 리스트 + 호가 화면 갱신
  ↓ DB 저장 불필요 (메모리 캐시로 충분)
```

### 24.2 주문 실행 흐름

```
차일드 창 — 사용자 주문 입력 [매수/매도]
  ↓ ipcRenderer.invoke('real:orderBuy', {ticker, qty, price})
main.js — ipcMain.handle('real:orderBuy')
  ↓ 로그인 상태 확인 (sharedState.loggedIn)
  ↓ HTTP POST localhost:5001/order/buy {ticker, qty, price, account_no}
bridge.py — KiwoomWorker.request_queue.put({action:'order', type:1, code, qty, price})
  ↓ KiwoomWorker: kiwoom.SendOrder(nOrderType=1, sCode, nQty, nPrice, "00")
  ↓ SendOrder 반환값: 0 = 접수 성공 (실제 주문번호 아님)
  ↓ DB INSERT trading_orders (status: 'submitted')
  ↓ return {status: 'submitted'}
차일드 창 — 주문 확인 메시지 표시
  ↓ (이후 OnReceiveChejanData SSE 이벤트로 실제 주문번호 수신)
trading_orders UPDATE kiwoom_order_no = FID 9001 값
```

### 24.3 체결 통보 흐름

```
키움 서버
  ↓ (OnReceiveChejanData — sGubun="0", FID 900=미체결수량 확인)
bridge.py — SSE push (type:'execution')
  data: {order_no, ticker, exec_qty, exec_price}
main.js — SSE 리스너
  ↓ trading_orders UPDATE (status='filled', exec_qty, exec_price, kiwoom_order_no)
  ↓ user_holdings_realtime 갱신 (수량·평균단가 재계산)
  ↓ childWindow.webContents.send('real:onExecution', {...})
차일드 창 — 체결 완료 알림 + 미체결 목록 갱신
```

### 24.4 계좌 잔고 동기화 흐름

```
[트리거: 실시간 창 열림 OR 주문 체결 OR 30분 주기]
  ↓ HTTP GET localhost:5001/account
bridge.py — kiwoom.CommRqData("OPW00004", "OPW00004", 0, "0101")
  ↓ output1: 예수금, 총평가금액, 총손익
  ↓ output2: 보유 종목 목록 (반복 행)
  ↓ DB INSERT trading_account (일별 스냅샷)
  ↓ DB UPSERT user_holdings_realtime
  ↓ broadcastToAllWindows('real:accountUpdated', {...})
메인 창 — 계좌 요약 패널 갱신
차일드 창 — 잔고 패널 갱신
```

### 24.5 Python 브릿지 생명주기

```
Electron 앱 시작
  ↓ main.js: child_process.spawn('python', ['src/bridge/bridge.py'])
    (python PATH 자동 탐색: 'python' → 'py' → 'python3' 순 시도)
  ↓ stdout에서 "Running on http://127.0.0.1:5001" 감지 OR GET /status 폴링 (10초, 500ms)
  ↓ {ready: true} → sharedState.bridgeConnected = true
사용자 [실시간 거래] 버튼 클릭
  ↓ POST /login → 키움 로그인 팝업 (KiwoomWorker 스레드에서 실행)
  ↓ OnEventConnect(0) → GetLoginInfo("GetServerGubun")=="0" (모의투자 확인)
  ↓ sharedState.loggedIn = true
  ↓ childWindow 생성
  ↓ GET /account → OPW00004 계좌 데이터 로드
  ↓ GET /realtime/events → SSE 스트림 연결 (eventsource npm 패키지)
앱 종료
  ↓ app.on('will-quit'): bridgeProcess.kill('SIGTERM') → bridgeProcess.kill('SIGKILL')
```

### 24.6 SSE 구현 상세

**Flask (bridge.py) SSE 스트림**:
```
GET /realtime/events
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive

  → Generator: sse_queue.get(timeout=30) → "data: {...}\n\n" yield
  → Heartbeat: 25초마다 ": ping\n\n" (연결 유지)
```

**Electron main.js SSE 수신**:
```
npm install eventsource  (Node.js용 EventSource 구현)

const EventSource = require('eventsource')
const sseClient = new EventSource('http://127.0.0.1:5001/realtime/events')
sseClient.onmessage = (e) => { ... broadcastToAllWindows(...) }
sseClient.onerror = () => { 재연결 로직 }
```

### 24.7 SSE 재연결 전략

```
MAX_RECONNECT = 5
RECONNECT_DELAY = 지수 백오프 (3s → 6s → 12s → 24s → 48s)

SSE 연결 끊김 (eventsource onerror)
  → 재연결 카운터++
  → delay 후 new EventSource(url)
재연결 성공
  → 기존 subscriptions Set 기반 SetRealReg 재등록 (POST /realtime/subscribe)
5회 실패 → 사용자 알림 "키움 브릿지 재시작 필요"
           → POST /shutdown → spawn 재시작
```

---

## 25. 실시간 화면 UI 설계

### 25.1 메인 화면 변경 (실시간 창 열릴 때)

**버튼 위치**: 헤더 우측에 `[📈 실시간 거래]` 버튼 추가

**창 열림 시 메인 화면 우측에 계좌 요약 패널 노출**:
```
┌──────────────────────────────────────────────────────────────────┐
│ 헤더: [종목검색] [기간선택]                       [📈 실시간거래] │
├────────────────────────────────────┬─────────────────────────────┤
│ 기존 차트 + AI 채팅 (좌측 70%)     │ 계좌 요약 패널 (우측 30%)   │
│                                    │                             │
│ [차트 3패널]                       │ 계좌: 812451811 (모의)      │
│                                    │ 예수금: 50,000,000원        │
│                                    │ 총 평가: 51,200,000원       │
│                                    │ 오늘 손익: +520,000원(+1.0%)│
│ [AI 채팅]                          │ ─────────────────────────  │
│                                    │ [보유 종목]                 │
│                                    │ 안랩  341주  61,500원       │
│                                    │ 현재  57,200원 (-6.9%)     │
│                                    │ 평가손익: -1,465,500원      │
└────────────────────────────────────┴─────────────────────────────┘
```

**CSS 토글**: `body.real-trading-open` 클래스 추가로 레이아웃 전환
- 좌측 영역: `width: 70%`
- 계좌 패널: `display: block` (기본은 hidden)

### 25.2 실시간 거래 차일드 창 레이아웃

```
┌─────────────────────────────────────────┐
│ 헤더 (60px)                             │
│ [812451811 ▼] [모의투자] | 예수금:50,000K│
├─────────────────────────────────────────┤
│ 탭: [관심종목] [호가] [주문] [체결내역]  │
├─────────────────────────────────────────┤
│ 관심종목 패널 (200px)                   │
│ 안랩    053800   57,200  ▼ -6.9%       │
│ 삼성전자 005930  72,900  ▲ +0.5%       │
├─────────────────────────────────────────┤
│ 호가 패널 (250px)                       │
│ 매도5  57,600  3,200주                  │
│ 매도4  57,500  2,800주                  │
│ 매도3  57,400  4,100주                  │
│ 매도2  57,300  2,200주                  │
│ 매도1  57,200  1,500주  ← 현재가        │
│ ─────────────────────                  │
│ 매수1  57,100  3,000주                  │
│ 매수2  57,000  5,200주                  │
├─────────────────────────────────────────┤
│ 주문 입력 패널 (160px)                  │
│ 종목: [안랩 053800 ▼]                   │
│ 구분: [매수 ▼]  수량:[100] 가격:[57,200]│
│       [취소]              [주문 확인]   │
├─────────────────────────────────────────┤
│ 미체결 / 체결 내역 (하단 나머지)         │
│ [미체결] 안랩 100주 57,200원 매수 대기   │
│ [체결]  안랩  50주 56,800원 매수 완료   │
└─────────────────────────────────────────┘
```

### 25.3 실시간 화면 신규 파일

| 파일 | 경로 | 역할 |
|------|------|------|
| `realtrading.html` | `src/renderer/realtrading.html` | 실시간 거래 화면 HTML |
| `realtrading.js` | `src/renderer/realtrading.js` | 거래 화면 렌더러 로직 |
| `realtrading.css` | `src/renderer/realtrading.css` | 거래 화면 스타일 |
| `bridge.py` | `src/bridge/bridge.py` | Python 브릿지 (Flask + pykiwoom) |
| `kiwoomService.js` | `src/services/kiwoomService.js` | 브릿지 HTTP 통신 래퍼 (Node.js) |
| `005_realtime_tables.sql` | `src/db/migrations/` | 4개 신규 테이블 DDL |

---

## 26. 실시간 거래 보안 및 주의사항

### 26.1 보안 체크리스트

| 위험도 | 항목 | 대응 |
|--------|------|------|
| HIGH | 계좌번호/비밀번호 노출 | .env에만 저장, 렌더러 전달 금지 |
| HIGH | Python 브릿지 외부 접근 | Flask 서버 127.0.0.1만 바인딩 (외부 차단) |
| HIGH | 모의/실투 혼용 | KIWOOM_IS_MOCK 환경변수 + is_paper 컬럼으로 강제 구분 |
| MED | 주문 수량/금액 미검증 | 주문 전 수량>0, 가격>0, 잔고 충분 여부 서버사이드 검증 |
| MED | 이중 주문 방지 | kiwoom_order_no UNIQUE KEY + 주문 중 버튼 비활성화 |
| LOW | Python 브릿지 크래시 | main.js에서 exit 이벤트 감지 → 자동 재시작 (최대 3회) |

### 26.2 모의투자 제약사항

| 항목 | 제약 |
|------|------|
| 신용거래 | 미지원 |
| 선물/옵션 | 미지원 |
| 주문 가능 시간 | 정규장 (09:00~15:30) |
| 시간외 거래 | 제한적 지원 (확인 필요) |
| 상한가/하한가 | 실제 시장과 동일 ±30% |
| 데이터 | 실시간 시장 데이터 사용 (가격은 실제 시장 반영) |

### 26.3 환경 변수 추가 항목

```
# 기존 .env에 추가
KIWOOM_ACCOUNT_NO=812451811
KIWOOM_ACCOUNT_PW=0000
KIWOOM_IS_MOCK=true
KIWOOM_BRIDGE_PORT=5001
```

### 26.4 설치 요건 체크리스트 (운영 PC)

**키움 OpenAPI+ 설치**:
- [ ] 키움증권 OpenAPI+ 설치 프로그램 실행 (KHOpenAPI.ocx 등록)
- [ ] 영웅문4 또는 키움 HTS 실행 후 모의투자 서버로 로그인 1회 이상 (OCX 활성화)
- [ ] C:\OpenApi\KOAStudioSA.exe 실행 → TR 조회 테스트 (OPW00004 필드명 직접 확인 권장)

**Python 환경**:
- [ ] Python 3.9 이상 설치 (32비트 Python 권장 — OCX 호환성 우선)
- [ ] PATH 등록 확인: `python --version` 실행 가능
- [ ] `pip install pykiwoom flask PyQt5` 완료
- [ ] pykiwoom 설치 확인: `python -c "from pykiwoom.kiwoom import Kiwoom; print('OK')"`

**Node.js (Electron 앱)**:
- [ ] `npm install eventsource` 완료 (SSE 클라이언트)

**환경 확인**:
- [ ] Windows 방화벽: 127.0.0.1:5001 내부 루프백 허용
- [ ] `python src/bridge/bridge.py` 단독 실행 → GET /status 응답 확인

> 비트 호환성 주의: 키움 OCX는 32비트 기반. Python 64비트에서도 동작 가능하나,
> 문제 발생 시 32비트 Python으로 전환 필요. 사전에 32비트 Python으로 설치 권장.

---

## 27. 실시간 거래 개발 로드맵

### 27.1 기존 로드맵에 추가 (3.5단계)

| 단계 | 내용 | 상태 |
|------|------|------|
| 1단계 | Electron 구조 + DB + CSV + 기본 차트 | 설계 완료 |
| 2단계 | AI 채팅 (Ollama) | 대기 |
| 3단계 | Claude API 연동 | 대기 |
| **3.5단계** | **실시간 거래 (키움 OpenAPI+ + Python 브릿지 + 차일드 창)** | **설계 완료** |
| 4단계 | FinanceDataReader 자동 수집 | 대기 |
| 5단계 | 박스권 종목 스캔 | 대기 |
| 6단계 | 가격 도달 알람 | 대기 |
| 7단계 | 백테스트 | 대기 |

### 27.2 실시간 거래 3.5단계 세부 구현 순서

| Step | 파일 | 내용 | 검증 |
|------|------|------|------|
| RT-0 | 환경 준비 | OpenAPI+ 설치, Python+pykiwoom 설치 | `GET /status` 응답 확인 |
| RT-1 | `src/db/migrations/005_realtime_tables.sql` | 4개 신규 테이블 DDL | SHOW TABLES |
| RT-2 | `src/bridge/bridge.py` | Python 브릿지 (Flask + pykiwoom) | GET /status 정상 응답 |
| RT-3 | `src/services/kiwoomService.js` | 브릿지 HTTP 통신 래퍼 (Node.js) | 로그인 응답 확인 |
| RT-4 | `main.js` 수정 | Python spawn, childWindow 생성, real:* IPC 핸들러 | 창 열기 확인 |
| RT-5 | `src/renderer/realtrading.html/js/css` | 실시간 거래 UI | UI 렌더링 확인 |
| RT-6 | SSE 실시간 연동 | 브릿지 SSE 수신 → broadcastToAllWindows | 시세 수신 확인 |
| RT-7 | 주문 실행 연동 | 매수/매도 → DB → 차일드 창 | 모의 주문 체결 확인 |
| RT-8 | 메인 창 계좌 패널 | `real:windowStateChange` 처리 | 패널 토글 확인 |

### 27.3 구현 전 확인 필요 항목

**환경 준비 (RT-0)**:
- [ ] 키움 OpenAPI+ 설치 확인: C:\OpenApi\KHOpenAPI.ocx 존재 여부
- [ ] Python 설치: `python --version` (3.9 권장, 32비트 우선)
- [ ] `pip install pykiwoom flask PyQt5` 완료
- [ ] `npm install eventsource` 완료
- [ ] pykiwoom 기본 동작 확인: `python -c "from pykiwoom.kiwoom import Kiwoom; print('OK')"`

**로그인 테스트 (RT-2 전)**:
- [ ] 영웅문4 실행 → 모의투자 서버 선택 → 로그인 성공 확인
- [ ] `GetLoginInfo("GetServerGubun")` == `"0"` (모의투자) 반드시 확인
- [ ] `GetLoginInfo("ACCNO")` 결과에 `"812451811"` 포함 여부 확인

**TR 필드명 최종 확인 (KOA Studio)**:
- [ ] KOA Studio(C:\OpenApi\KOAStudioSA.exe) 실행
- [ ] OPW00004 조회 → output2 실제 필드명 확인 (`종목번호`, `평균단가` 등)
- [ ] OPW00018 조회 → 실제 필드명 확인
- [ ] GetCommRealData FID 10(현재가), FID 9001(주문번호) 확인

**성능/제약 주의사항**:
- [ ] SendOrder 속도 제한: 1초 5회 이하 (자동 throttle 구현 필요)
- [ ] SetRealReg 화면당 최대 100종목
- [ ] OPW00004 연속조회: sPreNext=="2" 시 다음 페이지 처리

---

*V3 업데이트: 키움 OpenAPI+ 기반으로 전면 재설계 (REST API 방식에서 Python 브릿지(pykiwoom+Flask+QThread) 방식으로 변경)*
*V3.1 심층 보완: 3개 서브에이전트 병렬 연구 통합 — FID 오류 수정(9203→9001), OPW00004 정확한 필드명(종목번호/평균단가/평가손익율%), SetRealReg 세미콜론 구분, QThread+Queue 스레딩 모델, SSE eventsource npm, Python 32비트 주의사항*
*코딩 시작 전 이 문서를 먼저 읽고, 구현 중 참조 기준으로 활용한다.*
