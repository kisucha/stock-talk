# src/db/ GUIDE

| 항목 | 내용 |
|------|------|
| 폴더 목적 | MariaDB 연결 풀 및 쿼리 함수 모음 |
| 접속 방식 | mysql2/promise 연결 풀 (싱글톤) |

## 포함 파일

| 파일 | 용도 |
|------|------|
| `connection.js` | mysql2 연결 풀 — initPool/getPool/closePool |
| `queries.js` | 모든 SQL 쿼리 함수 (CRUD 완전 캡슐화) |
| `init.sql` | DB + 4개 테이블 DDL, 최초 1회 실행 |

## init.sql 실행 방법

```bash
mysql -h 192.168.20.80 -u root -p < src/db/init.sql
```

## Input-Based Paging 원칙

LIMIT/OFFSET 방식 사용 금지. 날짜 범위(fromDate/toDate)로만 필터링.
이유: 주식 데이터는 날짜 기반 — 오프셋 기준 조회는 의미 없음.

## 주요 설계 결정

| 결정 | 이유 |
|------|------|
| `timezone: '+09:00'` | KST 강제 — 일봉 날짜 UTC 변환 오류 방지 |
| `dateStrings: ['DATE']` | DATE 컬럼을 'YYYY-MM-DD' 문자열로 반환 |
| `multipleStatements: false` | SQL injection 방지 |
| `connectTimeout: 15000` | 원격 서버 연결 지연 허용 |
