-- 마이그레이션 012: chat_history / chat_sessions engine ENUM에 openrouter 추가
-- 책임: AI 엔진에 OpenRouter free 모델 통합 후 INSERT 시 "Data truncated for column 'engine'" 에러 방지
-- 배경: 기존 ENUM('ollama','claude')로 INSERT 'openrouter' 시 truncation 발생.

ALTER TABLE chat_history
  MODIFY COLUMN engine ENUM('ollama','claude','openrouter') DEFAULT 'ollama';

ALTER TABLE chat_sessions
  MODIFY COLUMN engine ENUM('ollama','claude','openrouter') DEFAULT 'ollama'
