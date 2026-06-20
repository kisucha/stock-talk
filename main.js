// main.js
// Electron 메인 프로세스. BrowserWindow 생성, IPC 핸들러 등록, DB 연결 풀 관리.
// 3.5단계 추가: Python 브릿지(bridge.py) spawn, 실시간 거래 차일드 창, SSE 클라이언트.
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
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
  getStockList, searchStocks, getStockInfo, getStockData,
  addOrUpdateStockInfo, getHoldings, upsertHoldings,
  getChatHistory, clearChatHistory,
  getLatestScanResults, confirmBoxResult, rejectBoxResult,
  createSession, listSessions, getSessionMessages, deleteSession, renameSession,
  listMemory, deleteMemory
} = require('./src/db/queries');
const { runBoxScan }   = require('./src/services/boxScanner');
const { runBacktest }  = require('./src/services/backtest');
const { calculateAll } = require('./src/services/indicators');
const { importCsv }    = require('./src/services/csvImport');
const { chat, listOllamaModels } = require('./src/services/aiService');
const kiwoomSvc = require('./src/services/kiwoomService');

// 파일 선택 대화상자
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  return result.filePaths ? result.filePaths[0] : null;
});

// CSV Import
ipcMain.handle('db:importCsv', async (event, { filePath, ticker }) => {
  try {
    const result = await importCsv(filePath, ticker || '053800');
    return result;
  } catch (err) {
    console.error('CSV import 에러:', err);
    return { success: false, inserted: 0, duplicates: 0, errors: [err.message] };
  }
});

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
ipcMain.handle('db:searchStocks', async (event, { query, limit = 20 } = {}) => {
  try {
    const data = await searchStocks(query, limit);
    return { success: true, data };
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

// 종목 추가
ipcMain.handle('db:addTicker', async (event, info) => {
  try {
    await addOrUpdateStockInfo(info);
    return { success: true };
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

// ============ 증분 업데이트 강제 실행 ============
ipcMain.on('db:runIncremental', (event) => {
  // COLLECTOR_PYTHON: 64비트 Python 경로 (Kiwoom 32비트와 별도)
  const pyCmd = process.env.COLLECTOR_PYTHON || 'python';
  const cwd   = path.join(__dirname);
  const env   = {
    ...process.env,
    SKIP_NON_BUSINESS_DAY: 'false',  // 평일/주말 무관 강제 실행
    PYTHONIOENCODING: 'utf-8'
  };

  const proc = spawn(pyCmd, ['-u', '-m', 'collector.scripts.incremental'], { cwd, env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const send = (text, type = 'stdout') => {
    if (!event.sender.isDestroyed()) event.reply('incremental:log', { text, type });
  };

  proc.stdout.on('data', d => send(d.toString('utf8').trimEnd()));
  proc.stderr.on('data', d => send(d.toString('utf8').trimEnd(), 'stderr'));
  proc.on('error', err => {
    send(`실행 오류: ${err.message}`, 'error');
    if (!event.sender.isDestroyed()) event.reply('incremental:done', { exitCode: -1 });
  });
  proc.on('exit', code => {
    if (!event.sender.isDestroyed()) event.reply('incremental:done', { exitCode: code });
  });
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

// 실시간 거래 창 열기
ipcMain.handle('real:openWindow', async () => {
  try {
    if (!sharedState.bridgeConnected) {
      return { success: false, error: 'Python 브릿지가 연결되지 않았습니다. 잠시 후 다시 시도하세요.' };
    }
    createChildWindow();
    return { success: true };
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
      // .env KIWOOM_IS_MOCK 우선, serverType "1"=모의 보조 확인
      sharedState.isMock    = process.env.KIWOOM_IS_MOCK !== 'false';
      sharedState.accountNo = process.env.KIWOOM_ACCOUNT_NO || '';
      result.isMock    = sharedState.isMock;
      result.accountNo = sharedState.accountNo;
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
    if (!sharedState.loggedIn) return { success: false, error: '로그인 필요' };
    const raw = await kiwoomSvc.getAccount();
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
