# 80서버 인프라 배포 가이드

| 문서명 | 내용 |
|--------|------|
| 문서명 | 80서버 Perplexica + Open WebUI 배포 가이드 |
| 버전 | V1 |
| 날짜 | 2026-06-22 |
| 작성자 | Claude Opus 4.7 |
| 문서 유형 | 인프라 배포 가이드 |
| 사용 모델 | claude-opus-4-7 |

---

## 1. 구성 요약

| 서비스 | 포트 | 역할 | 클라이언트 |
|--------|------|------|-----------|
| SearXNG (기존, 80서버) | 8888 | 메타 검색 엔진 | Perplexica, Open WebUI, 직접 호출 |
| Perplexica (신규, 80서버) | 3000 | AI 답변 엔진 (Perplexity 클론) | stock-talk aiService, 브라우저 일상 검색 |
| Open WebUI (신규, 80서버) | 8080 | 범용 채팅 UI + RAG | 가족/팀 LAN 사용 (stock-talk 비의존) |
| Ollama (별도, 30서버) | 11434 | LLM 추론 엔진 | Perplexica + Open WebUI + stock-talk 공통 |

```
192.168.20.30 (30서버)              192.168.20.80 (80서버)
└── Ollama :11434                   ├── MariaDB :3306
        ▲                            ├── SearXNG :8888           ─ 기존 운영
        │                            ├── Perplexica :3000   ──┐
        └───── LLM 추론 호출 ────────┤                          │ 답변엔진 + 채팅 UI 모두
                                     └── Open WebUI :8080   ──┘ 30서버 Ollama로 추론
```

---

## 2. 배포 순서

### 2.1 Perplexica 배포

```bash
# 80서버에서 실행
sudo mkdir -p /opt/perplexica
sudo chown $USER:$USER /opt/perplexica
cd /opt/perplexica

# 본 리포의 infra/perplexica/ 파일 복사
# (방법 1: scp 로컬 → 80서버)
#   scp infra/perplexica/* user@192.168.20.80:/opt/perplexica/
# (방법 2: git clone 후 인프라 디렉토리 사용)
#   git clone <stock-talk-repo> /tmp/st && cp /tmp/st/infra/perplexica/* /opt/perplexica/

# config 준비
mkdir -p data
cp config.toml.example data/config.toml
nano data/config.toml          # API_KEY (Ollama/Claude/OpenAI) 채우기

# 기동
docker compose up -d
docker compose logs -f         # 정상 부팅 확인 (Ctrl+C 로 빠짐)
```

**헬스체크**:
```bash
curl http://192.168.20.80:3000/api/config
# 200 + JSON 응답이면 정상
```

**검색 동작 테스트**:

먼저 config.toml에 LLM provider 등록 확인. Ollama API_URL 설정 + 모델 pull 사전 필요.

```bash
# Ollama 호스트(30서버) 도달 확인 (80서버에서 컨테이너 내부 호출)
docker exec perplexica wget -qO- http://192.168.20.30:11434/api/tags
# 또는 80서버 호스트에서 직접
curl http://192.168.20.30:11434/api/tags
```

**최소 호출** (config.toml에 등록된 기본 모델 사용):
```bash
curl -X POST http://192.168.20.80:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "안랩 최근 이슈",
    "focusMode": "webSearch",
    "optimizationMode": "balanced"
  }'
```

**명시 모델 지정 호출** (config.toml에 해당 모델 + provider 미리 등록 필수, 미등록 시 500):
```bash
curl -X POST http://192.168.20.80:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "안랩 최근 이슈",
    "focusMode": "webSearch",
    "optimizationMode": "balanced",
    "chatModel": { "provider": "ollama", "model": "gemma4:12b" },
    "embeddingModel": { "provider": "ollama", "model": "bge-m3" }
  }'
```

---

### 2.2 Open WebUI 배포

```bash
sudo mkdir -p /opt/openwebui
sudo chown $USER:$USER /opt/openwebui
cd /opt/openwebui

# 인프라 파일 복사 (방법은 Perplexica 와 동일)
mkdir -p data

# 기동
docker compose up -d
docker compose logs -f
```

**최초 접속**:
1. 브라우저: `http://192.168.20.80:8080`
2. 첫 화면에서 관리자 계정 생성
3. Settings → Models → Ollama 호스트 확인 (`OLLAMA_BASE_URL`)
4. Settings → Web Search → SearXNG 활성 확인

---

## 3. 방화벽 (외부 차단, LAN 허용)

```bash
# ufw 사용 예 (Ubuntu)
sudo ufw allow from 192.168.20.0/24 to any port 3000  proto tcp
sudo ufw allow from 192.168.20.0/24 to any port 8080  proto tcp
# 외부 인터넷에서는 접근 차단 (기본 정책 deny 가정)
```

---

## 4. 업데이트

```bash
# Perplexica
cd /opt/perplexica
docker compose pull
docker compose up -d

# Open WebUI (동일)
cd /opt/openwebui
docker compose pull
docker compose up -d
```

---

## 5. 백업

| 대상 | 경로 | 주기 |
|------|------|------|
| Perplexica 설정/이력 | `/opt/perplexica/data/` | 주 1회 tar |
| Open WebUI DB + 벡터 | `/opt/openwebui/data/` | 주 1회 tar |

예:
```bash
tar -czf /backup/perplexica-$(date +%Y%m%d).tar.gz /opt/perplexica/data
tar -czf /backup/openwebui-$(date +%Y%m%d).tar.gz /opt/openwebui/data
```

---

## 6. 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| Perplexica `/api/search` 502/504 | LLM provider 미설정 또는 Ollama 호스트(30서버) 도달 불가 | config.toml `[MODELS.OLLAMA] API_URL=http://192.168.20.30:11434` 확인. 80서버에서 `curl http://192.168.20.30:11434/api/tags` |
| Perplexica 답변 비어있음 | SearXNG 응답 빈 결과 | `curl http://192.168.20.80:8888/search?q=test&format=json` 직접 확인 |
| Open WebUI 첫 화면 무한 로딩 | 마이그레이션 충돌 | `docker compose logs open-webui` 확인, 필요 시 `data/webui.db` 백업 후 삭제 |
| 포트 충돌 (3000/8080) | 기존 서비스 점유 | `ss -ltn \| grep -E '3000\|8080'` 확인 후 docker-compose 포트 변경 |

---

## 7. stock-talk 통합 후 검증

배포 완료 후 stock-talk 실행:

1. `.env`에 `PERPLEXICA_URL=http://192.168.20.80:3000` 설정 (선택, 기본 fallback 동일)
2. 메인 창 AI 채팅에서 `인터넷 안랩 최근 이슈` 입력
3. 응답에 다음 포함 확인:
   - Perplexica 1차 답변 (출처 인용)
   - 박스권 분석 (MODE 1~6 중 하나)
   - 라이브 현재가 (네이버 polling)

증상별:
- "검색 실패: Perplexica..." → 80서버 도달 불가. SSH로 `docker compose ps` 확인
- 응답에 박스권 분석 누락 → `aiService.js` F블록 합성 로직 점검
