// src/services/csvImport.js
// CSV 파싱 후 stock_daily 테이블에 INSERT IGNORE. 스트림 방식으로 메모리 효율 유지.
const fs       = require('fs');
const readline = require('readline');
const { getPool } = require('../db/connection');

const BATCH_SIZE = 100;

/**
 * CSV 파일을 읽어 stock_daily 테이블에 INSERT IGNORE
 *
 * @param {string} filePath - CSV 파일 경로
 * @param {string} ticker   - 종목 코드 (기본값: '053800')
 * @returns {Promise<{success: boolean, inserted: number, duplicates: number, errors: Array}>}
 */
async function importCsv(filePath, ticker = '053800') {
  const results = { success: false, inserted: 0, duplicates: 0, errors: [] };

  let headerSkipped = false;
  let batch         = [];
  const pool        = getPool();

  // readline 이벤트 루프 내에서 비동기 배치 INSERT가 완료되도록 Promise 배열 관리
  const insertPromises = [];

  return new Promise((resolve) => {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headerSkipped) { headerSkipped = true; return; }

      try {
        const [dateStr, openStr, highStr, lowStr, closeStr, volumeStr] =
          line.split(',').map(v => v.trim());

        const tradeDate = convertDate(dateStr);
        if (!tradeDate) { results.errors.push(`잘못된 날짜: ${dateStr}`); return; }

        const open   = parseInt(openStr,   10);
        const high   = parseInt(highStr,   10);
        const low    = parseInt(lowStr,    10);
        const close  = parseInt(closeStr,  10);
        const volume = parseInt(volumeStr, 10);

        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
          results.errors.push(`숫자 변환 실패: ${line.substring(0, 50)}`);
          return;
        }

        batch.push({ ticker, tradeDate, open, high, low, close, volume });

        if (batch.length >= BATCH_SIZE) {
          const currentBatch = batch;
          batch = [];
          insertPromises.push(executeBatchInsert(pool, currentBatch, results));
        }
      } catch (err) {
        results.errors.push(`행 처리 실패: ${err.message}`);
      }
    });

    rl.on('close', async () => {
      try {
        if (batch.length > 0) {
          insertPromises.push(executeBatchInsert(pool, batch, results));
        }
        await Promise.all(insertPromises);
        results.success = true;
        resolve(results);
      } catch (err) {
        results.errors.push(`최종 처리 실패: ${err.message}`);
        resolve(results);
      }
    });

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
 */
async function executeBatchInsert(pool, batch, results) {
  if (batch.length === 0) return;

  try {
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = [];
    for (const row of batch) {
      values.push(row.ticker, row.tradeDate, row.open, row.high, row.low, row.close, row.volume);
    }

    const sql = `
      INSERT IGNORE INTO stock_daily
        (ticker, trade_date, open, high, low, close, volume)
      VALUES ${placeholders}
    `;

    const [result] = await pool.execute(sql, values);
    results.inserted  += result.affectedRows;
    results.duplicates += batch.length - result.affectedRows;
  } catch (err) {
    results.errors.push(`배치 INSERT 실패: ${err.message}`);
  }
}

/**
 * Date 변환 (YYYYMMDD → YYYY-MM-DD)
 */
function convertDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;

  const year  = dateStr.slice(0, 4);
  const month = dateStr.slice(4, 6);
  const day   = dateStr.slice(6, 8);

  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);

  if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year}-${month}-${day}`;
}

module.exports = { importCsv };
