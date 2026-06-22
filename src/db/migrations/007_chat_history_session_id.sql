-- 007_chat_history_session_id.sql
-- chat_history에 session_id 컬럼 추가 (MariaDB 10.0+ IF NOT EXISTS 지원)

ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS session_id INT NULL AFTER engine;
