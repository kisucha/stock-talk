// kiwoomService.js
// 목적: Python 브릿지(bridge.py)와 통신하는 Node.js HTTP 래퍼
//       Electron main.js의 IPC 핸들러에서 호출하여 키움 OpenAPI+ 기능 사용
// 참조: RESEARCH.md 섹션 21, 24

const http = require('http');

// 브릿지 기본 URL (환경변수로 포트 설정)
const BRIDGE_PORT = parseInt(process.env.KIWOOM_BRIDGE_PORT || '5001', 10);
const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

/**
 * 브릿지 HTTP 요청 공통 헬퍼 (Node.js 내장 http 모듈 사용)
 * @param {string} method - GET | POST
 * @param {string} path - /login, /account 등
 * @param {object|null} body - POST body (JSON)
 * @param {number} timeoutMs - 요청 타임아웃 (ms)
 */
function bridgeRequest(method, path, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url    = new URL(BRIDGE_BASE + path);
    const data   = body ? JSON.stringify(body) : null;
    const opts   = {
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      },
      timeout: timeoutMs
    };

    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          // JSON 파싱 실패 시 원시 텍스트 반환
          resolve({ success: false, error: `JSON 파싱 실패: ${raw.slice(0, 100)}` });
        }
      });
    });

    req.on('error', err => resolve({ success: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: `타임아웃 (${timeoutMs}ms)` });
    });

    if (data) req.write(data);
    req.end();
  });
}

/**
 * 브릿지 상태 확인 — Electron 시작 시 폴링으로 ready 확인
 * @returns {{ ready, loggedIn, serverType }}
 */
async function checkStatus() {
  return bridgeRequest('GET', '/status', null, 3000);
}

/**
 * 키움 로그인 — CommConnect(block=True) GUI 팝업 트리거
 * 사용자가 직접 ID/PW 입력 필요 (자동 로그인 금지)
 * @returns {{ success, loggedIn, serverType, isMock, accountNo }}
 */
async function login() {
  // 로그인 팝업 대기: 최대 120초
  return bridgeRequest('POST', '/login', {}, 120000);
}

/**
 * 계좌 잔고 + 보유종목 조회 (OPW00004)
 * @returns {{ success, account: { deposit, eval_total, pnl_total, rate_of_return }, holdings: [] }}
 */
async function getAccount() {
  return bridgeRequest('GET', '/account', null, 30000);
}

/**
 * 매수 주문 (nOrderType=1)
 * @param {{ ticker: string, qty: number, price: number }} order
 * @returns {{ success, status, ticker, qty, price }}
 */
async function orderBuy({ ticker, qty, price }) {
  return bridgeRequest('POST', '/order/buy', { ticker, qty, price }, 10000);
}

/**
 * 매도 주문 (nOrderType=2)
 * @param {{ ticker: string, qty: number, price: number }} order
 * @returns {{ success, status }}
 */
async function orderSell({ ticker, qty, price }) {
  return bridgeRequest('POST', '/order/sell', { ticker, qty, price }, 10000);
}

/**
 * 주문 취소 (nOrderType=3=매수취소, 4=매도취소)
 * @param {{ ticker: string, qty: number, orgOrderNo: string, orderType: number }} params
 */
async function cancelOrder({ ticker, qty, orgOrderNo, orderType = 3 }) {
  return bridgeRequest('POST', '/order/cancel', {
    ticker, qty, org_order_no: orgOrderNo, order_type: orderType
  }, 10000);
}

/**
 * 실시간 시세 구독 시작 (SetRealReg)
 * @param {string[]} tickers - 종목코드 배열 (예: ['053800', '005930'])
 * @returns {{ success, subscribed: [] }}
 */
async function subscribe(tickers) {
  const arr = Array.isArray(tickers) ? tickers : [tickers];
  return bridgeRequest('POST', '/realtime/subscribe', { tickers: arr }, 10000);
}

/**
 * 실시간 시세 구독 해제 (SetRealRemove)
 * @param {string[]} tickers - 해제할 종목코드 배열
 */
async function unsubscribe(tickers) {
  const arr = Array.isArray(tickers) ? tickers : [tickers];
  return bridgeRequest('POST', '/realtime/unsubscribe', { tickers: arr }, 10000);
}

async function logout() {
  return bridgeRequest('POST', '/logout', {}, 10000);
}

module.exports = {
  checkStatus,
  login,
  logout,
  getAccount,
  orderBuy,
  orderSell,
  cancelOrder,
  subscribe,
  unsubscribe
};
