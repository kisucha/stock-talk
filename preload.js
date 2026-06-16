// preload.js
// contextIsolation: false 환경 — window.appAPI 직접 할당으로 IPC 노출.
// 3.5단계 추가: real:* 채널 (실시간 거래)
const { ipcRenderer } = require('electron');

window.appAPI = {
  // 파일 대화상자
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),

  // 종목 목록 / 정보
  getStockList: () => ipcRenderer.invoke('db:getStockList'),
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

  // AI 채팅 스트리밍
  sendChat: (message, ticker, engine, model, images) =>
    ipcRenderer.send('ai:chat', { message, ticker, engine, model, images: images || [] }),

  listOllamaModels: () => ipcRenderer.invoke('ollama:listModels'),

  onAiChunk: (callback) =>
    ipcRenderer.on('ai:chunk', (_, data) => callback(data)),

  onAiDone: (callback) =>
    ipcRenderer.on('ai:done', (_, stats) => callback(stats)),

  removeAiListeners: () => {
    ipcRenderer.removeAllListeners('ai:chunk');
    ipcRenderer.removeAllListeners('ai:done');
  },

  // 채팅 이력
  loadChatHistory:  (ticker) => ipcRenderer.invoke('chat:load',  { ticker }),
  clearChatHistory: (ticker) => ipcRenderer.invoke('chat:clear', { ticker }),

  // 박스권 스캐너
  runBoxScan:           (configOverride) => ipcRenderer.invoke('scan:runBoxScan', configOverride || {}),
  getScannerDefaults:   ()               => ipcRenderer.invoke('scan:getDefaults'),
  getBoxScanResults: ()         => ipcRenderer.invoke('scan:getResults'),
  confirmBoxResult:  (resultId) => ipcRenderer.invoke('scan:confirmResult', { resultId }),
  rejectBoxResult:   (resultId) => ipcRenderer.invoke('scan:rejectResult',  { resultId }),

  // 백테스트
  runBacktest: (opts) => ipcRenderer.invoke('backtest:run', opts || {}),

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

  // 모든 실시간 이벤트 리스너 제거 (창 닫힐 때 정리)
  removeRealListeners: () => {
    ipcRenderer.removeAllListeners('real:onQuote');
    ipcRenderer.removeAllListeners('real:onOrderbook');
    ipcRenderer.removeAllListeners('real:onExecution');
    ipcRenderer.removeAllListeners('real:windowStateChange');
    ipcRenderer.removeAllListeners('real:bridgeError');
  }
};
