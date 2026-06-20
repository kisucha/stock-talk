-- 마이그레이션 009: utf8mb4_unicode_ci → utf8mb4_general_ci 통일
-- 이유: 005에서 신규 테이블이 unicode_ci로 생성되어 기존 테이블(general_ci, stock_info 등)과
--       JOIN 시 "Illegal mix of collations" 발생.
--       관심종목 로드(getWatchlist: realtime_watchlist LEFT JOIN stock_info)가 무조건 실패.
-- 적용 범위: 005에서 만든 5개 테이블만 CONVERT TO CHARACTER SET — 텍스트 컬럼 전부 재정렬

ALTER TABLE kiwoom_config          CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE trading_orders         CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE trading_account        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE realtime_watchlist     CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE user_holdings_realtime CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
