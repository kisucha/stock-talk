-- 008_chat_memory.sql
-- 전역 공유 메모리 테이블
-- AI가 자연어로 추가/수정/삭제 관리, 모든 세션의 systemPrompt에 주입됨

CREATE TABLE IF NOT EXISTS chat_memory (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  content         TEXT         NOT NULL,
  source_ticker   VARCHAR(20)  NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
