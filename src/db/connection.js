// src/db/connection.js
// mysql2 연결 풀 싱글톤. 앱 시작 시 1회만 초기화.
const mysql = require('mysql2/promise');
require('dotenv').config();

let pool = null;

/**
 * MySQL 연결 풀 초기화 (싱글톤)
 * KST 시간대 설정으로 일봉 날짜 오류 방지
 */
async function initPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT, 10) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    connectionLimit:  10,
    waitForConnections: true,
    connectTimeout:   15000,

    timezone:         '+09:00',    // KST — 일봉 날짜 오류 방지
    dateStrings:      ['DATE'],    // DATE 컬럼 → 'YYYY-MM-DD' 문자열
    multipleStatements: false,     // SQL injection 방지
    enableKeepAlive:  true,
    ssl:              false         // 로컬 네트워크 — SSL 비활성화
  });

  try {
    const connection = await pool.getConnection();
    console.log('MariaDB 연결 성공:', process.env.DB_HOST);
    connection.release();
  } catch (err) {
    console.error('MariaDB 연결 실패:', err.message);
    pool = null;
    throw err;
  }

  return pool;
}

/**
 * 연결 풀 획득
 */
function getPool() {
  if (!pool) throw new Error('Pool not initialized. Call initPool() first.');
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

module.exports = { initPool, getPool, closePool };
