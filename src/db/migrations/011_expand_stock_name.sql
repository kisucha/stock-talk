-- 마이그레이션 011: stock_info.name 컬럼 길이 확장
-- 책임: US 종목 Security Name이 100자 초과 (ETF/펀드 풀네임) → VARCHAR(255)로 확장
-- 배경: yfinance fetch_master() 실행 시 pymysql.err.DataError (1406) "Data too long for column 'name'" 발생
--       예: "Direxion Daily Semiconductor Bull 3X Shares" 등 ETF 풀네임이 100자 초과

ALTER TABLE stock_info
  MODIFY COLUMN name VARCHAR(255) NOT NULL
