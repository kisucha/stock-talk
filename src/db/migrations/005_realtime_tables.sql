-- 파일명: 005_realtime_tables.sql
-- 목적: 키움 OpenAPI+ 실시간 거래 기능용 신규 테이블 4종 + 실시간 보유종목 테이블
-- 버전: V1
-- 날짜: 2026-06-15
-- 작성자: Claude Sonnet 4.6
-- 참조: RESEARCH.md 섹션 23

USE stock_analysis;

-- ============================================================
-- 1. kiwoom_config — 키움 계좌 설정 (모의/실투, 화면번호 등)
-- ============================================================
CREATE TABLE IF NOT EXISTS kiwoom_config (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  account_no     VARCHAR(20)  NOT NULL COMMENT '키움 계좌번호 (812451811)',
  is_mock        TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1=모의투자, 0=실투',
  bridge_port    INT          NOT NULL DEFAULT 5001 COMMENT 'Python 브릿지 HTTP 포트',
  screen_no_base VARCHAR(4)   NOT NULL DEFAULT '0101' COMMENT '키움 화면번호 기본값',
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='키움 OpenAPI+ 계좌 설정';

-- 기본 설정 행 삽입 (중복 방지)
INSERT IGNORE INTO kiwoom_config (account_no, is_mock, bridge_port, screen_no_base)
VALUES ('812451811', 1, 5001, '0101');

-- ============================================================
-- 2. trading_orders — 주문 이력 (매수/매도/취소/체결 상태)
-- ============================================================
CREATE TABLE IF NOT EXISTS trading_orders (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  account_no       VARCHAR(10)  NOT NULL COMMENT '계좌번호',
  ticker           VARCHAR(20)  NOT NULL COMMENT '종목코드 (stock_info FK)',
  order_type       ENUM('buy','sell') NOT NULL COMMENT '주문 유형',
  order_qty        INT          NOT NULL DEFAULT 0 COMMENT '주문 수량',
  order_price      INT          NOT NULL DEFAULT 0 COMMENT '주문 단가 (시장가=0)',
  -- kiwoom_order_no: OnReceiveChejanData FID 9001에서 수신 (SendOrder 반환값 아님)
  kiwoom_order_no  VARCHAR(20)  DEFAULT NULL COMMENT '키움 주문번호 (FID 9001)',
  status           ENUM('submitted','pending','partial','filled','cancelled')
                               NOT NULL DEFAULT 'submitted' COMMENT '주문 상태',
  exec_qty         INT          NOT NULL DEFAULT 0 COMMENT '체결 수량',
  exec_price       INT          NOT NULL DEFAULT 0 COMMENT '체결 단가',
  exec_amount      BIGINT       NOT NULL DEFAULT 0 COMMENT '체결 금액',
  commission       INT          NOT NULL DEFAULT 0 COMMENT '수수료',
  is_paper         TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1=모의투자, 0=실투',
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '주문 시각',
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP COMMENT '체결/취소 갱신 시각',
  UNIQUE KEY uq_kiwoom_order (kiwoom_order_no),
  INDEX idx_ticker (ticker),
  INDEX idx_account_status (account_no, status),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='키움 주문 이력 — 매수/매도/체결/취소';

-- ============================================================
-- 3. trading_account — 일별 계좌 스냅샷 (예수금, 평가금액, 손익)
-- ============================================================
CREATE TABLE IF NOT EXISTS trading_account (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  account_no     VARCHAR(10)   NOT NULL COMMENT '계좌번호',
  deposit        BIGINT        NOT NULL DEFAULT 0 COMMENT '예수금 (OPW00004)',
  eval_total     BIGINT        NOT NULL DEFAULT 0 COMMENT '총 평가금액',
  eval_stock     BIGINT        NOT NULL DEFAULT 0 COMMENT '유가증권 평가금액',
  cash           BIGINT        NOT NULL DEFAULT 0 COMMENT '가용 현금',
  pnl_today      BIGINT        NOT NULL DEFAULT 0 COMMENT '당일 손익',
  pnl_total      BIGINT        NOT NULL DEFAULT 0 COMMENT '누적 손익 (총평가손익금액)',
  rate_of_return DECIMAL(8,4)  NOT NULL DEFAULT 0 COMMENT '수익률(%) (총수익률(%))',
  is_paper       TINYINT(1)    NOT NULL DEFAULT 1 COMMENT '1=모의투자, 0=실투',
  snapshot_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '스냅샷 시각',
  -- 동일 계좌의 같은 날 스냅샷은 최신 1건만 유지 (UPSERT 패턴)
  UNIQUE KEY uq_account_date (account_no, DATE(snapshot_at)),
  INDEX idx_snapshot (snapshot_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='계좌 일별 스냅샷 — 예수금/평가금액/손익';

-- ============================================================
-- 4. realtime_watchlist — 실시간 구독 관심종목
-- ============================================================
CREATE TABLE IF NOT EXISTS realtime_watchlist (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  ticker             VARCHAR(20)   NOT NULL COMMENT '종목코드 (stock_info FK)',
  display_order      INT           NOT NULL DEFAULT 0 COMMENT '화면 표시 순서',
  alert_price_high   INT           DEFAULT NULL COMMENT '고가 알람 기준 (원)',
  alert_price_low    INT           DEFAULT NULL COMMENT '저가 알람 기준 (원)',
  alert_volume_ratio DECIMAL(5,2)  DEFAULT NULL COMMENT '거래량 배수 알람 (예: 2.0 = 평균 2배)',
  is_active          TINYINT(1)    NOT NULL DEFAULT 1 COMMENT '1=활성, 0=비활성',
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ticker (ticker),
  INDEX idx_active_order (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='실시간 구독 관심종목 목록';

-- ============================================================
-- 5. user_holdings_realtime — OPW00004 기반 실시간 잔고 동기화
--    기존 user_holdings(수동 입력)는 유지하고 별도 테이블로 관리
-- ============================================================
CREATE TABLE IF NOT EXISTS user_holdings_realtime (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  account_no     VARCHAR(10)   NOT NULL COMMENT '계좌번호',
  -- ticker: OPW00004 "종목번호" 필드, "A" 접두사 제거 후 저장
  ticker         VARCHAR(20)   NOT NULL COMMENT '종목코드 (A 접두사 제거됨)',
  quantity       INT           NOT NULL DEFAULT 0 COMMENT '보유수량 (OPW00004 "보유수량")',
  avg_price      INT           NOT NULL DEFAULT 0 COMMENT '매입평균단가 (OPW00004 "평균단가")',
  current_price  INT           NOT NULL DEFAULT 0 COMMENT '현재가 (OPW00004 "현재가", abs() 처리)',
  eval_amount    BIGINT        NOT NULL DEFAULT 0 COMMENT '평가금액 (OPW00004 "평가금액")',
  pnl_amount     BIGINT        NOT NULL DEFAULT 0 COMMENT '평가손익 (OPW00004 "평가손익")',
  -- pnl_rate: OPW00004 "평가손익율(%)" 필드 (주의: "수익률(%)" 아님)
  pnl_rate       DECIMAL(8,4)  NOT NULL DEFAULT 0 COMMENT '평가손익율(%) (OPW00004 "평가손익율(%)")',
  is_paper       TINYINT(1)    NOT NULL DEFAULT 1 COMMENT '1=모의투자, 0=실투',
  synced_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP COMMENT '동기화 시각',
  UNIQUE KEY uq_account_ticker (account_no, ticker),
  INDEX idx_ticker (ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='키움 OPW00004 기반 실시간 보유종목 잔고 (수동 입력 user_holdings와 별도)';
