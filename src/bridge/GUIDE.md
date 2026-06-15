# src/bridge/GUIDE.md

| 항목 | 내용 |
|------|------|
| 문서명 | Python 브릿지 디렉토리 가이드 |
| 버전 | V1 |
| 날짜 | 2026-06-15 |
| 작성자 | Claude Sonnet 4.6 |
| 문서 유형 | 폴더 GUIDE |

## 목적

키움 OpenAPI+(KHOpenAPI.ocx COM/ActiveX)를 Electron(Node.js)에서 사용하기 위한
Python HTTP 브릿지 디렉토리.

## 파일 목록

| 파일 | 역할 |
|------|------|
| `bridge.py` | Flask HTTP 서버 + pykiwoom QThread 브릿지 |

## 아키텍처

```
Electron main.js
  ↓ child_process.spawn('python', ['src/bridge/bridge.py'])
  ↓ GET /status 폴링 (최대 10초)

bridge.py (메인 스레드: Flask, 워커 스레드: KiwoomWorker QThread)
  Flask 엔드포인트:
    GET  /status          — 브릿지 준비 상태
    POST /login           — CommConnect(block=True) 로그인 팝업
    GET  /account         — OPW00004 계좌/보유종목 조회
    GET  /holdings        — 보유종목 (account와 동일 TR)
    POST /order/buy       — SendOrder (nOrderType=1)
    POST /order/sell      — SendOrder (nOrderType=2)
    POST /order/cancel    — SendOrder (nOrderType=3/4)
    POST /realtime/subscribe   — SetRealReg
    POST /realtime/unsubscribe — SetRealRemove
    GET  /realtime/events      — SSE 스트림 (시세/체결 이벤트)
    POST /shutdown        — 브릿지 종료 요청
```

## 설치 요건

```bash
pip install pykiwoom flask PyQt5
```

- Python 3.9 이상 (32비트 권장 — Kiwoom OCX 호환성)
- 키움증권 OpenAPI+ 설치 필수 (KHOpenAPI.ocx)
- Windows 전용 (OCX COM 의존성)

## 주의사항

- Flask는 127.0.0.1 바인딩 (외부 접근 차단)
- CommConnect(block=True): GUI 팝업 — 자동 로그인 금지 (이용약관 위반)
- GetServerGubun "0" = 모의투자, "1" = 실투 — 반드시 확인
- KOA Studio(C:\OpenApi\KOAStudioSA.exe)로 OPW00004 필드명 사전 확인 권장
