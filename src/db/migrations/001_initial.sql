-- 001_initial.sql
-- 기존 init.sql 테이블 구조 — IF NOT EXISTS로 재실행 안전
-- schema_migrations 첫 실행 시 이 파일도 실행되어 기존 테이블과 충돌 없음

CREATE TABLE IF NOT EXISTS stock_info (
  ticker      VARCHAR(20)  PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  market      VARCHAR(20),
  box_low     INT,
  box_high    INT,
  note        TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_market (market)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_daily (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ticker      VARCHAR(20)  NOT NULL,
  trade_date  DATE         NOT NULL,
  open        INT          NOT NULL,
  high        INT          NOT NULL,
  low         INT          NOT NULL,
  close       INT          NOT NULL,
  volume      BIGINT       NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ticker_date (ticker, trade_date),
  INDEX idx_ticker_date (ticker, trade_date),
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_holdings (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  ticker          VARCHAR(20)  NOT NULL,
  avg_price       INT,
  quantity        INT,
  available_cash  INT,
  strategy        TEXT,
  horizon         TEXT,
  expected_issue  TEXT,
  split_plan      JSON,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker),
  UNIQUE KEY uq_ticker (ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS chat_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ticker      VARCHAR(20),
  role        ENUM('user','assistant') NOT NULL,
  content     TEXT         NOT NULL,
  engine      ENUM('ollama','claude') DEFAULT 'ollama',
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticker_created (ticker, created_at),
  FOREIGN KEY (ticker) REFERENCES stock_info(ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
