-- 마이그레이션: stock_info에 데이터 수집기용 컬럼 추가
-- 목적: 상장/폐지 상태 추적 + 마지막 동기화 시각 기록
-- 실행: mysql -h 192.168.20.80 -u root -p stock_analysis < 002_stock_info_collector_columns.sql
-- 멱등성: IF NOT EXISTS 처리 — 재실행 가능
-- 작성일: 2026-06-13

USE stock_analysis;

-- ============ stock_info 컬럼 확장 ============
-- MariaDB 10.0.2+ 부터 ADD COLUMN IF NOT EXISTS 지원

ALTER TABLE stock_info
  ADD COLUMN IF NOT EXISTS is_active      BOOLEAN   NOT NULL DEFAULT TRUE COMMENT '거래 가능 여부 (FALSE=상장폐지)',
  ADD COLUMN IF NOT EXISTS listed_date    DATE      NULL                  COMMENT '상장일 (참고용)',
  ADD COLUMN IF NOT EXISTS delisted_date  DATE      NULL                  COMMENT '상장 폐지일',
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP NULL                  COMMENT '마지막 종목 메타 동기화 시각';

-- 활성 종목 인덱스 (증분 수집 시 WHERE is_active=TRUE 가속)
ALTER TABLE stock_info
  ADD INDEX IF NOT EXISTS idx_is_active (is_active);

-- 기존 데이터 보정: 기존 행은 활성으로 간주
UPDATE stock_info
   SET is_active = TRUE
 WHERE is_active IS NULL;

-- 검증 쿼리 (수동 실행 권장)
-- SHOW COLUMNS FROM stock_info;
-- SELECT ticker, name, market, is_active, last_synced_at FROM stock_info LIMIT 5;
