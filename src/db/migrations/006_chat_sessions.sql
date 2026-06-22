-- 006_chat_sessions.sql
-- 채팅 세션 테이블 — 채팅창 단위 독립 세션 관리
-- ticker는 참고용 (NULL 허용)

CREATE TABLE IF NOT EXISTS chat_sessions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(200) NOT NULL DEFAULT '새 세션',
  ticker          VARCHAR(20)  NULL,
  engine          ENUM('ollama','claude') DEFAULT 'ollama',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_ticker (ticker),
  INDEX idx_last_active (last_active_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
