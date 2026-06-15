| 항목 | 내용 |
|------|------|
| 문서명 | collector 배포 가이드 |
| 버전 | V1 |
| 날짜 | 2026-06-13 |
| 작성자 | Claude Opus 4.7 |
| 문서 유형 | 배포/운영 매뉴얼 |
| 사용 모델 | claude-opus-4-7 |

# 한국 주식 일봉 수집기 — 배포 가이드

원격 Linux 서버(192.168.20.80)에 Python 수집기를 배포하고 cron으로 매일 자동 실행한다.

---

## 1. 사전 준비

- 서버 OS: Linux (Ubuntu/Debian 가정)
- Python 3.10+ 설치 확인: `python3 --version`
- MariaDB 14 동작 중 (`stock_analysis` DB 존재)
- 방화벽: KRX 외부 호출(443) 허용
- 텔레그램 봇 토큰 + chat_id 발급 (선택)

---

## 2. 서버 셋업 — 1회만 실행

### 2-1. 디렉토리/계정 준비 (root로 실행)

```bash
# 전용 시스템 계정 — login shell 불필요
sudo useradd -r -s /bin/bash -m -d /opt/stock-collector stockbot 2>/dev/null || true

# 프로젝트 디렉토리 (이미 useradd로 생성됨)
sudo chown -R stockbot:stockbot /opt/stock-collector
sudo chmod 755 /opt/stock-collector
```

### 2-2. 소스 배포

본 저장소의 `collector/` 디렉토리 전체를 서버 `/opt/stock-collector/`로 복사.

```bash
# 로컬 PC에서 (Git 또는 scp)
scp -r E:/stock-talk/collector/* stockbot@192.168.20.80:/opt/stock-collector/
```

또는 서버에서 git pull (저장소 클론 시).

### 2-3. Python venv + 패키지

```bash
sudo -u stockbot bash -c '
  cd /opt/stock-collector
  python3 -m venv venv
  ./venv/bin/pip install --upgrade pip
  ./venv/bin/pip install -r requirements.txt
'
```

### 2-4. 환경 변수 파일 작성

```bash
sudo -u stockbot cp /opt/stock-collector/.env.example /opt/stock-collector/.env
sudo -u stockbot nano /opt/stock-collector/.env
```

채울 항목:

| 키 | 값 |
|----|----|
| `DB_HOST` | `127.0.0.1` (동일 서버) |
| `DB_USER` | `root` |
| `DB_PASSWORD` | `<.env에서 직접 관리, 평문 노출 금지>` |
| `DB_NAME` | `stock_analysis` |
| `TELEGRAM_BOT_TOKEN` | `<봇 토큰>` (선택) |
| `TELEGRAM_CHAT_ID` | `<chat_id>` (선택) |
| `LOG_DIR` | `/opt/stock-collector/logs` |
| `STATE_DIR` | `/opt/stock-collector/state` |

권한 보호:

```bash
sudo chmod 600 /opt/stock-collector/.env
sudo chown stockbot:stockbot /opt/stock-collector/.env
```

### 2-5. DB 스키마 마이그레이션

```bash
mysql -h 127.0.0.1 -u root -p stock_analysis < /path/to/src/db/migrations/002_stock_info_collector_columns.sql
```

검증:

```sql
SHOW COLUMNS FROM stock_info;
-- is_active, listed_date, delisted_date, last_synced_at 4개 컬럼 확인
```

### 2-6. 서버 타임존 (KST 권장)

```bash
sudo timedatectl set-timezone Asia/Seoul
timedatectl  # Time zone: Asia/Seoul 확인
```

---

## 3. 텔레그램 봇 등록 (선택)

1. 텔레그램에서 `@BotFather` 검색 → 대화 시작
2. `/newbot` 입력 → 봇 이름/유저네임 지정 → **토큰** 발급
3. 발급된 봇과 대화 시작 (한 번이라도 메시지 전송)
4. 브라우저에서 chat_id 확인:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   응답에서 `"chat":{"id": <숫자>}` 가 **CHAT_ID**.
5. `.env`의 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` 채우기.
6. 검증:
   ```bash
   sudo -u stockbot /opt/stock-collector/venv/bin/python \
     -c "from collector.notify import send_telegram; print(send_telegram('수집기 연결 테스트'))"
   ```
   → 텔레그램 알림 1회 도착 + `True` 출력.

---

## 4. 초기 적재 실행 (1회, 야간 권장)

활성 종목 ~3,000개 × 5년 → **3~5시간** 소요. SSH 끊김 방지를 위해 `nohup` 또는 `screen` 사용.

```bash
sudo -u stockbot bash -c '
  cd /opt/stock-collector
  nohup ./venv/bin/python -m collector.scripts.init_load \
    > logs/init_load.out 2>&1 &
'

# 진행 상황 확인
tail -f /opt/stock-collector/logs/collector.log
```

종료 시 텔레그램으로 결과 요약 1건 전송.

---

## 5. cron 등록 — 매일 증분

```bash
sudo -u stockbot crontab -e
```

다음 행 추가:

```
# 한국 주식 일봉 매일 증분 — 평일 16:30 KST (장마감 + 60분)
30 16 * * 1-5 cd /opt/stock-collector && ./venv/bin/python -m collector.scripts.incremental >> logs/cron.log 2>&1
```

저장 후 확인:

```bash
sudo -u stockbot crontab -l
```

다음 영업일 16:30에 자동 실행. 텔레그램으로 결과 요약 도착.

---

## 6. 운영 명령

### 6-1. 로그 확인

```bash
# 실시간
tail -f /opt/stock-collector/logs/collector.log

# 최근 100행
tail -n 100 /opt/stock-collector/logs/collector.log

# cron stdout
tail -n 50 /opt/stock-collector/logs/cron.log
```

### 6-2. 실패 종목 재시도

```bash
sudo -u stockbot bash -c '
  cd /opt/stock-collector
  ./venv/bin/python -c "from collector.ohlcv import retry_failed; print(retry_failed().summary())"
'
```

### 6-3. 수동 증분 1회

```bash
sudo -u stockbot bash -c '
  cd /opt/stock-collector
  ./venv/bin/python -m collector.scripts.incremental
'
```

### 6-4. DB 적재 통계

```sql
-- 종목 수
SELECT COUNT(*) AS active_tickers FROM stock_info WHERE is_active=TRUE;

-- 일봉 총 행수
SELECT COUNT(*) AS total_rows FROM stock_daily;

-- 종목별 적재 범위
SELECT ticker, MIN(trade_date) AS first_d, MAX(trade_date) AS last_d, COUNT(*) AS rows
  FROM stock_daily
 GROUP BY ticker
 ORDER BY last_d DESC
 LIMIT 10;
```

---

## 7. 트러블슈팅

| 증상 | 원인 후보 | 조치 |
|------|-----------|------|
| `pymysql.OperationalError 2003` | MariaDB 미기동/방화벽 | `systemctl status mariadb`, 3306 포트 확인 |
| `pymysql.OperationalError 1045` | 비밀번호 오류 | `.env` `DB_PASSWORD` 점검 |
| pykrx 종목 목록 비어 있음 | KRX 일시 차단 / 휴장 | 1~2시간 후 재시도. `MAX_RETRY` 증가 검토 |
| 텔레그램 미전송 | 토큰 오타 / 봇과 대화 미시작 | `getUpdates`로 chat_id 재확인 |
| 로그 파일 미생성 | LOG_DIR 권한 | `chown stockbot:stockbot /opt/stock-collector/logs` |
| cron 미실행 | 시스템 cron 비활성 | `systemctl status cron` |
| 같은 날 2회 실행 | INSERT IGNORE로 멱등 — 신규 0건 OK | 정상 |

---

## 8. 보안 체크리스트

- [ ] `.env` chmod 600
- [ ] `stockbot` 사용자 계정 — root 권한 없음
- [ ] DB 비밀번호 평문 로그 비노출 (`config.summary()`에서 마스킹 확인)
- [ ] 텔레그램 토큰 외부 노출 금지
- [ ] `collector/logs/` 외부 공개 금지

---

## 9. 다음 단계 — Electron 앱 연동

수집기가 적재한 `stock_daily`는 Electron 앱(메인 PC)에서 그대로 조회 가능.
앱 측 변경 불필요 — 기존 `db:getStockData` IPC가 동일 테이블 사용.

박스권 종목 추출 등 분석 자동화는 별도 단계 (`stock_info.box_low/box_high` 수동 또는 별도 잡으로 채움).
