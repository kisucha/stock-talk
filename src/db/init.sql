-- src/db/init.sql
-- 데이터베이스 및 4개 테이블 생성. 최초 1회 실행.
-- 실행 방법: mysql -h 192.168.20.80 -u root -p < src/db/init.sql

CREATE DATABASE IF NOT EXISTS stock_analysis
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE stock_analysis;

-- ============ 테이블 1: stock_info (종목 기본 정보) ============
CREATE TABLE IF NOT EXISTS stock_info (
  ticker      VARCHAR(20)  PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  market      VARCHAR(20),
  box_low     INT,
  box_high    INT,
  note        TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_market (market)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 테이블 2: stock_daily (일봉 OHLCV) ============
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

-- ============ 테이블 3: user_holdings (보유 현황) ============
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
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (ticker) REFERENCES stock_info(ticker),
  UNIQUE KEY uq_ticker (ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============ 테이블 4: chat_history (AI 대화 기록) ============
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

-- ============ 초기 데이터 ============
INSERT INTO stock_info (ticker, name, market, box_low, box_high)
VALUES ('053800', '안랩', 'KOSDAQ', 51000, 70000)
ON DUPLICATE KEY UPDATE box_low=VALUES(box_low), box_high=VALUES(box_high);
