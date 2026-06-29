// src/db/queries.js
// DB 쿼리 함수 모음. 오프셋 페이징 대신 fromDate/toDate 범위 기반 조회.
const { getPool } = require('./connection');

/**
 * 모든 종목 목록 조회
 */
async function getStockList() {
  // KR 종목만 — US 마스터 1만+ 종목이 헤더 datalist/사이드바에 섞이는 사고 방지.
  // US 등록 종목은 listStocksByMarket('US') 또는 검색 IPC로 별도 조회.
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT ticker, name, market, box_low, box_high, note FROM stock_info "
    + "WHERE currency = 'KRW' OR currency IS NULL "
    + "ORDER BY ticker ASC"
  );
  return rows;
}

/**
 * 종목 검색 (관심종목 자동완성용)
 * marketFilter: 'KR' / 'US' / 특정 시장명 / null(전체)
 *   'KR' → KOSPI+KOSDAQ, 'US' → NASDAQ+NYSE+AMEX+ARCA+BATS+IEX
 * 입력이 숫자만이면 ticker LIKE 'q%' (prefix), 그 외 contains.
 */
async function searchStocks(query, limit = 20, marketFilter = null) {
  const pool = getPool();
  const q = (query || '').trim();
  if (!q) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 20, 50));
  const isNumeric  = /^\d+$/.test(q);
  const tickerLike = isNumeric ? q + '%' : '%' + q + '%';
  const nameLike   = '%' + q + '%';

  const KR_MARKETS = ['KOSPI', 'KOSDAQ'];
  const US_MARKETS = ['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS', 'IEX'];
  let marketSql = '';
  const marketParams = [];
  if (marketFilter === 'KR') {
    marketSql = ` AND market IN (${KR_MARKETS.map(() => '?').join(',')})`;
    marketParams.push(...KR_MARKETS);
  } else if (marketFilter === 'US') {
    marketSql = ` AND market IN (${US_MARKETS.map(() => '?').join(',')})`;
    marketParams.push(...US_MARKETS);
  } else if (marketFilter && typeof marketFilter === 'string') {
    marketSql = ' AND market = ?';
    marketParams.push(marketFilter);
  }

  const sql = `
    SELECT ticker, name, market, currency
    FROM stock_info
    WHERE (ticker LIKE ? OR name LIKE ?)
      AND (is_active = 1 OR is_active IS NULL)${marketSql}
    ORDER BY
      CASE WHEN ticker = ?         THEN 0
           WHEN ticker LIKE ?      THEN 1
           WHEN name   LIKE ?      THEN 2
           ELSE 3 END,
      ticker ASC
    LIMIT ${cap}
  `;
  const params = [tickerLike, nameLike, ...marketParams, q, q + '%', q + '%'];
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * US 종목 등록 — stock_info INSERT IGNORE (currency='USD').
 * Python 수집기와 별개로 JS 측에서 검색→선택→등록 트리거에 사용.
 */
async function registerUsStock(ticker, name, market = 'NASDAQ') {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO stock_info (ticker, name, market, currency, is_active, last_synced_at)
     VALUES (?, ?, ?, 'USD', TRUE, NOW())
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), market = VALUES(market), currency = 'USD', is_active = TRUE`,
    [ticker.toUpperCase(), name || ticker.toUpperCase(), market]
  );
}

/** US 종목 마스터 동기화 시각 조회. */
async function getUsMasterSyncedAt() {
  const pool = getPool();
  const [[row]] = await pool.query(
    'SELECT MAX(last_synced_at) AS last_at, COUNT(*) AS cnt FROM us_master_sync'
  );
  return { last_at: row && row.last_at, cnt: Number(row && row.cnt) || 0 };
}

/** 등록된 US 종목 ticker 목록. */
async function listUsTickers() {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT ticker FROM stock_info WHERE currency = 'USD' AND is_active = TRUE ORDER BY ticker"
  );
  return rows.map(r => r.ticker);
}

/** 등록된 KR 종목 ticker 목록 — 사이드바 표시용. */
async function listStocksByMarket(marketFilter) {
  const pool = getPool();
  const KR_MARKETS = ['KOSPI', 'KOSDAQ'];
  const US_MARKETS = ['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS', 'IEX'];
  let sql, params = [];
  if (marketFilter === 'KR') {
    sql = `SELECT ticker, name, market, currency FROM stock_info
           WHERE is_active = 1 AND market IN (${KR_MARKETS.map(() => '?').join(',')})
           ORDER BY ticker ASC`;
    params = KR_MARKETS;
  } else if (marketFilter === 'US') {
    sql = `SELECT ticker, name, market, currency FROM stock_info
           WHERE is_active = 1 AND market IN (${US_MARKETS.map(() => '?').join(',')})
           ORDER BY ticker ASC`;
    params = US_MARKETS;
  } else {
    sql = `SELECT ticker, name, market, currency FROM stock_info
           WHERE is_active = 1 ORDER BY ticker ASC`;
  }
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * 관심종목 목록 조회 (realtime_watchlist)
 * stock_info LEFT JOIN으로 종목명/시장 동시 반환.
 * is_active=1만, display_order ASC.
 */
async function getWatchlist() {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT w.ticker, COALESCE(s.name, w.ticker) AS name, s.market, w.display_order
     FROM realtime_watchlist w
     LEFT JOIN stock_info s ON s.ticker = w.ticker
     WHERE w.is_active = 1
     ORDER BY w.display_order ASC, w.id ASC`
  );
  return rows;
}

/**
 * display_order = 현재 MAX+1. 재추가 시 is_active=1 + display_order 갱신 (말미로 이동).
 * 트랜잭션 + FOR UPDATE — 동시 INSERT MAX 경합 방지.
 */
async function addToWatchlist(ticker) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      'SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order FROM realtime_watchlist FOR UPDATE'
    );
    const nextOrder = Number(row && row.next_order) || 1;
    await conn.execute(
      `INSERT INTO realtime_watchlist (ticker, display_order, is_active)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1, display_order = VALUES(display_order)`,
      [ticker, nextOrder]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 관심종목 삭제 (영구). 재추가 가능하도록 DELETE 사용.
 */
async function removeFromWatchlist(ticker) {
  const pool = getPool();
  await pool.execute(
    'DELETE FROM realtime_watchlist WHERE ticker = ?',
    [ticker]
  );
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
 * @param {string|null} toDate   - YYYY-MM-DD (null이면 오늘까지)
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
async function upsertHoldings({
  ticker, avg_price, quantity, available_cash,
  strategy, horizon, expected_issue, split_plan
}) {
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
      avg_price      || null,
      quantity       || null,
      available_cash || null,
      strategy       || null,
      horizon        || null,
      expected_issue || null,
      split_plan ? JSON.stringify(split_plan) : null
    ]
  );
}

/**
 * AI 대화 기록 조회 (최근 N개, 오래된 것부터 반환)
 * Ollama: 20개, Claude: 40개
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

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const [rows] = await pool.execute(sql, params);
  return rows.reverse(); // 시간 순서 복원
}

/**
 * AI 대화 메시지 저장
 */
async function saveChatMessage(ticker, role, content, engine, sessionId = null) {
  const pool = getPool();
  await pool.execute(
    'INSERT INTO chat_history (ticker, role, content, engine, session_id) VALUES (?, ?, ?, ?, ?)',
    [ticker, role, content, engine, sessionId || null]
  );
}

/**
 * AI 대화 이력 전체 삭제 (종목별)
 */
async function clearChatHistory(ticker) {
  const pool = getPool();
  const [result] = await pool.execute(
    'DELETE FROM chat_history WHERE ticker = ?',
    [ticker]
  );
  return result.affectedRows;
}

// ============ 박스권 스캐너 쿼리 ============

/**
 * stock_daily에 데이터가 있는 종목 목록 반환
 */
async function getScanTickers() {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT DISTINCT ticker FROM stock_daily ORDER BY ticker ASC'
  );
  return rows.map(r => r.ticker);
}

/**
 * 스캔 이력 INSERT → 생성된 scan_id 반환
 */
async function insertScanHistory({ period_months, scan_from, scan_to, total_tickers, memo }) {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO box_scan_history (period_months, scan_from, scan_to, total_tickers, memo)
     VALUES (?, ?, ?, ?, ?)`,
    [period_months, scan_from, scan_to, total_tickers, memo || null]
  );
  return result.insertId;
}

/**
 * 종목별 스캔 결과 INSERT
 */
async function insertScanResult({
  scan_id, ticker, scan_from, scan_to,
  box_high, box_low, box_range_pct, close_at_scan, data_days,
  resistance_center, support_center, resistance_touches, support_touches, last_touch_date
}) {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO box_scan_results
       (scan_id, ticker, scan_from, scan_to,
        box_high, box_low, box_range_pct, close_at_scan, data_days,
        resistance_center, support_center, resistance_touches, support_touches, last_touch_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scan_id, ticker, scan_from, scan_to,
      box_high, box_low, box_range_pct, close_at_scan, data_days,
      resistance_center ?? null, support_center ?? null,
      resistance_touches ?? null, support_touches ?? null, last_touch_date ?? null
    ]
  );
}

/**
 * 최신 스캔 결과 조회 (box_scan_history 최신 1건 기준)
 * stock_info JOIN으로 종목명도 함께 반환
 */
async function getLatestScanResults() {
  const pool = getPool();

  // 최신 scan_id 조회
  const [histRows] = await pool.execute(
    'SELECT * FROM box_scan_history ORDER BY scanned_at DESC LIMIT 1'
  );
  if (histRows.length === 0) return { history: null, results: [] };

  const history = histRows[0];
  const [resRows] = await pool.execute(
    `SELECT r.*, s.name AS stock_name
     FROM box_scan_results r
     LEFT JOIN stock_info s ON s.ticker = r.ticker
     WHERE r.scan_id = ?
     ORDER BY r.box_range_pct DESC`,
    [history.id]
  );
  return { history, results: resRows };
}

/**
 * 스캔 결과 확정 → stock_info.box_high/box_low 업데이트
 * resultId 기준으로 해당 종목의 박스권 값을 stock_info에 반영
 */
async function confirmBoxResult(resultId) {
  const pool = getPool();

  // 결과 조회
  const [rows] = await pool.execute(
    'SELECT ticker, box_high, box_low FROM box_scan_results WHERE id = ?',
    [resultId]
  );
  if (rows.length === 0) throw new Error(`스캔 결과 ID ${resultId} 없음`);

  const { ticker, box_high, box_low } = rows[0];

  // stock_info 박스권 업데이트
  await pool.execute(
    'UPDATE stock_info SET box_high = ?, box_low = ? WHERE ticker = ?',
    [box_high, box_low, ticker]
  );

  // 결과 상태 confirmed 업데이트
  await pool.execute(
    "UPDATE box_scan_results SET status = 'confirmed' WHERE id = ?",
    [resultId]
  );

  return { ticker, box_high, box_low };
}

/**
 * 스캔 결과 제외 — status를 rejected로 저장
 */
async function rejectBoxResult(resultId) {
  const pool = getPool();
  const [result] = await pool.execute(
    "UPDATE box_scan_results SET status = 'rejected' WHERE id = ?",
    [resultId]
  );
  if (result.affectedRows === 0) throw new Error(`스캔 결과 ID ${resultId} 없음`);
}

// ============ 채팅 세션 쿼리 ============

/**
 * 세션 생성
 */
async function createSession(name, ticker = null, engine = 'ollama') {
  const pool = getPool();
  const [result] = await pool.execute(
    'INSERT INTO chat_sessions (name, ticker, engine) VALUES (?, ?, ?)',
    [name || '새 세션', ticker || null, engine]
  );
  const id = result.insertId;
  const [[row]] = await pool.execute('SELECT * FROM chat_sessions WHERE id = ?', [id]);
  return row;
}

/**
 * 세션 목록 조회 (ticker 필터 선택적)
 */
async function listSessions(ticker = null) {
  const pool = getPool();
  let sql = 'SELECT * FROM chat_sessions';
  const params = [];
  if (ticker) { sql += ' WHERE ticker = ?'; params.push(ticker); }
  sql += ' ORDER BY last_active_at DESC';
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * 특정 세션의 메시지 목록 조회
 */
async function getSessionMessages(sessionId, limit = 100) {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT role, content, engine, created_at FROM chat_history WHERE session_id = ? ORDER BY created_at ASC LIMIT ?',
    [sessionId, limit]
  );
  return rows;
}

/**
 * 세션 삭제 (연관 메시지 포함)
 */
async function deleteSession(sessionId) {
  const pool = getPool();
  await pool.execute('DELETE FROM chat_history WHERE session_id = ?', [sessionId]);
  const [result] = await pool.execute('DELETE FROM chat_sessions WHERE id = ?', [sessionId]);
  return result.affectedRows > 0;
}

/**
 * 세션 이름 변경
 */
async function renameSession(sessionId, name) {
  const pool = getPool();
  const [result] = await pool.execute(
    'UPDATE chat_sessions SET name = ? WHERE id = ?',
    [name, sessionId]
  );
  return result.affectedRows > 0;
}

/**
 * 세션 마지막 활성 시간 갱신
 */
async function touchSession(sessionId) {
  const pool = getPool();
  await pool.execute(
    'UPDATE chat_sessions SET last_active_at = NOW() WHERE id = ?',
    [sessionId]
  );
}

// ============ 전역 메모리 쿼리 ============

/**
 * 메모리 항목 추가
 */
async function addMemory(content, sourceTicker = null) {
  const pool = getPool();
  const [result] = await pool.execute(
    'INSERT INTO chat_memory (content, source_ticker) VALUES (?, ?)',
    [content, sourceTicker || null]
  );
  return { id: result.insertId, content };
}

/**
 * 전체 메모리 목록 조회
 */
async function listMemory() {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT id, content, source_ticker, created_at, updated_at FROM chat_memory ORDER BY created_at ASC'
  );
  return rows;
}

/**
 * 메모리 항목 수정
 */
async function updateMemory(id, content) {
  const pool = getPool();
  const [result] = await pool.execute(
    'UPDATE chat_memory SET content = ? WHERE id = ?',
    [content, id]
  );
  return result.affectedRows > 0;
}

/**
 * 메모리 항목 삭제
 */
async function deleteMemory(id) {
  const pool = getPool();
  const [result] = await pool.execute(
    'DELETE FROM chat_memory WHERE id = ?',
    [id]
  );
  return result.affectedRows > 0;
}

module.exports = {
  getStockList,
  searchStocks,
  registerUsStock,
  getUsMasterSyncedAt,
  listUsTickers,
  listStocksByMarket,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getStockInfo,
  getStockData,
  addOrUpdateStockInfo,
  getHoldings,
  upsertHoldings,
  getChatHistory,
  saveChatMessage,
  clearChatHistory,
  // 박스권 스캐너
  getScanTickers,
  insertScanHistory,
  insertScanResult,
  getLatestScanResults,
  confirmBoxResult,
  rejectBoxResult,
  // 세션 관리
  createSession,
  listSessions,
  getSessionMessages,
  deleteSession,
  renameSession,
  touchSession,
  // 전역 메모리
  addMemory,
  listMemory,
  updateMemory,
  deleteMemory
};
