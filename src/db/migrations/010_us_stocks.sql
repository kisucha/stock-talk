-- 마이그레이션 010: 미국 주식 분석 도입 — Phase A
-- 책임:
--   1) stock_info.currency 컬럼 추가 (USD/KRW)
--   2) us_master_sync 메타 테이블 신설 — Nasdaq Trader 마스터 동기화 시각 보관
--   3) stock_daily FK ON DELETE CASCADE 전환 — 종목 삭제 시 일봉 자동 삭제
--      (user_holdings/chat_history는 RESTRICT 유지 — 데이터 보호)

-- ===========================================================
-- 1) currency 컬럼 (KR 기존 데이터는 DEFAULT 'KRW'로 채워짐)
-- ===========================================================
ALTER TABLE stock_info
  ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'KRW' COMMENT '통화: KRW|USD';

-- ===========================================================
-- 2) us_master_sync — 마스터 갱신 메타
-- ===========================================================
CREATE TABLE IF NOT EXISTS us_master_sync (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  last_synced_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '마지막 마스터 갱신 시각',
  tickers_count   INT       NOT NULL DEFAULT 0                COMMENT '마지막 갱신 시 적재 종목 수',
  source          VARCHAR(64) DEFAULT 'nasdaqtrader_ftp'       COMMENT '데이터 소스'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='US 종목 마스터 동기화 이력';

-- ===========================================================
-- 3) stock_daily FK CASCADE 전환 (현재 RESTRICT)
-- ===========================================================
ALTER TABLE stock_daily
  DROP FOREIGN KEY stock_daily_ibfk_1;

ALTER TABLE stock_daily
  ADD CONSTRAINT stock_daily_ibfk_1
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker) ON DELETE CASCADE
