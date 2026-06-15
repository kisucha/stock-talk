# src/renderer/ GUIDE

| 항목 | 내용 |
|------|------|
| 폴더 목적 | Electron 렌더러 프로세스 파일 모음 |
| 보안 제약 | Node.js 직접 접근 불가 — 모든 통신은 window.appAPI 경유 |

## 포함 파일

| 파일 | 용도 |
|------|------|
| `index.html` | 3패널 다크 테마 레이아웃 (헤더+사이드바+메인) |
| `styles.css` | CSS 변수 기반 다크 테마 |
| `chart.js` | Chart.js 3패널 차트 초기화 + 업데이트 |
| `renderer.js` | 이벤트 핸들러 + IPC 호출 진입점 |

## 보안 설정

- `contextIsolation: true` — window 객체 직접 접근 금지
- `nodeIntegration: true` — chart.js require() 사용 위해 필요 (로컬 파일만 로드)
- CSP: `script-src 'self'` — 외부 CDN 차단

## 데이터 흐름

```
사용자 이벤트 (renderer.js)
    ↓ window.appAPI.*
preload.js (contextBridge)
    ↓ ipcRenderer.invoke / send
main.js IPC 핸들러
    ↓ DB 쿼리 / 지표 계산 / AI 호출
응답 반환
    ↓
renderer.js → chart.js (차트 업데이트)
```

## chart.js 로드 방식

CDN 불가 (오프라인 환경 + CSP). node_modules에서 require로 직접 로드.

```javascript
const { Chart } = require('../../node_modules/chart.js/auto');
```

`window.initCharts`, `window.updateCharts`로 renderer.js에서 접근.
