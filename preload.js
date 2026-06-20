// preload.js
// contextIsolation: false 환경 — window.appAPI 직접 할당으로 IPC 노출.
// 3.5단계 추가: real:* 채널 (실시간 거래)
const { ipcRenderer } = require('electron');

window.appAPI = {
  // 파일 대화상자
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),

  // 종목 목록 / 정보
  getStockList: () => ipcRenderer.invoke('db:getStockList'),
  // 종목 검색 (관심종목 자동완성)
  searchStocks: (query, limit = 20) => ipcRenderer.invoke('db:searchStocks', { query, limit }),
  // 관심종목 영속화 (실시간 거래 창 ↔ realtime_watchlist 테이블)
  getWatchlist:      ()       => ipcRenderer.invoke('db:getWatchlist'),
  addWatchlistDB:    (ticker) => ipcRenderer.invoke('db:addWatchlist',    { ticker }),
  removeWatchlistDB: (ticker) => ipcRenderer.invoke('db:removeWatchlist', { ticker }),
  getStockInfo: (ticker) => ipcRenderer.invoke('db:getStockInfo', { ticker }),

  // 일봉 데이터 + 지표 계산
  getStockData: (ticker, fromDate, toDate) =>
    ipcRenderer.invoke('db:getStockData', { ticker, fromDate: fromDate || null, toDate: toDate || null }),

  // 종목 추가
  addTicker: (info) => ipcRenderer.invoke('db:addTicker', info),

  // CSV Import
  importCsv: (filePath, ticker) =>
    ipcRenderer.invoke('db:importCsv', { filePath, ticker }),

  // 보유 현황
  getHoldings: (ticker) => ipcRenderer.invoke('db:getHoldings', { ticker }),
  updateHoldings: (holdings) => ipcRenderer.invoke('db:updateHoldings', holdings),

  // AI 채팅 스트리밍 (sessionId 선택적)
  sendChat: (message, ticker, engine, model, images, sessionId) =>
    ipcRenderer.send('ai:chat', { message, ticker, engine, model, images: images || [], sessionId: sessionId || null }),

  listOllamaModels: () => ipcRenderer.invoke('ollama:listModels'),

  onAiChunk: (callback) =>
    ipcRenderer.on('ai:chunk', (_, data) => callback(data)),

  onAiDone: (callback) =>
    ipcRenderer.on('ai:done', (_, stats) => callback(stats)),

  removeAiListeners: () => {
    ipcRenderer.removeAllListeners('ai:chunk');
    ipcRenderer.removeAllListeners('ai:done');
  },

  // 채팅 이력 (레거시)
  loadChatHistory:  (ticker) => ipcRenderer.invoke('chat:load',  { ticker }),
  clearChatHistory: (ticker) => ipcRenderer.invoke('chat:clear', { ticker }),

  // ============ 세션 관리 ============
  createSession:  (name, ticker, engine) => ipcRenderer.invoke('chat:createSession', { name, ticker, engine }),
  listSessions:   (ticker)               => ipcRenderer.invoke('chat:listSessions',  { ticker }),
  loadSession:    (sessionId, limit)     => ipcRenderer.invoke('chat:loadSession',   { sessionId, limit }),
  deleteSession:  (sessionId)            => ipcRenderer.invoke('chat:deleteSession', { sessionId }),
  renameSession:  (sessionId, name)      => ipcRenderer.invoke('chat:renameSession', { sessionId, name }),

  // ============ 전역 메모리 ============
  listMemory:   ()   => ipcRenderer.invoke('memory:list'),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', { id }),

  // 박스권 스캐너
  runBoxScan:           (configOverride) => ipcRenderer.invoke('scan:runBoxScan', configOverride || {}),
  getScannerDefaults:   ()               => ipcRenderer.invoke('scan:getDefaults'),
  getBoxScanResults: ()         => ipcRenderer.invoke('scan:getResults'),
  confirmBoxResult:  (resultId) => ipcRenderer.invoke('scan:confirmResult', { resultId }),
  rejectBoxResult:   (resultId) => ipcRenderer.invoke('scan:rejectResult',  { resultId }),

  // 백테스트
  runBacktest: (opts) => ipcRenderer.invoke('backtest:run', opts || {}),

  // 증분 업데이트 강제 실행 (collector/scripts/incremental.py)
  runIncremental: () => ipcRenderer.send('db:runIncremental'),
  onIncrementalLog:  (cb) => ipcRenderer.on('incremental:log',  (_, d) => cb(d)),
  onIncrementalDone: (cb) => ipcRenderer.on('incremental:done', (_, d) => cb(d)),
  removeIncrementalListeners: () => {
    ipcRenderer.removeAllListeners('incremental:log');
    ipcRenderer.removeAllListeners('incremental:done');
  },

  // ============ 실시간 거래 (3.5단계) ============

  // 실시간 거래 창 열기
  realOpenWindow: () => ipcRenderer.invoke('real:openWindow'),

  // 키움 로그인 (CommConnect GUI 팝업)
  realLogin: () => ipcRenderer.invoke('real:login'),

  // 계좌 잔고 + 보유종목 조회 (OPW00004)
  realGetAccount: () => ipcRenderer.invoke('real:getAccount'),

  // 보유종목 조회
  realGetHoldings: () => ipcRenderer.invoke('real:getHoldings'),

  // 실시간 시세 구독
  realSubscribe: (tickers) => ipcRenderer.invoke('real:subscribe', { tickers }),

  // 실시간 시세 구독 해제
  realUnsubscribe: (tickers) => ipcRenderer.invoke('real:unsubscribe', { tickers }),

  // 매수 주문
  realOrderBuy: (ticker, qty, price) =>
    ipcRenderer.invoke('real:orderBuy', { ticker, qty, price }),

  // 매도 주문
  realOrderSell: (ticker, qty, price) =>
    ipcRenderer.invoke('real:orderSell', { ticker, qty, price }),

  // 주문 취소
  realCancelOrder: (ticker, qty, orgOrderNo, orderType) =>
    ipcRenderer.invoke('real:cancelOrder', { ticker, qty, orgOrderNo, orderType }),

  // 브릿지 상태 조회
  realBridgeStatus: () => ipcRenderer.invoke('real:bridgeStatus'),

  // 로그아웃
  realLogout: () => ipcRenderer.invoke('real:logout'),

  // SSE 강제 재연결
  realReconnectSSE: () => ipcRenderer.invoke('real:reconnectSSE'),

  // ---- push 이벤트 수신 (main → renderer) ----

  // 실시간 시세 이벤트 수신
  onRealQuote: (callback) =>
    ipcRenderer.on('real:onQuote', (_, data) => callback(data)),

  // 호가 이벤트 수신
  onRealOrderbook: (callback) =>
    ipcRenderer.on('real:onOrderbook', (_, data) => callback(data)),

  // 체결 통보 수신
  onRealExecution: (callback) =>
    ipcRenderer.on('real:onExecution', (_, data) => callback(data)),

  // 실시간 창 열림/닫힘 알림 수신 (메인 창에서 계좌 패널 토글)
  onRealWindowStateChange: (callback) =>
    ipcRenderer.on('real:windowStateChange', (_, data) => callback(data)),

  // 브릿지 오류 알림 수신
  onRealBridgeError: (callback) =>
    ipcRenderer.on('real:bridgeError', (_, data) => callback(data)),

  // 계좌 데이터 메인 창으로 broadcast (차일드 창에서 호출)
  realBroadcastAccount: (account, holdings) =>
    ipcRenderer.send('real:broadcastAccount', { account, holdings }),

  // 메인 창: 계좌 데이터 수신 (real:broadcastAccount relay)
  onRealAccountUpdated: (callback) =>
    ipcRenderer.on('real:accountUpdated', (_, data) => callback(data)),

  // 모든 실시간 이벤트 리스너 제거 (창 닫힐 때 정리)
  removeRealListeners: () => {
    ipcRenderer.removeAllListeners('real:onQuote');
    ipcRenderer.removeAllListeners('real:onOrderbook');
    ipcRenderer.removeAllListeners('real:onExecution');
    ipcRenderer.removeAllListeners('real:windowStateChange');
    ipcRenderer.removeAllListeners('real:bridgeError');
    ipcRenderer.removeAllListeners('real:accountUpdated');
  }
};
