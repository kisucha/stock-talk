// migrate.js
// src/db/migrations/*.sql 파일을 순서대로 DB에 실행하는 일회성 마이그레이션 스크립트.
// 실행: node migrate.js

const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');
require('dotenv').config();

async function runMigrations() {
  const conn = await mysql.createConnection({
    host:               process.env.DB_HOST,
    port:               parseInt(process.env.DB_PORT, 10) || 3306,
    user:               process.env.DB_USER,
    password:           process.env.DB_PASSWORD,
    database:           process.env.DB_NAME,
    timezone:           '+09:00',
    multipleStatements: true,   // 파일 내 다중 구문 실행 허용
    ssl:                false
  });

  console.log('DB 연결:', process.env.DB_HOST);

  const migrationsDir = path.join(__dirname, 'src', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();  // 001_, 002_, 003_ 순서 보장

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql      = fs.readFileSync(filePath, 'utf8');

    console.log(`실행 중: ${file}`);
    try {
      await conn.query(sql);
      console.log(`  완료: ${file}`);
    } catch (err) {
      // 이미 존재하는 테이블은 IF NOT EXISTS로 무시됨. 그 외 오류는 출력.
      console.error(`  오류 (${file}):`, err.message);
    }
  }

  await conn.end();
  console.log('마이그레이션 완료.');
}

runMigrations().catch(err => {
  console.error('치명적 오류:', err.message);
  process.exit(1);
});
