-- 마이그레이션 013: OpenRouter 엔진 제거 — chat_history/chat_sessions engine ENUM 원복
-- 책임:
--   1) engine='openrouter' 행 정리(필수) — ENUM MODIFY 전 truncation 방지
--      chat_history: 행 자체 삭제 (대화 내용 손실 — OpenRouter 응답은 보존가치 낮음)
--      chat_sessions: engine='ollama'로 다운그레이드 (세션 메타 보존)
--   2) ENUM('ollama','claude','openrouter') → ENUM('ollama','claude')
-- 배경: OpenRouter free tier rate limit + 호출 폭증으로 실용성 낮아 제거.

DELETE FROM chat_history WHERE engine = 'openrouter';

UPDATE chat_sessions SET engine = 'ollama' WHERE engine = 'openrouter';

ALTER TABLE chat_history
  MODIFY COLUMN engine ENUM('ollama','claude') DEFAULT 'ollama';

ALTER TABLE chat_sessions
  MODIFY COLUMN engine ENUM('ollama','claude') DEFAULT 'ollama'
