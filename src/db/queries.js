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
async function saveChatMessage(ticker, role, content, engine) {
  const pool = getPool();
  await pool.execute(
    'INSERT INTO chat_history (ticker, role, content, engine) VALUES (?, ?, ?, ?)',
    [ticker, role, content, engine]
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

module.exports = {
  getStockList,
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
  rejectBoxResult
};
