// main.js
// Electron 메인 프로세스. BrowserWindow 생성, IPC 핸들러 등록, DB 연결 풀 관리.
// 3.5단계 추가: Python 브릿지(bridge.py) spawn, 실시간 거래 차일드 창, SSE 클라이언트.
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');
require('dotenv').config({ quiet: true });

// ============ 파일 로거 ============
// INFO/WARN → 파일 전용 (터미널 출력 없음 — Windows CP949 한글 깨짐 방지)
// ERROR/CRIT → 파일 + 터미널
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function _getLogPath() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${ymd}.log`);
}

function writeLog(level, ...args) {
  const ts  = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = args.join(' ');
  const line = `[${ts}] [${level.padEnd(5)}] ${msg}\n`;
  try { fs.appendFileSync(_getLogPath(), line, 'utf8'); } catch (_) {}
  if (level === 'ERROR' || level === 'CRIT') process.stderr.write(line);
}

// console 오버라이드 — 기존 코드 수정 없이 모든 로그를 파일로 라우팅
const _origError = console.error.bind(console);
console.log   = (...a) => writeLog('INFO',  ...a);
console.info  = (...a) => writeLog('INFO',  ...a);
console.warn  = (...a) => writeLog('WARN',  ...a);
console.error = (...a) => writeLog('ERROR', ...a);

let mainWindow;
let childWindow = null;  // 실시간 거래 차일드 창

// ============ 공유 상태 (main.js 전역) ============
const sharedState = {
  bridgeConnected: false,       // Python 브릿지 연결 상태
  bridgePort:      parseInt(process.env.KIWOOM_BRIDGE_PORT || '5001', 10),
  bridgeProcess:   null,        // child_process 참조
  bridgeRestarts:  0,           // 브릿지 재시작 횟수 (최대 3회)
  loggedIn:        false,       // 키움 로그인 완료 여부
  accountNo:       process.env.KIWOOM_ACCOUNT_NO || '',
  isMock:          process.env.KIWOOM_IS_MOCK !== 'false',
  subscriptions:   new Set(),   // 구독 중인 종목 코드
  priceCache:      new Map()    // ticker → { price, change, volume, ts }
};

// ============ SSE 클라이언트 상태 ============
let sseClient   = null;
let sseReconnectCount = 0;
const SSE_MAX_RECONNECT  = 5;
const SSE_RECONNECT_BASE = 3000; // 지수 백오프 기본 (3s → 6s → 12s → 24s → 48s)

// ============ broadcastToAllWindows — 모든 창에 이벤트 push ============
function broadcastToAllWindows(channel, data) {
  if (mainWindow  && !mainWindow.isDestroyed())  mainWindow.webContents.send(channel, data);
  if (childWindow && !childWindow.isDestroyed()) childWindow.webContents.send(channel, data);
}

// ============ Python 브릿지 시작 ============
function startBridge() {
  // Python PATH 탐색: 32비트 Python 우선, 이후 시스템 PATH 순
  const pythonCandidates = [
    'C:\\Users\\kisucha\\AppData\\Local\\Programs\\Python\\Python310-32\\python.exe',
    'python', 'py', 'python3'
  ];
  const bridgePath = path.join(__dirname, 'src', 'bridge', 'bridge.py');

  function trySpawn(candidates) {
    if (candidates.length === 0) {
      console.error('[bridge] Python 실행 파일을 찾을 수 없음');
      return;
    }
    const cmd = candidates[0];
    const proc = spawn(cmd, ['-u', bridgePath], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (data) => {
      const msg = data.toString('utf8');
      console.log('[bridge stdout]', msg.trim());
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString('utf8').trim();
      if (!msg) return;
      // Python 실행 파일 탐색 오류 → 다음 후보로 시도
      if (msg.includes('not recognized') || msg.includes('cannot find') ||
          msg.includes("'python' is not") || msg.includes('No such file')) {
        proc.kill();
        trySpawn(candidates.slice(1));
        return;
      }
      // Flask HTTP 접근 로그 ("GET /... HTTP/1.1") → INFO
      if (/"\w+ \/.+ HTTP\//.test(msg)) {
        console.log('[bridge]', msg);
      // Flask 개발 서버 안내 메시지 → WARN
      } else if (msg.includes('WARNING:') || msg.includes('Running on') ||
                 msg.includes('Press CTRL+C') || msg.includes('production deployment') ||
                 msg.includes('Serving Flask')) {
        console.warn('[bridge]', msg);
      // 그 외 실제 오류 → ERROR
      } else {
        console.error('[bridge stderr]', msg);
      }
    });

    proc.on('error', () => trySpawn(candidates.slice(1)));

    proc.on('exit', (code, signal) => {
      console.log(`[bridge] 프로세스 종료: code=${code}, signal=${signal}`);
      sharedState.bridgeConnected = false;
      sharedState.loggedIn = false;
      sharedState.bridgeProcess = null;

      // 비정상 종료 시 자동 재시작 (최대 3회)
      if (code !== 0 && signal !== 'SIGTERM' && sharedState.bridgeRestarts < 3) {
        sharedState.bridgeRestarts++;
        console.log(`[bridge] 재시작 시도 ${sharedState.bridgeRestarts}/3`);
        setTimeout(() => startBridge(), 3000);
      }
    });

    sharedState.bridgeProcess = proc;
    // 브릿지 준비 폴링 후 SSE 시작
    startBridgeReady();
  }

  trySpawn(pythonCandidates);
}

// ============ 브릿지 준비 폴링 ============
async function pollBridgeReady(retries = 20) {
  const { checkStatus } = require('./src/services/kiwoomService');
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await checkStatus();
      if (res && res.ready) {
        sharedState.bridgeConnected = true;
        sharedState.bridgeRestarts  = 0;
        console.log('[bridge] 연결 준비 완료');
        return true;
      }
    } catch (e) {
      // 아직 시작 중
    }
  }
  console.warn('[bridge] 준비 타임아웃 (10초)');
  return false;
}

// pollBridgeReady 성공 후 SSE 시작 — try/catch 외부에서 호출 (에러가 poll 루프에 영향 없게)
async function startBridgeReady() {
  const ok = await pollBridgeReady();
  if (ok) connectSSE();
}

// ============ SSE 클라이언트 연결 ============
function connectSSE() {
  // eventsource v4 — require()는 { EventSource } 객체 반환
  let EventSource;
  try {
    ({ EventSource } = require('eventsource'));
  } catch (e) {
    console.error('[SSE] eventsource 패키지 없음. npm install eventsource 실행 필요');
    return;
  }

  const url = `http://127.0.0.1:${sharedState.bridgePort}/realtime/events`;
  sseClient = new EventSource(url);

  sseClient.onopen = () => {
    console.log('[SSE] 연결됨');
    sseReconnectCount = 0;
    // 기존 구독 종목 재등록
    if (sharedState.subscriptions.size > 0) {
      const { subscribe } = require('./src/services/kiwoomService');
      subscribe([...sharedState.subscriptions]).catch(console.error);
    }
  };

  sseClient.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === 'quote') {
        // 실시간 시세 — 메모리 캐시 업데이트 후 전체 창에 broadcast
        sharedState.priceCache.set(event.ticker, event);
        broadcastToAllWindows('real:onQuote', event);
      } else if (event.type === 'orderbook') {
        // 호가 데이터
        broadcastToAllWindows('real:onOrderbook', event);
      } else if (event.type === 'execution') {
        // 체결 통보 — 차일드 창에만 전달
        if (childWindow && !childWindow.isDestroyed()) {
          childWindow.webContents.send('real:onExecution', event);
        }
      } else if (event.type === 'message') {
        // 키움 서버 메시지 (주문 거부 사유, 호가단위 오류 등)
        console.log(`[kiwoom message] rqname=${event.rqname} msg=${event.message}`);
        if (childWindow && !childWindow.isDestroyed()) {
          childWindow.webContents.send('real:onMessage', event);
        }
      }
    } catch (err) {
      console.error('[SSE] 이벤트 파싱 오류:', err.message);
    }
  };

  sseClient.onerror = () => {
    if (sseReconnectCount >= SSE_MAX_RECONNECT) {
      console.error('[SSE] 재연결 한계 초과. 브릿지 재시작 필요');
      broadcastToAllWindows('real:bridgeError', { message: '키움 브릿지 재시작 필요' });
      sseClient.close();
      sseClient = null;
      return;
    }
    sseReconnectCount++;
    const delay = SSE_RECONNECT_BASE * Math.pow(2, sseReconnectCount - 1);
    console.log(`[SSE] 재연결 시도 ${sseReconnectCount}/${SSE_MAX_RECONNECT} (${delay}ms 후)`);
    setTimeout(() => connectSSE(), delay);
  };
}

// ============ 창 생성 ============
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,    // nodeIntegration과 함께 사용 — chart.js require() 허용
      nodeIntegration: true,      // chart.js require() 사용 위해 필요
      sandbox: false,
      enableRemoteModule: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
}

// ============ 실시간 거래 차일드 창 생성 ============
function createChildWindow() {
  if (childWindow && !childWindow.isDestroyed()) {
    childWindow.focus();
    return;
  }
  const mainBounds = mainWindow.getBounds();
  childWindow = new BrowserWindow({
    parent: mainWindow,
    modal:  false,        // 독립 조작 가능 (modal이면 부모 차단됨)
    width:  800,
    height: 900,
    x:      mainBounds.x + mainBounds.width + 10,
    y:      mainBounds.y,
    title:  '실시간 거래',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration:  true,
      sandbox:          false,
      enableRemoteModule: false
    }
  });

  childWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'realtrading.html'));

  childWindow.on('closed', () => {
    childWindow = null;
    // 메인 창에 닫힘 알림 (계좌 패널 숨기기)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('real:windowStateChange', { state: 'closed' });
    }
    // 창 강제 종료 시 자동 로그아웃 (구독 해제 + 로그인 상태 초기화)
    if (sharedState.loggedIn) {
      const { logout } = require('./src/services/kiwoomService');
      logout().catch(() => {});
      sharedState.loggedIn = false;
      sharedState.subscriptions.clear();
    }
  });

  // 메인 창에 열림 알림 (계좌 패널 표시)
  mainWindow.webContents.send('real:windowStateChange', { state: 'open' });
}

// ============ 앱 시작 ============
const { initPool, closePool } = require('./src/db/connection');

app.on('ready', async () => {
  Menu.setApplicationMenu(null);
  try {
    await initPool();
    createWindow();
    // Python 브릿지 시작 (백그라운드)
    startBridge();
    // US 마스터 자동 동기화 (백그라운드, 비차단). 증분은 핀 도착 시 별도 트리거.
    runUsStartupMasterCheck().catch(err => console.error('[us-sync] master check error:', err.message));
  } catch (err) {
    console.error('앱 시작 실패 (DB 연결 오류):', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async () => {
  // SSE 클라이언트 종료
  if (sseClient) { sseClient.close(); sseClient = null; }
  // Python 브릿지 종료
  if (sharedState.bridgeProcess) {
    sharedState.bridgeProcess.kill('SIGTERM');
    // 2초 후에도 살아있으면 강제 종료
    setTimeout(() => {
      if (sharedState.bridgeProcess) sharedState.bridgeProcess.kill('SIGKILL');
    }, 2000);
  }
  await closePool();
});

// ============ IPC 핸들러 — DB 관련 ============
const {
  getStockList, searchStocks,
  registerUsStock, getUsMasterSyncedAt, listUsTickers, listStocksByMarket,
  getWatchlist, addToWatchlist, removeFromWatchlist,
  getStockInfo, getStockData,
  addOrUpdateStockInfo, getHoldings, upsertHoldings,
  getChatHistory, clearChatHistory,
  getLatestScanResults, confirmBoxResult, rejectBoxResult,
  createSession, listSessions, getSessionMessages, deleteSession, renameSession,
  listMemory, deleteMemory
} = require('./src/db/queries');
const { runBoxScan }   = require('./src/services/boxScanner');
const { runBacktest }  = require('./src/services/backtest');
const { calculateAll } = require('./src/services/indicators');
const { chat, listOllamaModels } = require('./src/services/aiService');
const kiwoomSvc = require('./src/services/kiwoomService');

// 종목 목록 조회
ipcMain.handle('db:getStockList', async () => {
  try {
    const data = await getStockList();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 종목 검색 (관심종목 자동완성용 — ticker prefix 또는 name contains)
// marketFilter: 'KR' | 'US' | 특정 시장 | null
ipcMain.handle('db:searchStocks', async (event, { query, limit = 20, marketFilter = null } = {}) => {
  try {
    const data = await searchStocks(query, limit, marketFilter);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 시장별 등록 종목 목록 (사이드바 KR/US 탭)
ipcMain.handle('db:listStocksByMarket', async (event, { marketFilter = null } = {}) => {
  try {
    const data = await listStocksByMarket(marketFilter);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 관심종목 영속화 — realtime_watchlist 테이블 기반
ipcMain.handle('db:getWatchlist', async () => {
  try {
    const data = await getWatchlist();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Ticker 검증 다중 패턴:
//   KR: 6자리 숫자 (053800, 005930) — 000000 제외
//   US: 알파벳 1~5자 대문자 (AAPL, TSLA) — 점/대시 미지원 (Phase A 단순화)
const TICKER_KR_RE = /^[0-9]{6}$/;
const TICKER_US_RE = /^[A-Z]{1,5}$/;
function isValidTicker(t) {
  if (typeof t !== 'string') return false;
  if (TICKER_KR_RE.test(t)) return t !== '000000';
  if (TICKER_US_RE.test(t)) return true;
  return false;
}
function isUsTicker(t) { return typeof t === 'string' && TICKER_US_RE.test(t); }

ipcMain.handle('db:addWatchlist', async (event, { ticker } = {}) => {
  try {
    if (!isValidTicker(ticker)) return { success: false, error: '잘못된 ticker 형식' };
    await addToWatchlist(ticker);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('db:removeWatchlist', async (event, { ticker } = {}) => {
  try {
    if (!isValidTicker(ticker)) return { success: false, error: '잘못된 ticker 형식' };
    await removeFromWatchlist(ticker);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 종목 기본 정보 조회
ipcMain.handle('db:getStockInfo', async (event, { ticker }) => {
  try {
    const data = await getStockInfo(ticker);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 일봉 데이터 + 지표 계산
ipcMain.handle('db:getStockData', async (event, { ticker, fromDate = null, toDate = null }) => {
  try {
    const rows = await getStockData(ticker, fromDate, toDate);
    if (rows.length === 0) return { success: true, data: [] };

    const ohlcvArr = rows.map(r => ({
      date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
    }));

    const data = calculateAll(ohlcvArr, fromDate, toDate);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 보유현황 조회
ipcMain.handle('db:getHoldings', async (event, { ticker }) => {
  try {
    const data = await getHoldings(ticker);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 보유현황 저장
ipcMain.handle('db:updateHoldings', async (event, holdings) => {
  try {
    if (holdings.box_low || holdings.box_high) {
      const existing = await getStockInfo(holdings.ticker);
      await addOrUpdateStockInfo({
        ticker:   holdings.ticker,
        name:     existing?.name || holdings.ticker,
        market:   existing?.market || 'KOSDAQ',
        box_low:  holdings.box_low  || existing?.box_low,
        box_high: holdings.box_high || existing?.box_high,
        note:     existing?.note
      });
    }
    await upsertHoldings(holdings);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============ AI 채팅 스트리밍 ============
ipcMain.on('ai:chat', async (event, { message, ticker, engine, model, images, sessionId }) => {
  try {
    const rows = await getStockData(ticker, null, null);
    const ohlcvData = rows.length > 0
      ? calculateAll(rows.map(r => ({
          date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
        })))
      : [];

    await chat({
      message, ticker, engine, ohlcvData, model, images: images || [],
      sessionId: sessionId || null,
      onChunk: (data)  => event.reply('ai:chunk', data),
      onDone:  (stats) => event.reply('ai:done',  stats)
    });
  } catch (err) {
    event.reply('ai:chunk', { content: `오류: ${err.message}` });
    event.reply('ai:done',  { engine, tokens: 0, mode: 'MODE 6' });
  }
});

// ============ 세션 관리 IPC ============

ipcMain.handle('chat:createSession', async (event, { name, ticker, engine }) => {
  try {
    const session = await createSession(name, ticker || null, engine || 'ollama');
    return { success: true, session };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('chat:listSessions', async (event, { ticker } = {}) => {
  try {
    const sessions = await listSessions(ticker || null);
    return { success: true, sessions };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('chat:loadSession', async (event, { sessionId, limit }) => {
  try {
    const messages = await getSessionMessages(sessionId, limit || 100);
    return { success: true, messages };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('chat:deleteSession', async (event, { sessionId }) => {
  try {
    const ok = await deleteSession(sessionId);
    return { success: ok };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('chat:renameSession', async (event, { sessionId, name }) => {
  try {
    const ok = await renameSession(sessionId, name);
    return { success: ok };
  } catch (err) { return { success: false, error: err.message }; }
});

// ============ 메모리 IPC ============

ipcMain.handle('memory:list', async () => {
  try {
    const items = await listMemory();
    return { success: true, items };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('memory:delete', async (event, { id }) => {
  try {
    const ok = await deleteMemory(id);
    return { success: ok };
  } catch (err) { return { success: false, error: err.message }; }
});

// Ollama 모델 목록
ipcMain.handle('ollama:listModels', async () => {
  try {
    const models = await listOllamaModels();
    return { success: true, models };
  } catch (err) {
    return { success: false, error: err.message, models: [] };
  }
});

// 채팅 이력 조회
ipcMain.handle('chat:load', async (event, { ticker, limit = 50 }) => {
  try {
    const data = await getChatHistory(ticker, null, limit);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 채팅 이력 초기화
ipcMain.handle('chat:clear', async (event, { ticker }) => {
  try {
    const affected = await clearChatHistory(ticker);
    return { success: true, affected };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============ 박스권 스캐너 IPC ============
const { DEFAULTS: SCANNER_DEFAULTS } = require('./src/config/scanner.config');

ipcMain.handle('scan:getDefaults', async () => {
  return { success: true, defaults: SCANNER_DEFAULTS };
});

ipcMain.handle('scan:runBoxScan', async (event, configOverride = {}) => {
  try {
    const result = await runBoxScan(configOverride);
    return { success: true, ...result };
  } catch (err) {
    console.error('박스권 스캔 오류:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('scan:getResults', async () => {
  try {
    const data = await getLatestScanResults();
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('scan:confirmResult', async (event, { resultId }) => {
  try {
    const updated = await confirmBoxResult(resultId);
    return { success: true, ...updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('scan:rejectResult', async (event, { resultId }) => {
  try {
    await rejectBoxResult(resultId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============ 백테스트 IPC ============
ipcMain.handle('backtest:run', async (event, opts = {}) => {
  try {
    const result = await runBacktest(opts);
    return result;
  } catch (err) {
    console.error('백테스트 오류:', err);
    return { success: false, error: err.message };
  }
});

// ============ 실시간 거래 IPC 핸들러 (3.5단계) ============

// 실시간 거래 창 열기 — mode: 'mock' | 'real' 사용자 선택 즉시 sharedState.isMock 반영
ipcMain.handle('real:openWindow', async (_event, { mode } = {}) => {
  try {
    if (!sharedState.bridgeConnected) {
      return { success: false, error: 'Python 브릿지가 연결되지 않았습니다. 잠시 후 다시 시도하세요.' };
    }
    // mode 미지정 시 .env 폴백. 'real' → 실투(isMock=false), 'mock' → 모의(isMock=true)
    if (mode === 'real')      sharedState.isMock = false;
    else if (mode === 'mock') sharedState.isMock = true;
    console.log(`[real:openWindow] mode=${mode || '(env fallback)'} isMock=${sharedState.isMock}`);
    createChildWindow();
    return { success: true, isMock: sharedState.isMock };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 키움 로그인
ipcMain.handle('real:login', async () => {
  try {
    const result = await kiwoomSvc.login();
    if (result.success) {
      sharedState.loggedIn  = true;
      // ⚠ 진실의 단일 출처(SSOT) = 키움 OpenAPI+ 응답 serverType.
      //    serverType '1' = 모의투자, '0'/빈 = 실투자.
      //    단 일부 환경에서 GetServerGubun이 빈값/undefined로 와 false-positive 발생 사례 다수 —
      //    빈값/불명확이면 검증 스킵하고 사용자 의도를 신뢰한다.
      const srvType   = result.serverType == null ? '' : String(result.serverType).trim();
      const srvKnown  = srvType !== '';
      const srvIsMock = srvType === '1';
      const userIntent = sharedState.isMock;  // 사용자 모달 선택값 (null이면 미지정)

      // 키움 응답 명확하면 그 값 사용, 불명확이면 사용자 의도 사용
      sharedState.isMock    = srvKnown ? srvIsMock : (userIntent ?? true);
      // bridge가 전달한 계좌만 사용 — .env 폴백 금지.
      // 키움에서 받은 진실만 보여주고, 못 받았으면 "미수신" 명시 (사용자 요구).
      sharedState.accountNo = result.accountNo || '';
      result.isMock    = sharedState.isMock;
      result.accountNo = sharedState.accountNo;
      result.accountList = result.accountList || [];

      console.log(`[login] raw serverType=${JSON.stringify(result.serverType)} parsed='${srvType}' known=${srvKnown} srvIsMock=${srvIsMock} userIntent=${userIntent}`);

      // 사용자 선택 vs 키움 실제 양방향 검증.
      // 키움 serverType이 불명확(빈값)이면 검증 스킵 — false-positive 차단.
      if (srvKnown && userIntent != null && userIntent !== srvIsMock) {
        const want   = userIntent ? 'mock' : 'real';
        const actual = srvIsMock  ? 'mock' : 'real';
        const wantKo   = userIntent ? '모의' : '실전';
        const actualKo = srvIsMock  ? '모의' : '실전';
        const hintBody = srvIsMock
          ? '키움 OpenAPI+ 로그인 창에서 "모의투자" 체크를 **해제**하고 ID/PW 입력 후 다시 로그인.'
          : '키움 OpenAPI+ 로그인 창에서 "모의투자" 체크를 **선택**하고 ID/PW 입력 후 다시 로그인.';
        result.modeMismatch = {
          userIntent: want,
          actual,
          userIntentKo: wantKo,
          actualKo,
          block: true,
          hint: `${hintBody}\n(로그인 다이얼로그 첫 화면 ID/비밀번호 입력 옆 "모의투자" 체크박스)`
        };
        console.warn(`[login] ⛔ 모드 불일치 — 사용자=${wantKo} 키움실제=${actualKo} — 로그인 차단`);
      }
      console.log(`[login] serverType=${result.serverType} isMock=${result.isMock} accountNo=${result.accountNo}`);
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 계좌 잔고 조회 — bridge 응답을 렌더러 기대 구조로 변환
ipcMain.handle('real:getAccount', async () => {
  try {
    if (!sharedState.loggedIn) {
      console.warn('[real:getAccount] 로그인 필요 — sharedState.loggedIn=false');
      return { success: false, error: '로그인 필요' };
    }
    console.log('[real:getAccount] kiwoomSvc.getAccount() 호출 시작');
    const t0 = Date.now();
    const raw = await kiwoomSvc.getAccount();
    console.log(`[real:getAccount] kiwoomSvc.getAccount() 응답 ${Date.now()-t0}ms success=${raw && raw.success}`);
    if (!raw.success) return raw;
    return {
      success:  true,
      account: {
        deposit:       raw.deposit      || 0,
        eval_total:    raw.evalTotal    || 0,
        pnl_total:     raw.pnlTotal     || 0,
        rate_of_return: raw.rateOfReturn || 0,
        withdrawable:  raw.withdrawable || 0,
        orderable:     raw.orderable    || 0,
        deposit_d2:    raw.depositD2    || 0
      },
      holdings: raw.holdings || []
    };
  } catch (err) {
    console.error('[real:getAccount] 예외:', err.message);
    return { success: false, error: err.message };
  }
});

// 체결/미체결 내역 조회 (OPT10075) — 실데이터 기준
ipcMain.handle('real:getExecutions', async () => {
  try {
    if (!sharedState.loggedIn) return { success: false, error: '로그인 필요' };
    return await kiwoomSvc.getExecutions();
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 보유종목 조회 — getAccount의 holdings 필드 사용
ipcMain.handle('real:getHoldings', async () => {
  try {
    if (!sharedState.loggedIn) return { success: false, error: '로그인 필요' };
    const raw = await kiwoomSvc.getAccount();
    if (!raw.success) return raw;
    return { success: true, holdings: raw.holdings || [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 실시간 구독 시작
ipcMain.handle('real:subscribe', async (event, { tickers }) => {
  try {
    if (!sharedState.loggedIn) return { success: false, error: '로그인 필요' };
    const arr = Array.isArray(tickers) ? tickers : [tickers];
    const result = await kiwoomSvc.subscribe(arr);
    if (result.success) arr.forEach(t => sharedState.subscriptions.add(t));
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 실시간 구독 해제
ipcMain.handle('real:unsubscribe', async (event, { tickers }) => {
  try {
    const arr = Array.isArray(tickers) ? tickers : [tickers];
    const result = await kiwoomSvc.unsubscribe(arr);
    if (result.success) arr.forEach(t => sharedState.subscriptions.delete(t));
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 매수 주문
ipcMain.handle('real:orderBuy', async (event, { ticker, qty, price }) => {
  try {
    if (!sharedState.loggedIn) return { success: false, error: '로그인 필요' };
    if (!ticker || qty <= 0) return { success: false, error: '종목코드와 수량을 확인하세요' };
    return await kiwoomSvc.orderBuy({ ticker, qty, price: price || 0 });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 매도 주문
ipcMain.handle('real:orderSell', async (event, { ticker, qty, price }) => {
  try {
    if (!sharedState.loggedIn) return { success: false, error: '로그인 필요' };
    if (!ticker || qty <= 0) return { success: false, error: '종목코드와 수량을 확인하세요' };
    return await kiwoomSvc.orderSell({ ticker, qty, price: price || 0 });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 주문 취소
ipcMain.handle('real:cancelOrder', async (event, { ticker, qty, orgOrderNo, orderType }) => {
  try {
    if (!sharedState.loggedIn) return { success: false, error: '로그인 필요' };
    return await kiwoomSvc.cancelOrder({ ticker, qty, orgOrderNo, orderType });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 키움 로그아웃
ipcMain.handle('real:logout', async () => {
  try {
    const result = await kiwoomSvc.logout();
    if (result.success) {
      sharedState.loggedIn = false;
      sharedState.subscriptions.clear();
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// SSE 강제 재연결 — sseReconnectCount 초기화 후 connectSSE 재실행
ipcMain.handle('real:reconnectSSE', async () => {
  try {
    if (sseClient) { sseClient.close(); sseClient = null; }
    sseReconnectCount = 0;
    connectSSE();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 브릿지 상태 확인
ipcMain.handle('real:bridgeStatus', async () => {
  return {
    bridgeConnected: sharedState.bridgeConnected,
    loggedIn:        sharedState.loggedIn,
    isMock:          sharedState.isMock,
    accountNo:       sharedState.accountNo,
    subscriptions:   [...sharedState.subscriptions]
  };
});

// 계좌 데이터 메인 창으로 relay (차일드 창 → main.js → 메인 창)
ipcMain.on('real:broadcastAccount', (event, { account, holdings }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('real:accountUpdated', { account, holdings });
  }
});

// ============================================================
// US 종목 동기화 (마스터 / 5y init / 증분)
// ============================================================
const usSyncState = {
  masterRunning: false,
  masterProgress: '',     // 사용자 표시용 텍스트
  incrementalRunning: false,
  incrementalProgress: '',
  registering: new Set()  // 등록 진행 중 ticker 집합 (사이드바 스피너용)
};

// 핀(모니터링) 리스트 캐시 — renderer가 pinned:sync IPC로 push.
// US 증분은 이 캐시 ∩ isUsTicker(t) 만 대상으로 한다 (마스터 1만+ 전체 아님).
let pinnedTickersCache = [];
let pinnedSyncReceived = false;  // 첫 push 도착 여부 — startup incremental 트리거용

function broadcastUsSync() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('us:syncStatus', {
      masterRunning:      usSyncState.masterRunning,
      masterProgress:     usSyncState.masterProgress,
      incrementalRunning: usSyncState.incrementalRunning,
      incrementalProgress: usSyncState.incrementalProgress,
      registering:        [...usSyncState.registering]
    });
  }
}

function spawnUsSync(mode, args = []) {
  const pyCmd = process.env.COLLECTOR_PYTHON || 'python';
  const cwd   = path.join(__dirname);
  const env   = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  return spawn(pyCmd, ['-u', '-m', 'collector.scripts.us_sync', '--mode', mode, ...args],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function runUsMasterSync() {
  if (usSyncState.masterRunning) return;
  usSyncState.masterRunning = true;
  usSyncState.masterProgress = 'US 종목 마스터 다운로드 중...';
  broadcastUsSync();
  return new Promise((resolve) => {
    const proc = spawnUsSync('master');
    let output = '';
    proc.stdout.on('data', d => { output += d.toString('utf8'); });
    proc.stderr.on('data', d => console.error('[us-master]', d.toString('utf8').trimEnd()));
    proc.on('error', err => {
      console.error('[us-master] spawn error:', err.message);
      usSyncState.masterRunning = false;
      usSyncState.masterProgress = '';
      broadcastUsSync();
      resolve({ success: false, error: err.message });
    });
    proc.on('exit', code => {
      usSyncState.masterRunning = false;
      let count = 0;
      try {
        const lastJson = output.trim().split('\n').filter(l => l.startsWith('{')).pop();
        if (lastJson) count = JSON.parse(lastJson).tickers || 0;
      } catch {}
      usSyncState.masterProgress = code === 0 ? `완료 (${count}종목)` : '실패';
      broadcastUsSync();
      setTimeout(() => { usSyncState.masterProgress = ''; broadcastUsSync(); }, 6000);
      resolve({ success: code === 0, count });
    });
  });
}

// yfinance 단일 종목 hang 시 전체 증분 정지 방지 — 90초/종목
const US_INCREMENTAL_TIMEOUT_MS = 90 * 1000;

function runOneIncremental(ticker) {
  return new Promise((resolve) => {
    const proc = spawnUsSync('incremental', ['--ticker', ticker]);
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(reason);
    };
    const killer = setTimeout(() => {
      console.warn(`[us-sync] ${ticker} timeout — kill child`);
      try { proc.kill('SIGTERM'); } catch {}
      finish('timeout');
    }, US_INCREMENTAL_TIMEOUT_MS);
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('exit', () => finish('exit'));
    proc.on('error', () => finish('error'));
  });
}

async function runUsIncrementalAll() {
  if (usSyncState.incrementalRunning) return;
  // 핀(모니터링) 리스트 ∩ US 종목 패턴 → 증분 대상.
  // pinnedTickersCache는 renderer가 pinned:sync IPC로 push한다.
  // 마스터 전체(1만+) 대상으로 spawn 폭주하는 사고 방지.
  const tickers = pinnedTickersCache.filter(t => isUsTicker((t || '').toUpperCase()))
                                    .map(t => t.toUpperCase());
  if (tickers.length === 0) {
    console.log('[us-sync] 증분 대상 핀 종목 없음 — 스킵');
    return { success: true, count: 0 };
  }
  console.log(`[us-sync] 증분 시작: 핀 US 종목 ${tickers.length}개 [${tickers.join(', ')}]`);
  usSyncState.incrementalRunning = true;
  usSyncState.incrementalProgress = `US 증분 0/${tickers.length}`;
  broadcastUsSync();
  let done = 0;
  for (const t of tickers) {
    // 시작 신호 — 탭 점 빨강
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('us:tickerUpdating', { ticker: t });
    }
    await runOneIncremental(t);
    done++;
    usSyncState.incrementalProgress = `US 증분 ${done}/${tickers.length}`;
    broadcastUsSync();
    // 완료 신호 — 탭 점 초록 복귀 + 현재 ticker면 차트 reload
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('us:tickerUpdated', { ticker: t });
    }
  }
  usSyncState.incrementalRunning = false;
  usSyncState.incrementalProgress = `US 증분 완료 (${done}종목)`;
  broadcastUsSync();
  setTimeout(() => { usSyncState.incrementalProgress = ''; broadcastUsSync(); }, 6000);
  return { success: true, count: done };
}

async function runUsRegisterAndFetch(ticker, name, market) {
  const sym = ticker.toUpperCase();
  usSyncState.registering.add(sym);
  broadcastUsSync();
  try {
    await registerUsStock(sym, name, market);
    await new Promise((resolve) => {
      const proc = spawnUsSync('init', ['--ticker', sym]);
      proc.stdout.on('data', () => {});
      proc.stderr.on('data', d => console.error('[us-init]', d.toString('utf8').trimEnd()));
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    usSyncState.registering.delete(sym);
    broadcastUsSync();
  }
}

// 부팅 시 마스터 동기화만 수행 (첫 부팅 또는 매월 1일).
// 증분은 renderer가 핀 리스트를 pinned:sync로 push한 시점에 별도 트리거.
async function runUsStartupMasterCheck() {
  try {
    const status = await getUsMasterSyncedAt();
    const today = new Date();
    const isFirstDay = today.getDate() === 1;
    const noMaster = status.cnt === 0;
    let lastIsCurrentMonth = false;
    if (status.last_at) {
      const last = new Date(status.last_at);
      lastIsCurrentMonth = last.getFullYear() === today.getFullYear() && last.getMonth() === today.getMonth();
    }
    if (noMaster || (isFirstDay && !lastIsCurrentMonth)) {
      console.log('[us-sync] master 동기화 시작', { noMaster, isFirstDay });
      await runUsMasterSync();
    }
  } catch (err) {
    console.error('[us-sync] master check error:', err.message);
  }
}

// IPC 핸들러 — US 종목
ipcMain.handle('us:masterStatus', async () => {
  try {
    const s = await getUsMasterSyncedAt();
    return { success: true, ...s, ...usSyncState, registering: [...usSyncState.registering] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('us:syncMaster', async () => {
  return runUsMasterSync();
});

ipcMain.handle('us:incrementalAll', async () => {
  return runUsIncrementalAll();
});

ipcMain.handle('us:registerStock', async (event, { ticker, name, market } = {}) => {
  if (!isUsTicker((ticker || '').toUpperCase())) {
    return { success: false, error: '잘못된 US ticker 형식' };
  }
  return runUsRegisterAndFetch(ticker, name, market || 'NASDAQ');
});

ipcMain.handle('us:syncStatusSnapshot', async () => {
  return { success: true, ...usSyncState, registering: [...usSyncState.registering] };
});

// 핀(모니터링) 리스트 push — renderer 부팅 후 + togglePin 시마다 호출.
// 첫 push 시점에 US 증분 startup 트리거 (renderer 부팅 = 사용자 앱 켠 시점).
ipcMain.handle('pinned:sync', async (_event, { tickers } = {}) => {
  try {
    pinnedTickersCache = Array.isArray(tickers) ? tickers.filter(t => typeof t === 'string') : [];
    const firstPush = !pinnedSyncReceived;
    pinnedSyncReceived = true;
    if (firstPush) {
      console.log(`[pinned] 첫 push 수신 — 종목 ${pinnedTickersCache.length}개. US 증분 트리거.`);
      // 백그라운드 비차단
      runUsIncrementalAll().catch(e => console.error('[us-sync] incremental error:', e.message));
    }
    return { success: true, count: pinnedTickersCache.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
