// main.js
// Electron 메인 프로세스. BrowserWindow 생성, IPC 핸들러 등록, DB 연결 풀 관리.
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
require('dotenv').config();

let mainWindow;

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

// ============ 앱 시작 ============
const { initPool, closePool } = require('./src/db/connection');

app.on('ready', async () => {
  Menu.setApplicationMenu(null); // 메뉴바 완전 제거
  try {
    await initPool();
    createWindow();
  } catch (err) {
    console.error('앱 시작 실패 (DB 연결 오류):', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', async () => {
  await closePool();
});

// ============ IPC 핸들러 — DB 관련 ============
const {
  getStockList, getStockInfo, getStockData,
  addOrUpdateStockInfo, getHoldings, upsertHoldings,
  getChatHistory, clearChatHistory,
  getLatestScanResults, confirmBoxResult, rejectBoxResult
} = require('./src/db/queries');
const { runBoxScan }   = require('./src/services/boxScanner');
const { runBacktest }  = require('./src/services/backtest');
const { calculateAll } = require('./src/services/indicators');
const { importCsv }    = require('./src/services/csvImport');
const { chat, listOllamaModels } = require('./src/services/aiService');

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

// 종목 기본 정보 조회
ipcMain.handle('db:getStockInfo', async (event, { ticker }) => {
  try {
    const data = await getStockInfo(ticker);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 일봉 데이터 + 지표 계산 (Input-based paging — fromDate/toDate 범위)
ipcMain.handle('db:getStockData', async (event, { ticker, fromDate = null, toDate = null }) => {
  try {
    const rows = await getStockData(ticker, fromDate, toDate);
    if (rows.length === 0) return { success: true, data: [] };

    const ohlcvArr = rows.map(r => ({
      date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
    }));

    // 전체 계산 후 범위 필터링 — RSI 등 누적 지표 정확도 유지
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

// 보유현황 저장 (박스권 정보도 stock_info에 동시 저장)
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

// ============ AI 채팅 스트리밍 — ipcMain.on + event.reply ============
// handle은 단일 반환값만 가능 — 스트리밍에는 on+reply 방식 사용
ipcMain.on('ai:chat', async (event, { message, ticker, engine, model, images }) => {
  try {
    const rows = await getStockData(ticker, null, null);
    const ohlcvData = rows.length > 0
      ? calculateAll(rows.map(r => ({
          date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
        })))
      : [];

    // aiService.chat()이 이미 user/assistant 메시지 DB 저장 처리함 (queries.saveChatMessage)
    // images: [{ base64, mediaType }] — 이미지는 DB 저장 안함 (용량 문제)
    await chat({
      message, ticker, engine, ohlcvData, model, images: images || [],
      onChunk: (data)  => event.reply('ai:chunk', data),
      onDone:  (stats) => event.reply('ai:done',  stats)
    });
  } catch (err) {
    event.reply('ai:chunk', { content: `오류: ${err.message}` });
    event.reply('ai:done',  { engine, tokens: 0, mode: 'MODE 6' });
  }
});

// Ollama 설치 모델 목록 조회
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

// 스캐너 기본값 조회 — 설정 UI에서 기본값 표시용
const { DEFAULTS: SCANNER_DEFAULTS } = require('./src/config/scanner.config');
ipcMain.handle('scan:getDefaults', async () => {
  return { success: true, defaults: SCANNER_DEFAULTS };
});

// 스캔 실행 — 렌더러에서 configOverride 수신 (localStorage 설정값)
ipcMain.handle('scan:runBoxScan', async (event, configOverride = {}) => {
  try {
    const result = await runBoxScan(configOverride);
    return { success: true, ...result };
  } catch (err) {
    console.error('박스권 스캔 오류:', err);
    return { success: false, error: err.message };
  }
});

// 최신 스캔 결과 조회
ipcMain.handle('scan:getResults', async () => {
  try {
    const data = await getLatestScanResults();
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 스캔 결과 확정 → stock_info 박스권 업데이트
ipcMain.handle('scan:confirmResult', async (event, { resultId }) => {
  try {
    const updated = await confirmBoxResult(resultId);
    return { success: true, ...updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 스캔 결과 제외 → status rejected 저장
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
