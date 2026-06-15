// realtrading.js
// 목적: 키움 OpenAPI+ 실시간 거래 차일드 창 렌더러 스크립트
//       관심종목 관리, 호가 표시, 주문 입력, 체결내역 조회
// 참조: RESEARCH.md 섹션 22, 24, 25

// ============ 상태 ============
const state = {
  watchlist: [],           // [{ ticker, name, price, change, volume, subscribed }]
  orderbook: {             // 현재 선택 종목 호가
    ticker: '',
    asks: [],              // 매도 5호가 [{price, volume}]
    bids: []               // 매수 5호가 [{price, volume}]
  },
  order: {
    ticker: '',
    type:   'buy',         // 'buy' | 'sell'
    priceType: 'limit',    // 'limit' | 'market'
    price: 0,
    qty:   0
  },
  pendingOrders:  [],      // 미체결 주문 목록
  execHistory:    [],      // 체결 내역
  account: null,           // { deposit, eval_total, pnl_total, rate_of_return }
  loggedIn: false,
  isMock: true,
  accountNo: ''
};

// ============ 유틸리티 ============
function fmtNum(n) {
  if (n == null || isNaN(n)) return '-';
  return Math.abs(n).toLocaleString('ko-KR');
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '-';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${parseFloat(n).toFixed(2)}%`;
}

function pnlClass(n) {
  if (n > 0) return 'bullish';
  if (n < 0) return 'bearish';
  return 'neutral';
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ============ 초기화 ============
document.addEventListener('DOMContentLoaded', async () => {
  setupTabNav();
  setupWatchlistUI();
  setupOrderbookUI();
  setupOrderFormUI();
  setupHistoryUI();
  setupRealEventListeners();
  // 브릿지 상태 초기 확인
  await checkBridgeStatus();
});

// ============ 탭 네비게이션 ============
function setupTabNav() {
  document.querySelectorAll('.rt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rt-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.rt-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ============ 브릿지 상태 확인 ============
async function checkBridgeStatus() {
  updateStatusUI('connecting', '연결 중...');
  try {
    const res = await window.appAPI.realBridgeStatus();
    if (res.bridgeConnected) {
      updateStatusUI('connected', '연결됨');
      if (res.loggedIn) {
        state.loggedIn   = true;
        state.isMock     = res.isMock;
        state.accountNo  = res.accountNo;
        updateAccountHeader();
        await loadAccount();
      }
    } else {
      updateStatusUI('disconnected', '브릿지 연결 안됨');
    }
  } catch (e) {
    updateStatusUI('disconnected', '오류');
  }
}

function updateStatusUI(statusClass, text) {
  const dot  = document.getElementById('rt-status-dot');
  const txt  = document.getElementById('rt-status-text');
  dot.className = `rt-status-dot ${statusClass}`;
  txt.textContent = text;
}

// ============ 로그인 ============
function setupWatchlistUI() {
  // 로그인 버튼
  document.getElementById('btn-rt-login').addEventListener('click', async () => {
    const btn = document.getElementById('btn-rt-login');
    btn.disabled = true;
    btn.textContent = '로그인 중...';
    updateStatusUI('connecting', '로그인 대기...');
    try {
      const res = await window.appAPI.realLogin();
      if (res.success) {
        state.loggedIn  = true;
        state.isMock    = res.isMock;
        state.accountNo = res.accountNo;
        btn.textContent = '로그아웃';
        updateStatusUI('connected', `연결됨 (${res.isMock ? '모의' : '실투'})`);
        updateAccountHeader();
        await loadAccount();
        // 관심종목 자동 구독
        if (state.watchlist.length > 0) {
          const tickers = state.watchlist.map(w => w.ticker);
          await window.appAPI.realSubscribe(tickers);
        }
      } else {
        updateStatusUI('disconnected', '로그인 실패');
        alert(`로그인 실패: ${res.error}`);
        btn.textContent = '로그인';
      }
    } catch (e) {
      updateStatusUI('disconnected', '오류');
      btn.textContent = '로그인';
    } finally {
      btn.disabled = false;
    }
  });

  // 관심종목 추가 버튼
  document.getElementById('btn-rt-add-ticker').addEventListener('click', () => addWatchlistTicker());

  // 새로고침 버튼
  document.getElementById('btn-rt-refresh').addEventListener('click', () => loadAccount());

  // 엔터키로 관심종목 추가
  document.getElementById('rt-ticker-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWatchlistTicker();
  });

  // 전체 구독 버튼
  document.getElementById('btn-rt-subscribe-all').addEventListener('click', async () => {
    if (!state.loggedIn) { alert('먼저 로그인하세요'); return; }
    const tickers = state.watchlist.map(w => w.ticker);
    if (tickers.length === 0) return;
    const res = await window.appAPI.realSubscribe(tickers);
    if (res.success) {
      state.watchlist.forEach(w => w.subscribed = true);
      renderWatchlist();
    }
  });
}

function updateAccountHeader() {
  document.getElementById('rt-account-no').textContent = state.accountNo || '-';
  const badge = document.getElementById('rt-mock-badge');
  badge.textContent = state.isMock ? '모의투자' : '실투자';
  badge.style.background = state.isMock ? '#533483' : '#c0392b';
}

async function loadAccount() {
  try {
    const res = await window.appAPI.realGetAccount();
    if (res.success && res.account) {
      state.account = res.account;
      renderAccountHeader(res.account);
      // 보유종목 메인 창 패널에 알림 (broadcastToAllWindows로 main이 처리)
    }
  } catch (e) {
    console.error('계좌 조회 실패:', e);
  }
}

function renderAccountHeader(account) {
  document.getElementById('rt-deposit').textContent = fmtNum(account.deposit) + '원';
  document.getElementById('rt-eval-total').textContent = fmtNum(account.eval_total) + '원';
  const pnlEl  = document.getElementById('rt-pnl-total');
  const pnlVal = account.pnl_total || 0;
  pnlEl.textContent = `(${fmtPct(account.rate_of_return)})`;
  pnlEl.className   = `rt-pnl ${pnlClass(pnlVal)}`;
}

// ============ 관심종목 관리 ============
async function addWatchlistTicker() {
  const input  = document.getElementById('rt-ticker-input');
  const ticker = input.value.trim().replace(/[^0-9]/g, '').padStart(6, '0').slice(-6);
  if (!ticker || ticker === '000000') return;
  if (state.watchlist.find(w => w.ticker === ticker)) {
    input.value = '';
    return;
  }
  state.watchlist.push({ ticker, name: ticker, price: 0, change: 0, volume: 0, subscribed: false });
  input.value = '';
  renderWatchlist();
  // 호가/주문 종목 선택 드롭다운 업데이트
  updateTickerSelects();
  // 로그인된 경우 즉시 구독
  if (state.loggedIn) {
    const res = await window.appAPI.realSubscribe([ticker]);
    if (res.success) {
      const item = state.watchlist.find(w => w.ticker === ticker);
      if (item) item.subscribed = true;
      renderWatchlist();
    }
  }
}

function removeWatchlistTicker(ticker) {
  state.watchlist = state.watchlist.filter(w => w.ticker !== ticker);
  renderWatchlist();
  updateTickerSelects();
  window.appAPI.realUnsubscribe([ticker]).catch(() => {});
}

function renderWatchlist() {
  const tbody = document.getElementById('rt-watchlist-tbody');
  const empty = document.getElementById('rt-watchlist-empty');
  if (state.watchlist.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = state.watchlist.map(w => {
    const changeClass = pnlClass(w.change);
    return `<tr>
      <td>${w.ticker}</td>
      <td>${w.name}</td>
      <td class="rt-num ${changeClass}">${fmtNum(w.price)}</td>
      <td class="rt-num ${changeClass}">${fmtPct(w.change)}</td>
      <td class="rt-num">${fmtNum(w.volume)}</td>
      <td><span class="rt-sub-status ${w.subscribed ? 'active' : ''}" title="${w.subscribed ? '구독중' : '미구독'}"></span></td>
      <td>
        <button class="rt-btn rt-btn-sm" onclick="selectForOrder('${w.ticker}')">주문</button>
        <button class="rt-btn rt-btn-sm" onclick="removeWatchlistTicker('${w.ticker}')">삭제</button>
      </td>
    </tr>`;
  }).join('');
}

// ============ 호가 탭 ============
function setupOrderbookUI() {
  document.getElementById('rt-ob-ticker').addEventListener('change', (e) => {
    state.orderbook.ticker = e.target.value;
    clearOrderbook();
  });
}

function clearOrderbook() {
  document.getElementById('rt-ob-asks').innerHTML = '';
  document.getElementById('rt-ob-bids').innerHTML = '';
  document.getElementById('rt-ob-current').textContent = '현재가 -';
  document.getElementById('rt-ob-name').textContent = '-';
  document.getElementById('rt-ob-price').textContent = '-';
  document.getElementById('rt-ob-change').textContent = '-';
}

function renderOrderbook(data) {
  if (data.ticker !== state.orderbook.ticker) return;
  state.orderbook.asks = data.asks || [];
  state.orderbook.bids = data.bids || [];

  // 매도호가 — 5→1 순서 (위쪽에 높은 가격)
  const asksHtml = [...state.orderbook.asks].reverse().map(a =>
    `<tr><td>${fmtNum(a.volume)}</td><td>${fmtNum(a.price)}</td></tr>`
  ).join('');
  document.getElementById('rt-ob-asks').innerHTML = asksHtml;

  // 매수호가 — 1→5 순서
  const bidsHtml = state.orderbook.bids.map(b =>
    `<tr><td>${fmtNum(b.price)}</td><td>${fmtNum(b.volume)}</td></tr>`
  ).join('');
  document.getElementById('rt-ob-bids').innerHTML = bidsHtml;
}

// ============ 주문 탭 ============
function setupOrderFormUI() {
  // 주문 구분 (매수/매도)
  document.getElementById('btn-type-buy').addEventListener('click', () => setOrderType('buy'));
  document.getElementById('btn-type-sell').addEventListener('click', () => setOrderType('sell'));

  // 주문 방식 (지정가/시장가)
  document.getElementById('btn-price-limit').addEventListener('click', () => setPriceType('limit'));
  document.getElementById('btn-price-market').addEventListener('click', () => setPriceType('market'));

  // 현재가 적용 버튼
  document.getElementById('btn-rt-use-current').addEventListener('click', () => {
    const ticker = state.order.ticker;
    const item   = state.watchlist.find(w => w.ticker === ticker);
    if (item && item.price) {
      document.getElementById('rt-order-price').value = item.price;
      state.order.price = item.price;
      updateOrderTotal();
    }
  });

  // 가격/수량 변경 시 예상금액 업데이트
  document.getElementById('rt-order-price').addEventListener('input', (e) => {
    state.order.price = parseInt(e.target.value) || 0;
    updateOrderTotal();
    validateOrderForm();
  });
  document.getElementById('rt-order-qty').addEventListener('input', (e) => {
    state.order.qty = parseInt(e.target.value) || 0;
    updateOrderTotal();
    validateOrderForm();
  });

  // 종목 선택
  document.getElementById('rt-order-ticker').addEventListener('change', (e) => {
    state.order.ticker = e.target.value;
    const item = state.watchlist.find(w => w.ticker === e.target.value);
    document.getElementById('rt-order-name').textContent = item ? item.name : '-';
    validateOrderForm();
  });

  // 취소 버튼 — 폼 초기화
  document.getElementById('btn-rt-order-cancel').addEventListener('click', resetOrderForm);

  // 주문 제출 버튼
  document.getElementById('btn-rt-order-submit').addEventListener('click', submitOrder);
}

function setOrderType(type) {
  state.order.type = type;
  document.getElementById('btn-type-buy').classList.toggle('active',  type === 'buy');
  document.getElementById('btn-type-sell').classList.toggle('active', type === 'sell');
  validateOrderForm();
}

function setPriceType(type) {
  state.order.priceType = type;
  document.getElementById('btn-price-limit').classList.toggle('active',  type === 'limit');
  document.getElementById('btn-price-market').classList.toggle('active', type === 'market');
  // 시장가이면 가격 입력 비활성
  const priceRow = document.getElementById('rt-price-row');
  priceRow.style.opacity = type === 'market' ? '0.4' : '1';
  document.getElementById('rt-order-price').disabled = type === 'market';
  if (type === 'market') { state.order.price = 0; }
  updateOrderTotal();
  validateOrderForm();
}

function updateOrderTotal() {
  const price  = state.order.priceType === 'market' ? 0 : (state.order.price || 0);
  const qty    = state.order.qty || 0;
  const total  = price * qty;
  document.getElementById('rt-order-total').textContent = total > 0 ? fmtNum(total) + '원' : '-';
}

function validateOrderForm() {
  const btn     = document.getElementById('btn-rt-order-submit');
  const hasStock = !!state.order.ticker;
  const hasQty   = state.order.qty > 0;
  const hasPrice = state.order.priceType === 'market' || state.order.price > 0;
  const canOrder = state.loggedIn && hasStock && hasQty && hasPrice;
  btn.disabled = !canOrder;
}

function resetOrderForm() {
  document.getElementById('rt-order-price').value = '';
  document.getElementById('rt-order-qty').value   = '';
  state.order.price = 0;
  state.order.qty   = 0;
  updateOrderTotal();
  validateOrderForm();
  hideOrderResult();
}

async function submitOrder() {
  if (!state.loggedIn) { alert('먼저 로그인하세요'); return; }
  const { ticker, type, priceType, price, qty } = state.order;
  if (!ticker || qty <= 0) { alert('종목과 수량을 확인하세요'); return; }

  const submitBtn = document.getElementById('btn-rt-order-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = '주문 중...';

  try {
    const actualPrice = priceType === 'market' ? 0 : price;
    let res;
    if (type === 'buy') {
      res = await window.appAPI.realOrderBuy(ticker, qty, actualPrice);
    } else {
      res = await window.appAPI.realOrderSell(ticker, qty, actualPrice);
    }

    if (res.success) {
      showOrderResult('success',
        `${type === 'buy' ? '매수' : '매도'} 주문 접수 완료. ` +
        `${ticker} ${fmtNum(qty)}주 @ ${priceType === 'market' ? '시장가' : fmtNum(actualPrice) + '원'}`
      );
      // 미체결 내역에 임시 추가 — localId 부여로 취소 시 안전 식별
      // orderNo는 OnReceiveChejanData(FID 9001)로 수신 후 갱신됨
      const localId = Date.now() + Math.random().toString(36).slice(2, 6);
      state.pendingOrders.push({
        localId, ticker, type, price: actualPrice, qty, remaining: qty,
        orderNo: null, ts: Date.now()
      });
      renderPendingOrders();
    } else {
      showOrderResult('error', `주문 실패: ${res.error}`);
    }
  } catch (e) {
    showOrderResult('error', `오류: ${e.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '주문 확인';
    validateOrderForm();
  }
}

function showOrderResult(type, msg) {
  const el = document.getElementById('rt-order-result');
  el.className = `rt-order-result ${type}`;
  el.textContent = msg;
  el.style.display = 'block';
  // 5초 후 자동 숨김
  setTimeout(hideOrderResult, 5000);
}

function hideOrderResult() {
  const el = document.getElementById('rt-order-result');
  if (el) el.style.display = 'none';
}

// ============ 체결내역 탭 ============
function setupHistoryUI() {
  document.getElementById('btn-rt-refresh-history').addEventListener('click', () => {
    renderPendingOrders();
    renderExecHistory();
  });
}

function renderPendingOrders() {
  const tbody = document.getElementById('rt-pending-tbody');
  const empty = document.getElementById('rt-pending-empty');
  const count = document.getElementById('rt-pending-count');
  const pending = state.pendingOrders.filter(o => o.remaining > 0);
  count.textContent = pending.length;

  if (pending.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  // localId로 취소 버튼 식별 — 배열 인덱스 사용 금지 (취소 시 배열 변경으로 off-by-one 발생)
  tbody.innerHTML = pending.map(o => `<tr>
    <td>${o.ticker}</td>
    <td class="${o.type === 'buy' ? 'bullish' : 'bearish'}">${o.type === 'buy' ? '매수' : '매도'}</td>
    <td class="rt-num">${o.price > 0 ? fmtNum(o.price) : '시장가'}</td>
    <td class="rt-num">${fmtNum(o.qty)}</td>
    <td class="rt-num">${fmtNum(o.remaining)}</td>
    <td>${o.orderNo || '-'}</td>
    <td>
      <button class="rt-btn rt-btn-sm" onclick="cancelPending('${o.localId}')">취소</button>
    </td>
  </tr>`).join('');
}

async function cancelPending(localId) {
  // localId로 직접 찾기 — 배열 인덱스 의존 제거
  const order = state.pendingOrders.find(o => o.localId === localId && o.remaining > 0);
  if (!order) return;
  if (!confirm(`${order.ticker} ${order.type === 'buy' ? '매수' : '매도'} 주문을 취소하시겠습니까?`)) return;
  const orderType = order.type === 'buy' ? 3 : 4;
  // orderNo가 없으면 취소 불가 (키움 주문번호 수신 전)
  if (!order.orderNo) { alert('키움 주문번호 수신 대기 중입니다. 잠시 후 재시도하세요.'); return; }
  const res = await window.appAPI.realCancelOrder(order.ticker, order.remaining, order.orderNo, orderType);
  if (res.success) {
    order.remaining = 0;
    renderPendingOrders();
  } else {
    alert(`취소 실패: ${res.error}`);
  }
}

function renderExecHistory() {
  const tbody = document.getElementById('rt-history-tbody');
  const empty = document.getElementById('rt-history-empty');
  if (state.execHistory.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = [...state.execHistory].reverse().map(e => `<tr>
    <td>${fmtTime(e.ts)}</td>
    <td>${e.ticker || '-'}</td>
    <td class="${e.type === 'buy' ? 'bullish' : 'bearish'}">${e.type === 'buy' ? '매수' : '매도'}</td>
    <td class="rt-num">${fmtNum(e.exec_price)}</td>
    <td class="rt-num">${fmtNum(e.exec_qty)}</td>
    <td class="rt-num">${fmtNum((e.exec_price || 0) * (e.exec_qty || 0))}</td>
    <td>${e.status === 'filled' ? '체결' : '부분체결'}</td>
  </tr>`).join('');
}

// ============ 종목 선택 드롭다운 동기화 ============
function updateTickerSelects() {
  const options = [
    '<option value="">-- 종목 선택 --</option>',
    ...state.watchlist.map(w => `<option value="${w.ticker}">${w.ticker} ${w.name}</option>`)
  ].join('');
  document.getElementById('rt-ob-ticker').innerHTML  = options;
  document.getElementById('rt-order-ticker').innerHTML = options;
}

// 관심종목에서 주문 탭으로 이동 + 종목 선택
function selectForOrder(ticker) {
  state.order.ticker = ticker;
  // 주문 탭으로 전환
  document.querySelectorAll('.rt-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.rt-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="order"]').classList.add('active');
  document.getElementById('panel-order').classList.add('active');
  // 종목 선택
  document.getElementById('rt-order-ticker').value = ticker;
  const item = state.watchlist.find(w => w.ticker === ticker);
  document.getElementById('rt-order-name').textContent = item ? item.name : '-';
  // 현재가 적용
  if (item && item.price) {
    document.getElementById('rt-order-price').value = item.price;
    state.order.price = item.price;
    updateOrderTotal();
  }
  validateOrderForm();
}

// ============ 실시간 이벤트 수신 ============
function setupRealEventListeners() {
  // 실시간 시세 — 관심종목 목록 갱신
  window.appAPI.onRealQuote((data) => {
    const item = state.watchlist.find(w => w.ticker === data.ticker);
    if (item) {
      item.price  = data.price;
      item.change = data.change;
      item.volume = data.volume;
      renderWatchlist();
    }
    // 호가 탭에서 선택된 종목이면 현재가 표시 갱신
    if (state.orderbook.ticker === data.ticker) {
      const priceEl  = document.getElementById('rt-ob-price');
      const changeEl = document.getElementById('rt-ob-change');
      const curEl    = document.getElementById('rt-ob-current');
      priceEl.textContent  = fmtNum(data.price);
      priceEl.className    = `rt-ob-price ${pnlClass(data.change)}`;
      changeEl.textContent = fmtPct(data.change);
      changeEl.className   = `rt-ob-change ${pnlClass(data.change)}`;
      curEl.textContent    = `현재가 ${fmtNum(data.price)}`;
    }
  });

  // 호가 갱신
  window.appAPI.onRealOrderbook((data) => {
    renderOrderbook(data);
  });

  // 체결 통보 — 미체결 목록 상태 갱신
  window.appAPI.onRealExecution((data) => {
    const { order_no, ticker } = data;
    // 1단계: orderNo로 이미 매핑된 주문 찾기
    let order = order_no ? state.pendingOrders.find(o => o.orderNo === order_no) : null;
    // 2단계: orderNo가 없는 신규 주문에 키움 주문번호 역방향 매핑
    //        (같은 ticker, orderNo=null인 가장 최근 주문에 할당)
    if (!order && order_no && ticker) {
      const unmatched = state.pendingOrders
        .filter(o => o.ticker === ticker && !o.orderNo && o.remaining > 0)
        .sort((a, b) => b.ts - a.ts);
      if (unmatched.length > 0) {
        unmatched[0].orderNo = order_no;
        order = unmatched[0];
      }
    }
    if (order) {
      order.remaining = Math.max(0, order.remaining - (data.exec_qty || 0));
    }
    // 체결 내역에 추가
    state.execHistory.push(data);
    renderPendingOrders();
    renderExecHistory();
  });

  // 브릿지 오류 알림
  window.appAPI.onRealBridgeError((data) => {
    updateStatusUI('disconnected', '브릿지 오류');
    alert(data.message || '키움 브릿지 오류가 발생했습니다.');
  });

  // 창 닫힐 때 이벤트 리스너 정리
  window.addEventListener('beforeunload', () => {
    window.appAPI.removeRealListeners();
  });
}
