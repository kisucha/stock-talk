// src/db/connection.js
// mysql2 연결 풀 싱글톤. 앱 시작 시 1회만 초기화.
// initPool() 완료 후 runMigrations() 자동 실행 — 미실행 마이그레이션만 순차 적용
const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');
require('dotenv').config({ quiet: true });

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

  await runMigrations();
  return pool;
}

/**
 * DB 자동 마이그레이션 — migrations/ 디렉토리의 *.sql 파일을 파일명 오름차순으로 순차 실행
 * schema_migrations 테이블로 실행 이력 관리, 미실행 파일만 적용
 */
async function runMigrations() {
  const conn = await pool.getConnection();
  try {
    // schema_migrations 테이블 없으면 생성
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        filename     VARCHAR(255) NOT NULL UNIQUE,
        executed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 이미 실행된 파일 목록 조회
    const [done] = await conn.execute('SELECT filename FROM schema_migrations');
    const executed = new Set(done.map(r => r.filename));

    // migrations/ 디렉토리의 *.sql 파일 오름차순 정렬
    const migrDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrDir)) return;
    const files = fs.readdirSync(migrDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (executed.has(file)) continue;

      const sql = fs.readFileSync(path.join(migrDir, file), 'utf8');
      // 세미콜론 기준 분리 후 빈 구문 제거 (PREPARE/EXECUTE 구문 포함)
      const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
      try {
        for (const stmt of statements) {
          await conn.execute(stmt);
        }
        await conn.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
        console.log(`[migration] 적용 완료: ${file}`);
      } catch (err) {
        console.error(`[migration] 실패: ${file} — ${err.message}`);
        throw err;
      }
    }
  } finally {
    conn.release();
  }
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

module.exports = { initPool, getPool, closePool, runMigrations };
