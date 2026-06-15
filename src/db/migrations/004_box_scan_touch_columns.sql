-- src/db/migrations/004_box_scan_touch_columns.sql
-- box_scan_results에 지지/저항 구역 상세 컬럼 추가.
-- 실행: node migrate.js

USE stock_analysis;

-- 중복 실행 안전: 컬럼이 없을 때만 추가
ALTER TABLE box_scan_results
  ADD COLUMN IF NOT EXISTS resistance_center  INT          NULL AFTER box_range_pct,
  ADD COLUMN IF NOT EXISTS support_center     INT          NULL AFTER resistance_center,
  ADD COLUMN IF NOT EXISTS resistance_touches INT          NULL AFTER support_center,
  ADD COLUMN IF NOT EXISTS support_touches    INT          NULL AFTER resistance_touches,
  ADD COLUMN IF NOT EXISTS last_touch_date    DATE         NULL AFTER support_touches;
