# 변경 이력 (code_update.md)

| 항목 | 내용 |
|------|------|
| 문서명 | code_update.md |
| 버전 | V1 |
| 날짜 | 2026-06-11 |
| 프로젝트 | AI 주식 분석 시스템 |

---

## 변경 이력

| 날짜 | 시간 | 파일 | 변경 내용 | 이유 |
|------|------|------|-----------|------|
| 2026-06-14 | - | `src/services/boxScanner.js` | 최소 데이터 기준 `750` 고정값 → `Math.floor(periodMonths * 17)` 동적값으로 변경 | 36개월 기간의 실제 거래일은 약 729일로 고정 750 기준 전 종목 탈락 버그. 수정 후 2485개 종목 통과 |
| 2026-06-14 | - | `src/services/aiService.js`, `main.js`, `preload.js`, `src/renderer/index.html`, `src/renderer/renderer.js`, `src/renderer/styles.css` | AI 채팅창 이미지 첨부 비전 기능 추가 | Ollama/Claude 비전 API 활용. 파일 선택/클립보드 붙여넣기(캡처)/드래그 앤 드롭 3가지 방식 지원. base64 변환 후 IPC 전송. 이미지는 DB 미저장(용량). |
| 2026-06-14 | - | `src/renderer/chart.js`, `src/renderer/index.html`, `src/renderer/styles.css` | 차트 2패널→3패널. 최상단 캔들+MA5/20/60 패널 추가 | 이동평균선(MA5 빨강/MA20 노랑/MA60 파랑) 시각화. 박스권 annotation 공유, 팬/윈도우 3패널 동기화. 비율 MA:캔들:지표=2:2:1. |
| 2026-06-14 | - | `src/config/scanner.config.js`(신규), `src/services/boxScanner.js`, `main.js`, `preload.js`, `src/renderer/index.html`, `src/renderer/renderer.js`, `src/renderer/styles.css` | 박스권 스캐너 v4: 설정 파일 분리 + 전체 필터 강화 + UI 설정 창 | config 기반 파라미터화, 유니버스/유동성/최근성/위치/거짓박스권 필터 추가. 사이드바에 설정 창(기본값 표시, 항목별/전체 초기화). localStorage 저장. 2768→2637종목으로 유니버스 정리. |
| 2026-06-14 | - | `src/services/backtest.js`(신규), `main.js`, `preload.js`, `src/renderer/index.html`, `src/renderer/renderer.js`, `src/renderer/styles.css` | 박스권 백테스트 기능 추가 | 최신 스캔 결과 종목별 1000만원 독립 시뮬레이션(3년). 지지선 터치→전액매수, 저항선 터치→전량매도, 손절 없음, 수수료 0.015%. 수익률/승률/평균보유기간/미실현손익 표시. |
| 2026-06-14 | - | `src/services/aiService.js`, `src/renderer/renderer.js`, `src/renderer/styles.css` | 에이전틱 다단계 검색 + 후속 질문 제안 | 인터넷 검색 시 1차(5개)→AI 반성→2차 검색(최대 10개)까지 자동 확장. 답변 끝 [Q:...] 태그 파싱해 클릭 가능 후속 질문 버튼 렌더링. 채팅 스크롤 개선(질문 최상단 고정). |
|------|------|------|-----------|------|
| 2026-06-11 | 세션 1 | CLAUDE.md | 최초 프로젝트 설계 문서 생성 | 프로젝트 시작 |
| 2026-06-11 | 세션 1 | .claude/agents/*.md | 5개 에이전트 정의 생성 | 서브에이전트 워크플로우 설정 |
| 2026-06-11 | 세션 1 | .claude/advisor_workflow.md | Advisor 워크플로우 생성 | 에스컬레이션 조건 정의 |
| 2026-06-11 | 세션 1 | .claude/hooks/*.sh | 프로젝트 훅 생성 | PostToolUse/SessionEnd 처리 |
| 2026-06-11 | 세션 2 | RESEARCH.md | 최초 생성 — 13섹션 심층 연구 보고서 | /order1 실행, 서브에이전트 3개 병렬 연구 통합 |
| 2026-06-11 | 세션 2 | 차트시각화_기술지표_심층연구_V1_20260611.md | 차트/지표 상세 연구 보조 문서 생성 | 서브에이전트 #2 산출물 |
| 2026-06-11 | 세션 2 | CLAUDE.md | 확정 환경 정보 업데이트 (Ollama 모델, DB 접속 정보, Node 버전) | /order1 확정 정보 반영 |
| 2026-06-11 | 세션 3 | RESEARCH.md | V1→V2 대규모 업데이트 — 섹션 14~19 신규 추가, 기존 섹션 보완 | /order1 재실행, 98% 완성도 목표 |
| 2026-06-11 | 세션 3 | RESEARCH.md | V2 최종 확인 업데이트 — IP 확인, 모델 확인, PyKRX 확정, 체크리스트 완료 | 사용자 5개 항목 확인 답변 반영 |
| 2026-06-11 | 세션 3 | CLAUDE.md | 미결 사항 업데이트, 데이터 소스 확정(PyKRX+yfinance), Ollama 모델 목록 보완 | 사용자 확인 정보 반영 |
| 2026-06-11 | 세션 4 | PLAN.md | 최초 생성 (1670행) — Step 1~9 구현 계획서, 코드 스니펫 포함 | /order2 실행 (98% 완성도 목표) |
| 2026-06-11 | 세션 4 | PLAN.md | V1 완성 (3166행) — Step 2.3 queries.js, Step 6 HTML+CSS, Step 7 Chart.js, Step 8 renderer.js, Step 9 aiService.js 전체 코드 추가 | 컨텍스트 압축 후 재개, 미완성 Step 완성 |
| 2026-06-11 | 세션 4 | PLAN.md | Step 5.4 IPC 핸들러 수정 — LIMIT 방식 → fromDate/toDate Input-based paging | 오프셋 페이징 버그 수정 |
| 2026-06-11 | 세션 5 | main.js | 최종 통합 main.js 생성 — BrowserWindow + 전체 IPC 핸들러 (dialog, db, ai) | PLAN.md Step 1.2+2.2+4.3+8.2+9.2 통합 |
| 2026-06-11 | 세션 5 | src/db/connection.js | mysql2 연결 풀 싱글톤 생성 | Step 2 구현 |
| 2026-06-11 | 세션 5 | src/db/queries.js | DB 쿼리 함수 8개 — Input-based paging 전용 | Step 2 구현 |
| 2026-06-11 | 세션 5 | src/db/init.sql | 4개 테이블 DDL + 안랩 초기 데이터 | Step 3 구현 |
| 2026-06-11 | 세션 5 | src/db/GUIDE.md | DB 폴더 문서화 | Step 2 완성 |
| 2026-06-11 | 세션 5 | src/services/csvImport.js | CSV 파싱 + INSERT IGNORE (100행 배치, 스트림) | Step 4 구현 |
| 2026-06-11 | 세션 5 | src/services/indicators.js | 12개 기술지표 — RSI Wilder/BB N-1 분산 | Step 5 구현 |
| 2026-06-11 | 세션 5 | src/services/aiService.js | Ollama+Claude 이중 구조, 4블록 프롬프트, 6모드 | Step 9 구현 |
| 2026-06-11 | 세션 5 | src/services/GUIDE.md | aiService.js 구현 완료 반영 업데이트 | Step 9 완성 |
| 2026-06-11 | 세션 5 | src/renderer/index.html | 3패널 다크 테마 레이아웃 | Step 6 구현 |
| 2026-06-11 | 세션 5 | src/renderer/styles.css | CSS 변수 기반 다크 테마 | Step 6 구현 |
| 2026-06-11 | 세션 5 | src/renderer/chart.js | Chart.js 3패널 (candlestick+OBV+RSI) + 박스권 어노테이션 | Step 7 구현 |
| 2026-06-11 | 세션 5 | src/renderer/renderer.js | 이벤트 핸들러 + IPC 호출 + AI 스트리밍 | Step 8 구현 |
| 2026-06-11 | 세션 5 | src/renderer/GUIDE.md | renderer 폴더 문서화 | Step 6 완성 |
| 2026-06-11 | 세션 5 | node_modules/ | npm install 완료 (310 packages, 0 vulnerabilities) | 의존성 설치 |
| 2026-06-13 | 세션 6 | DataCollector_V1_20260613.md | 데이터 수집 파이프라인 설계 문서 생성 | /ralph 워크플로우 — 사용자 9개 미결 결정 사항 반영 전 합의 |
| 2026-06-13 | 세션 6 | src/db/migrations/002_stock_info_collector_columns.sql | stock_info 컬럼 확장 (is_active/listed_date/delisted_date/last_synced_at) + idx_is_active 인덱스 | 폐지 종목 추적 + 수집기 마지막 동기화 시각 기록 |
| 2026-06-13 | 세션 6 | collector/__init__.py | 패키지 마커 + __version__ | 서버용 Python 수집기 진입 |
| 2026-06-13 | 세션 6 | collector/config.py | .env 로드 + 환경 상수 노출 + DB 비밀번호 마스킹 summary() | 단일 진입점에서 설정 흡수 |
| 2026-06-13 | 세션 6 | collector/log.py | TimedRotatingFileHandler 30일 + 콘솔 핸들러 | cron stdout/stderr 양쪽 캡처 |
| 2026-06-13 | 세션 6 | collector/notify.py | 텔레그램 sendMessage + graceful skip | 토큰 미설정 시 수집 중단 방지 |
| 2026-06-13 | 세션 6 | collector/db.py | pymysql 싱글톤 + ping reconnect + 트랜잭션 컨텍스트 + executemany | 안정적 DB 적재 + SQL Injection 방지 |
| 2026-06-13 | 세션 6 | collector/krx.py | pykrx 래퍼 — get_all_tickers/get_ohlcv + 3회 지수 백오프 재시도 | KRX 일시 오류 신뢰성 확보 |
| 2026-06-13 | 세션 6 | collector/tickers.py | stock_info 동기화 — 신규/명변경/폐지/복귀 단일 트랜잭션 | 종목 메타 무결성 보존 |
| 2026-06-13 | 세션 6 | collector/ohlcv.py | init_load/incremental/retry_failed + 실패 큐 (state/failed_tickers.json) | 종목별 격리 + 멱등 적재 |
| 2026-06-13 | 세션 6 | collector/scripts/init_load.py | 초기 5년치 일괄 적재 진입점 + 텔레그램 요약 + Exit code 0/1/2 | 1회성 부트스트랩 |
| 2026-06-13 | 세션 6 | collector/scripts/incremental.py | 매일 cron 진입점 — 영업일 체크 + 증분 + 텔레그램 요약 | 16:30 KST 평일 자동 실행 |
| 2026-06-13 | 세션 6 | collector/requirements.txt + .env.example | pykrx/pymysql/dotenv/requests/pandas + 환경 변수 템플릿 | 서버 셋업 명시화 |
| 2026-06-13 | 세션 6 | collector/GUIDE.md + README.md | 폴더 가이드 + 배포 매뉴얼 (텔레그램 봇 등록 / cron / 트러블슈팅) | 운영 표준화 |
| 2026-06-13 | 세션 6 | collector/ohlcv.py | init_load._range() 단순화 — 5년 보장 전제 (INSERT IGNORE로 중복 자동 무시) | cavecrew-reviewer 지적 (혼란스러운 min() 로직 제거) |
| 2026-06-13 | 세션 6 | collector/krx.py | _retry()에 max_attempts 옵션 + get_ticker_name() fast-fail (1회) | 종목명 조회 3,000회 누적 대기 폭증 방지 |
| 2026-06-13 | 세션 6 | collector/requirements.txt | 주석 영문화 (UTF-8 한글 → cp949 충돌 회피) | Windows pip 인코딩 호환 |
| 2026-06-13 | 세션 6 | DB 마이그레이션 실행 | 192.168.20.80 stock_info에 is_active/listed_date/delisted_date/last_synced_at 적용 — pymysql 직접 실행 | 002_stock_info_collector_columns.sql 적용 |
| 2026-06-13 | 세션 6 | collector/krx.py | is_business_day() 요일 기반 단순화 + get_recent_business_day() 폴백 강화 (주말→직전 금요일) | pykrx 미래 날짜 API 응답 불안정 → 정상 영업일에 cron 오스킵 방지 |
| 2026-06-13 | 세션 6 | 안랩(053800) 단일 종목 파이프라인 검증 | OHLCV 30일 조회 + INSERT IGNORE 1행 신규 + DB 누적 3,001행 (2014-03-19 ~ 2026-06-12) 확인 | end-to-end 검증 |
| 2026-06-13 | 세션 6 | collector/krx.py | get_all_tickers_with_names() — FinanceDataReader 우선 + pykrx 폴백 (KOSPI 946+KOSDAQ 1822 일괄 + 종목명 포함) | KRX 메타 endpoint 주말 미응답 회피 + 종목명 조회 N+1 제거 |
| 2026-06-13 | 세션 6 | collector/tickers.py | sync_tickers() — FDR 일괄 결과 직접 사용, 종목명 개별 호출 제거 | 5~10분 → 1초로 단축 |
| 2026-06-13 | 세션 6 | collector/requirements.txt | finance-datareader 추가 | 종목 마스터 폴백 소스 |
| 2026-06-13 | 세션 6 | init_load 백그라운드 실행 (PID 8188) | PowerShell Start-Process detached + RedirectStandardOutput — 2,768 종목 5년치 원격 DB 적재 | 사용자 요청: 메인 프로그램과 별개 백그라운드 |
| 2026-06-13 | 세션 6 | src/renderer/index.html | date-range 기본 selected 3m→6m + 검색 박스(#stock-search) + 시장 필터(#stock-market-filter) + 종목 수 카운트(#stock-count) + 수동 추가 폼 details 접힘 | 사용자 요청: 메인화면 6개월 + 사이드바 검색 |
| 2026-06-13 | 세션 6 | src/renderer/renderer.js | state.fromDate 기본 6m + state.allStocks 캐싱 + renderStockList() 필터 함수 + escapeHtml + debounce(200ms) + 검색/필터 이벤트 | 클라이언트 사이드 검색 (2,768개 메모리 필터) |
| 2026-06-13 | 세션 6 | src/renderer/styles.css | 검색 행 + 시장 필터 + 종목 목록 스크롤(max-height 360px) + 3열 종목 행 (코드/이름/시장) + details summary 스타일 | UI 일관성 |
| 2026-06-13 | 세션 6 | src/renderer/chart.js | updateCharts() 윈도우 캡 제거 — 받은 데이터 전체(fromDate~toDate) 표시. ONE_MONTH_MS 상수 제거 | 사용자 보고: 6m 선택해도 21봉(1개월)만 표시 — 차트가 강제로 최근 1개월로 잘랐던 원인 해결 |
| 2026-06-13 | 세션 6 | src/renderer/chart.js | SIX_MONTH_MS 상수 + 가시 윈도우 6개월 캡 부활 — 데이터가 6개월 초과면 화면은 최근 6개월, 나머지는 드래그 | 사용자 요청: 6개월 캡 + 나머지 드래그 |
| 2026-06-13 | 세션 6 | src/renderer/index.html + renderer.js | 헤더 date-range 기본 6m → 1y, state.fromDate 1년치 로딩 | 화면 6개월 + 추가 6개월치 드래그 영역 확보 |
| 2026-06-13 | 세션 6 | src/renderer/index.html | chart-area 최상단에 #ticker-tabs 영역 추가 | 핀(체크) 종목 탭 표시 자리 |
| 2026-06-13 | 세션 6 | src/renderer/renderer.js | state.pinnedTickers (localStorage 영속) + prefetchCache(TTL 5분) + selectTicker/togglePin/renderTickerTabs/setupTickerTabs/prefetchTicker/prefetchPinned + loadStockData 캐시 우선 + 날짜 변경 시 캐시 무효화 + 핀 재프리로드 | 사용자 요청: 체크박스 핀 + 백그라운드 프리로드 + 탭 UI |
| 2026-06-13 | 세션 6 | src/renderer/styles.css | .pin-checkbox + .ticker-tabs + .ticker-tab (active/cached) + .tab-close 스타일 | 사이드바 체크박스 + 차트 위 탭 바 |
| 2026-06-13 | 세션 6 | src/renderer/index.html | 헤더에 #header-stock-search (datalist 자동완성) + #btn-header-search 추가 | 사용자 보고: 종목 검색 방법 안 보임 — 사이드바 외 헤더에도 큰 검색 박스 |
| 2026-06-13 | 세션 6 | src/renderer/renderer.js | datalist 자동 채움 + resolveHeaderSearch() (정확/시작/포함 매칭 우선순위) + Enter/조회 버튼/datalist 선택 이벤트 | 헤더 검색 동작 — 코드/종목명 입력 → selectTicker() |
| 2026-06-13 | 세션 6 | src/renderer/styles.css | .header-search-wrap + #header-stock-search 220px + #btn-header-search 스타일 | 헤더 검색 UI |
| 2026-06-13 | 세션 6 | src/services/aiService.js + .env | SearXNG 기본 포트 8080 → 8888 (실측 확정 엔드포인트) + 타임아웃 8s → 15s + .env에 SEARXNG_URL 명시 | 사용자 보고: 인터넷 검색 타임아웃 — 포트 오인지 + 타임아웃 부족 |
| 2026-06-13 | 세션 6 | src/renderer/styles.css | #stock-market-filter max-width 70px + #ticker-select max-width 140px | 사용자 요청: 마켓 선택 화면 절반 (사이드바 필터 + 헤더 드롭다운 양쪽 적용) |
| 2026-06-13 | 세션 6 | src/renderer/renderer.js | PINNED_KEY + loadPinnedTickers + savePinnedTickers를 state 선언 *위*로 이동 + catch 로그 추가 | 사용자 보고: 재시작 시 체크 상태 미복원 — state 초기화에서 loadPinnedTickers() 호출 시 PINNED_KEY가 TDZ → ReferenceError가 catch로 흡수되어 항상 빈 배열 반환되던 침묵 버그 수정 |
| 2026-06-14 | 세션 6 | collector/ohlcv.py | incremental() 재작성 — 종목 단위(2,768 호출) → 날짜 단위(영업일당 2 호출, KOSPI+KOSDAQ get_market_ohlcv_by_ticker). MAX(trade_date)+1 ~ today 영업일 루프. 활성 종목 필터 + INSERT IGNORE. 실패 큐 저장 제거(다음 cron 자연 재시도) | 사용자 보고: 증분이 init_load와 동일 시간(~60분) — KRX API 호출 횟수가 병목, 데이터 양이 아님. 변경 후 1 영업일당 ~3초 예상 (1,200배 단축) |
