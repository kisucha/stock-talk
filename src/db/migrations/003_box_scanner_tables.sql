-- src/db/migrations/003_box_scanner_tables.sql
-- 박스권 스캐너용 테이블 2개 추가. 최초 1회 실행.
-- 실행: mysql -h 192.168.20.80 -u root -p stock_analysis < src/db/migrations/003_box_scanner_tables.sql

USE stock_analysis;

-- ============ 스캔 실행 이력 ============
CREATE TABLE IF NOT EXISTS box_scan_history (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  scanned_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  period_months  INT          NOT NULL DEFAULT 36,
  scan_from      DATE         NOT NULL,
  scan_to        DATE         NOT NULL,
  total_tickers  INT          NOT NULL DEFAULT 0,
  memo           VARCHAR(200),

  INDEX idx_scanned_at (scanned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 종목별 스캔 결과 ============
CREATE TABLE IF NOT EXISTS box_scan_results (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  scan_id        INT          NOT NULL,
  ticker         VARCHAR(20)  NOT NULL,
  scan_from      DATE         NOT NULL,
  scan_to        DATE         NOT NULL,
  box_high       INT          NOT NULL,
  box_low        INT          NOT NULL,
  box_range_pct  DECIMAL(6,2) NOT NULL,
  close_at_scan  INT          NOT NULL,
  data_days      INT          NOT NULL DEFAULT 0,
  status         ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (scan_id) REFERENCES box_scan_history(id) ON DELETE CASCADE,
  FOREIGN KEY (ticker)  REFERENCES stock_info(ticker)   ON DELETE CASCADE,
  INDEX idx_scan_id  (scan_id),
  INDEX idx_ticker   (ticker),
  INDEX idx_status   (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
