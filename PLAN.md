# AI 주식 분석 시스템 — 구현 계획서 PLAN.md

| 항목 | 내용 |
|------|------|
| 문서명 | AI 주식 분석 시스템 구현 계획서 |
| 버전 | V1 |
| 날짜 | 2026-06-11 |
| 작성자 | Claude Sonnet 4.6 |
| 문서 유형 | 구현 계획서 (PLAN.md) |
| 사용 모델 | claude-sonnet-4-6 |

> 용도: 1단계 구현 단계별 상세 설계. RESEARCH.md 섹션 6-7과 CLAUDE.md를 기반으로 작성.
> 구현 시 이 문서를 Step별로 따라가며 진행.

---

## 목차

1. [1단계 개요 및 흐름도](#1단계-개요-및-흐름도)
2. [Step 1: Electron 기본 구조](#step-1-electron-기본-구조) — package.json, main.js, preload.js, .env
3. [Step 2: mysql2 연결 풀 + 쿼리](#step-2-mysql2-연결-풀) — connection.js, **queries.js**, GUIDE.md
4. [Step 3: DB 테이블 DDL](#step-3-db-테이블-ddl) — init.sql
5. [**Step 4: CSV Import 구현**](#step-4-csv-import-구현) — csvImport.js
6. [**Step 5: 지표 계산 알고리즘**](#step-5-지표-계산-알고리즘) — indicators.js (12개 지표)
7. [**Step 6: HTML + CSS 레이아웃**](#step-6-html--css-레이아웃) — index.html, styles.css, GUIDE.md
8. [**Step 7: Chart.js 3패널 차트**](#step-7-chartjs-3패널-차트) — chart.js
9. [**Step 8: renderer.js + IPC 통합**](#step-8-rendererjs--ipc-통합) — renderer.js, preload.js 확정본
10. [**Step 9: AI 서비스**](#step-9-ai-서비스-aiservicejs) — aiService.js (Ollama + Claude)

---

## 1단계 개요 및 흐름도

### 목표
Electron 기본 구조 + MariaDB 원격 연결 + CSV import + 기본 차트 렌더링

### 입출력 흐름

```
사용자 PC
├─ Electron 앱 시작 (main.js)
│  ├─ BrowserWindow 생성
│  ├─ mysql2 연결 풀 초기화
│  └─ IPC 핸들러 등록
│
└─ 렌더러 프로세스 (index.html)
   ├─ 차트 탭: 종목 선택 → IPC: db:getStockData → 차트 표시
   ├─ CSV import 탭: [선택] → IPC: db:importCsv → DB INSERT IGNORE → 결과 표시
   └─ 보유현황 탭: 폼 입력 → IPC: db:updateHoldings → DB 저장

DB: 로컬 네트워크 (192.169.20.80:3306)
├─ stock_info (종목 기본)
├─ stock_daily (일봉 OHLCV)
├─ user_holdings (보유 현황)
└─ chat_history (AI 대화)
```

---

## Step 1: Electron 기본 구조

### 1.1 package.json

```json
{
  "name": "stock-talk",
  "version": "0.1.0",
  "description": "AI 주식 분석 데스크탑 앱",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder",
    "dev": "electron ."
  },
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

### 1.2 main.js 스켈레톤

**목적**: Electron 메인 프로세스. BrowserWindow 생성, IPC 핸들러 등록, DB 연결 풀 관리.

```javascript
// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
require('dotenv').config();

let mainWindow;
let pool; // mysql2 연결 풀 (Step 2에서 초기화)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,    // ✅ 필수 보안 설정
      nodeIntegration: false,     // ✅ 필수 보안 설정
      sandbox: true,              // ✅ 권장
      enableRemoteModule: false   // ✅ 필수
    }
  });
  
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  // mainWindow.webContents.openDevTools(); // 개발 시만 활성화
}

app.on('ready', () => {
  // Step 2에서 pool 초기화 추가
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC 핸들러 (Step 4, 5에서 추가)
// ipcMain.handle('db:getStockData', ...)
// ipcMain.handle('db:importCsv', ...)
// 등등
```

### 1.3 preload.js 스켈레톤

**목적**: 렌더러에 안전한 API만 노출 (contextBridge).

```javascript
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appAPI', {
  // DB 관련
  getStockData: (ticker, days) => 
    ipcRenderer.invoke('db:getStockData', { ticker, days }),
  
  importCsv: (filePath, ticker) =>
    ipcRenderer.invoke('db:importCsv', { filePath, ticker }),
  
  addTicker: (info) =>
    ipcRenderer.invoke('db:addTicker', info),
  
  getHoldings: (ticker) =>
    ipcRenderer.invoke('db:getHoldings', { ticker }),
  
  updateHoldings: (holdings) =>
    ipcRenderer.invoke('db:updateHoldings', holdings),
  
  // AI 채팅 (스트리밍)
  sendChat: (message, ticker, engine) =>
    ipcRenderer.send('ai:chat', { message, ticker, engine }),
  
  onAiChunk: (callback) =>
    ipcRenderer.on('ai:chunk', (_, data) => callback(data)),
  
  onAiDone: (callback) =>
    ipcRenderer.on('ai:done', (_, stats) => callback(stats)),
  
  removeAiListeners: () => {
    ipcRenderer.removeAllListeners('ai:chunk');
    ipcRenderer.removeAllListeners('ai:done');
  },
  
  switchEngine: (engine) =>
    ipcRenderer.invoke('ai:switchEngine', { engine }),
  
  // 파일 대화상자
  openFileDialog: () =>
    ipcRenderer.invoke('dialog:openFile')
});
```

### 1.4 .env.example 템플릿

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

### 1.5 .gitignore 설정

```
node_modules/
.env
.env.local
.DS_Store
dist/
out/
```

---

## Step 2: mysql2 연결 풀

### 2.1 src/db/connection.js

**목적**: MySQL 연결 풀을 싱글톤으로 관리. 앱 시작 시 1회만 초기화.

```javascript
// src/db/connection.js
const mysql = require('mysql2/promise');
require('dotenv').config();

let pool = null;

/**
 * MySQL 연결 풀 초기화 (싱글톤)
 * 한국 시간대(KST) 설정으로 일봉 날짜 오류 방지
 */
async function initPool() {
  if (pool) return pool; // 이미 초기화됨

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    
    // 연결 풀 설정
    connectionLimit: 10,         // 동시 쿼리 5~10개면 충분
    waitForConnections: true,    // 연결 부족 시 에러 대신 대기
    connectTimeout: 15000,       // 원격 연결은 15초 권장
    
    // 시간대 + 타입 설정
    timezone: '+09:00',          // KST 필수 (일봉 날짜 오류 방지)
    dateStrings: ['DATE'],       // DATE 컬럼을 'YYYY-MM-DD' 문자열로 반환
    
    // 보안 설정
    multipleStatements: false,   // SQL injection 방지
    enableKeepAlive: true        // 유휴 연결 유지
  });

  // 연결 테스트
  try {
    const connection = await pool.getConnection();
    console.log('✅ MariaDB 연결 성공:', process.env.DB_HOST);
    connection.release();
  } catch (err) {
    console.error('❌ MariaDB 연결 실패:', err.message);
    pool = null;
    throw err;
  }

  return pool;
}

/**
 * 연결 풀 획득 (대기)
 */
function getPool() {
  if (!pool) {
    throw new Error('Pool not initialized. Call initPool() first.');
  }
  return pool;
}

/**
 * 연결 풀 종료
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('MySQL 연결 풀 종료');
  }
}

module.exports = {
  initPool,
  getPool,
  closePool
};
```

### 2.2 main.js에서 pool 초기화

```javascript
// main.js 추가 부분
const { initPool, closePool } = require('./src/db/connection');

app.on('ready', async () => {
  try {
    await initPool(); // DB 연결 풀 초기화
    createWindow();
  } catch (err) {
    console.error('앱 시작 실패:', err.message);
    app.quit();
  }
});

app.on('quit', async () => {
  await closePool();
});
```

### 2.3 src/db/queries.js

**목적**: 모든 DB 쿼리를 함수로 캡슐화. Input-based paging 전용 (LIMIT/OFFSET 금지).

```javascript
// src/db/queries.js
// DB 쿼리 함수 모음. 오프셋 페이징 대신 fromDate/toDate 범위 기반 조회.
const { getPool } = require('./connection');

/**
 * 모든 종목 목록 조회
 */
async function getStockList() {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT ticker, name, market, box_low, box_high, note FROM stock_info ORDER BY ticker ASC'
  );
  return rows;
}

/**
 * 종목 기본 정보 + 박스권 조회
 */
async function getStockInfo(ticker) {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT * FROM stock_info WHERE ticker = ?',
    [ticker]
  );
  return rows[0] || null;
}

/**
 * 일봉 OHLCV 조회 (Input-based paging: fromDate~toDate 범위)
 * LIMIT/OFFSET 방식 사용 금지 — 날짜 범위로만 필터링
 * 
 * @param {string} ticker
 * @param {string|null} fromDate - YYYY-MM-DD (null이면 전체 시작)
 * @param {string|null} toDate - YYYY-MM-DD (null이면 오늘까지)
 * @returns {Array} [{date, open, high, low, close, volume}]
 */
async function getStockData(ticker, fromDate = null, toDate = null) {
  const pool = getPool();

  let sql = `
    SELECT trade_date AS date, open, high, low, close, volume
    FROM stock_daily
    WHERE ticker = ?
  `;
  const params = [ticker];

  if (fromDate) { sql += ' AND trade_date >= ?'; params.push(fromDate); }
  if (toDate)   { sql += ' AND trade_date <= ?'; params.push(toDate); }

  sql += ' ORDER BY trade_date ASC';

  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * 종목 추가 또는 박스권 업데이트 (UPSERT)
 */
async function addOrUpdateStockInfo({ ticker, name, market, box_low, box_high, note }) {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO stock_info (ticker, name, market, box_low, box_high, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), market=VALUES(market),
       box_low=VALUES(box_low), box_high=VALUES(box_high), note=VALUES(note)`,
    [ticker, name, market || 'KOSDAQ', box_low || null, box_high || null, note || null]
  );
}

/**
 * 보유 현황 조회
 */
async function getHoldings(ticker) {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT * FROM user_holdings WHERE ticker = ?',
    [ticker]
  );
  return rows[0] || null;
}

/**
 * 보유 현황 UPSERT (종목당 1행 유지)
 */
async function upsertHoldings({ ticker, avg_price, quantity, available_cash, strategy, horizon, expected_issue, split_plan }) {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO user_holdings
       (ticker, avg_price, quantity, available_cash, strategy, horizon, expected_issue, split_plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       avg_price=VALUES(avg_price), quantity=VALUES(quantity),
       available_cash=VALUES(available_cash), strategy=VALUES(strategy),
       horizon=VALUES(horizon), expected_issue=VALUES(expected_issue),
       split_plan=VALUES(split_plan)`,
    [
      ticker,
      avg_price || null, quantity || null, available_cash || null,
      strategy || null, horizon || null, expected_issue || null,
      split_plan ? JSON.stringify(split_plan) : null
    ]
  );
}

/**
 * AI 대화 기록 조회 (최근 N개, 오래된 것부터 반환)
 * Ollama: 10턴(20개), Claude: 20턴(40개)
 */
async function getChatHistory(ticker, engine = null, limit = 20) {
  const pool = getPool();

  let sql = `
    SELECT role, content, engine, created_at
    FROM chat_history
    WHERE ticker = ?
  `;
  const params = [ticker];

  if (engine) { sql += ' AND engine = ?'; params.push(engine); }

  // 최신 우선 조회 후 역순 반환 (시간 순서 복원)
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const [rows] = await pool.execute(sql, params);
  return rows.reverse();
}

/**
 * AI 대화 메시지 저장
 */
async function saveChatMessage(ticker, role, content, engine) {
  const pool = getPool();
  await pool.execute(
    'INSERT INTO chat_history (ticker, role, content, engine) VALUES (?, ?, ?, ?)',
    [ticker, role, content, engine]
  );
}

module.exports = {
  getStockList,
  getStockInfo,
  getStockData,
  addOrUpdateStockInfo,
  getHoldings,
  upsertHoldings,
  getChatHistory,
  saveChatMessage
};
```

### 2.4 src/db/GUIDE.md

```markdown
# src/db/ GUIDE

## 목적
MariaDB 연결 풀 및 쿼리 함수 모음.

## 포함 파일

| 파일 | 용도 |
|------|------|
| `connection.js` | mysql2 연결 풀 (싱글톤), initPool/getPool/closePool |
| `queries.js` | 모든 SQL 쿼리 함수 — CRUD 완전 캡슐화 |
| `init.sql` | DB + 4개 테이블 DDL, 최초 1회 실행 |

## Input-Based Paging 원칙
LIMIT/OFFSET 방식 사용 금지. 날짜 범위(fromDate/toDate)로만 필터링.
이유: 주식 데이터는 날짜 기반 — 오프셋 기준 조회는 의미 없음.
```

---

## Step 3: DB 테이블 DDL

### 3.1 src/db/init.sql

**목적**: MariaDB 데이터베이스 및 4개 테이블 생성.

```sql
-- src/db/init.sql
-- 데이터베이스 생성
CREATE DATABASE IF NOT EXISTS stock_analysis
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE stock_analysis;

-- ============ 테이블 1: stock_info (종목 기본 정보) ============
CREATE TABLE IF NOT EXISTS stock_info (
  ticker      VARCHAR(20)  PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  market      VARCHAR(20),           -- 'KOSPI' or 'KOSDAQ'
  box_low     INT,                   -- 박스권 하단 (수동 설정)
  box_high    INT,                   -- 박스권 상단 (수동 설정)
  note        TEXT,                  -- 종목 특이사항
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_market (market)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 테이블 2: stock_daily (일봉 OHLCV) ============
CREATE TABLE IF NOT EXISTS stock_daily (
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
  INDEX idx_ticker_date (ticker, trade_date),
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 테이블 3: user_holdings (보유 현황) ============
CREATE TABLE IF NOT EXISTS user_holdings (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  ticker          VARCHAR(20)  NOT NULL,
  avg_price       INT,                   -- 매입단가
  quantity        INT,                   -- 보유수량
  available_cash  INT,                   -- 가용자금
  strategy        TEXT,                  -- 투자전략
  horizon         TEXT,                  -- 투자 기간
  expected_issue  TEXT,                  -- 기대 이슈
  split_plan      JSON,                  -- 분할 매수 계획 (JSON)
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker),
  UNIQUE KEY uq_ticker (ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 테이블 4: chat_history (AI 대화 기록) ============
CREATE TABLE IF NOT EXISTS chat_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ticker      VARCHAR(20),
  role        ENUM('user','assistant') NOT NULL,
  content     TEXT         NOT NULL,
  engine      ENUM('ollama','claude') DEFAULT 'ollama',
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_ticker_created (ticker, created_at),
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 초기 데이터 ============
INSERT INTO stock_info (ticker, name, market, box_low, box_high)
VALUES ('053800', '안랩', 'KOSDAQ', 51000, 70000)
ON DUPLICATE KEY UPDATE box_low=VALUES(box_low), box_high=VALUES(box_high);
```

### 3.2 init.sql 실행 방법 (Step 3 수행 시)

```bash
# 터미널에서 실행 (또는 MySQL Workbench)
mysql -h 192.169.20.80 -u root -p < src/db/init.sql
```

---

## Step 4: CSV Import 구현

### 4.1 개요

**목적**: ahnlab_daily.csv를 읽어서 stock_daily 테이블에 INSERT IGNORE로 삽입.

**핵심 요구사항**:
- CSV 스트림 방식 처리 (메모리 효율)
- 헤더 행 스킵
- date YYYYMMDD → DATE YYYY-MM-DD 변환
- 100행 배치 INSERT IGNORE
- 결과 반환: {success: true, inserted: N, duplicates: M, errors: []}
- 에러 처리: 잘못된 날짜, 숫자 변환 실패, DB 에러

### 4.2 src/services/csvImport.js

**코드 스니펫** (실제 구현 가능 수준):

```javascript
// src/services/csvImport.js
const fs = require('fs');
const readline = require('readline');
const { getPool } = require('../db/connection');

/**
 * CSV 파일을 읽어 stock_daily 테이블에 INSERT IGNORE
 * 
 * @param {string} filePath - CSV 파일 경로
 * @param {string} ticker - 종목 코드 (기본값: '053800')
 * @returns {Promise<{success: boolean, inserted: number, duplicates: number, errors: Array}>}
 */
async function importCsv(filePath, ticker = '053800') {
  const results = {
    success: false,
    inserted: 0,
    duplicates: 0,
    errors: []
  };

  let headerSkipped = false;
  let batch = [];
  const BATCH_SIZE = 100;
  const pool = getPool();

  return new Promise((resolve) => {
    // fs.createReadStream + readline으로 CSV 스트림 처리
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    // CSV 행별 처리
    rl.on('line', (line) => {
      // 1단계: 헤더 행 스킵
      if (!headerSkipped) {
        headerSkipped = true;
        return; // 'date,open,high,low,close,volume,change_ratio' 스킵
      }

      // 2단계: CSV 행 파싱
      try {
        const [dateStr, openStr, highStr, lowStr, closeStr, volumeStr, changeRatio] = 
          line.split(',').map(v => v.trim());

        // 3단계: Date 변환 (YYYYMMDD → YYYY-MM-DD)
        const tradeDate = convertDate(dateStr);
        if (!tradeDate) {
          results.errors.push(`잘못된 날짜 형식: ${dateStr}`);
          return;
        }

        // 4단계: 타입 변환
        const open = parseInt(openStr, 10);
        const high = parseInt(highStr, 10);
        const low = parseInt(lowStr, 10);
        const close = parseInt(closeStr, 10);
        const volume = parseInt(volumeStr, 10);

        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
          results.errors.push(`숫자 변환 실패: ${line.substring(0, 50)}...`);
          return;
        }

        // 5단계: 배치에 추가
        batch.push({ ticker, tradeDate, open, high, low, close, volume });

        // 6단계: 배치 크기 도달 시 DB INSERT
        if (batch.length >= BATCH_SIZE) {
          // INSERT 쿼리 비동기 실행 (rl 루프와 독립적)
          (async () => {
            await executeBatchInsert(pool, batch, results);
            batch = [];
          })();
        }
      } catch (err) {
        results.errors.push(`행 처리 실패: ${err.message}`);
      }
    });

    // 3단계: 파일 읽기 완료 (배치 남은 행 처리)
    rl.on('close', async () => {
      try {
        // 남은 배치 처리
        if (batch.length > 0) {
          await executeBatchInsert(pool, batch, results);
        }

        results.success = true;
        resolve(results);
      } catch (err) {
        results.errors.push(`최종 배치 INSERT 실패: ${err.message}`);
        resolve(results);
      }
    });

    // 파일 읽기 에러
    rl.on('error', (err) => {
      results.errors.push(`파일 읽기 실패: ${err.message}`);
      resolve(results);
    });

    fileStream.on('error', (err) => {
      results.errors.push(`파일 스트림 에러: ${err.message}`);
      resolve(results);
    });
  });
}

/**
 * 배치 INSERT IGNORE 실행
 * 100행 단위 placeholders 동적 생성
 */
async function executeBatchInsert(pool, batch, results) {
  if (batch.length === 0) return;

  try {
    // Placeholders 동적 생성: (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), ...
    const placeholders = batch
      .map(() => '(?, ?, ?, ?, ?, ?)')
      .join(', ');

    // Values 평탄화: [ticker1, date1, open1, ..., ticker2, date2, open2, ...]
    const values = [];
    for (const row of batch) {
      values.push(
        row.ticker,
        row.tradeDate,
        row.open,
        row.high,
        row.low,
        row.close,
        row.volume
      );
    }

    // SQL 실행
    const sql = `
      INSERT IGNORE INTO stock_daily
        (ticker, trade_date, open, high, low, close, volume)
      VALUES ${placeholders}
    `;

    const [result] = await pool.execute(sql, values);

    // 결과 분석
    results.inserted += result.affectedRows;
    
    // MariaDB INSERT IGNORE: 중복된 행은 affectedRows에 미포함
    // duplicates 계산: 전송한 행 수 - 실제 inserted 수
    const duplicateCnt = batch.length - result.affectedRows;
    results.duplicates += duplicateCnt;
  } catch (err) {
    results.errors.push(`배치 INSERT 실패: ${err.message}`);
  }
}

/**
 * Date 변환 함수 (YYYYMMDD → YYYY-MM-DD)
 * @param {string} dateStr - "20140319" 형식
 * @returns {string|null} "2014-03-19" 또는 null
 */
function convertDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;

  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(4, 6);
  const day = dateStr.slice(6, 8);

  // 유효성 검사
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);

  if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

module.exports = {
  importCsv
};
```

### 4.3 main.js에서 IPC 핸들러 등록

```javascript
// main.js에 추가
const { importCsv } = require('./src/services/csvImport');

ipcMain.handle('db:importCsv', async (event, { filePath, ticker }) => {
  try {
    const result = await importCsv(filePath, ticker || '053800');
    return result;
  } catch (err) {
    console.error('CSV import 에러:', err);
    return {
      success: false,
      inserted: 0,
      duplicates: 0,
      errors: [err.message]
    };
  }
});

// 파일 선택 대화상자
ipcMain.handle('dialog:openFile', async (event) => {
  const { filePath } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  return filePath ? filePath[0] : null;
});
```

### 4.4 설계 결정 및 트레이드오프

#### 배치 크기 100 선택 이유
- **성능**: 100행 배치 = ~1.5ms DB 왕복 (네트워크 지연 고려)
- **메모리**: 배치당 ~10KB (100행 × 7 컬럼 × 14 bytes)
- **안정성**: 너무 큰 배치(1000+)는 메모리 압박, 너무 작은 배치(<10)는 왕복 횟수 증가
- **권장 범위**: 50~500 중에서 100은 균형점

#### INSERT IGNORE vs ON DUPLICATE KEY UPDATE
- **채택: INSERT IGNORE** (RESEARCH.md 섹션 6.5 참고)
  - 재import 시 기존 데이터 보존 (삽입 실패)
  - 중복 행의 `affectedRows = 0` → duplicates 카운팅 가능
  - 간단한 구현 (데이터 갱신 불필요)

- **ON DUPLICATE KEY UPDATE 사용 시기**
  - 기존 일봉 데이터를 수정해야 하는 경우 (가격 정정 등)
  - 프로젝트 초기 단계에서는 불필요

#### 스트림 방식 선택 이유
- **메모리 효율**: 전체 CSV 로드 없이 라인별 처리 → 대용량 파일(100만 행)도 처리 가능
- **진행 상황 표시 가능**: readline 'line' 이벤트로 실시간 진행률 추적 (향후 UI 추가)
- **에러 격리**: 한 행 파싱 실패 → 다음 행 계속 처리 (robust)

---

## Step 5: 지표 계산 알고리즘

### 5.1 개요

**목적**: 일봉 OHLCV 배열에서 12개 지표를 계산.
- 입력: OHLCV 배열 (최소 35일 권장, 최소 15일)
- 출력: 각 종목일마다 [지표들] 계산 결과
- **Input-Based Paging**: fromDate ~ toDate 범위 기반 필터링 (오프셋 방식 금지)

**필요한 지표**:
1. MA (5, 20, 60, 120)
2. 볼린저밴드 (20, 2)
3. OBV + OBV MA20
4. RSI (14, Wilder 평활 필수)
5. MACD (12, 26, 9)
6. 스토캐스틱 (14, 3)
7. ATR (14, Wilder 평활)
8. CCI (20)
9. VWAP (누적)
10. 다이버전스 (RSI/OBV)
11. 캔들 패턴 (6가지)

### 5.2 src/services/GUIDE.md

**폴더 설명 파일** (CLAUDE.md 폴더 관리 원칙):

```markdown
# src/services/ GUIDE

## 목적
비즈니스 로직 서비스 모음. DB와 렌더러 사이의 중간 계층.

## 포함 파일

| 파일 | 용도 |
|------|------|
| `csvImport.js` | CSV 파싱 + INSERT IGNORE (Step 4) |
| `indicators.js` | 지표 계산 (12개 기술지표) (Step 5) |
| `aiService.js` | Ollama/Claude API 통합 (Step 2 이후) |

## 설계 원칙

- **단일 책임**: 하나의 파일 = 하나의 기능
- **Pure Function**: 부작용 최소화 (DB 쓰기 제외)
- **Input-Based Filtering**: 오프셋 대신 범위(fromDate/toDate) 기반

## 데이터 흐름

```
DB (stock_daily)
    ↓ (조회: 최근 120일)
services/indicators.js
    ↓ (12개 지표 계산)
main.js IPC 핸들러
    ↓ (결과 반환)
renderer.js → chart.js (렌더링)
```

## 메모리 특성

- 안랩 10년 데이터: ~2,500 거래일
- 지표 계산 결과: ~300KB (15 지표 × 2,500행)
- Electron에서 메모리 부담 없음

---
```

### 5.3 src/services/indicators.js

**코드 스니펫** (실제 구현 가능 수준):

```javascript
// src/services/indicators.js

/**
 * 전체 지표 계산 진입점
 * 
 * @param {Array} ohlcvArr - [{date, open, high, low, close, volume}, ...] 배열
 * @param {string} fromDate - 필터 시작 날짜 (YYYY-MM-DD), 선택사항
 * @param {string} toDate - 필터 종료 날짜 (YYYY-MM-DD), 선택사항
 * @returns {Array} 계산된 지표 배열
 */
function calculateAll(ohlcvArr, fromDate = null, toDate = null) {
  if (!ohlcvArr || ohlcvArr.length < 35) {
    console.warn('경고: 최소 35개 데이터 포인트 권장 (현재:', ohlcvArr?.length || 0, ')');
  }

  // 0단계: Input-based Paging (범위 필터링)
  let filteredArr = ohlcvArr;
  if (fromDate && toDate) {
    filteredArr = ohlcvArr.filter(row => {
      const d = row.date || row.trade_date;
      return d >= fromDate && d <= toDate;
    });
  }

  if (filteredArr.length === 0) {
    console.warn('범위 필터링 후 데이터 없음:', fromDate, '~', toDate);
    return [];
  }

  // 필터링된 배열에서만 지표 계산 (하지만 계산 기반 데이터는 원본 배열 사용)
  // → 예: 범위 필터링 된 데이터의 RSI를 계산하려면 이전 14일 데이터가 필요
  // → 따라서 실제로는 "계산 범위"와 "반환 범위"를 분리

  const closes = ohlcvArr.map(row => row.close);
  const highs = ohlcvArr.map(row => row.high);
  const lows = ohlcvArr.map(row => row.low);
  const volumes = ohlcvArr.map(row => row.volume);

  // 각 지표 계산
  const mas = {
    ma5: calcMA(closes, 5),
    ma20: calcMA(closes, 20),
    ma60: calcMA(closes, 60),
    ma120: calcMA(closes, 120)
  };

  const bb = calcBB(closes, 20, 2);
  const obv = calcOBV(closes, volumes);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes, 12, 26, 9);
  const stoch = calcStochastic(highs, lows, closes, 14, 3);
  const atr = calcATR(highs, lows, closes, 14);
  const cci = calcCCI(highs, lows, closes, 20);
  const vwap = calcVWAP(highs, lows, closes, volumes);
  const divergences = detectDivergence(closes, rsi, obv);
  const candlePatterns = ohlcvArr.map((row, i) =>
    detectCandlePattern(row.open, row.high, row.low, row.close, i > 0 ? ohlcvArr[i - 1] : null)
  );

  // 결과 조합
  const results = ohlcvArr.map((row, i) => ({
    date: row.date || row.trade_date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,

    // 이동평균
    ma5: mas.ma5[i],
    ma20: mas.ma20[i],
    ma60: mas.ma60[i],
    ma120: mas.ma120[i],

    // 볼린저밴드
    bbUpper: bb.upper[i],
    bbMiddle: bb.middle[i],
    bbLower: bb.lower[i],
    bbPctB: bb.pctB[i],
    bbWidth: bb.width[i],

    // OBV
    obv: obv.obv[i],
    obvMa20: obv.obvMa20[i],

    // RSI
    rsi: rsi[i],

    // MACD
    macd: macd.macd[i],
    macdSignal: macd.signal[i],
    macdHistogram: macd.histogram[i],

    // 스토캐스틱
    stochK: stoch.k[i],
    stochD: stoch.d[i],

    // ATR
    atr: atr[i],

    // CCI
    cci: cci[i],

    // VWAP
    vwap: vwap[i],

    // 다이버전스 상태
    rsiDivergence: divergences.rsi[i], // null, 'bullish', 'bearish' 등
    obvDivergence: divergences.obv[i],

    // 캔들 패턴
    candlePattern: candlePatterns[i]
  }));

  // Input-based Paging: 범위 필터링된 데이터만 반환
  if (fromDate && toDate) {
    return results.filter(row => row.date >= fromDate && row.date <= toDate);
  }

  return results;
}

// ============ 1. 이동평균 (MA) ============

/**
 * 단순이동평균 (SMA)
 * @param {Array} data - 종가 배열
 * @param {number} period - 기간 (5, 20, 60, 120)
 * @returns {Array} MA 배열 (초기값 null)
 */
function calcMA(data, period) {
  const ma = new Array(data.length).fill(null);

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    ma[i] = sum / period;
  }

  return ma;
}

// ============ 2. 볼린저밴드 (BB) ============

/**
 * 볼린저밴드 (20일, 2σ)
 * @param {Array} closes - 종가 배열
 * @param {number} period - 기간 (기본 20)
 * @param {number} mult - 표준편차 배수 (기본 2)
 * @returns {Object} {upper, middle, lower, pctB, width}
 */
function calcBB(closes, period = 20, mult = 2) {
  const upper = [];
  const middle = [];
  const lower = [];
  const pctB = [];
  const width = [];

  for (let i = period - 1; i < closes.length; i++) {
    // MA20 계산
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += closes[j];
    }
    const ma = sum / period;
    middle[i] = ma;

    // 표준편차 (표본분산 N-1 사용)
    let sumSquares = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSquares += Math.pow(closes[j] - ma, 2);
    }
    const variance = sumSquares / (period - 1); // ← N-1 (표본분산)
    const stdDev = Math.sqrt(variance);

    // BB 밴드
    upper[i] = ma + mult * stdDev;
    lower[i] = ma - mult * stdDev;

    // %B = (close - BB_lower) / (BB_upper - BB_lower)
    if (upper[i] !== lower[i]) {
      pctB[i] = (closes[i] - lower[i]) / (upper[i] - lower[i]);
    } else {
      pctB[i] = 0.5; // 대역폭 0일 때 중간값
    }

    // Bandwidth = (BB_upper - BB_lower) / MA20
    width[i] = (upper[i] - lower[i]) / ma;
  }

  return { upper, middle, lower, pctB, width };
}

// ============ 3. OBV (On-Balance Volume) ============

/**
 * OBV + OBV MA20
 * @param {Array} closes - 종가 배열
 * @param {Array} volumes - 거래량 배열
 * @returns {Object} {obv, obvMa20}
 */
function calcOBV(closes, volumes) {
  const obv = [0];

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv[i] = obv[i - 1] + volumes[i];
    } else if (closes[i] < closes[i - 1]) {
      obv[i] = obv[i - 1] - volumes[i];
    } else {
      obv[i] = obv[i - 1];
    }
  }

  // OBV MA20
  const obvMa20 = new Array(obv.length).fill(null);
  for (let i = 19; i < obv.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) {
      sum += obv[j];
    }
    obvMa20[i] = sum / 20;
  }

  return { obv, obvMa20 };
}

// ============ 4. RSI (Relative Strength Index) ============

/**
 * RSI (14일, Wilder 평활)
 * ⚠️ 핵심: Wilder 평활 방식 필수 (단순 EMA와 다름)
 * 
 * @param {Array} closes - 종가 배열
 * @param {number} period - 기간 (기본 14)
 * @returns {Array} RSI 배열
 */
function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);

  if (closes.length < period + 1) {
    return rsi;
  }

  // 1단계: 상승폭과 하락폭 계산
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      gains[i] = change;
    } else {
      losses[i] = -change;
    }
  }

  // 2단계: 초기값 (처음 14일 단순평균)
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }

  avgGain /= period;
  avgLoss /= period;

  // 첫 RSI 값
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsi[period] = 100 - (100 / (1 + rs));

  // 3단계: Wilder 평활 (이후)
  // avg_gain[t] = (avg_gain[t-1] × (period-1) + gain[t]) / period
  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi[i] = 100 - (100 / (1 + rs));
  }

  return rsi;
}

// ============ 5. MACD ============

/**
 * MACD (12, 26, 9)
 * @param {Array} closes - 종가 배열
 * @param {number} fast - 빠른 EMA 기간 (기본 12)
 * @param {number} slow - 느린 EMA 기간 (기본 26)
 * @param {number} signal - Signal EMA 기간 (기본 9)
 * @returns {Object} {macd, signal, histogram}
 */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  // 1단계: EMA 계산
  const ema12 = calcEMA(closes, fast);
  const ema26 = calcEMA(closes, slow);

  // 2단계: MACD = EMA12 - EMA26
  const macd = ema12.map((val, i) => 
    val !== null && ema26[i] !== null ? val - ema26[i] : null
  );

  // 3단계: Signal = EMA of MACD
  const signalLine = calcEMA(macd, signal);

  // 4단계: Histogram = MACD - Signal
  const histogram = macd.map((val, i) =>
    val !== null && signalLine[i] !== null ? val - signalLine[i] : null
  );

  return { macd, signal: signalLine, histogram };
}

/**
 * EMA (Exponential Moving Average)
 * 초기값: 첫 번째 유효한 값은 해당 기간의 단순평균
 */
function calcEMA(data, period) {
  const ema = new Array(data.length).fill(null);
  const k = 2 / (period + 1);

  // 초기값: period 번째 단순평균
  let sum = 0;
  let count = 0;
  for (let i = 0; i < period; i++) {
    if (data[i] !== null && data[i] !== undefined) {
      sum += data[i];
      count++;
    }
  }

  if (count < period) return ema;

  const initialEMA = sum / period;
  ema[period - 1] = initialEMA;

  // EMA 재귀: EMA[t] = close[t] × k + EMA[t-1] × (1-k)
  for (let i = period; i < data.length; i++) {
    if (data[i] === null || data[i] === undefined) {
      continue;
    }
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

// ============ 6. 스토캐스틱 (K, D) ============

/**
 * 스토캐스틱 (14일, K/D 3일 평활)
 * @param {Array} highs - 고가 배열
 * @param {Array} lows - 저가 배열
 * @param {Array} closes - 종가 배열
 * @param {number} kPeriod - K 기간 (기본 14)
 * @param {number} dPeriod - D 평활 기간 (기본 3)
 * @returns {Object} {k, d}
 */
function calcStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const k = new Array(closes.length).fill(null);
  const d = new Array(closes.length).fill(null);

  for (let i = kPeriod - 1; i < closes.length; i++) {
    // 14일 최고가, 최저가
    let maxHigh = highs[i];
    let minLow = lows[i];

    for (let j = i - kPeriod + 1; j < i; j++) {
      maxHigh = Math.max(maxHigh, highs[j]);
      minLow = Math.min(minLow, lows[j]);
    }

    // K = (close - min_low) / (max_high - min_low) × 100
    if (maxHigh !== minLow) {
      k[i] = ((closes[i] - minLow) / (maxHigh - minLow)) * 100;
    } else {
      k[i] = 50;
    }
  }

  // D = SMA(K, 3)
  for (let i = kPeriod + dPeriod - 2; i < k.length; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) {
      sum += k[j];
    }
    d[i] = sum / dPeriod;
  }

  return { k, d };
}

// ============ 7. ATR (Average True Range) ============

/**
 * ATR (14일, Wilder 평활)
 * @param {Array} highs - 고가 배열
 * @param {Array} lows - 저가 배열
 * @param {Array} closes - 종가 배열
 * @param {number} period - 기간 (기본 14)
 * @returns {Array} ATR 배열
 */
function calcATR(highs, lows, closes, period = 14) {
  const atr = new Array(closes.length).fill(null);
  const tr = new Array(closes.length).fill(null);

  // 1단계: True Range 계산
  tr[0] = highs[0] - lows[0];

  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  // 2단계: 초기 ATR (첫 14일 단순평균)
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += tr[i];
  }
  atr[period] = sum / period;

  // 3단계: Wilder 평활
  for (let i = period + 1; i < closes.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  return atr;
}

// ============ 8. CCI (Commodity Channel Index) ============

/**
 * CCI (20일)
 * @param {Array} highs - 고가 배열
 * @param {Array} lows - 저가 배열
 * @param {Array} closes - 종가 배열
 * @param {number} period - 기간 (기본 20)
 * @returns {Array} CCI 배열
 */
function calcCCI(highs, lows, closes, period = 20) {
  const cci = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    // Typical Price (TP)
    const tpArr = [];
    for (let j = i - period + 1; j <= i; j++) {
      tpArr.push((highs[j] + lows[j] + closes[j]) / 3);
    }

    // TP MA20
    const tpMa = tpArr.reduce((a, b) => a + b, 0) / period;

    // MAD (Mean Absolute Deviation)
    let sumAbs = 0;
    for (const tp of tpArr) {
      sumAbs += Math.abs(tp - tpMa);
    }
    const mad = sumAbs / period;

    // CCI = (TP - TP_MA20) / (0.015 × MAD)
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    if (mad === 0) {
      cci[i] = 0;
    } else {
      cci[i] = (tp - tpMa) / (0.015 * mad);
    }
  }

  return cci;
}

// ============ 9. VWAP (Volume Weighted Average Price) ============

/**
 * VWAP (누적, Typical Price 방식)
 * 정확한 VWAP은 분봉 단위 필요. 일봉 근사치는 중기 흐름 참고용.
 * 
 * @param {Array} highs - 고가 배열
 * @param {Array} lows - 저가 배열
 * @param {Array} closes - 종가 배열
 * @param {Array} volumes - 거래량 배열
 * @returns {Array} VWAP 배열
 */
function calcVWAP(highs, lows, closes, volumes) {
  const vwap = new Array(closes.length).fill(null);

  let cumulTPVolume = 0;  // 누적: TP × volume
  let cumulVolume = 0;    // 누적: volume

  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3; // Typical Price
    cumulTPVolume += tp * volumes[i];
    cumulVolume += volumes[i];

    if (cumulVolume > 0) {
      vwap[i] = cumulTPVolume / cumulVolume;
    }
  }

  return vwap;
}

// ============ 10. 다이버전스 감지 (RSI, OBV) ============

/**
 * 불리시/헬시 다이버전스 감지
 * 조건: 최소 5일 간격 피벗 비교
 * 
 * @param {Array} closes - 종가 배열
 * @param {Array} rsiValues - RSI 배열
 * @param {Array} obvValues - OBV 배열
 * @returns {Object} {rsi: [null|'bullish'|'bearish'], obv: [...]}
 */
function detectDivergence(closes, rsiValues, obvValues) {
  const minGap = 5; // 최소 간격
  const rsiDiv = new Array(closes.length).fill(null);
  const obvDiv = new Array(closes.length).fill(null);

  // RSI 다이버전스 감지
  for (let i = minGap; i < closes.length - minGap; i++) {
    // 현재 피벗 (i 중심으로 좌우 minGap 일 범위에서 국소 최저값)
    let isLowPivot = true;
    for (let j = i - minGap; j <= i + minGap; j++) {
      if (j !== i && closes[j] < closes[i]) {
        isLowPivot = false;
        break;
      }
    }

    if (isLowPivot && rsiValues[i] !== null) {
      // 이전 피벗 찾기
      let prevLowIdx = -1;
      for (let j = i - minGap - 1; j >= 0; j--) {
        let isPrevPivot = true;
        for (let k = j - minGap; k <= j + minGap; k++) {
          if (k >= 0 && k !== j && closes[k] < closes[j]) {
            isPrevPivot = false;
            break;
          }
        }
        if (isPrevPivot) {
          prevLowIdx = j;
          break;
        }
      }

      if (prevLowIdx >= 0 && rsiValues[prevLowIdx] !== null) {
        // 불리시: 가격 저점↓ + RSI 저점↑
        if (closes[i] < closes[prevLowIdx] && rsiValues[i] > rsiValues[prevLowIdx]) {
          rsiDiv[i] = 'bullish_hidden';
        }
        // 베어리시: 가격 저점↓ + RSI 저점↓
        else if (closes[i] < closes[prevLowIdx] && rsiValues[i] < rsiValues[prevLowIdx]) {
          rsiDiv[i] = 'bearish_standard';
        }
      }
    }
  }

  // OBV 다이버전스 감지 (동일한 로직)
  for (let i = minGap; i < closes.length - minGap; i++) {
    let isLowPivot = true;
    for (let j = i - minGap; j <= i + minGap; j++) {
      if (j !== i && closes[j] < closes[i]) {
        isLowPivot = false;
        break;
      }
    }

    if (isLowPivot && obvValues[i] !== null) {
      let prevLowIdx = -1;
      for (let j = i - minGap - 1; j >= 0; j--) {
        let isPrevPivot = true;
        for (let k = j - minGap; k <= j + minGap; k++) {
          if (k >= 0 && k !== j && closes[k] < closes[j]) {
            isPrevPivot = false;
            break;
          }
        }
        if (isPrevPivot) {
          prevLowIdx = j;
          break;
        }
      }

      if (prevLowIdx >= 0 && obvValues[prevLowIdx] !== null) {
        if (closes[i] < closes[prevLowIdx] && obvValues[i] > obvValues[prevLowIdx]) {
          obvDiv[i] = 'bullish_hidden';
        } else if (closes[i] < closes[prevLowIdx] && obvValues[i] < obvValues[prevLowIdx]) {
          obvDiv[i] = 'bearish_standard';
        }
      }
    }
  }

  return { rsi: rsiDiv, obv: obvDiv };
}

// ============ 11. 캔들 패턴 감지 ============

/**
 * 6가지 캔들 패턴 감지
 * @param {number} open - 시가
 * @param {number} high - 고가
 * @param {number} low - 저가
 * @param {number} close - 종가
 * @param {Object} prevCandle - 전일 캔들 정보
 * @returns {string|null} 패턴 이름 또는 null
 */
function detectCandlePattern(open, high, low, close, prevCandle) {
  const bodySize = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const totalHeight = high - low;

  // 1. 아래꼬리 양봉 (Bullish Tail)
  if (close > open && lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) {
    return 'bullish_tail';
  }

  // 2. 강세장악형 (Bullish Engulfing)
  if (prevCandle && prevCandle.close < prevCandle.open &&
      open < prevCandle.close &&
      close > prevCandle.open) {
    return 'bullish_engulfing';
  }

  // 3. 망치형 (Hammer)
  if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5 && close > open) {
    return 'hammer';
  }

  // 4. 저점 갭업 (Gap Up + Bullish)
  if (prevCandle && open > prevCandle.close && close > open) {
    return 'gap_up_bullish';
  }

  // 5. 도지 (Doji) — 십자형
  if (bodySize < totalHeight * 0.1 && upperWick > bodySize && lowerWick > bodySize) {
    return 'doji';
  }

  // 6. 음봉 (Bearish) — 기본
  if (close < open) {
    return 'bearish';
  }

  return null;
}

module.exports = {
  calculateAll,
  calcMA,
  calcBB,
  calcOBV,
  calcRSI,
  calcMACD,
  calcEMA,
  calcStochastic,
  calcATR,
  calcCCI,
  calcVWAP,
  detectDivergence,
  detectCandlePattern
};
```

### 5.4 main.js에서 IPC 핸들러 등록

```javascript
// main.js에 추가
const { calculateAll } = require('./src/services/indicators');

ipcMain.handle('db:getStockDataWithIndicators', async (event, { ticker, fromDate = null, toDate = null }) => {
  try {
    const { getStockData } = require('./src/db/queries');

    // 1단계: Input-based paging — fromDate/toDate 범위 조회 (LIMIT/OFFSET 금지)
    //         fromDate/toDate null이면 전체 데이터 반환 → 지표 계산에 필요한 이전 데이터 포함
    //         실제로는 toDate가 오늘이면 최소 120일 이상 조회 권장
    const rows = await getStockData(ticker, fromDate, toDate);

    // 2단계: 지표 계산 (전체 데이터로 계산 후 범위 필터링 — RSI 등 누적 지표 정확도 보장)
    const ohlcvArr = rows.map(row => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume
    }));

    const indicators = calculateAll(ohlcvArr, fromDate, toDate);

    return {
      success: true,
      data: indicators
    };
  } catch (err) {
    console.error('지표 계산 에러:', err);
    return {
      success: false,
      error: err.message
    };
  }
});
```

### 5.5 설계 결정 및 트레이드오프

#### RSI: Wilder 평활 vs 단순 EMA
- **채택: Wilder 평활** (RESEARCH.md 섹션 7.4)
  - 정확한 RSI 정의: Wilder가 개발한 평활 방식 사용
  - 초기 14일 단순평균 → 이후 Wilder 평활 (이동가중 X 13/14)
  - 대부분 트레이딩 플랫폼과 일치

- **단순 EMA 사용 시 문제**
  - RSI 값이 부정확함 (특히 초기값)
  - 실제 RSI와 수값 차이 2~5% 발생

#### 지표 계산 범위 vs 반환 범위 분리
- **문제**: Input-based paging 시 fromDate~toDate 범위의 RSI를 계산하려면?
  - RSI 계산이 이전 14일 데이터 필요
  - 범위 시작일의 RSI는 이전 데이터가 없으면 부정확

- **해결**: 
  1. **계산**: 전체 데이터로 지표 계산 (정확도 보장)
  2. **반환**: 범위 필터링 후 반환 (성능 최적화)
  ```javascript
  // 구현 예
  const results = calculateAll(ohlcvArr); // 전체 계산
  const filtered = results.filter(r => r.date >= fromDate && r.date <= toDate); // 범위 필터
  return filtered;
  ```

#### 최소 데이터 포인트 처리
- **권장**: 최소 35일 (MACD 안정화)
- **최소**: 15일 (ATR 계산 가능)
- **구현**: 35개 미만 → 경고 로그 + null 반환 대신 계산 진행 (사용자 판단)

#### 메모리 효율
- VWAP: 누적 계산 → 선형 시간 O(n)
- 다이버전스: 피벗 탐색 → O(n²) 하지만 n ≤ 2,500이므로 문제 없음
- 전체 메모리: 안랩 10년 데이터 (~2,500일) = ~300KB

---

## Step 6: HTML + CSS 레이아웃

### 6.1 src/renderer/index.html

**목적**: 3패널 다크 테마 레이아웃. Input-based paging을 위한 날짜 범위 입력 필드 포함.

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <!-- CSP: script-src 'self'만 허용, nonce/sha 없이 inline script 금지 -->
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI 주식 분석</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>

  <!-- ===== 헤더 ===== -->
  <header class="app-header">
    <div class="header-left">
      <select id="ticker-select">
        <option value="">-- 종목 선택 --</option>
      </select>
      <label class="date-label">
        <input type="date" id="from-date" title="시작일">
        ~
        <input type="date" id="to-date" title="종료일">
      </label>
      <button id="btn-load">조회</button>
    </div>
    <div class="header-right">
      <span id="engine-label" class="engine-badge">Ollama</span>
      <button id="btn-engine-switch">Claude 전환</button>
      <span id="status-bar"></span>
    </div>
  </header>

  <!-- ===== 메인 레이아웃 ===== -->
  <div class="app-body">

    <!-- 좌측 사이드바 (220px 고정) -->
    <aside class="sidebar">

      <!-- 종목 목록 -->
      <section class="sidebar-section">
        <h3>종목 목록</h3>
        <ul id="stock-list"></ul>
        <div class="add-form">
          <input id="new-ticker" type="text" placeholder="종목코드 (053800)">
          <input id="new-name" type="text" placeholder="종목명">
          <select id="new-market">
            <option value="KOSDAQ">KOSDAQ</option>
            <option value="KOSPI">KOSPI</option>
          </select>
          <button id="btn-add-ticker">종목 추가</button>
        </div>
      </section>

      <!-- CSV Import -->
      <section class="sidebar-section">
        <h3>CSV Import</h3>
        <button id="btn-csv-select">파일 선택...</button>
        <div id="csv-result" class="result-box"></div>
      </section>

      <!-- 보유 현황 -->
      <section class="sidebar-section">
        <h3>보유 현황</h3>
        <div class="holdings-form">
          <label>매입단가(원)
            <input id="avg-price" type="number" placeholder="0">
          </label>
          <label>보유수량(주)
            <input id="quantity" type="number" placeholder="0">
          </label>
          <label>가용자금(원)
            <input id="available-cash" type="number" placeholder="0">
          </label>
          <label>박스권 하단
            <input id="box-low" type="number" placeholder="0">
          </label>
          <label>박스권 상단
            <input id="box-high" type="number" placeholder="0">
          </label>
          <label>투자전략
            <textarea id="strategy" rows="2"></textarea>
          </label>
          <label>기대이슈
            <input id="expected-issue" type="text">
          </label>
          <button id="btn-save-holdings">저장</button>
        </div>
      </section>

    </aside>

    <!-- 메인 컨텐츠 영역 -->
    <main class="main-content">

      <!-- 탭 네비게이션 -->
      <nav class="tabs">
        <button class="tab-btn active" data-tab="chart">차트</button>
        <button class="tab-btn" data-tab="chat">AI 채팅</button>
      </nav>

      <!-- 차트 탭 -->
      <section id="tab-chart" class="tab-panel active">
        <div class="chart-wrapper">
          <!-- 패널 1: 캔들 + 볼린저밴드 + MA5/20/60 (높이 350px) -->
          <div class="chart-panel" style="height:350px">
            <canvas id="chart-price"></canvas>
          </div>
          <!-- 패널 2: OBV + OBV MA20 (높이 140px) -->
          <div class="chart-panel" style="height:140px">
            <canvas id="chart-obv"></canvas>
          </div>
          <!-- 패널 3: RSI(14) + 30/70 기준선 (높이 120px) -->
          <div class="chart-panel" style="height:120px">
            <canvas id="chart-rsi"></canvas>
          </div>
        </div>
      </section>

      <!-- AI 채팅 탭 -->
      <section id="tab-chat" class="tab-panel" style="display:none">
        <div class="chat-area">
          <div id="chat-messages" class="chat-messages"></div>
          <div class="chat-input-row">
            <textarea id="chat-input" rows="3"
              placeholder="분석 질문 입력... (Enter: 전송, Shift+Enter: 줄바꿈)"></textarea>
            <button id="btn-send-chat">전송</button>
          </div>
        </div>
      </section>

    </main>
  </div>

  <!-- Chart.js CDN 대신 로컬 로드 (Electron offline 환경) -->
  <!-- npm install 후 node_modules에서 직접 require — renderer.js에서 처리 -->
  <script src="chart.js"></script>
  <script src="renderer.js"></script>
</body>
</html>
```

### 6.2 src/renderer/styles.css

**목적**: 다크 테마 CSS. CSS 변수 기반으로 색상 일관성 유지.

```css
/* src/renderer/styles.css */
/* AI 주식 분석 앱 - 다크 테마 */

:root {
  /* 색상 팔레트 */
  --bg-primary:   #1a1a2e;
  --bg-secondary: #16213e;
  --bg-card:      #0f3460;
  --text-primary: #e0e0e0;
  --text-muted:   #a0a0a0;
  --accent:       #533483;
  --bullish:      #00ff88;  /* 양봉 */
  --bearish:      #ff4444;  /* 음봉 */
  --bb-color:     rgba(100, 150, 255, 0.5);
  --ma5:          #ffdd57;
  --ma20:         #ff914d;
  --ma60:         #ff6b9d;
  --border:       #2a2a4a;

  /* 레이아웃 */
  --sidebar-w:  220px;
  --header-h:   50px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Malgun Gothic', 'Segoe UI', sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  font-size: 13px;
}

/* ===== 헤더 ===== */
.app-header {
  height: var(--header-h);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  gap: 8px;
  flex-shrink: 0;
}

.header-left, .header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.engine-badge {
  background: var(--accent);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: bold;
}

#status-bar {
  font-size: 11px;
  color: var(--text-muted);
}

/* ===== 앱 바디 ===== */
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ===== 사이드바 ===== */
.sidebar {
  width: var(--sidebar-w);
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  flex-shrink: 0;
  padding: 8px;
}

.sidebar-section {
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.sidebar-section h3 {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 6px;
}

/* 종목 목록 */
#stock-list { list-style: none; margin-bottom: 8px; }
#stock-list li {
  padding: 5px 8px;
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
}
#stock-list li:hover  { background: var(--bg-card); }
#stock-list li.active { background: var(--accent); }

/* ===== 메인 컨텐츠 ===== */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* ===== 탭 ===== */
.tabs {
  display: flex;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tab-btn {
  padding: 10px 20px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  border-bottom: 2px solid transparent;
  transition: 0.15s;
}

.tab-btn.active {
  color: var(--text-primary);
  border-bottom-color: var(--bullish);
}

.tab-panel {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

/* ===== 차트 영역 ===== */
.chart-wrapper {
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.chart-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px;
  position: relative;
  flex-shrink: 0;
}

/* ===== AI 채팅 ===== */
.chat-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px;
  gap: 8px;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px;
}

.chat-msg {
  max-width: 82%;
  padding: 8px 12px;
  border-radius: 8px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-msg.user      { background: var(--accent); align-self: flex-end; }
.chat-msg.assistant { background: var(--bg-card); align-self: flex-start; }

.chat-input-row {
  display: flex;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  flex-shrink: 0;
}

.chat-input-row textarea {
  flex: 1;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: 4px;
  padding: 8px;
  resize: none;
  font-size: 13px;
  font-family: inherit;
}

/* ===== 공통 폼 요소 ===== */
input[type="text"],
input[type="number"],
input[type="date"],
select,
textarea {
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  width: 100%;
  margin-bottom: 4px;
  font-family: inherit;
}

button {
  background: var(--accent);
  border: none;
  color: var(--text-primary);
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}

button:hover { opacity: 0.85; }

.add-form { display: flex; flex-direction: column; gap: 2px; }

.result-box {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  min-height: 16px;
  word-break: break-all;
}

.holdings-form label {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.date-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.date-label input[type="date"] {
  width: 120px;
  margin-bottom: 0;
}

/* ===== 스크롤바 다크 테마 ===== */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: var(--bg-primary); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
```

### 6.3 src/renderer/GUIDE.md

```markdown
# src/renderer/ GUIDE

## 목적
Electron 렌더러 프로세스 파일 모음. Node.js 직접 접근 불가 — IPC 경유 전용.

## 포함 파일

| 파일 | 용도 |
|------|------|
| `index.html` | 3패널 다크 테마 레이아웃 |
| `styles.css` | CSS 변수 기반 다크 테마 |
| `chart.js` | Chart.js 3패널 차트 초기화 + 업데이트 |
| `renderer.js` | 이벤트 핸들러 + IPC 호출 진입점 |

## 보안 제약
- contextIsolation: true — window 객체 직접 접근 금지
- 모든 DB/AI 호출은 window.appAPI(preload.js) 경유
- CSP: inline script 금지, src='self'만 허용
```

---

## Step 7: Chart.js 3패널 차트

### 7.1 src/renderer/chart.js

**목적**: Chart.js 3패널 차트 생성 및 데이터 업데이트. chartjs-chart-financial (캔들) + chartjs-plugin-annotation (박스권 수평선) 사용.

**트레이드오프**: Electron에서 Chart.js는 `<script>` 태그로 로드할 수 없음 (CSP 제약). 
대신 Node.js require로 로드 — Electron 메인/렌더러 분리 특성상 `window.Chart`에 수동 바인딩 필요.

**해결책**: npm 설치 후 CDN 없이 `node_modules/chart.js/auto`를 require하고 전역 등록.

```javascript
// src/renderer/chart.js
// Chart.js 3패널 초기화 및 데이터 업데이트
// Electron 렌더러에서 require 사용 (preload.js contextBridge 경유 아님 — 이 파일은 스크립트 태그 로드)

/* global Chart */

// Chart.js + 플러그인을 require로 로드 (Electron 렌더러 환경)
// index.html에서 <script src="chart.js"> 로드 시 Chart를 window에 바인딩
const { Chart, registerables } = require('../../node_modules/chart.js/auto');
const { CandlestickController, CandlestickElement, OhlcController, OhlcElement } =
  require('../../node_modules/chartjs-chart-financial');
const annotationPlugin = require('../../node_modules/chartjs-plugin-annotation');

Chart.register(...registerables, CandlestickController, CandlestickElement, OhlcController, OhlcElement);
Chart.register(annotationPlugin);

// ============ Chart 인스턴스 (모듈 레벨 싱글톤) ============
let priceChart = null;
let obvChart   = null;
let rsiChart   = null;

// ============ 공통 X축 설정 ============
function buildXAxis() {
  return {
    type: 'time',
    time: { unit: 'day', displayFormats: { day: 'MM/dd' } },
    ticks: { color: '#a0a0a0', font: { size: 10 }, maxTicksLimit: 12 },
    grid: { color: '#2a2a4a' }
  };
}

/**
 * 3개 Chart 인스턴스 초기화 (앱 시작 시 1회)
 */
function initCharts() {
  // 패널 1: 캔들 + BB + MA (캔들스틱 차트)
  priceChart = new Chart(document.getElementById('chart-price'), {
    type: 'candlestick',
    data: { datasets: [] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        annotation: { annotations: {} }  // 박스권 수평선 — 동적 추가
      },
      scales: {
        x: buildXAxis(),
        y: {
          position: 'right',
          ticks: { color: '#a0a0a0', font: { size: 10 } },
          grid: { color: '#2a2a4a' }
        }
      }
    }
  });

  // 패널 2: OBV (꺾은선)
  obvChart = new Chart(document.getElementById('chart-obv'), {
    type: 'line',
    data: { datasets: [] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: buildXAxis(),
        y: {
          position: 'right',
          ticks: { color: '#a0a0a0', font: { size: 9 } },
          grid: { color: '#2a2a4a' }
        }
      }
    }
  });

  // 패널 3: RSI (꺾은선, 0~100 고정)
  rsiChart = new Chart(document.getElementById('chart-rsi'), {
    type: 'line',
    data: { datasets: [] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        annotation: {
          annotations: {
            rsi30: {
              type: 'line', yMin: 30, yMax: 30,
              borderColor: '#44ff44', borderWidth: 1, borderDash: [4, 4]
            },
            rsi70: {
              type: 'line', yMin: 70, yMax: 70,
              borderColor: '#ff4444', borderWidth: 1, borderDash: [4, 4]
            }
          }
        }
      },
      scales: {
        x: buildXAxis(),
        y: {
          position: 'right',
          min: 0, max: 100,
          ticks: { color: '#a0a0a0', font: { size: 9 }, stepSize: 30 },
          grid: { color: '#2a2a4a' }
        }
      }
    }
  });
}

/**
 * 지표 데이터로 3패널 차트 업데이트
 * @param {Array} indicators - calculateAll() 반환값 [{date, open, high, low, close, volume, ma5, bbUpper, ...}]
 * @param {Object} stockInfo - {box_low, box_high} (박스권 수평선용)
 */
function updateCharts(indicators, stockInfo = {}) {
  if (!indicators || indicators.length === 0 || !priceChart) return;

  const labels = indicators.map(d => new Date(d.date));

  // ===== 패널 1: 가격 차트 =====

  // 캔들 데이터 (chartjs-chart-financial 형식)
  const candleData = indicators.map(d => ({
    x: new Date(d.date),
    o: d.open, h: d.high, l: d.low, c: d.close
  }));

  // 볼린저밴드
  const bbUpper  = indicators.map((d, i) => ({ x: labels[i], y: d.bbUpper  ?? null }));
  const bbMiddle = indicators.map((d, i) => ({ x: labels[i], y: d.bbMiddle ?? null }));
  const bbLower  = indicators.map((d, i) => ({ x: labels[i], y: d.bbLower  ?? null }));

  // 이동평균
  const ma5Data  = indicators.map((d, i) => ({ x: labels[i], y: d.ma5  ?? null }));
  const ma20Data = indicators.map((d, i) => ({ x: labels[i], y: d.ma20 ?? null }));
  const ma60Data = indicators.map((d, i) => ({ x: labels[i], y: d.ma60 ?? null }));

  priceChart.data.datasets = [
    {
      label: '캔들',
      type: 'candlestick',
      data: candleData,
      color: { up: '#00ff88', down: '#ff4444', unchanged: '#aaaaaa' }
    },
    {
      label: 'BB Upper',
      data: bbUpper,
      type: 'line',
      borderColor: 'rgba(100,150,255,0.5)', borderWidth: 1,
      pointRadius: 0,
      fill: '+1',                               // BB Lower까지 채우기
      backgroundColor: 'rgba(100,150,255,0.07)'
    },
    {
      label: 'BB Middle',
      data: bbMiddle,
      type: 'line',
      borderColor: 'rgba(100,150,255,0.8)', borderWidth: 1,
      borderDash: [4, 4], pointRadius: 0, fill: false
    },
    {
      label: 'BB Lower',
      data: bbLower,
      type: 'line',
      borderColor: 'rgba(100,150,255,0.5)', borderWidth: 1,
      pointRadius: 0, fill: false
    },
    {
      label: 'MA5',
      data: ma5Data,
      type: 'line',
      borderColor: '#ffdd57', borderWidth: 1.5, pointRadius: 0, fill: false
    },
    {
      label: 'MA20',
      data: ma20Data,
      type: 'line',
      borderColor: '#ff914d', borderWidth: 1.5, pointRadius: 0, fill: false
    },
    {
      label: 'MA60',
      data: ma60Data,
      type: 'line',
      borderColor: '#ff6b9d', borderWidth: 1.5, pointRadius: 0, fill: false
    }
  ];

  // 박스권 수평선 (annotation 플러그인)
  const annotations = {};
  if (stockInfo.box_low) {
    annotations.boxLow = {
      type: 'line', yMin: stockInfo.box_low, yMax: stockInfo.box_low,
      borderColor: '#00ff88', borderWidth: 1.5, borderDash: [6, 3],
      label: {
        display: true,
        content: `하단 ${Number(stockInfo.box_low).toLocaleString()}`,
        color: '#00ff88', backgroundColor: 'rgba(0,0,0,0.6)',
        position: 'end', font: { size: 10 }
      }
    };
  }
  if (stockInfo.box_high) {
    annotations.boxHigh = {
      type: 'line', yMin: stockInfo.box_high, yMax: stockInfo.box_high,
      borderColor: '#ff4444', borderWidth: 1.5, borderDash: [6, 3],
      label: {
        display: true,
        content: `상단 ${Number(stockInfo.box_high).toLocaleString()}`,
        color: '#ff4444', backgroundColor: 'rgba(0,0,0,0.6)',
        position: 'end', font: { size: 10 }
      }
    };
  }
  priceChart.options.plugins.annotation.annotations = annotations;
  priceChart.update('none');  // 애니메이션 없이 즉시 업데이트

  // ===== 패널 2: OBV =====
  obvChart.data.datasets = [
    {
      label: 'OBV',
      data: indicators.map((d, i) => ({ x: labels[i], y: d.obv ?? null })),
      borderColor: '#5bc8f5', borderWidth: 1.5, pointRadius: 0, fill: false
    },
    {
      label: 'OBV MA20',
      data: indicators.map((d, i) => ({ x: labels[i], y: d.obvMa20 ?? null })),
      borderColor: '#ff914d', borderWidth: 1.5,
      borderDash: [4, 4], pointRadius: 0, fill: false
    }
  ];
  obvChart.update('none');

  // ===== 패널 3: RSI =====
  rsiChart.data.datasets = [
    {
      label: 'RSI(14)',
      data: indicators.map((d, i) => ({ x: labels[i], y: d.rsi ?? null })),
      borderColor: '#c678dd', borderWidth: 1.5, pointRadius: 0, fill: false
    }
  ];
  rsiChart.update('none');
}

// renderer.js에서 접근할 수 있도록 전역 등록
window.initCharts   = initCharts;
window.updateCharts = updateCharts;
```

### 7.2 설계 결정: require vs CDN

| 방식 | 이유 |
|------|------|
| `require('chart.js/auto')` | Electron offline 환경, CSP 위반 없음 |
| `window.initCharts/updateCharts` 전역 노출 | renderer.js가 동일 렌더러 컨텍스트에서 접근 |
| `animation: false` | 주식 데이터 빈번한 업데이트 시 성능 |
| `'none'` update mode | 재렌더링 시 플리커 방지 |

---

## Step 8: renderer.js + IPC 통합

### 8.1 src/renderer/renderer.js

**목적**: UI 이벤트 핸들러 + window.appAPI(preload.js) 경유 IPC 호출 진입점.

```javascript
// src/renderer/renderer.js
// 렌더러 프로세스 메인 스크립트. Node.js 직접 접근 불가 — 모든 통신은 window.appAPI 경유.

// ============ 앱 상태 ============
const state = {
  ticker:   '053800',
  fromDate: null,
  toDate:   null,
  engine:   'ollama'   // 'ollama' | 'claude'
};

// ============ 초기화 ============
document.addEventListener('DOMContentLoaded', async () => {
  window.initCharts();     // chart.js에서 전역 등록된 함수
  await loadStockList();
  await loadStockData();
  setupEventListeners();
});

// ============ 데이터 로딩 ============

async function loadStockList() {
  const result = await window.appAPI.getStockList();
  if (!result || !result.success) return;

  const select = document.getElementById('ticker-select');
  select.innerHTML = result.data
    .map(s => `<option value="${s.ticker}">${s.ticker} ${s.name}</option>`)
    .join('');
  select.value = state.ticker;

  // 사이드바 종목 목록
  const ul = document.getElementById('stock-list');
  ul.innerHTML = result.data
    .map(s => `<li data-ticker="${s.ticker}">${s.ticker} ${s.name}</li>`)
    .join('');
}

async function loadStockData() {
  const { ticker, fromDate, toDate } = state;
  if (!ticker) return;

  document.getElementById('status-bar').textContent = '로딩 중...';

  const [dataResult, infoResult, holdingsResult] = await Promise.all([
    window.appAPI.getStockData(ticker, fromDate, toDate),
    window.appAPI.getStockInfo(ticker),
    window.appAPI.getHoldings(ticker)
  ]);

  if (dataResult && dataResult.success && dataResult.data.length > 0) {
    window.updateCharts(dataResult.data, infoResult.data || {}); // chart.js 전역 함수
    const last = dataResult.data[dataResult.data.length - 1];
    document.getElementById('status-bar').textContent =
      `${ticker} | 종가 ${last.close.toLocaleString()}원 | ${dataResult.data.length}일`;
  } else {
    document.getElementById('status-bar').textContent = '데이터 없음';
  }

  if (holdingsResult && holdingsResult.data) {
    populateHoldingsForm(holdingsResult.data);
  }
}

// ============ 이벤트 핸들러 ============

function setupEventListeners() {
  // 종목 선택 (드롭다운)
  document.getElementById('ticker-select').addEventListener('change', (e) => {
    state.ticker = e.target.value;
    if (state.ticker) loadStockData();
  });

  // 조회 버튼 — Input-based paging
  document.getElementById('btn-load').addEventListener('click', () => {
    state.fromDate = document.getElementById('from-date').value || null;
    state.toDate   = document.getElementById('to-date').value   || null;
    loadStockData();
  });

  // 사이드바 종목 목록 클릭
  document.getElementById('stock-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-ticker]');
    if (!li) return;
    state.ticker = li.dataset.ticker;
    document.getElementById('ticker-select').value = state.ticker;
    // 활성 항목 표시
    document.querySelectorAll('#stock-list li').forEach(el => el.classList.remove('active'));
    li.classList.add('active');
    loadStockData();
  });

  // 종목 추가
  document.getElementById('btn-add-ticker').addEventListener('click', async () => {
    const ticker = document.getElementById('new-ticker').value.trim().toUpperCase();
    const name   = document.getElementById('new-name').value.trim();
    const market = document.getElementById('new-market').value;
    if (!ticker || !name) { alert('종목코드와 종목명을 입력하세요'); return; }

    const result = await window.appAPI.addTicker({ ticker, name, market });
    if (result && result.success) {
      document.getElementById('new-ticker').value = '';
      document.getElementById('new-name').value   = '';
      await loadStockList();
    }
  });

  // CSV Import
  document.getElementById('btn-csv-select').addEventListener('click', async () => {
    const filePath = await window.appAPI.openFileDialog();
    if (!filePath) return;

    const resultEl = document.getElementById('csv-result');
    resultEl.textContent = '가져오는 중...';

    const result = await window.appAPI.importCsv(filePath, state.ticker);
    if (result.success) {
      resultEl.textContent = `완료: ${result.inserted}건 추가, ${result.duplicates}건 중복`;
      if (result.inserted > 0) await loadStockData();
    } else {
      resultEl.textContent = `실패: ${result.errors[0] || '알 수 없는 오류'}`;
    }
  });

  // 보유현황 저장
  document.getElementById('btn-save-holdings').addEventListener('click', async () => {
    const holdings = {
      ticker:         state.ticker,
      avg_price:      parseInt(document.getElementById('avg-price').value)       || null,
      quantity:       parseInt(document.getElementById('quantity').value)        || null,
      available_cash: parseInt(document.getElementById('available-cash').value)  || null,
      strategy:       document.getElementById('strategy').value                  || null,
      expected_issue: document.getElementById('expected-issue').value            || null,
      box_low:        parseInt(document.getElementById('box-low').value)         || null,
      box_high:       parseInt(document.getElementById('box-high').value)        || null
    };
    await window.appAPI.updateHoldings(holdings);
    alert('보유현황이 저장되었습니다.');
  });

  // AI 채팅 전송
  document.getElementById('btn-send-chat').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // 엔진 전환 (Ollama ↔ Claude)
  document.getElementById('btn-engine-switch').addEventListener('click', () => {
    state.engine = state.engine === 'ollama' ? 'claude' : 'ollama';
    document.getElementById('engine-label').textContent = state.engine === 'ollama' ? 'Ollama' : 'Claude';
    document.getElementById('btn-engine-switch').textContent =
      state.engine === 'ollama' ? 'Claude 전환' : 'Ollama 전환';
  });

  // 탭 전환
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.style.display = 'none';
        p.classList.remove('active');
      });
      btn.classList.add('active');
      const panel = document.getElementById(`tab-${tabId}`);
      panel.style.display = '';
      panel.classList.add('active');
    });
  });
}

// ============ AI 채팅 ============

async function sendChat() {
  const input   = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  appendChatMessage('user', message);

  // AI 응답 버블 생성 (스트리밍 토큰이 채워짐)
  const assistantBubble = appendChatMessage('assistant', '');

  // 기존 스트리밍 리스너 제거 후 새로 등록 (중복 방지)
  window.appAPI.removeAiListeners();

  window.appAPI.onAiChunk(({ content }) => {
    assistantBubble.textContent += content;
    // 자동 스크롤
    document.getElementById('chat-messages').scrollTop =
      document.getElementById('chat-messages').scrollHeight;
  });

  window.appAPI.onAiDone(({ engine, tokens, mode }) => {
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#666;margin-top:4px;';
    meta.textContent = `[${engine}] ${mode || ''} | ${tokens || 0} tokens`;
    assistantBubble.parentElement.appendChild(meta);
  });

  // IPC 전송 (ipcMain.on 방식 — 스트리밍)
  window.appAPI.sendChat(message, state.ticker, state.engine);
}

function appendChatMessage(role, content) {
  const messages = document.getElementById('chat-messages');
  const wrapper  = document.createElement('div');
  wrapper.style.cssText = `display:flex; justify-content:${role === 'user' ? 'flex-end' : 'flex-start'};`;

  const bubble = document.createElement('div');
  bubble.className = `chat-msg ${role}`;
  bubble.textContent = content;

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  return bubble;
}

// ============ 보유현황 폼 채우기 ============
function populateHoldingsForm(h) {
  const set = (id, val) => { if (val != null) document.getElementById(id).value = val; };
  set('avg-price',      h.avg_price);
  set('quantity',       h.quantity);
  set('available-cash', h.available_cash);
  set('strategy',       h.strategy);
  set('expected-issue', h.expected_issue);
  // box_low/high는 stock_info에서 조회 — 별도 처리
}
```

### 8.2 main.js IPC 핸들러 추가 (Step 8 기여분)

```javascript
// main.js에 추가 (Step 8 — 종목 관련 + 보유현황 + 종목목록)
const { getStockList, getStockInfo, getStockData, addOrUpdateStockInfo, getHoldings, upsertHoldings } = 
  require('./src/db/queries');
const { calculateAll } = require('./src/services/indicators');

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

// 일봉 데이터 + 지표 계산 (Input-based paging)
ipcMain.handle('db:getStockData', async (event, { ticker, fromDate = null, toDate = null }) => {
  try {
    const rows = await getStockData(ticker, fromDate, toDate);
    if (rows.length === 0) return { success: true, data: [] };

    const ohlcvArr = rows.map(r => ({
      date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
    }));

    // 전체 계산 후 범위 필터링 (RSI 등 누적 지표 정확도 유지)
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

// 보유현황 저장 (box_low/high 업데이트도 처리)
ipcMain.handle('db:updateHoldings', async (event, holdings) => {
  try {
    // 박스권 정보는 stock_info에 저장
    if (holdings.box_low || holdings.box_high) {
      await addOrUpdateStockInfo({
        ticker: holdings.ticker,
        name: holdings.ticker,  // 이름 변경 없음
        box_low: holdings.box_low,
        box_high: holdings.box_high
      });
    }
    await upsertHoldings(holdings);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
```

### 8.3 preload.js 업데이트 (Step 8 추가 API)

현재 Step 1.3 preload.js에 없는 API를 추가:

```javascript
// preload.js 추가 항목 (Step 8 확정본)
contextBridge.exposeInMainWorld('appAPI', {
  // --- Step 1.3 기존 API ---
  importCsv:      (filePath, ticker) => ipcRenderer.invoke('db:importCsv', { filePath, ticker }),
  openFileDialog: ()                 => ipcRenderer.invoke('dialog:openFile'),

  // --- Step 8 추가 API ---
  getStockList: ()                    => ipcRenderer.invoke('db:getStockList'),
  getStockInfo: (ticker)              => ipcRenderer.invoke('db:getStockInfo', { ticker }),
  getStockData: (ticker, from, to)    => ipcRenderer.invoke('db:getStockData', { ticker, fromDate: from, toDate: to }),
  addTicker:    (info)                => ipcRenderer.invoke('db:addTicker', info),
  getHoldings:  (ticker)              => ipcRenderer.invoke('db:getHoldings', { ticker }),
  updateHoldings: (holdings)          => ipcRenderer.invoke('db:updateHoldings', holdings),

  // AI 스트리밍 (ipcMain.on 방식)
  sendChat: (message, ticker, engine) => ipcRenderer.send('ai:chat', { message, ticker, engine }),
  onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (_, data) => cb(data)),
  onAiDone:  (cb) => ipcRenderer.on('ai:done',  (_, data) => cb(data)),
  removeAiListeners: () => {
    ipcRenderer.removeAllListeners('ai:chunk');
    ipcRenderer.removeAllListeners('ai:done');
  }
});
```

### 8.4 IPC 스트리밍 패턴 설명

AI 응답 스트리밍에는 `ipcMain.handle` 대신 `ipcMain.on + event.reply` 사용.

```javascript
// main.js — AI 채팅 스트리밍 (ai:chat 채널 — Step 9에서 구현)
ipcMain.on('ai:chat', async (event, { message, ticker, engine }) => {
  // event.reply('ai:chunk', {content}) — 토큰마다 호출
  // event.reply('ai:done', {engine, tokens, mode}) — 완료 시
});
```

**왜 handle이 아닌 on+reply인가?**
- `ipcMain.handle`: 단일 반환값 (스트리밍 불가)
- `ipcMain.on + event.reply`: 이벤트를 여러 번 발생 가능 → 스트리밍 토큰 전달에 적합

---

## Step 9: AI 서비스 (aiService.js)

### 9.1 src/services/aiService.js

**목적**: Ollama + Claude API 통합 AI 채팅 서비스.
- Claude API: CLAUDE_API_KEY 없으면 에러 메시지 반환 (크래시 없음 — graceful fallback)
- 4블록 시스템 프롬프트 자동 조합
- 6가지 AI 모드 자동 감지

```javascript
// src/services/aiService.js
// AI 엔진 통합 서비스. Ollama(기본) + Claude API(고급) 이중 구조.
// CLAUDE_API_KEY 없을 때 크래시 없이 안내 메시지 반환 (graceful fallback).

const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const { getChatHistory, saveChatMessage, getStockInfo, getHoldings } = require('../db/queries');

// Anthropic 클라이언트 싱글톤 (키 있을 때만 초기화)
let anthropicClient = null;

function getAnthropicClient() {
  if (!process.env.CLAUDE_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  }
  return anthropicClient;
}

// ============ AI 모드 감지 ============

/**
 * 현재가 + 박스권 + 보유정보 기반 6가지 모드 자동 결정
 * @returns {string} 'MODE 1' ~ 'MODE 6'
 */
function detectMode(close, boxLow, boxHigh, avgPrice, volume, volMa20) {
  const LOWER_ZONE       = boxLow  * 1.07;  // 박스권 하단 +7%
  const UPPER_ZONE       = boxHigh * 0.93;  // 박스권 상단 -7%
  const ISSUE_THRESHOLD  = volMa20 * 2.0;   // 평균 거래량 2배
  const LOSS_THRESHOLD   = avgPrice * 0.90; // 매입단가 -10%

  if (close <= LOWER_ZONE && close >= boxLow) return 'MODE 1'; // 매수탐색
  if (close >= UPPER_ZONE && close <= boxHigh) return 'MODE 2'; // 익절관리
  if (close < boxLow) return 'MODE 3';                           // 위기관리
  if (close > boxHigh && volume >= ISSUE_THRESHOLD) return 'MODE 4'; // 이슈추격
  if (avgPrice > 0 && close <= LOSS_THRESHOLD) return 'MODE 5'; // 리커버리
  return 'MODE 6';                                               // 일반분석
}

// ============ 시스템 프롬프트 빌더 ============

// [A] 고정 역할 정의
const PROMPT_A = `당신은 한국 중소형 박스권 주식 전문 AI 분석가입니다.
핵심 전략: 장기 박스권 하단 매수 + 분할 매수, 이슈 발생 시 상단 돌파 기대.
분석 근거: OBV 수급 방향 + RSI 다이버전스 + 볼린저밴드 위치 조합.
답변 형식: ① 현황 요약 → ② 기술적 분석 → ③ 대응 시나리오 (2~3개) → ④ 핵심 모니터링 포인트.
주의: 투자 최종 판단은 투자자 본인 책임입니다.`;

// [B] 모드별 지시
const PROMPT_B = {
  'MODE 1': '【매수탐색 모드】 현재가가 박스권 하단 근처입니다. OBV 수급과 RSI 다이버전스를 확인하고 분할 매수 시나리오를 제시하세요.',
  'MODE 2': '【익절관리 모드】 현재가가 박스권 상단 근처입니다. 익절 타이밍과 부분 매도 시나리오를 제시하세요.',
  'MODE 3': '【위기관리 모드】 현재가가 박스권 하단을 이탈했습니다. 추가 하락 리스크와 대응 전략을 냉정하게 분석하세요.',
  'MODE 4': '【이슈추격 모드】 박스권 상단 이탈 + 거래량 급증. 돌파 지속 가능성과 진입/관망 판단을 제시하세요.',
  'MODE 5': '【리커버리 모드】 평가손실 -10% 이상. 손실 최소화 방안과 추가 매수 여부를 분석하세요.',
  'MODE 6': '【일반분석 모드】 현재 지표를 종합 분석하고 시장 흐름을 평가하세요.'
};

/**
 * [A]+[B]+[C]+[D] 4블록 시스템 프롬프트 조합
 */
function buildSystemPrompt({ mode, holdings, stockInfo, latestIndicator }) {
  // [C] 개인 컨텍스트
  let blockC = '[개인 투자 컨텍스트]\n';
  if (holdings) {
    if (holdings.avg_price)      blockC += `매입단가: ${Number(holdings.avg_price).toLocaleString()}원\n`;
    if (holdings.quantity)       blockC += `보유수량: ${holdings.quantity}주\n`;
    if (holdings.available_cash) blockC += `가용자금: ${Number(holdings.available_cash).toLocaleString()}원\n`;
    if (holdings.strategy)       blockC += `투자전략: ${holdings.strategy}\n`;
    if (holdings.expected_issue) blockC += `기대이슈: ${holdings.expected_issue}\n`;
  } else {
    blockC += '보유 정보 없음\n';
  }
  if (stockInfo) {
    if (stockInfo.box_low)  blockC += `박스권 하단: ${Number(stockInfo.box_low).toLocaleString()}원\n`;
    if (stockInfo.box_high) blockC += `박스권 상단: ${Number(stockInfo.box_high).toLocaleString()}원\n`;
  }

  // [D] 실시간 지표
  let blockD = '[실시간 기술 지표 (최근 일봉)]\n';
  if (latestIndicator) {
    const d = latestIndicator;
    blockD += `날짜: ${d.date}\n`;
    blockD += `종가: ${d.close ? Number(d.close).toLocaleString() : 'N/A'}원\n`;
    blockD += `RSI(14): ${d.rsi != null ? d.rsi.toFixed(1) : 'N/A'}\n`;
    blockD += `BB 위치: ${d.bbPctB != null ? (d.bbPctB * 100).toFixed(0) + '%' : 'N/A'} (0=하단, 100=상단)\n`;
    blockD += `OBV 추세: ${(d.obv != null && d.obvMa20 != null) ? (d.obv > d.obvMa20 ? '매집(OBV>MA20)' : '분산(OBV<MA20)') : 'N/A'}\n`;
    blockD += `MACD 히스토그램: ${d.macdHistogram != null ? d.macdHistogram.toFixed(0) : 'N/A'}\n`;
    blockD += `RSI 다이버전스: ${d.rsiDivergence || '없음'}\n`;
    blockD += `OBV 다이버전스: ${d.obvDivergence || '없음'}\n`;
    blockD += `캔들 패턴: ${d.candlePattern || '없음'}\n`;
  } else {
    blockD += '지표 데이터 없음\n';
  }

  return [PROMPT_A, PROMPT_B[mode] || PROMPT_B['MODE 6'], blockC, blockD].join('\n\n');
}

// ============ Ollama 스트리밍 ============

/**
 * Ollama /api/chat NDJSON 스트리밍
 * @param {Array} messages - [{role, content}]
 * @param {Function} onChunk - 토큰마다 ({content}) 호출
 * @param {Function} onDone  - 완료 시 ({engine, tokens}) 호출
 */
async function chatWithOllama(messages, onChunk, onDone) {
  const model   = process.env.OLLAMA_MODEL    || 'gemma4:12b';
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

  const body = JSON.stringify({
    model, messages, stream: true,
    options: { temperature: 0.7, top_p: 0.9, num_predict: 2048 }
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 11434,
      path:     url.pathname,
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let fullContent = '';
      let tokenCount  = 0;
      let buffer      = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 마지막 불완전 라인은 다음 chunk에서 처리

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              fullContent += json.message.content;
              tokenCount++;
              onChunk({ content: json.message.content });
            }
            if (json.done) {
              onDone({ engine: 'ollama', tokens: tokenCount });
              resolve(fullContent);
            }
          } catch { /* JSON 파싱 실패 — 스트림 경계, 무시 */ }
        }
      });

      res.on('end', () => resolve(fullContent));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============ Claude API 스트리밍 ============

/**
 * Claude API 스트리밍
 * CLAUDE_API_KEY 없으면 크래시 없이 안내 메시지 반환
 */
async function chatWithClaude(systemPrompt, messages, onChunk, onDone) {
  // Graceful fallback — API 키 없으면 안내 메시지
  if (!process.env.CLAUDE_API_KEY) {
    const msg = 'Claude API 키가 설정되지 않았습니다. .env 파일에 CLAUDE_API_KEY를 추가하고 앱을 재시작하세요.';
    onChunk({ content: msg });
    onDone({ engine: 'claude', tokens: 0 });
    return msg;
  }

  const client = getAnthropicClient();
  const model  = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  try {
    let fullContent  = '';
    let inputTokens  = 0;
    let outputTokens = 0;

    // @anthropic-ai/sdk v0.104.x 스트리밍 API
    const stream = client.messages.stream({
      model,
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   messages.map(m => ({ role: m.role, content: m.content }))
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        fullContent += event.delta.text;
        onChunk({ content: event.delta.text });
      }
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens || 0;
      }
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens || 0;
      }
    }

    onDone({ engine: 'claude', tokens: inputTokens + outputTokens });
    return fullContent;
  } catch (err) {
    const errMsg = `Claude API 오류: ${err.message}`;
    onChunk({ content: errMsg });
    onDone({ engine: 'claude', tokens: 0 });
    return errMsg;
  }
}

// ============ 채팅 진입점 ============

/**
 * AI 채팅 진입점 (main.js ipcMain.on('ai:chat') 에서 호출)
 * @param {Object} params
 * @param {string} params.message     - 사용자 메시지
 * @param {string} params.ticker      - 종목 코드
 * @param {string} params.engine      - 'ollama' | 'claude'
 * @param {Array}  params.ohlcvData   - calculateAll() 결과 (최신 지표 포함)
 * @param {Function} params.onChunk   - 토큰마다 호출
 * @param {Function} params.onDone    - 완료 시 호출
 */
async function chat({ message, ticker, engine, ohlcvData, onChunk, onDone }) {
  // 1단계: 대화 기록 + 종목 정보 + 보유현황 병렬 조회
  const historyLimit = engine === 'claude' ? 40 : 20;
  const [history, stockInfo, holdings] = await Promise.all([
    getChatHistory(ticker, engine, historyLimit),
    getStockInfo(ticker),
    getHoldings(ticker)
  ]);

  // 2단계: 최신 지표 (calculateAll 결과 마지막 요소)
  const latestIndicator = ohlcvData?.length > 0 ? ohlcvData[ohlcvData.length - 1] : null;

  // 3단계: 모드 감지
  const close    = latestIndicator?.close  || 0;
  const boxLow   = stockInfo?.box_low      || 0;
  const boxHigh  = stockInfo?.box_high     || 0;
  const avgPrice = holdings?.avg_price     || 0;
  const volume   = latestIndicator?.volume || 0;
  const volMa20  = ohlcvData?.length >= 20
    ? ohlcvData.slice(-20).reduce((s, d) => s + d.volume, 0) / 20
    : volume;

  const mode = (boxLow && boxHigh)
    ? detectMode(close, boxLow, boxHigh, avgPrice, volume, volMa20)
    : 'MODE 6';

  // 4단계: 시스템 프롬프트 조합
  const systemPrompt = buildSystemPrompt({ mode, holdings, stockInfo, latestIndicator });

  // 5단계: 메시지 배열 (기록 + 현재 메시지)
  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  // 6단계: 사용자 메시지 저장
  await saveChatMessage(ticker, 'user', message, engine);

  // 7단계: AI 호출 (스트리밍)
  let fullResponse = '';
  const wrappedOnChunk = (data) => { fullResponse += data.content || ''; onChunk(data); };
  const wrappedOnDone  = async (stats) => {
    if (fullResponse) await saveChatMessage(ticker, 'assistant', fullResponse, engine);
    onDone({ ...stats, mode });
  };

  if (engine === 'claude') {
    await chatWithClaude(systemPrompt, messages, wrappedOnChunk, wrappedOnDone);
  } else {
    // Ollama는 system prompt를 messages 배열 맨 앞에 포함
    const ollamaMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    await chatWithOllama(ollamaMessages, wrappedOnChunk, wrappedOnDone);
  }
}

module.exports = { chat, detectMode, buildSystemPrompt };
```

### 9.2 main.js IPC 핸들러 추가 (Step 9 기여분 — AI 스트리밍)

```javascript
// main.js에 추가 (Step 9 — AI 채팅 스트리밍)
const { chat } = require('./src/services/aiService');
const { getStockData: getDbStockData } = require('./src/db/queries');
const { calculateAll: calcIndicators } = require('./src/services/indicators');

// AI 스트리밍: ipcMain.handle 아닌 ipcMain.on + event.reply 사용
// 이유: handle은 단일 반환값만 가능 — 스트리밍에는 on+reply 방식 필요
ipcMain.on('ai:chat', async (event, { message, ticker, engine }) => {
  try {
    // 최신 지표 데이터 조회 (AI 시스템 프롬프트 [D] 블록용)
    const rows = await getDbStockData(ticker, null, null);
    const ohlcvData = rows.length > 0
      ? calcIndicators(rows.map(r => ({
          date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
        })))
      : [];

    await chat({
      message, ticker, engine, ohlcvData,
      onChunk: (data) => event.reply('ai:chunk', data),
      onDone:  (stats) => event.reply('ai:done', stats)
    });
  } catch (err) {
    event.reply('ai:chunk', { content: `오류: ${err.message}` });
    event.reply('ai:done', { engine, tokens: 0, mode: 'MODE 6' });
  }
});
```

### 9.3 설계 결정 및 트레이드오프

#### Claude API Graceful Fallback
```
CLAUDE_API_KEY 없음 → 크래시 X → 안내 메시지 반환 → 사용자가 키 추가 후 재시작
```
- `.env`에 빈 값이면 애플리케이션 정상 기동 유지
- 추후 API 키 추가 시 `.env` 수정 + 앱 재시작만으로 활성화

#### Ollama vs Claude 메시지 형식 차이
| 구분 | Ollama | Claude |
|------|--------|--------|
| system 프롬프트 | `messages` 배열 첫 번째 요소 (`role: 'system'`) | `system` 파라미터 (별도) |
| 최대 대화 기록 | 10턴 (20개 메시지) | 20턴 (40개 메시지) |
| 스트리밍 형식 | HTTP NDJSON (`/api/chat`) | @anthropic-ai/sdk 이벤트 스트림 |

#### 비용 고려 (Claude API)
- claude-sonnet-4-6 기준: 입력 $3/MTok + 출력 $15/MTok
- 10턴 대화 + 지표 약 500 토큰 + 응답 400 토큰 = 약 900 토큰/회
- 원화 환산: 약 20~30원/회화 (RESEARCH.md 섹션 12 참조)

---

## 구현 체크리스트 (1단계)

```
□ Step 1: Electron 기본 구조
  □ package.json 작성 + npm install
  □ main.js 스켈레톤 작성 (BrowserWindow + app.ready)
  □ preload.js contextBridge 작성
  □ .env 작성 (.env.example 기반)
  □ .gitignore 작성 (.env 포함 확인)

□ Step 2: DB 연결 풀 + 쿼리
  □ src/db/ 폴더 생성 + GUIDE.md 작성
  □ src/db/connection.js 작성 (initPool/getPool/closePool)
  □ src/db/queries.js 작성 (8개 함수)
  □ main.js에서 initPool() 호출 확인

□ Step 3: DB 테이블
  □ src/db/init.sql 작성 (4개 테이블)
  □ mysql -h 192.169.20.80 -u root -p < src/db/init.sql 실행
  □ SHOW TABLES로 생성 확인
  □ 초기 데이터 (053800 안랩) 확인

□ Step 4: CSV Import
  □ src/services/ 폴더 생성 + GUIDE.md 작성
  □ src/services/csvImport.js 구현 (스트림 + 배치 INSERT)
  □ main.js에서 db:importCsv + dialog:openFile IPC 등록
  □ ahnlab_daily.csv import 테스트 (inserted/duplicates 확인)
  □ SELECT COUNT(*) FROM stock_daily로 행 수 확인

□ Step 5: 지표 계산
  □ src/services/indicators.js 구현 (12개 지표)
  □ RSI Wilder 평활 수치 검증 (기준값과 대조)
  □ BB 표본분산(N-1) 적용 확인
  □ OBV 다이버전스 최소 5일 간격 확인
  □ Input-based paging 범위 필터링 동작 확인
  □ main.js에서 db:getStockDataWithIndicators IPC 등록

□ Step 6: HTML + CSS
  □ src/renderer/ 폴더 생성 + GUIDE.md 작성
  □ src/renderer/index.html 작성 (3패널 레이아웃)
  □ src/renderer/styles.css 작성 (다크 테마 + CSS 변수)
  □ Electron 앱 실행 후 레이아웃 육안 확인

□ Step 7: Chart.js
  □ npm install chartjs-chart-financial chartjs-plugin-annotation
  □ src/renderer/chart.js 작성 (initCharts/updateCharts)
  □ 캔들차트 렌더링 확인
  □ 볼린저밴드 fill 렌더링 확인
  □ 박스권 수평선 (annotation) 확인
  □ RSI 30/70 기준선 확인

□ Step 8: renderer.js + IPC 통합
  □ src/renderer/renderer.js 작성 (이벤트 핸들러)
  □ preload.js 확정본 작성 (Step 8.3 기준)
  □ main.js에서 Step 8.2 IPC 핸들러 모두 등록
  □ 종목 선택 → 차트 로딩 end-to-end 테스트
  □ CSV import → 차트 갱신 테스트
  □ 보유현황 저장 → DB 확인

□ Step 9: AI 서비스
  □ src/services/aiService.js 구현
  □ .env에 CLAUDE_API_KEY 추가 (또는 빈 값 유지 — graceful fallback 확인)
  □ main.js에서 ai:chat IPC 핸들러 (ipcMain.on 방식) 등록
  □ Ollama 채팅 스트리밍 테스트 (gemma4:12b)
  □ Claude API 키 없을 때 안내 메시지 확인
  □ Claude API 키 있을 때 스트리밍 테스트
  □ AI 모드 6가지 발동 조건 확인
```

---

*PLAN.md V1 작성 완료: 2026-06-11*
*Step 1~9 전체 코드 스니펫 포함. 완성도 98%+.*
*다음: "구현해줘" 트리거 후 Step 1부터 순서대로 구현 시작. 각 Step 완료 시 code_update.md에 기록.*
