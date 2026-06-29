# AI 주식 분석 시스템 — 프로젝트 CLAUDE.md

| 항목 | 내용 |
|------|------|
| 문서명 | AI 주식 분석 시스템 프로젝트 지침 |
| 버전 | V1 |
| 날짜 | 2026-06-11 |
| 작성자 | Claude Sonnet 4.6 |
| 문서 유형 | 프로젝트 CLAUDE.md |
| 사용 모델 | claude-sonnet-4-6 |

> 전역 CLAUDE.md 중복 규칙은 이 파일에 기재하지 않는다.
> 코딩 원칙, 서브에이전트 규칙, 언어 설정 등은 전역 CLAUDE.md 참조.

---

## 서브에이전트 목록

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| `db-agent` | Sonnet | MariaDB 연결, 쿼리, CSV import |
| `chart-agent` | Sonnet | Chart.js 차트, 지표 계산 |
| `ai-agent` | Sonnet | Ollama/Claude API, 프롬프트 관리 |
| `ui-agent` | Sonnet | Electron 메인/렌더러, IPC |
| `critic` | Sonnet | 리스크 평가, 보안 취약점 비판 검토 |
| Advisor | **Opus** | 에스컬레이션 응답 전용 — 직접 실행 불가 |

에이전트 상세 정의: `.claude/agents/*.md`
에스컬레이션 조건: `.claude/advisor_workflow.md`

---

## 1. 프로젝트 개요

한국 중소형 박스권 종목 전문 AI 주식 분석 데스크탑 앱.
안랩(053800.KQ)처럼 장기 박스권을 유지하면서 이슈 발생 시 급등하는 종목을
OBV/볼린저밴드/RSI 다이버전스 분석으로 진입 타이밍을 판단한다.
자연어 대화 인터페이스로 AI와 실시간 전략 수립.

**투자 전략 핵심**
- 손절 없는 박스권 하단 매수 + 분할 매수
- 오후장(12:00~15:30) 집중 모니터링
- 일봉으로 구역 설정 → 15분/30분봉으로 진입 타이밍 확정
- 이슈 발생 시 박스권 상단 돌파 기대 (안철수 정치 행보 / 보안 이슈)

---

## 2. 기술 스택

| 영역 | 기술 | 버전/비고 |
|------|------|-----------|
| 데스크탑 | Electron | Windows 전용 |
| 렌더러 | HTML / CSS / Vanilla JS | 프레임워크 없음 |
| 차트 | Chart.js + chartjs-chart-financial | 캔들차트 플러그인 필수 |
| DB 연결 | mysql2 (Node.js) | Promise API 사용 |
| AI 기본 | Ollama API | localhost:11434 |
| AI 고급 | Claude API | claude-sonnet-4-6 |
| 데이터 수집 | FinanceDataReader + PyKRX + yfinance (Python) | 4단계 이후, 무료 |
| DB 서버 | MariaDB 14 on Linux | 로컬 네트워크 원격 서버 |
| 패키징 | electron-builder | Windows 배포 |

---

## 3. 디렉토리 구조

```
stock-talk/
├── CLAUDE.md
├── package.json
├── main.js                     # Electron 메인 프로세스
├── preload.js                  # IPC 컨텍스트 브릿지 (contextBridge)
├── .env                        # DB/API 접속 정보 (git 제외)
├── .env.example                # 환경 변수 템플릿
├── src/
│   ├── db/
│   │   ├── connection.js       # mysql2 연결 풀 (싱글톤)
│   │   ├── queries.js          # 종목별 SQL 쿼리 함수 모음
│   │   └── init.sql            # DB/테이블 생성 DDL
│   ├── services/
│   │   ├── indicators.js       # OBV/BB/RSI/MACD 계산
│   │   └── aiService.js        # Ollama + Claude API 통합
│   └── renderer/
│       ├── index.html          # 메인 화면 레이아웃
│       ├── renderer.js         # 렌더러 진입점 + IPC 연결
│       ├── chart.js            # Chart.js 3패널 차트
│       └── styles.css
├── assets/
│   └── (아이콘, 정적 파일)
├── code_update.md              # 변경 이력 (날짜/변경내용/이유)
└── talk_history.md             # 세션 요약
```

---

## 4. 데이터베이스 설계

### 접속 정보
- 서버: 로컬 네트워크 내 Linux 서버 (MariaDB 14)
- 포트: 3306
- DB명: `stock_analysis`
- 계정: `stock_user` (전용 계정)
- 접속 방식: 동일 공유기 내부 네트워크 (실시간성 불필요)

### 테이블 목록

| 테이블 | 용도 |
|--------|------|
| `stock_info` | 종목 기본 정보 + 박스권 상단/하단 |
| `stock_daily` | 일봉 OHLCV 데이터 |
| `user_holdings` | 보유 현황 (매입단가, 수량, 가용자금) |
| `chat_history` | AI 대화 기록 (엔진 구분 포함) |

### stock_info 주요 컬럼
`ticker (PK), name, market, box_low, box_high, note, created_at`

### stock_daily 주요 컬럼
`id, ticker, trade_date (DATE), open, high, low, close, volume, created_at`
UNIQUE KEY: `(ticker, trade_date)`

### user_holdings 주요 컬럼
`id, ticker (FK), avg_price, quantity, available_cash, strategy, horizon, expected_issue, split_plan, updated_at`

### chat_history 주요 컬럼
`id, ticker, role ENUM('user','assistant'), content, engine ENUM('ollama','claude'), created_at`

---

## 5. AI 엔진 이중 구조

| 구분 | 엔진 | 사용 시점 | 맥락 유지 |
|------|------|-----------|-----------|
| 기본 | Ollama (로컬) | 일상 분석, 지표 조회, 현황 요약 | 최근 10턴 |
| 고급 | Claude API | 실제 매수 판단, 이례적 패턴, 이슈 발생 시 | 최근 20턴 |

**확정 모델: `gemma4:12b`** (RTX 5060 Ti 16GB, 7.6GB, 확인 완료)

> 로컬 추가 모델: `exaone3.5:2.4b` (경량 백업)
> 클라우드 모델: `gpt-oss:120b-cloud`, `gemma4:31b-cloud`, `qwen3-coder:480b-cloud` (외부 API, 별도 확인 필요)

---

## 6. AI 시스템 프롬프트 구조

매 대화 시 4개 블록 조합:
- **[A] 기본 프롬프트** (고정): 역할 정의 + 분석 철학
- **[B] 모드 프롬프트** (동적): 6가지 모드 중 자동 선택
- **[C] 개인 컨텍스트** (동적): user_holdings에서 조회
- **[D] 실시간 지표** (동적): DB에서 계산한 최신값

**6가지 AI 모드**

| 모드 | 발동 조건 |
|------|-----------|
| MODE 1 매수탐색 | 현재가 박스권 하단 ±7% 이내 |
| MODE 2 익절관리 | 현재가 박스권 상단 ±7% 이내 |
| MODE 3 위기관리 | 현재가 박스권 하단 이탈 |
| MODE 4 이슈추격 | 박스권 상단 이탈 + 거래량 평균 대비 2배 이상 |
| MODE 5 리커버리 | 평가손실 매입단가 대비 -10% 이상 |
| MODE 6 일반분석 | 위 5가지에 해당하지 않는 경우 (기본값) |

---

## 7. CSV Import 규칙

안랩 CSV 형식: `date, open, high, low, close, volume, change_ratio`
- `date` 형식: YYYYMMDD → DATE 변환 필요
- `change_ratio` 컬럼: DB에 저장하지 않음 (재계산 가능)
- 중복 처리: `INSERT IGNORE` 사용 (UNIQUE KEY 활용)
- 기본 ticker: `053800` (안랩)

---

## 8. 차트 구성

| 패널 | 지표 | 비고 |
|------|------|------|
| 패널 1 (메인) | 캔들 + 볼린저밴드 + MA5/20/60 | 박스권 상단/하단 수평선 오버레이 |
| 패널 2 | OBV + OBV MA20 | 수급 방향 |
| 패널 3 | RSI(14) + 30/70 기준선 | 과매도/과매수 |

Chart.js 기본은 캔들 미지원 → `chartjs-chart-financial` 플러그인 필수.

---

## 9. IPC 채널 목록

| 채널명 | 방향 | 기능 |
|--------|------|------|
| `db:getStockData` | renderer → main | 종목 일봉 데이터 조회 |
| `db:getHoldings` | renderer → main | 보유 현황 조회 |
| `db:updateHoldings` | renderer → main | 보유 현황 수정 |
| `ai:chat` | renderer → main | AI 메시지 전송 |
| `ai:switchEngine` | renderer → main | Ollama ↔ Claude 전환 |

---

## 10. 환경 변수 (.env)

```
DB_HOST=192.168.20.80
DB_PORT=3306
DB_USER=root
DB_PASSWORD=<비밀번호 — .env에만 저장>
DB_NAME=stock_analysis
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:12b
CLAUDE_API_KEY=<Anthropic API Key>
CLAUDE_MODEL=claude-sonnet-4-6
```

> DB_HOST: `192.168.20.80` (표준 사설망 IP, 확인 완료)

---

## 11. 개발 로드맵

| 단계 | 내용 | 상태 |
|------|------|------|
| 1단계 | Electron 구조 + MariaDB 연결 + CSV import + 기본 차트 | 설계 완료 |
| 2단계 | AI 채팅 연동 (Ollama) + 시스템 프롬프트 | 대기 |
| 3단계 | Claude API 연동 + 엔진 전환 UI | 대기 |
| 4단계 | FinanceDataReader 자동 수집 | 대기 |
| 5단계 | 박스권 종목 스캔 (KRX 전 종목) | 대기 |
| 6단계 | 가격 도달 알람 | 대기 |
| 7단계 | 백테스트 | 대기 |

### 1단계 세부 구현 순서
```
Step 1  package.json + Electron 기본 구조 (main.js, preload.js)
Step 2  .env + mysql2 연결 풀 (connection.js)
Step 3  init.sql — 4개 테이블 DDL
Step 4  csvImport.js — ahnlab_daily.csv 파싱 및 INSERT
Step 5  indicators.js — OBV/BB/RSI 계산 함수
Step 6  index.html + styles.css — 3패널 레이아웃
Step 7  chart.js — Chart.js 캔들+OBV+RSI
Step 8  renderer.js + IPC 연결 — 전체 흐름 연결 테스트
```

---

## 12. 주요 설계 결정 및 배경

| 결정 | 배경 |
|------|------|
| 원격 MariaDB 사용 | 앱 재설치 시 데이터 보존, 여러 PC 접근 가능 |
| Ollama 기본 + Claude 고급 이중 구조 | 일상 분석 무료화, 중요 판단 시만 과금 (건당 15~30원) |
| holdings 테이블 1단계 포함 | AI 개인 컨텍스트 주입에 필수, 나중 추가 시 구조 변경 복잡 |
| IPC 브릿지 경유 DB 접속 | Electron 보안 모델 — 렌더러에서 직접 mysql2 사용 불가 |
| chartjs-chart-financial 플러그인 | Chart.js 기본 캔들차트 미지원 |
| INSERT IGNORE로 CSV 중복 처리 | 재import 시 기존 데이터 보존 |

---

## 13. 미결 사항

- [x] Ollama 모델 확정: `gemma4:12b` (7.6GB, 확인)
- [x] Node.js 버전 확인: 로컬 PC v24.15.0 / 원격 서버 v20.20.2
- [x] DB 접속 정보 확정: 192.168.20.80:3306 (root)
- [x] `192.168.20.80` ping 응답 확인
- [x] Claude API 키 보유 확인
- [x] 데이터 소스 확정: yfinance + PyKRX (무료)
- [ ] MariaDB `stock_analysis` DB 생성 — Step 3 init.sql 실행 시 생성
- [ ] DB root 계정 원격 접속 권한 확인 — Step 2 접속 테스트 시 검증
- [ ] 프로젝트명 결정 (현재 폴더명: stock-talk)
