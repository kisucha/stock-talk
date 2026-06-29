// realtrading.js
// 목적: 키움 OpenAPI+ 실시간 거래 차일드 창 렌더러 스크립트
//       관심종목 관리, 호가 표시, 주문 입력, 체결내역 조회
// 참조: RESEARCH.md 섹션 22, 24, 25

// ============ 상태 ============
const state = {
  watchlist: [],           // [{ ticker, name, price, change, changeRate, volume, subscribed }]
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
  pendingOrders:  [],      // 미체결 주문 — 키움 OPT10075 응답(pending) 덮어쓰기 전용
  execHistory:    [],      // 체결 내역   — 키움 OPT10075 응답(filled) 덮어쓰기 전용
  account: null,           // { deposit, eval_total, pnl_total, rate_of_return }
  holdings: [],            // 보유종목 목록 (loadAccount 시 갱신)
  searchResults:   [],     // 자동완성 결과 [{ ticker, name, market }]
  searchActiveIdx: -1,     // 드롭다운 키보드 활성 인덱스
  loggedIn: false,
  isMock: true,
  accountNo: ''
};

// ============ 이익분기단가(BEP) 계산 ============
// 모의투자: 매수 수수료 0.35% (편도). 거래세/매도수수료 미적용.
// 실투자  : 매수/매도 수수료 각 0.015% + 매도 거래세 0.18%
//          BEP = avg × (1 + 매수수수료) / (1 − 매도수수료 − 거래세)
function calcBEP(avgPrice, isMock) {
  const avg = Number(avgPrice);
  if (!avg || avg <= 0) return 0;
  if (isMock) return Math.round(avg * 1.0035);
  return Math.round(avg * 1.00015 / (1 - 0.00015 - 0.0018));
}

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
  setupHoldingsDragScroll();
  // 관심종목 DB 로드 (브릿지 상태 확인 전에 — 로그인 자동 구독 시점에 watchlist 존재해야 함)
  await loadWatchlistFromDB();
  // 브릿지 상태 초기 확인
  await checkBridgeStatus();
});

// stock_info 미등록 종목은 ticker로 fallback. DB 오류와 빈 상태 구분용 명시 로그.
async function loadWatchlistFromDB() {
  try {
    const res = await window.appAPI.getWatchlist();
    if (!res || res.success !== true) {
      console.warn('[watchlist] DB 로드 실패:', res && res.error);
      return;
    }
    if (!Array.isArray(res.data)) return;
    state.watchlist = res.data.map(r => ({
      ticker: r.ticker,
      name:   r.name || r.ticker,
      price: 0, change: 0, changeRate: 0, volume: 0, subscribed: false
    }));
    renderWatchlist();
    updateTickerSelects();
    console.log(`[watchlist] DB 로드 완료: ${state.watchlist.length}종목`);
  } catch (e) {
    console.error('[watchlist] DB 로드 예외:', e);
  }
}

// ============ 탭 네비게이션 ============
function setupTabNav() {
  document.querySelectorAll('.rt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rt-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.rt-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
      // 체결내역 탭 진입 시 키움 OpenAPI 실데이터 즉시 조회
      if (btn.dataset.tab === 'history') loadExecutions();
    });
  });
}

// ============ 브릿지 상태 확인 + 자동 로그인 ============
async function checkBridgeStatus() {
  updateStatusUI('connecting', '연결 중...');
  try {
    const res = await window.appAPI.realBridgeStatus();
    // 브릿지 응답에 isMock이 명확하면 화면 표시 즉시 반영 — 로그인 전 mode 뱃지 정확성 보장.
    // main.js real:openWindow 핸들러가 사용자 모달 선택값으로 sharedState.isMock을 미리 설정.
    if (res.isMock != null) {
      state.isMock = res.isMock;
      updateAccountHeader();
    }
    if (!res.bridgeConnected) {
      updateStatusUI('disconnected', '브릿지 연결 안됨');
      return;
    }
    if (res.loggedIn) {
      // 이미 로그인된 상태
      state.loggedIn  = true;
      state.isMock    = res.isMock;
      state.accountNo = res.accountNo;
      updateStatusUI('connected', `연결됨 (${res.isMock ? '모의' : '실투'})`);
      updateAccountHeader();
      await loadAccount();
      loadExecutions();
    } else {
      // 자동 로그인 시작
      updateStatusUI('connecting', '로그인 중... (키움 로그인 창 확인)');
      const btn = document.getElementById('btn-rt-login');
      if (btn) { btn.disabled = true; btn.textContent = '로그인 중...'; }
      const loginRes = await window.appAPI.realLogin();
      if (loginRes.success) {
        // 실전 선택 + 키움 실제=모의 → 차단 (사용자 옵션 없음)
        if (loginRes.modeMismatch && loginRes.modeMismatch.block) {
          const mm = loginRes.modeMismatch;
          alert(`⛔ 거래 모드 불일치 — 로그인 차단\n\n사용자 선택: ${mm.userIntentKo} 거래\n키움 실제 접속: ${mm.actualKo} 거래\n\n${mm.hint}`);
          await window.appAPI.realLogout();
          updateStatusUI('disconnected', `${mm.userIntentKo}/${mm.actualKo} 불일치 — 로그인 차단`);
          if (btn) { btn.textContent = '로그인'; btn.disabled = false; }
          return;
        }
        state.loggedIn  = true;
        state.isMock    = loginRes.isMock;
        state.accountNo = loginRes.accountNo;
        if (btn) btn.textContent = '로그아웃';
        updateStatusUI('connected', `연결됨 (${loginRes.isMock ? '모의' : '실투'})`);
        updateAccountHeader();
        await loadAccount();
        loadExecutions();
        if (state.watchlist.length > 0) {
          await window.appAPI.realSubscribe(state.watchlist.map(w => w.ticker));
        }
      } else {
        if (btn) { btn.disabled = false; btn.textContent = '로그인'; }
        updateStatusUI('disconnected', `로그인 실패: ${loginRes.error || ''}`);
      }
    }
  } catch (e) {
    updateStatusUI('disconnected', '오류: ' + e.message);
  }
}

function updateStatusUI(statusClass, text) {
  const dot  = document.getElementById('rt-status-dot');
  const txt  = document.getElementById('rt-status-text');
  dot.className = `rt-status-dot ${statusClass}`;
  txt.textContent = text;
}

// ============ 로그인 / 로그아웃 ============
async function doLogin() {
  const btn = document.getElementById('btn-rt-login');
  btn.disabled = true;
  btn.textContent = '로그인 중...';
  updateStatusUI('connecting', '로그인 대기...');
  try {
    const res = await window.appAPI.realLogin();
    if (res.success) {
      // 실전 선택 + 키움 실제=모의 → 차단 (사용자 옵션 없음, 즉시 로그아웃)
      if (res.modeMismatch && res.modeMismatch.block) {
        const mm = res.modeMismatch;
        alert(`⛔ 거래 모드 불일치 — 로그인 차단\n\n사용자 선택: ${mm.userIntentKo} 거래\n키움 실제 접속: ${mm.actualKo} 거래\n\n${mm.hint}`);
        await window.appAPI.realLogout();
        updateStatusUI('disconnected', `${mm.userIntentKo}/${mm.actualKo} 불일치 — 로그인 차단`);
        btn.textContent = '로그인';
        btn.disabled = false;
        return;
      }
      state.loggedIn  = true;
      state.isMock    = res.isMock;
      state.accountNo = res.accountNo;
      btn.textContent = '로그아웃';
      updateStatusUI('connected', `연결됨 (${res.isMock ? '모의' : '실투'})`);
      updateAccountHeader();
      await loadAccount();
      loadExecutions();
      if (state.watchlist.length > 0) {
        await window.appAPI.realSubscribe(state.watchlist.map(w => w.ticker));
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
}

async function doLogout() {
  const btn = document.getElementById('btn-rt-login');
  btn.disabled = true;
  btn.textContent = '로그아웃 중...';
  try {
    await window.appAPI.realLogout();
  } catch (e) {
    console.error('로그아웃 오류:', e);
  }
  // 결과와 무관하게 UI 초기화
  state.loggedIn  = false;
  state.accountNo = '';
  state.account   = {};
  state.holdings  = [];
  state.pendingOrders = [];
  state.execHistory   = [];
  state.watchlist.forEach(w => { w.subscribed = false; });
  renderWatchlist();
  renderPendingOrders();
  renderExecHistory();
  renderHoldingsBar([], state.isMock);
  document.getElementById('rt-deposit').textContent   = '-';
  document.getElementById('rt-eval-total').textContent = '-';
  document.getElementById('rt-pnl-total').textContent  = '-';
  document.getElementById('rt-account-no').textContent = '-';
  btn.textContent = '로그인';
  btn.disabled    = false;
  updateStatusUI('disconnected', '로그아웃됨');
}

function setupWatchlistUI() {
  // 로그인 / 로그아웃 버튼 (상태에 따라 분기)
  document.getElementById('btn-rt-login').addEventListener('click', async () => {
    if (state.loggedIn) {
      await doLogout();
    } else {
      await doLogin();
    }
  });

  // 관심종목 추가 버튼
  document.getElementById('btn-rt-add-ticker').addEventListener('click', () => addWatchlistTicker());

  // 새로고침 버튼
  document.getElementById('btn-rt-refresh').addEventListener('click', () => loadAccount());

  // SSE 강제 재연결 버튼 (브릿지 오류 발생 시 표시됨)
  document.getElementById('btn-rt-reconnect').addEventListener('click', async () => {
    const btn = document.getElementById('btn-rt-reconnect');
    btn.disabled = true;
    btn.textContent = '재연결 중...';
    updateStatusUI('connecting', '재연결 중...');
    const res = await window.appAPI.realReconnectSSE();
    if (res.success) {
      btn.style.display = 'none';
      updateStatusUI('connected', '재연결됨');
    } else {
      btn.disabled = false;
      btn.textContent = '재연결';
      updateStatusUI('disconnected', '재연결 실패');
    }
  });

  // 종목 검색 자동완성 설정 (입력 이벤트 + 키보드 네비게이션 + 외부 클릭 닫힘)
  setupTickerSearch();

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
  // 키움에서 전달받은 계좌만 표시 — env 폴백/임의값 금지.
  // 미수신 시 명확하게 표기 (사용자가 신뢰할 수 있는 정보만).
  const accEl = document.getElementById('rt-account-no');
  if (state.accountNo) {
    accEl.textContent = state.accountNo;
    accEl.title = '키움 OpenAPI에서 전달받은 실제 사용 계좌';
    accEl.style.color = '';
  } else {
    accEl.textContent = '(계좌 미수신)';
    accEl.title = '키움 OpenAPI 응답에 계좌가 없음 — 로그인 또는 권한 문제';
    accEl.style.color = '#ffcc66';
  }
  const badge = document.getElementById('rt-mock-badge');
  badge.textContent = state.isMock ? '모의투자' : '실투자';
  badge.style.background = state.isMock ? '#533483' : '#c0392b';
}

async function loadAccount() {
  const btn = document.getElementById('btn-rt-refresh');
  btn.disabled = true;
  btn.textContent = '조회 중...';
  const MAX = 3;
  for (let i = 0; i < MAX; i++) {
    try {
      const res = await window.appAPI.realGetAccount();
      if (res.success && res.account) {
        state.account  = res.account;
        // 상장폐지 종목 필터링 — bridge 측 OPW00004 상장폐지조회구분=1로 1차 제외 +
        // 클라이언트 측 종목명 패턴(폐)/(관) 2차 안전망. 메인 창과 카드 모두 동일 데이터 사용.
        const rawHoldings = res.holdings || [];
        state.holdings = rawHoldings.filter(h => {
          const name = (h.name || '').trim();
          return !/[\(（][폐관][\)）]/.test(name);
        });
        renderAccountHeader(res.account);
        renderHoldingsBar(state.holdings, state.isMock);
        // 메인 창 계좌 요약 패널 업데이트 (is_mock 포함하여 BEP 계산용)
        window.appAPI.realBroadcastAccount(
          { ...res.account, account_no: state.accountNo, is_mock: state.isMock },
          state.holdings
        );
        // [A] 보유종목 자동 실시간 구독 — 관심종목 미등록 보유종목도 카드 현재가/손익 tick 갱신
        const holdingTickers = state.holdings.map(h => h.ticker).filter(Boolean);
        if (holdingTickers.length > 0) {
          window.appAPI.realSubscribe(holdingTickers).catch(() => {});
        }
        btn.textContent = '새로고침';
        btn.disabled = false;
        return;
      }
    } catch (e) {
      console.error(`계좌 조회 실패 (${i + 1}/${MAX}):`, e);
    }
    if (i < MAX - 1) await new Promise(r => setTimeout(r, 1500));
  }
  // 3회 모두 실패
  btn.textContent = '실패 — 재시도';
  btn.disabled = false;
}

function renderAccountHeader(account) {
  // 매매가능금액(OPW00001 '주문가능금액') 우선 표시. 예수금은 매매 후 보유종목 평가금만큼 차감되지 않아 의미 적음.
  document.getElementById('rt-deposit').textContent = fmtNum(account.orderable != null ? account.orderable : account.deposit) + '원';
  document.getElementById('rt-eval-total').textContent = fmtNum(account.eval_total) + '원';
  const pnlEl  = document.getElementById('rt-pnl-total');
  const pnlVal = account.pnl_total || 0;
  pnlEl.textContent = `(${fmtPct(account.rate_of_return)})`;
  pnlEl.className   = `rt-pnl ${pnlClass(pnlVal)}`;
}

// ============ 보유종목 바 ============
// 예수금 아래, 탭 위 가로 카드 바. 5종목까지 보이고 초과 시 드래그 스크롤.
function renderHoldingsBar(holdings, isMock) {
  const track = document.getElementById('rt-holdings-track');
  if (!track) return;
  if (!holdings || holdings.length === 0) {
    track.innerHTML = '<div class="rt-holdings-empty">보유종목 없음</div>';
    return;
  }
  track.innerHTML = holdings.map(h => renderHoldingCard(h, isMock)).join('');
}

// 카드 1장 HTML 생성. data-* 속성에 avg/qty 보관 → 실시간 시세 갱신 시 사용.
function renderHoldingCard(h, isMock) {
  const avg  = Number(h.avgPrice) || 0;
  const bep  = calcBEP(avg, isMock);
  const cur  = Number(h.currentPrice) || 0;
  const qty  = Number(h.qty) || 0;
  const rate = Number(h.pnlRate) || 0;
  const amt  = (cur - avg) * qty;
  const cls  = pnlClass(amt);
  const sign = amt >= 0 ? '+' : '-';
  const name = h.name || h.ticker;
  return `
    <div class="rt-holding-card" data-ticker="${h.ticker}" data-avg="${avg}" data-qty="${qty}" data-bep="${bep}">
      <div class="rt-holding-name">${name}<span>(${h.ticker})</span></div>
      <div class="rt-holding-row">
        <span>현재가</span><span class="rt-holding-val rt-holding-cur">${fmtNum(cur)}원</span>
      </div>
      <div class="rt-holding-row">
        <span>수량</span><span class="rt-holding-val">${fmtNum(qty)}주</span>
      </div>
      <div class="rt-holding-bep-label">평균단가(이익분기단가)</div>
      <div class="rt-holding-bep">${fmtNum(avg)}원(${fmtNum(bep)}원)</div>
      <div class="rt-holding-pnl">
        <span class="${cls} rt-holding-pnl-amt">${sign}${fmtNum(amt)}원</span>
        <span class="${cls} rt-holding-pnl-rate">${fmtPct(rate)}</span>
      </div>
    </div>
  `;
}

// 실시간 시세 수신 시 카드 현재가/평가손익 in-place 갱신.
function updateHoldingCardPrice(ticker, price) {
  const card = document.querySelector(`#rt-holdings-track [data-ticker="${ticker}"]`);
  if (!card) return;
  const avg = parseInt(card.dataset.avg, 10) || 0;
  const qty = parseInt(card.dataset.qty, 10) || 0;
  const curEl = card.querySelector('.rt-holding-cur');
  if (curEl) curEl.textContent = fmtNum(price) + '원';
  if (!avg || !qty) return;
  const amt  = (price - avg) * qty;
  const rate = ((price - avg) / avg) * 100;
  const cls  = pnlClass(amt);
  const sign = amt >= 0 ? '+' : '-';
  const amtEl  = card.querySelector('.rt-holding-pnl-amt');
  const rateEl = card.querySelector('.rt-holding-pnl-rate');
  if (amtEl)  { amtEl.textContent  = `${sign}${fmtNum(amt)}원`; amtEl.className  = `${cls} rt-holding-pnl-amt`; }
  if (rateEl) { rateEl.textContent = fmtPct(rate);              rateEl.className = `${cls} rt-holding-pnl-rate`; }
}

// [C] 체결 통보 후 계좌 재조회 디바운서.
// 부분체결 다수 수신 시 마지막 이벤트 기준 1.5초 후 1회만 loadAccount() 호출
// → 매수/매도 직후 수량·평단·BEP 자동 동기화. TR 호출 폭주 방지.
let _accountRefreshTimer = null;
function scheduleAccountRefresh(delayMs = 1500) {
  if (_accountRefreshTimer) clearTimeout(_accountRefreshTimer);
  _accountRefreshTimer = setTimeout(() => {
    _accountRefreshTimer = null;
    if (state.loggedIn) loadAccount();
  }, delayMs);
}

// 마우스 드래그로 가로 스크롤. CSS는 이미 overflow-x:auto + cursor:grab.
function setupHoldingsDragScroll() {
  const track = document.getElementById('rt-holdings-track');
  if (!track) return;
  let isDown = false, startX = 0, startScroll = 0;
  track.addEventListener('mousedown', (e) => {
    isDown = true;
    track.classList.add('dragging');
    startX = e.pageX;
    startScroll = track.scrollLeft;
  });
  const stop = () => { isDown = false; track.classList.remove('dragging'); };
  track.addEventListener('mouseleave', stop);
  track.addEventListener('mouseup',    stop);
  track.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    track.scrollLeft = startScroll - (e.pageX - startX);
  });
  // 휠 가로 스크롤 (선택)
  track.addEventListener('wheel', (e) => {
    if (e.deltaY === 0) return;
    track.scrollLeft += e.deltaY;
  }, { passive: true });
}

// ============ 관심종목 관리 ============
// addWatchlistTicker(ticker?, name?)
// - 인자 있으면(드롭다운 선택) 그대로 사용
// - 인자 없으면 input 값 기반: 6자리 숫자 → ticker로, 그 외 텍스트 → 검색 첫 결과 자동 선택
async function addWatchlistTicker(ticker, name) {
  const input = document.getElementById('rt-ticker-input');
  if (!ticker) {
    const raw     = (input.value || '').trim();
    const cleaned = raw.replace(/[^0-9]/g, '');
    if (raw.length > 0 && cleaned.length === 6 && cleaned === raw) {
      // 순수 6자리 숫자 입력 → ticker 직접 사용. 이름은 DB에서 보조 조회.
      ticker = cleaned;
      try {
        const r = await window.appAPI.searchStocks(ticker, 1);
        if (r.success && r.data && r.data[0]) name = r.data[0].name;
      } catch { /* DB 미연결이어도 ticker만으로 등록 */ }
    } else if (state.searchResults.length > 0) {
      // 텍스트 입력 + 드롭다운 결과 존재 → 활성 항목 또는 첫 결과
      const idx = state.searchActiveIdx >= 0 ? state.searchActiveIdx : 0;
      const r   = state.searchResults[idx];
      ticker = r.ticker;
      name   = r.name;
    } else {
      return; // 검색 결과 없음 → 무시
    }
  }
  if (!ticker || ticker === '000000') return;
  // US ticker(알파벳) 차단 — 실시간 거래는 KR 전용 (Phase A)
  if (!/^[0-9]{6}$/.test(ticker)) {
    alert('미국 주식 실시간 거래는 Phase B 예정.\n분석은 메인 창에서 가능합니다.');
    input.value = '';
    closeSearchDropdown();
    return;
  }
  if (state.watchlist.find(w => w.ticker === ticker)) {
    input.value = '';
    closeSearchDropdown();
    return;
  }
  state.watchlist.push({
    ticker, name: name || ticker,
    price: 0, change: 0, changeRate: 0, volume: 0, subscribed: false
  });
  input.value = '';
  closeSearchDropdown();
  renderWatchlist();
  // 호가/주문 종목 선택 드롭다운 업데이트
  updateTickerSelects();
  // 실패 시 메모리/DB 상태 분기 — 다음 세션 로드에서 발견됨
  try {
    const r = await window.appAPI.addWatchlistDB(ticker);
    if (!r || r.success !== true) console.error('[watchlist] DB 저장 실패:', r && r.error);
  } catch (e) {
    console.error('[watchlist] DB 저장 예외:', e);
  }
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

// ============ 종목 검색 자동완성 ============
// 입력 이벤트 → 250ms 디바운스 → DB 검색(`db:searchStocks`)
// 키보드: ArrowDown/Up 네비게이션, Enter 선택, Esc 닫기.
// mousedown 클릭(blur 이전)으로 항목 선택 → 드롭다운 닫힘 회피.
function setupTickerSearch() {
  const input = document.getElementById('rt-ticker-input');
  const list  = document.getElementById('rt-search-results');
  if (!input || !list) return;
  let searchTimer = null;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) { closeSearchDropdown(); return; }
    searchTimer = setTimeout(async () => {
      try {
        // 실시간 거래 창은 KR 종목만 검색 (Phase A: 미국 실시간 미지원)
        const res = await window.appAPI.searchStocks(q, 20, 'KR');
        if (!res.success) { closeSearchDropdown(); return; }
        state.searchResults   = res.data || [];
        state.searchActiveIdx = state.searchResults.length > 0 ? 0 : -1;
        renderSearchResults();
      } catch (e) {
        console.error('종목 검색 오류:', e);
        closeSearchDropdown();
      }
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    const n = state.searchResults.length;
    if (e.key === 'ArrowDown' && n > 0) {
      state.searchActiveIdx = (state.searchActiveIdx + 1) % n;
      renderSearchResults();
      e.preventDefault();
    } else if (e.key === 'ArrowUp' && n > 0) {
      state.searchActiveIdx = (state.searchActiveIdx - 1 + n) % n;
      renderSearchResults();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (state.searchActiveIdx >= 0 && state.searchResults[state.searchActiveIdx]) {
        const r = state.searchResults[state.searchActiveIdx];
        addWatchlistTicker(r.ticker, r.name);
      } else {
        addWatchlistTicker();
      }
      e.preventDefault();
    } else if (e.key === 'Escape') {
      closeSearchDropdown();
    }
  });

  // 외부 클릭 시 드롭다운 닫기 (검색 wrap 내부 클릭은 유지)
  document.addEventListener('click', (e) => {
    if (e.target.closest('.rt-search-wrap')) return;
    closeSearchDropdown();
  });
}

function renderSearchResults() {
  const list = document.getElementById('rt-search-results');
  if (!list) return;
  if (state.searchResults.length === 0) {
    list.innerHTML = '<li class="rt-sr-empty">검색 결과 없음</li>';
    list.style.display = '';
    return;
  }
  list.innerHTML = state.searchResults.map((r, i) => `
    <li data-idx="${i}" class="${i === state.searchActiveIdx ? 'active' : ''}">
      <span class="rt-sr-ticker">${r.ticker}</span>
      <span class="rt-sr-name">${escapeHTML(r.name || '')}</span>
      <span class="rt-sr-market">${escapeHTML(r.market || '')}</span>
    </li>
  `).join('');
  list.style.display = '';
  // mousedown으로 처리 → input blur보다 먼저 발생해 드롭다운 닫힘 회피
  list.querySelectorAll('li[data-idx]').forEach(li => {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const idx = parseInt(li.dataset.idx, 10);
      const r   = state.searchResults[idx];
      if (r) addWatchlistTicker(r.ticker, r.name);
    });
  });
  // 활성 항목 스크롤 가시화
  const active = list.querySelector('li.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function closeSearchDropdown() {
  const list = document.getElementById('rt-search-results');
  if (list) {
    list.style.display = 'none';
    list.innerHTML = '';
  }
  state.searchResults   = [];
  state.searchActiveIdx = -1;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

async function removeWatchlistTicker(ticker) {
  state.watchlist = state.watchlist.filter(w => w.ticker !== ticker);
  renderWatchlist();
  updateTickerSelects();
  window.appAPI.realUnsubscribe([ticker]).catch(() => {});
  // 실패 시 메모리/DB 상태 분기 — 다음 세션 로드에서 부활 가능성 있음
  try {
    const r = await window.appAPI.removeWatchlistDB(ticker);
    if (!r || r.success !== true) console.error('[watchlist] DB 삭제 실패:', r && r.error);
  } catch (e) {
    console.error('[watchlist] DB 삭제 예외:', e);
  }
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
    const changeClass = pnlClass(w.changeRate);
    return `<tr>
      <td>${w.ticker}</td>
      <td>${w.name}</td>
      <td class="rt-num ${changeClass}">${fmtNum(w.price)}</td>
      <td class="rt-num ${changeClass}">${fmtPct(w.changeRate)}</td>
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
  // 시장가 매수 추정금액 갱신용
  if (state.order.ticker === data.ticker && state.order.type === 'buy' && state.order.priceType === 'market') {
    updateOrderTotal();
  }

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
  updateOrderTotal();  // 매수/매도 전환 시 가용자금 표시 갱신
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

// 매수 시 예상 사용 금액 추정.
// 지정가: price × qty
// 시장가: 5호가 첫 매도호가(asks[0].price) × qty × 1.005 (슬리피지 마진 0.5%)
//        호가 없으면 추정 불가 → 0 반환
// 매도는 검증 불필요 — 가용금액 사용 없음.
function estimateBuyCost() {
  const qty = state.order.qty || 0;
  if (qty <= 0) return 0;
  if (state.order.priceType === 'market') {
    const askTop = state.orderbook.asks && state.orderbook.asks[0] && state.orderbook.asks[0].price;
    if (!askTop) return 0;
    return Math.ceil(askTop * qty * 1.005);
  }
  const price = state.order.price || 0;
  return price * qty;
}

function updateOrderTotal() {
  const price   = state.order.priceType === 'market' ? 0 : (state.order.price || 0);
  const qty     = state.order.qty || 0;
  const isBuy   = state.order.type === 'buy';
  const display = price * qty;
  const totalEl = document.getElementById('rt-order-total');
  totalEl.textContent = display > 0 ? fmtNum(display) + '원' : (isBuy && state.order.priceType === 'market' && qty > 0 ? '시장가 추정 →' : '-');

  // 가용자금 표시 (매수 시만). 초과면 빨강, 미만이면 평상.
  const orderableEl = document.getElementById('rt-order-orderable');
  const wrap = orderableEl && orderableEl.parentElement;
  if (!orderableEl || !wrap) return;
  if (!isBuy) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const orderable = (state.account && state.account.orderable) || 0;
  orderableEl.textContent = orderable > 0 ? fmtNum(orderable) + '원' : '-';
  const cost = estimateBuyCost();
  // 초과 또는 추정 0이면 색상 처리. 시장가 추정 0(호가 미수신)은 경고만.
  totalEl.classList.remove('over-orderable', 'market-estimate');
  wrap.classList.remove('over-orderable');
  if (cost > 0 && orderable > 0 && cost > orderable) {
    totalEl.classList.add('over-orderable');
    wrap.classList.add('over-orderable');
    // 시장가일 때는 추정 금액도 함께 표시
    if (state.order.priceType === 'market') {
      totalEl.textContent = '~' + fmtNum(cost) + '원 (시장가 추정)';
    }
  } else if (state.order.priceType === 'market' && cost > 0) {
    totalEl.textContent = '~' + fmtNum(cost) + '원 (시장가 추정)';
    totalEl.classList.add('market-estimate');
  }
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

  // 매수 사전 검증 — 가용자금 vs 예상 매수비용. 초과 시 confirm으로 사용자 확인.
  // 키움 서버가 거부할 수도 있지만 사전 차단이 더 안전.
  if (type === 'buy') {
    const orderable = (state.account && state.account.orderable) || 0;
    const cost = estimateBuyCost();
    if (priceType === 'market' && cost === 0) {
      if (!confirm(
        '시장가 매수 주문 — 호가 정보 없음으로 예상 금액 추정 불가.\n' +
        '가용자금 초과 시 키움 서버가 거부할 수 있습니다.\n\n' +
        '그래도 진행할까요?'
      )) return;
    } else if (cost > 0 && orderable > 0 && cost > orderable) {
      const overText = priceType === 'market' ? '예상 금액(시장가 추정)' : '주문 금액';
      const proceed = confirm(
        `⛔ 가용자금 초과\n\n` +
        `${overText}: ${fmtNum(cost)}원\n` +
        `가용자금: ${fmtNum(orderable)}원\n` +
        `초과액: ${fmtNum(cost - orderable)}원\n\n` +
        `키움 서버가 거부할 가능성이 매우 높습니다.\n` +
        `그래도 강제 전송할까요?`
      );
      if (!proceed) return;
    }
  }

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
        `${type === 'buy' ? '매수' : '매도'} 주문 요청 전송됨. ` +
        `${ticker} ${fmtNum(qty)}주 @ ${priceType === 'market' ? '시장가' : fmtNum(actualPrice) + '원'} — ` +
        `결과는 OPT10075 재조회로 확인 (2초)`
      );
      // 키움 모의서버 처리 시간 대기. SendOrder ret=0은 "전송 성공"이지 "주문 체결" 아님.
      // OnReceiveMsg 거부 사유는 onRealMessage 리스너에서 alert 표시.
      scheduleExecutionsRefresh(2000);
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
// 출처: 키움 OpenAPI OPT10075 (실시간미체결요청, 체결구분=0) — 실데이터.
// 메모리 캐시 사용 안 함. 창 재오픈 시에도 OpenAPI 호출로 정합성 보장.
function setupHistoryUI() {
  document.getElementById('btn-rt-refresh-history').addEventListener('click', () => {
    loadExecutions();
  });
}

// 키움 OpenAPI 조회 → state.pendingOrders / state.execHistory 덮어쓰기.
async function loadExecutions() {
  if (!state.loggedIn) {
    state.pendingOrders = [];
    state.execHistory   = [];
    renderPendingOrders();
    renderExecHistory();
    return;
  }
  const btn = document.getElementById('btn-rt-refresh-history');
  if (btn) { btn.disabled = true; btn.textContent = '조회 중...'; }
  try {
    const res = await window.appAPI.realGetExecutions();
    if (res && res.success) {
      state.pendingOrders = res.pending || [];
      state.execHistory   = res.filled  || [];
      renderPendingOrders();
      renderExecHistory();
    } else {
      console.warn('체결내역 조회 실패:', res && res.error);
    }
  } catch (e) {
    console.error('체결내역 조회 예외:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '새로고침'; }
  }
}

// 부분체결 다수 수신 시 마지막 이벤트 기준 1회만 OPT10075 재조회. TR 호출 폭주 방지.
let _executionsRefreshTimer = null;
function scheduleExecutionsRefresh(delayMs = 800) {
  if (_executionsRefreshTimer) clearTimeout(_executionsRefreshTimer);
  _executionsRefreshTimer = setTimeout(() => {
    _executionsRefreshTimer = null;
    if (state.loggedIn) loadExecutions();
  }, delayMs);
}

// 출처: OPT10075 응답. 필드: orderNo, ticker, name, side, orderQty, orderPrice, remainQty, state...
function renderPendingOrders() {
  const tbody = document.getElementById('rt-pending-tbody');
  const empty = document.getElementById('rt-pending-empty');
  const count = document.getElementById('rt-pending-count');
  const pending = state.pendingOrders;
  count.textContent = pending.length;

  if (pending.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  // orderNo로 취소 버튼 식별 — OPT10075 응답 기준
  tbody.innerHTML = pending.map(o => `<tr>
    <td>${o.ticker}${o.name ? ' ' + escapeHTML(o.name) : ''}</td>
    <td class="${o.side === 'buy' ? 'bullish' : 'bearish'}">${o.side === 'buy' ? '매수' : '매도'}</td>
    <td class="rt-num">${o.orderPrice > 0 ? fmtNum(o.orderPrice) : '시장가'}</td>
    <td class="rt-num">${fmtNum(o.orderQty)}</td>
    <td class="rt-num">${fmtNum(o.remainQty)}</td>
    <td>${o.orderNo || '-'}</td>
    <td>
      <button class="rt-btn rt-btn-sm" onclick="cancelPending('${o.orderNo}')">취소</button>
    </td>
  </tr>`).join('');
}

async function cancelPending(orderNo) {
  const order = state.pendingOrders.find(o => o.orderNo === orderNo && o.remainQty > 0);
  if (!order) return;
  if (!confirm(`${order.ticker} ${order.side === 'buy' ? '매수' : '매도'} 주문을 취소하시겠습니까?`)) return;
  // 키움 주문취소 nOrderType: 매수취소=3, 매도취소=4
  const orderType = order.side === 'buy' ? 3 : 4;
  const res = await window.appAPI.realCancelOrder(order.ticker, order.remainQty, order.orderNo, orderType);
  if (res.success) {
    // 키움 OpenAPI 재조회로 정합성 확보 (메모리 직접 갱신 안 함)
    scheduleExecutionsRefresh(500);
  } else {
    alert(`취소 실패: ${res.error}`);
  }
}

// 출처: OPT10075 응답(filled). 필드: orderTime, ticker, name, side, execPrice, execQty, state...
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
    <td>${e.orderTime || '-'}</td>
    <td>${e.ticker || '-'}${e.name ? ' ' + escapeHTML(e.name) : ''}</td>
    <td class="${e.side === 'buy' ? 'bullish' : 'bearish'}">${e.side === 'buy' ? '매수' : '매도'}</td>
    <td class="rt-num">${fmtNum(e.execPrice)}</td>
    <td class="rt-num">${fmtNum(e.execQty)}</td>
    <td class="rt-num">${fmtNum(e.execTotal || (e.execPrice || 0) * (e.execQty || 0))}</td>
    <td>${e.state || '-'}</td>
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
      item.price      = data.price;
      item.change     = data.change;
      item.changeRate = data.changeRate != null ? data.changeRate : item.changeRate;
      item.volume     = data.volume;
      renderWatchlist();
    }
    // 보유종목 카드 현재가/평가손익 in-place 갱신
    updateHoldingCardPrice(data.ticker, data.price);
    // 호가 탭에서 선택된 종목이면 현재가 표시 갱신
    if (state.orderbook.ticker === data.ticker) {
      const priceEl  = document.getElementById('rt-ob-price');
      const changeEl = document.getElementById('rt-ob-change');
      const curEl    = document.getElementById('rt-ob-current');
      const rate     = data.changeRate != null ? data.changeRate : 0;
      priceEl.textContent  = fmtNum(data.price);
      priceEl.className    = `rt-ob-price ${pnlClass(rate)}`;
      changeEl.textContent = fmtPct(rate);
      changeEl.className   = `rt-ob-change ${pnlClass(rate)}`;
      curEl.textContent    = `현재가 ${fmtNum(data.price)}`;
    }
  });

  // 호가 갱신
  window.appAPI.onRealOrderbook((data) => {
    renderOrderbook(data);
  });

  // 체결 통보 — 키움 OnReceiveChejanData 알림 신호로만 사용. 데이터 자체는 OPT10075 재조회로 채움.
  window.appAPI.onRealExecution(() => {
    // 부분체결 다수 수신 시 디바운스 후 OPT10075 1회 재조회
    scheduleExecutionsRefresh();
    // 계좌(예수금/평단/평가)도 동기화
    scheduleAccountRefresh();
  });

  // 키움 서버 메시지 — 주문 거부 사유, 호가단위 오류, 잔고부족 등
  window.appAPI.onRealMessage((data) => {
    const msg = (data && data.message) || '';
    if (!msg) return;
    console.warn(`[kiwoom MSG] rqname=${data.rqname} trcode=${data.trcode} msg=${msg}`);
    // 사용자에게 토스트(주문 결과 영역 재활용)로 표시
    showOrderResult('error', `키움 서버: ${msg}`);
  });

  // 브릿지 오류 — 재연결 버튼 표시 (alert 제거)
  window.appAPI.onRealBridgeError(() => {
    updateStatusUI('disconnected', '브릿지 연결 끊김');
    document.getElementById('btn-rt-reconnect').style.display = '';
  });

  // 창 닫힐 때: 로그인 상태면 로그아웃 후 리스너 정리
  window.addEventListener('beforeunload', () => {
    if (state.loggedIn) {
      window.appAPI.realLogout().catch(() => {});
    }
    window.appAPI.removeRealListeners();
  });
}
