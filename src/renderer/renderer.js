// src/renderer/renderer.js
// 렌더러 프로세스 메인 스크립트. 모든 통신은 window.appAPI(preload.js) 경유.

// ============ 날짜 프리셋 계산 ============
function calcDateRange(preset) {
  if (preset === 'all') return { from: null, to: null };
  const now  = new Date();
  const from = new Date(now);
  const map  = {
    '1w': () => from.setDate(from.getDate() - 7),
    '1m': () => from.setMonth(from.getMonth() - 1),
    '3m': () => from.setMonth(from.getMonth() - 3),
    '6m': () => from.setMonth(from.getMonth() - 6),
    '1y': () => from.setFullYear(from.getFullYear() - 1),
    '2y': () => from.setFullYear(from.getFullYear() - 2),
    '3y': () => from.setFullYear(from.getFullYear() - 3),
    '5y': () => from.setFullYear(from.getFullYear() - 5)
  };
  if (map[preset]) map[preset]();
  return { from: from.toISOString().slice(0, 10), to: null };
}

// localStorage 핀 종목 영속화 ───────────────
// 주의: 이 두 정의는 반드시 state 선언 *이전*에 있어야 한다.
// state 초기화에서 loadPinnedTickers()를 호출하므로 PINNED_KEY가 TDZ에 걸리면
// catch로 흡수되어 항상 빈 배열만 반환되는 침묵 버그가 난다.
const PINNED_KEY = 'pinned_tickers_v1';

function loadPinnedTickers() {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(t => typeof t === 'string') : [];
  } catch (e) {
    console.warn('핀 로드 실패:', e);
    return [];
  }
}

function savePinnedTickers() {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(state.pinnedTickers));
  } catch (e) {
    console.warn('핀 저장 실패:', e);
  }
}

// ============ 앱 상태 ============
const state = {
  ticker:   '053800',
  // 데이터 로딩 기본 1년 — 차트는 최근 6개월만 가시, 그 이전은 좌측 드래그로 탐색
  fromDate: calcDateRange('1y').from,
  toDate:   null,
  engine:   'ollama',
  ollamaModel: localStorage.getItem('last_ollama_model') || null,
  // 종목 목록 전체 캐시 — 검색/필터 시 DB 재호출 없이 메모리에서 처리
  allStocks: [],
  searchKeyword: '',
  marketFilter: '',
  // 핀(체크) 종목 — localStorage 영속화. 탭으로 노출 + 백그라운드 프리로드.
  pinnedTickers: loadPinnedTickers(),
  // 프리로드 캐시 — ticker → { dataResult, infoResult, holdingsResult, fetchedAt }
  prefetchCache: new Map(),
  // 캐시 TTL — 5분(장중 갱신 고려)
  prefetchTtlMs: 5 * 60 * 1000
};

// ============ 초기화 ============
document.addEventListener('DOMContentLoaded', async () => {
  try { window.initCharts(); } catch (e) { console.error('차트 초기화 실패:', e); }
  try { await loadStockList(); } catch (e) { console.error('종목목록 로딩 실패:', e); }
  try { await loadOllamaModels(); } catch (e) { console.error('모델 목록 로딩 실패:', e); }
  try { await loadStockData(); } catch (e) {
    console.error('데이터 로딩 실패:', e);
    document.getElementById('status-bar').textContent = '데이터 없음';
  }
  setupEventListeners();
  setupResizeHandle();
  // 핀 종목 탭 렌더 + 탭 이벤트 + 백그라운드 프리로드 (앱 첫 진입 시 한 번)
  setupTickerTabs();
  renderTickerTabs();
  prefetchPinned();
  // 스캐너 설정 UI 초기화
  try { await initScannerConfigUI(); } catch (e) { console.warn('스캐너 설정 UI 초기화 실패:', e); }
  // 마지막 스캔 결과 복원 (비동기, 실패해도 앱 진입 영향 없음)
  try { await restoreScanResults(); } catch (e) { console.warn('스캔 결과 복원 실패:', e); }
  // 실시간 거래 버튼 + 계좌 패널 이벤트 초기화
  try { setupRealTradingUI(); } catch (e) { console.warn('실시간 거래 UI 초기화 실패:', e); }
});

// ============ Ollama 모델 목록 로드 ============
async function loadOllamaModels() {
  const select = document.getElementById('ollama-model-select');
  if (!select) return;
  const result = await window.appAPI.listOllamaModels();
  if (!result || !result.success || !result.models.length) {
    select.innerHTML = '<option value="">모델 없음</option>';
    return;
  }
  select.innerHTML = result.models
    .map(m => `<option value="${m.name}">${m.name}</option>`)
    .join('');
  // 마지막 사용 모델 복원, 없으면 첫번째 모델
  const saved = state.ollamaModel;
  const exists = result.models.some(m => m.name === saved);
  state.ollamaModel = exists ? saved : result.models[0].name;
  select.value = state.ollamaModel;
}

// ============ 데이터 로딩 ============

async function loadStockList() {
  const result = await window.appAPI.getStockList();
  if (!result || !result.success) return;

  // 전체 종목을 상태에 캐싱 — 검색/필터에서 DB 재호출 없이 메모리 필터링
  state.allStocks = result.data || [];

  // 헤더 드롭다운에는 전체 종목 채움 (변경 빈도 낮음)
  const select = document.getElementById('ticker-select');
  if (select) {
    select.innerHTML = state.allStocks
      .map(s => `<option value="${s.ticker}">${s.ticker} ${s.name}</option>`)
      .join('');
    select.value = state.ticker;
  }

  // 헤더 검색 자동완성용 datalist — 종목명 + 코드 표시
  const dl = document.getElementById('header-stock-datalist');
  if (dl) {
    dl.innerHTML = state.allStocks
      .map(s => `<option value="${s.ticker}" label="${escapeHtml(s.name || '')} (${s.market || ''})">${escapeHtml(s.name || '')}</option>`)
      .join('');
  }

  // 사이드바 목록은 현재 검색/필터 조건 적용해서 렌더
  renderStockList();
}

// ============ 헤더 검색 — 종목코드/명 → 선택 ============
function resolveHeaderSearch(rawInput) {
  if (!rawInput) return null;
  const v = rawInput.trim();
  if (!v) return null;
  // 1) 정확한 ticker 일치 우선
  const exactByTicker = state.allStocks.find(s => s.ticker === v);
  if (exactByTicker) return exactByTicker;
  // 2) 정확한 종목명 일치
  const exactByName = state.allStocks.find(s => (s.name || '') === v);
  if (exactByName) return exactByName;
  // 3) 부분 일치 — 코드 우선, 그 다음 종목명
  const lower = v.toLowerCase();
  const partial = state.allStocks.find(s =>
    (s.ticker || '').toLowerCase().startsWith(lower)
    || (s.name || '').toLowerCase().includes(lower)
  );
  return partial || null;
}

// ============ 사이드바 목록 렌더 + 검색/필터 ============

function renderStockList() {
  const ul = document.getElementById('stock-list');
  if (!ul) return;

  const kw = (state.searchKeyword || '').trim().toLowerCase();
  const mkt = state.marketFilter || '';

  // 필터링 — 종목코드/종목명 부분 일치 + 시장 일치
  const filtered = state.allStocks.filter(s => {
    if (mkt && s.market !== mkt) return false;
    if (!kw) return true;
    return (
      (s.ticker || '').toLowerCase().includes(kw) ||
      (s.name || '').toLowerCase().includes(kw)
    );
  });

  // 카운트 표시
  const countEl = document.getElementById('stock-count');
  if (countEl) {
    countEl.textContent = `(${filtered.length.toLocaleString()}/${state.allStocks.length.toLocaleString()})`;
  }

  // 빈 결과 처리
  if (!filtered.length) {
    ul.innerHTML = '<li class="empty">검색 결과 없음</li>';
    return;
  }

  // 핀 종목 빠른 조회용 Set
  const pinnedSet = new Set(state.pinnedTickers);

  // 단일 innerHTML 할당 — 2,768개여도 1프레임 내 완료
  ul.innerHTML = filtered
    .map(s => {
      const active = s.ticker === state.ticker ? ' active' : '';
      const checked = pinnedSet.has(s.ticker) ? ' checked' : '';
      return `<li data-ticker="${s.ticker}" class="stock-item${active}">`
        + `<input type="checkbox" class="pin-checkbox" data-ticker="${s.ticker}"${checked} title="핀(프리로드)">`
        + `<span class="stock-ticker">${s.ticker}</span>`
        + `<span class="stock-name">${escapeHtml(s.name || '')}</span>`
        + `<span class="stock-market">${s.market || ''}</span>`
        + `</li>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 입력 디바운스 — 빠른 타이핑 시 매 키마다 재렌더 방지
function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ============ 종목 선택 (사이드바 행 클릭 + 탭 클릭 공통 진입) ============
function selectTicker(ticker) {
  if (!ticker || ticker === state.ticker) return;
  state.ticker = ticker;
  const sel = document.getElementById('ticker-select');
  if (sel) sel.value = ticker;
  // 사이드바 active 갱신
  document.querySelectorAll('#stock-list li').forEach(el => {
    el.classList.toggle('active', el.dataset.ticker === ticker);
  });
  // 탭 active 갱신
  document.querySelectorAll('#ticker-tabs .ticker-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.ticker === ticker);
  });
  loadStockData();
}

// ============ 핀(체크) 토글 ============
function togglePin(ticker, checked) {
  if (!ticker) return;
  const idx = state.pinnedTickers.indexOf(ticker);
  if (checked && idx < 0) {
    state.pinnedTickers.push(ticker);
  } else if (!checked && idx >= 0) {
    state.pinnedTickers.splice(idx, 1);
    // 핀 해제 시 캐시도 정리 — 메모리 절약
    state.prefetchCache.delete(ticker);
  } else {
    return;
  }
  savePinnedTickers();
  renderTickerTabs();
  // 새로 핀된 종목만 백그라운드 프리로드
  if (checked) prefetchTicker(ticker);
}

// ============ 핀 종목 탭 렌더 ============
function renderTickerTabs() {
  const wrap = document.getElementById('ticker-tabs');
  if (!wrap) return;

  if (!state.pinnedTickers.length) {
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';

  // 종목명 조회용 lookup
  const lookup = new Map(state.allStocks.map(s => [s.ticker, s.name || '']));

  wrap.innerHTML = state.pinnedTickers
    .map(t => {
      const name = lookup.get(t) || '';
      const active = t === state.ticker ? ' active' : '';
      const cached = state.prefetchCache.has(t) ? ' cached' : '';
      return `<div class="ticker-tab${active}${cached}" data-ticker="${t}" title="${escapeHtml(name)}">`
        + `<span class="tab-ticker">${t}</span>`
        + (name ? `<span class="tab-name">${escapeHtml(name)}</span>` : '')
        + `<button class="tab-close" data-ticker="${t}" title="닫기">×</button>`
        + `</div>`;
    })
    .join('');
}

// 탭 클릭 / 닫기 이벤트 위임
function setupTickerTabs() {
  const wrap = document.getElementById('ticker-tabs');
  if (!wrap) return;
  wrap.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.tab-close');
    if (closeBtn) {
      e.stopPropagation();
      const t = closeBtn.dataset.ticker;
      // 핀 해제 — 사이드바 체크박스도 동기화 필요
      const cb = document.querySelector(`.pin-checkbox[data-ticker="${t}"]`);
      if (cb) cb.checked = false;
      togglePin(t, false);
      return;
    }
    const tab = e.target.closest('.ticker-tab[data-ticker]');
    if (tab) selectTicker(tab.dataset.ticker);
  });
}

// ============ 프리로드 — 캐시 채우기 ============
async function prefetchTicker(ticker) {
  if (!ticker) return;
  // 이미 신선한 캐시가 있으면 skip
  const hit = state.prefetchCache.get(ticker);
  if (hit && (Date.now() - hit.fetchedAt) < state.prefetchTtlMs) return;

  try {
    const [dataResult, infoResult, holdingsResult] = await Promise.all([
      window.appAPI.getStockData(ticker, state.fromDate, state.toDate),
      window.appAPI.getStockInfo(ticker),
      window.appAPI.getHoldings(ticker)
    ]);
    state.prefetchCache.set(ticker, {
      dataResult, infoResult, holdingsResult,
      fetchedAt: Date.now(),
      fromDate: state.fromDate,
      toDate:   state.toDate
    });
    renderTickerTabs();  // cached 마크 갱신
  } catch (e) {
    console.warn('프리로드 실패:', ticker, e);
  }
}

// 핀 전체를 백그라운드로 순차 프리로드 (0.4초 간격 — DB 부하 분산)
async function prefetchPinned() {
  for (const t of state.pinnedTickers.slice()) {
    if (t === state.ticker) continue;
    await prefetchTicker(t);
    await new Promise(r => setTimeout(r, 400));
  }
}

async function loadStockData() {
  const { ticker, fromDate, toDate } = state;
  if (!ticker) return;

  const statusEl = document.getElementById('status-bar');

  // 종목 변경 시 채팅 이력도 함께 로드
  loadChatForCurrentTicker();

  // 캐시 히트 우선 — fromDate/toDate 일치 + TTL 유효 시
  const cached = state.prefetchCache.get(ticker);
  const cacheValid = cached
    && cached.fromDate === fromDate
    && cached.toDate   === toDate
    && (Date.now() - cached.fetchedAt) < state.prefetchTtlMs;

  let dataResult, infoResult, holdingsResult;
  if (cacheValid) {
    if (statusEl) statusEl.textContent = '캐시 적용 중...';
    ({ dataResult, infoResult, holdingsResult } = cached);
  } else {
    if (statusEl) statusEl.textContent = '로딩 중...';
    [dataResult, infoResult, holdingsResult] = await Promise.all([
      window.appAPI.getStockData(ticker, fromDate, toDate),
      window.appAPI.getStockInfo(ticker),
      window.appAPI.getHoldings(ticker)
    ]);
    // 핀 종목이면 캐시에 저장 — 다음 진입 시 즉시 표시
    if (state.pinnedTickers.includes(ticker)) {
      state.prefetchCache.set(ticker, {
        dataResult, infoResult, holdingsResult,
        fetchedAt: Date.now(), fromDate, toDate
      });
      renderTickerTabs();
    }
  }

  if (dataResult && dataResult.success && dataResult.data.length > 0) {
    window.updateCharts(dataResult.data, infoResult.data || {});
    generateReport(dataResult.data, infoResult.data || {});
    const last = dataResult.data[dataResult.data.length - 1];
    document.getElementById('status-bar').textContent =
      `${ticker} | 종가 ${last.close.toLocaleString()}원 | ${dataResult.data.length}일`;
  } else {
    document.getElementById('status-bar').textContent = '데이터 없음';
  }

  if (holdingsResult && holdingsResult.data) {
    populateHoldingsForm(holdingsResult.data);
  }

  // 박스권 정보도 폼에 채우기
  if (infoResult && infoResult.data) {
    const si = infoResult.data;
    const setIfNotEmpty = (id, val) => {
      if (val != null) document.getElementById(id).value = val;
    };
    setIfNotEmpty('box-low',  si.box_low);
    setIfNotEmpty('box-high', si.box_high);
  }
}

// ============ 이벤트 핸들러 ============

function setupEventListeners() {
  // 종목 선택 드롭다운
  document.getElementById('ticker-select').addEventListener('change', (e) => {
    state.ticker = e.target.value;
    if (state.ticker) loadStockData();
  });

  // 날짜 프리셋 드롭다운
  document.getElementById('date-range').addEventListener('change', (e) => {
    const preset = e.target.value;
    const customWrap = document.getElementById('custom-date-wrap');
    if (preset === 'custom') {
      customWrap.style.display = '';
      return;
    }
    customWrap.style.display = 'none';
    const { from, to } = calcDateRange(preset);
    state.fromDate = from;
    state.toDate   = to;
    // 기간 변경 시 기존 캐시는 무효 — 비우고 핀 종목 재프리로드
    state.prefetchCache.clear();
    renderTickerTabs();
    loadStockData();
    prefetchPinned();
  });

  // 조회 버튼 — 커스텀 날짜 직접 입력 시
  document.getElementById('btn-load').addEventListener('click', () => {
    state.fromDate = document.getElementById('from-date').value || null;
    state.toDate   = document.getElementById('to-date').value   || null;
    state.prefetchCache.clear();
    renderTickerTabs();
    loadStockData();
    prefetchPinned();
  });

  // 사이드바 종목 목록 — 체크박스 토글 vs 행 클릭 분리
  document.getElementById('stock-list').addEventListener('click', (e) => {
    // 체크박스 클릭 = 핀 토글 (행 선택 없음)
    const cb = e.target.closest('.pin-checkbox');
    if (cb) {
      e.stopPropagation();
      togglePin(cb.dataset.ticker, cb.checked);
      return;
    }
    // 그 외 행 클릭 = 종목 선택
    const li = e.target.closest('li[data-ticker]');
    if (!li) return;
    selectTicker(li.dataset.ticker);
  });

  // 헤더 종목 검색 — Enter 또는 조회 버튼으로 선택
  const headerSearch = document.getElementById('header-stock-search');
  const headerSearchBtn = document.getElementById('btn-header-search');
  const headerSearchSubmit = () => {
    if (!headerSearch) return;
    const matched = resolveHeaderSearch(headerSearch.value);
    if (!matched) {
      document.getElementById('status-bar').textContent = '검색 결과 없음';
      return;
    }
    headerSearch.value = `${matched.ticker} ${matched.name || ''}`.trim();
    selectTicker(matched.ticker);
  };
  if (headerSearch) {
    headerSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        headerSearchSubmit();
      }
    });
    // datalist에서 항목 선택 시 즉시 적용
    headerSearch.addEventListener('change', () => {
      // change는 datalist 항목 클릭 시에도 발동
      const matched = resolveHeaderSearch(headerSearch.value);
      if (matched && matched.ticker !== state.ticker) {
        selectTicker(matched.ticker);
      }
    });
  }
  if (headerSearchBtn) {
    headerSearchBtn.addEventListener('click', headerSearchSubmit);
  }

  // 종목 검색 입력 — 200ms 디바운스
  const searchInput = document.getElementById('stock-search');
  if (searchInput) {
    const onSearch = debounce(() => {
      state.searchKeyword = searchInput.value;
      renderStockList();
    }, 200);
    searchInput.addEventListener('input', onSearch);
    // Esc 키로 검색어 초기화
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        state.searchKeyword = '';
        renderStockList();
      }
    });
  }

  // 시장 필터 (KOSPI/KOSDAQ/전체)
  const marketFilter = document.getElementById('stock-market-filter');
  if (marketFilter) {
    marketFilter.addEventListener('change', (e) => {
      state.marketFilter = e.target.value;
      renderStockList();
    });
  }

  // 종목 추가
  document.getElementById('btn-add-ticker').addEventListener('click', async () => {
    const ticker = document.getElementById('new-ticker').value.trim().toUpperCase();
    const name   = document.getElementById('new-name').value.trim();
    const market = document.getElementById('new-market').value;
    if (!ticker || !name) { alert('종목코드와 종목명을 입력하세요'); return; }

    const result = await window.appAPI.addTicker({ ticker, name, market });
    if (result && result.success) {
      document.getElementById('new-ticker').value = '';
      document.getElementById('new-name').value   = '';
      await loadStockList();
    }
  });

  // CSV Import
  document.getElementById('btn-csv-select').addEventListener('click', async () => {
    const filePath = await window.appAPI.openFileDialog();
    if (!filePath) return;

    const resultEl = document.getElementById('csv-result');
    resultEl.textContent = '가져오는 중...';

    const result = await window.appAPI.importCsv(filePath, state.ticker);
    if (result.success) {
      resultEl.textContent = `완료: ${result.inserted}건 추가, ${result.duplicates}건 중복`;
      if (result.inserted > 0) await loadStockData();
    } else {
      resultEl.textContent = `실패: ${result.errors[0] || '알 수 없는 오류'}`;
    }
  });

  // 보유현황 저장
  document.getElementById('btn-save-holdings').addEventListener('click', async () => {
    const holdings = {
      ticker:         state.ticker,
      avg_price:      parseInt(document.getElementById('avg-price').value)      || null,
      quantity:       parseInt(document.getElementById('quantity').value)       || null,
      available_cash: parseInt(document.getElementById('available-cash').value) || null,
      strategy:       document.getElementById('strategy').value                 || null,
      expected_issue: document.getElementById('expected-issue').value           || null,
      box_low:        parseInt(document.getElementById('box-low').value)        || null,
      box_high:       parseInt(document.getElementById('box-high').value)       || null
    };
    const result = await window.appAPI.updateHoldings(holdings);
    if (result && result.success) {
      alert('보유현황이 저장되었습니다.');
      await loadStockData();
    } else {
      alert('저장 실패: ' + (result?.error || '알 수 없는 오류'));
    }
  });

  // AI 채팅 전송
  document.getElementById('btn-send-chat').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // 이미지 첨부 버튼 클릭 → 파일 선택 다이얼로그
  document.getElementById('btn-attach-image').addEventListener('click', () => {
    document.getElementById('attach-file-input').click();
  });

  // 파일 선택 처리
  document.getElementById('attach-file-input').addEventListener('change', (e) => {
    addAttachFiles(e.target.files);
    e.target.value = ''; // 동일 파일 재선택 허용
  });

  // 채팅 입력창 클립보드 붙여넣기 (Ctrl+V 캡처 이미지)
  document.getElementById('chat-input').addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData.items || []);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault(); // 텍스트로 붙여넣기 방지
    imageItems.forEach(item => {
      const file = item.getAsFile();
      if (file) addAttachFiles([file]);
    });
  });

  // 채팅 입력창 드래그 앤 드롭
  const chatInput = document.getElementById('chat-input');
  chatInput.addEventListener('dragover', (e) => { e.preventDefault(); chatInput.classList.add('drag-over'); });
  chatInput.addEventListener('dragleave', () => chatInput.classList.remove('drag-over'));
  chatInput.addEventListener('drop', (e) => {
    e.preventDefault();
    chatInput.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) addAttachFiles(files);
  });

  // MA120 체크박스 — maChart 4번 데이터셋 hidden 토글
  const chkMa120 = document.getElementById('chk-ma120');
  if (chkMa120) {
    chkMa120.addEventListener('change', () => {
      if (!window.maChart) return;
      const ds = window.maChart.data.datasets[4];
      if (ds) { ds.hidden = !chkMa120.checked; window.maChart.update('none'); }
    });
  }

  // 엔진 전환 (Ollama/Claude 뱃지 클릭)
  document.querySelectorAll('.engine-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.engine = btn.dataset.engine;
      document.querySelectorAll('.engine-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Claude 선택 시 모델 select 숨김 (Ollama 전용)
      const modelSel = document.getElementById('ollama-model-select');
      if (modelSel) modelSel.style.display = state.engine === 'ollama' ? '' : 'none';
    });
  });

  // Ollama 모델 변경 — localStorage 저장
  const modelSelect = document.getElementById('ollama-model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', (e) => {
      state.ollamaModel = e.target.value;
      localStorage.setItem('last_ollama_model', state.ollamaModel);
    });
  }

  // 박스권 스캔 실행
  const btnScan = document.getElementById('btn-box-scan');
  if (btnScan) {
    btnScan.addEventListener('click', async () => {
      await runBoxScanUI();
    });
  }

  // 스캔 결과 보기 버튼
  const btnShowScan = document.getElementById('btn-show-scan-results');
  if (btnShowScan) {
    btnShowScan.addEventListener('click', () => {
      document.getElementById('scan-panel').style.display = 'flex';
    });
  }

  // 스캔 패널 닫기
  const btnCloseScan = document.getElementById('btn-close-scan-panel');
  if (btnCloseScan) {
    btnCloseScan.addEventListener('click', () => {
      document.getElementById('scan-panel').style.display = 'none';
    });
  }

  // 백테스트 실행
  const btnBacktest = document.getElementById('btn-run-backtest');
  if (btnBacktest) {
    btnBacktest.addEventListener('click', async () => {
      await runBacktestUI();
    });
  }

  // 백테스트 패널 닫기
  const btnCloseBacktest = document.getElementById('btn-close-backtest');
  if (btnCloseBacktest) {
    btnCloseBacktest.addEventListener('click', () => {
      document.getElementById('backtest-panel').style.display = 'none';
    });
  }

  // 채팅 이력 초기화
  document.getElementById('btn-chat-clear').addEventListener('click', async () => {
    if (!state.ticker) return;
    if (!confirm(`${state.ticker} 종목의 채팅 이력을 모두 삭제하시겠습니까?`)) return;
    const result = await window.appAPI.clearChatHistory(state.ticker);
    if (result && result.success) {
      document.getElementById('chat-messages').innerHTML = '';
    } else {
      alert('삭제 실패: ' + (result?.error || '알 수 없는 오류'));
    }
  });
}

// ============ 채팅 이력 로드 ============

async function loadChatForCurrentTicker() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';
  if (!state.ticker) return;

  const result = await window.appAPI.loadChatHistory(state.ticker);
  if (!result || !result.success || !result.data || !result.data.length) return;

  result.data.forEach(msg => {
    appendChatMessage(msg.role, msg.content);
  });
}

// ============ 채팅창 리사이즈 핸들 ============

function setupResizeHandle() {
  const handle    = document.getElementById('chat-resize-handle');
  const chatPanel = document.querySelector('.chat-panel');
  if (!handle || !chatPanel) return;

  let isResizing = false;

  handle.addEventListener('mousedown', e => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!isResizing) return;
    const container = document.querySelector('.main-content');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const newWidth = Math.max(200, Math.min(600, rect.right - e.clientX));
    chatPanel.style.width = newWidth + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ============ AI 채팅 이미지 첨부 관리 ============

// 첨부 이미지 상태: [{ base64, mediaType, previewUrl, name }]
const attachedImages = [];

/**
 * File 배열을 읽어 attachedImages에 추가 + 미리보기 렌더링
 * @param {FileList|File[]} files
 */
function addAttachFiles(files) {
  Array.from(files).forEach(file => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      // data:image/png;base64,<base64> → base64만 추출
      const base64 = dataUrl.split(',')[1];
      attachedImages.push({ base64, mediaType: file.type, previewUrl: dataUrl, name: file.name });
      renderAttachPreviews();
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 첨부 이미지 미리보기 패널 렌더링
 */
function renderAttachPreviews() {
  const panel = document.getElementById('chat-attachments');
  if (attachedImages.length === 0) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  panel.style.display = 'flex';
  panel.innerHTML = attachedImages.map((img, i) => `
    <div class="attach-preview-item" data-idx="${i}">
      <img src="${img.previewUrl}" alt="${img.name}" title="${img.name}">
      <button class="attach-remove-btn" data-idx="${i}" title="제거">✕</button>
    </div>
  `).join('');
  panel.querySelectorAll('.attach-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      attachedImages.splice(idx, 1);
      renderAttachPreviews();
    });
  });
}

/**
 * 첨부 이미지 전체 초기화
 */
function clearAttachments() {
  attachedImages.length = 0;
  renderAttachPreviews();
}

// ============ AI 채팅 ============

async function sendChat() {
  const input   = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message && attachedImages.length === 0) return;

  const msgText = message || '이 이미지를 분석해주세요.';
  input.value = '';

  // 사용자 메시지 버블 (이미지 썸네일 + 텍스트)
  appendChatMessage('user', msgText, [...attachedImages]);
  const currentImages = [...attachedImages];
  clearAttachments();

  const assistantBubble = appendChatMessage('assistant', '');
  let rawText = '';

  window.appAPI.removeAiListeners();

  window.appAPI.onAiChunk(({ content }) => {
    rawText += content;
    assistantBubble.innerHTML = simpleMarkdown(rawText);
    // 스크롤 없음 — 사용자가 질문 위치에서 답변을 읽어 내려가도록
  });

  window.appAPI.onAiDone(({ engine, tokens, mode }) => {
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#666;margin-top:4px;';
    const imgNote = currentImages.length > 0 ? ` | 이미지 ${currentImages.length}장` : '';
    meta.textContent = `[${engine}] ${mode || ''} | ${tokens || 0} tokens${imgNote}`;
    assistantBubble.parentElement.appendChild(meta);

    // 후속 질문 제안 파싱 → 클릭 버튼 렌더링
    const suggestions = extractFollowUpSuggestions(rawText);
    if (suggestions.length > 0) {
      renderFollowUpButtons(suggestions, assistantBubble.parentElement);
    }
  });

  window.appAPI.sendChat(msgText, state.ticker, state.engine, state.ollamaModel, currentImages);
}

/**
 * 채팅 메시지 버블 추가
 * @param {string} role     - 'user' | 'assistant'
 * @param {string} content  - 텍스트 내용
 * @param {Array}  images   - 첨부 이미지 배열 [{ previewUrl, name }] (user 메시지 전용)
 */
function appendChatMessage(role, content, images) {
  const messages = document.getElementById('chat-messages');
  const wrapper  = document.createElement('div');
  wrapper.style.cssText = `display:flex; flex-direction:column; align-items:${role === 'user' ? 'flex-end' : 'flex-start'};`;

  // 이미지 썸네일 (user 메시지 + 이미지 첨부 시)
  if (role === 'user' && images && images.length > 0) {
    const imgRow = document.createElement('div');
    imgRow.className = 'chat-msg-images';
    images.forEach(img => {
      const thumb = document.createElement('img');
      thumb.src = img.previewUrl;
      thumb.alt = img.name || '첨부 이미지';
      thumb.className = 'chat-msg-thumb';
      thumb.title = img.name || '첨부 이미지';
      imgRow.appendChild(thumb);
    });
    wrapper.appendChild(imgRow);
  }

  const bubble = document.createElement('div');
  bubble.className = `chat-msg ${role}`;
  if (role === 'user') {
    bubble.textContent = content;
  } else {
    bubble.innerHTML = content ? simpleMarkdown(content) : '';
  }

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);

  // user 메시지 → 해당 버블을 컨테이너 최상단에 맞춰 스크롤
  // assistant 버블(스트리밍 시작)은 스크롤 없음 — 질문 위치에서 읽어 내려감
  if (role === 'user') {
    messages.scrollTop = wrapper.offsetTop - 8;
  }

  return bubble;
}

// ============ 마크다운 → HTML 변환 (XSS 안전) ============

function simpleMarkdown(text) {
  // 1) HTML 특수문자 이스케이프 (XSS 방지)
  let h = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2) 코드 블록 (``` ... ```) — 먼저 처리 (내부 MD 변환 방지)
  h = h.replace(/```[\w]*\n?([\s\S]*?)```/g,
    (_, code) => `<pre><code>${code.trimEnd()}</code></pre>`);

  // 3) 인라인 코드
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 4) 헤더 — leading whitespace 허용, #### 까지
  h = h.replace(/^[ \t]*#### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^[ \t]*### (.+)$/gm,  '<h3>$1</h3>');
  h = h.replace(/^[ \t]*## (.+)$/gm,   '<h2>$1</h2>');
  h = h.replace(/^[ \t]*# (.+)$/gm,    '<h1>$1</h1>');

  // 5) 볼드 / 이탤릭
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  // 이탤릭: 단어 경계 보호 (볼드 잔여 매칭 방지)
  h = h.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');

  // 6) 수평선
  h = h.replace(/^[ \t]*---+[ \t]*$/gm, '<hr>');

  // 7) 목록 — leading whitespace + asterisk/dash/bullet + 다중공백 허용
  //    예: "      *   text", "  - text", "    1. text" 모두 매칭
  h = h.replace(/^[ \t]*[\-\*•][ \t]+(.+)$/gm, '<li>$1</li>');
  h = h.replace(/^[ \t]*\d+\.[ \t]+(.+)$/gm, '<li>$1</li>');
  // 8) 연속 <li> 를 <ul>로 묶기 (사이 \n 허용)
  h = h.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // 9) 문단 분리: \n\n+ 기준 split, 블록 태그는 <p> 감싸지 않음
  const blocks = h.split(/\n\n+/).map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<(h\d|ul|ol|pre|hr|table|blockquote)/.test(t)) return block;
    // 일반 문단: 단일 \n → <br>
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).filter(Boolean);

  return blocks.join('\n');
}

// ============ 지표 분석 리포트 생성 ============

function generateReport(indicators, stockInfo) {
  const el = document.getElementById('report-content');
  if (!el || !indicators || indicators.length < 2) return;

  const last = indicators[indicators.length - 1];
  const prev = indicators[indicators.length - 2];
  const n    = indicators.length;

  // ── 수치 계산 ──
  const rsi = last.rsi != null ? last.rsi : null;
  let bbPct = null;
  if (last.bbUpper && last.bbLower && last.bbUpper !== last.bbLower) {
    bbPct = (last.close - last.bbLower) / (last.bbUpper - last.bbLower) * 100;
  }
  const obvTrend = (last.obv != null && last.obvMa20 != null && prev.obv != null && prev.obvMa20 != null)
    ? (last.obv > last.obvMa20 && prev.obv > prev.obvMa20 ? 'up'
      : last.obv < last.obvMa20 && prev.obv < prev.obvMa20 ? 'down' : 'cross')
    : 'unknown';
  const ma5Gap  = last.ma5  ? (last.close - last.ma5)  / last.ma5  * 100 : null;
  const ma20Gap = last.ma20 ? (last.close - last.ma20) / last.ma20 * 100 : null;
  const ma60Gap = last.ma60 ? (last.close - last.ma60) / last.ma60 * 100 : null;

  // ── 박스권 모드 분류 ──
  const boxLow  = stockInfo.box_low  || null;
  const boxHigh = stockInfo.box_high || null;
  const boxSet  = boxLow && boxHigh && boxHigh > boxLow;
  let mode = 'MODE 6 일반분석', modeClass = 'neutral';
  if (boxSet) {
    const c = last.close;
    if      (c < boxLow * 0.93)   { mode = 'MODE 3 위기관리'; modeClass = 'bearish'; }
    else if (c > boxHigh * 1.07)  { mode = 'MODE 4 이슈추격'; modeClass = 'bullish'; }
    else if (c <= boxLow * 1.07)  { mode = 'MODE 1 매수탐색'; modeClass = 'bullish'; }
    else if (c >= boxHigh * 0.93) { mode = 'MODE 2 익절관리'; modeClass = 'bearish'; }
  }

  // ── 다이버전스 감지 (최근 20봉) ──
  const w20 = indicators.slice(Math.max(0, n - 20));
  let divKind = 'none';
  if (w20.length >= 10) {
    const priceΔ = last.close - w20[0].close;
    const rsiΔ   = (last.rsi ?? 50) - (w20[0].rsi ?? 50);
    const obvΔ   = (last.obv  ?? 0)  - (w20[0].obv  ?? 0);
    if      (priceΔ > 0 && rsiΔ < -5) divKind = 'bearish-rsi';
    else if (priceΔ < 0 && rsiΔ > 5)  divKind = 'bullish-rsi';
    else if (priceΔ > 0 && obvΔ < 0)  divKind = 'bearish-obv';
    else if (priceΔ < 0 && obvΔ > 0)  divKind = 'bullish-obv';
  }

  // ── 라벨/색상 ──
  const rsiLabel = rsi == null ? '–'
    : rsi < 30 ? `${rsi.toFixed(1)} 과매도`
    : rsi > 70 ? `${rsi.toFixed(1)} 과매수`
    : `${rsi.toFixed(1)} 중립`;
  const rsiClass = rsi == null ? 'neutral' : rsi < 30 ? 'bullish' : rsi > 70 ? 'bearish' : 'neutral';

  const bbLabel = bbPct == null ? '–'
    : bbPct > 80 ? `%B ${bbPct.toFixed(0)}% (상단근접)`
    : bbPct < 20 ? `%B ${bbPct.toFixed(0)}% (하단근접)`
    : `%B ${bbPct.toFixed(0)}%`;
  const bbClass = bbPct == null ? 'neutral' : bbPct > 80 ? 'bearish' : bbPct < 20 ? 'bullish' : 'neutral';

  const obvLabel = obvTrend === 'up' ? 'MA20 상향 (수급 유입)'
                 : obvTrend === 'down' ? 'MA20 하향 (수급 이탈)'
                 : obvTrend === 'cross' ? 'MA20 교차 중' : '–';
  const obvClass = obvTrend === 'up' ? 'bullish' : obvTrend === 'down' ? 'bearish' : 'neutral';

  const gapHtml = (g, label) => g === null ? ''
    : `<span class="report-item"><span class="report-label">${label}</span>&nbsp;<span class="report-value ${g >= 0 ? 'bullish' : 'bearish'}">${g >= 0 ? '+' : ''}${g.toFixed(1)}%</span></span>`;

  // ── 신호 분석 엔진 (다중 시그널 통합) ──
  const sig = analyzeSignals(indicators, boxLow, boxHigh);
  sig.divKind = divKind;
  sig.strength = computeStrength(sig);

  // ── 섹션 텍스트 생성 (시그널 기반 동적) ──
  const judgment   = buildJudgment(sig);
  const scenario   = buildScenario(sig);
  const advice     = buildAdvice(sig);
  const monitoring = buildMonitoring(sig);
  const divExplain = buildDivergenceExplain(divKind);

  // ── HTML 출력 ──
  el.innerHTML = `
    <div class="report-row">
      <span class="report-item"><span class="report-label">모드</span>&nbsp;<span class="report-value ${modeClass}">${mode}</span></span>
      <span class="report-item"><span class="report-label">RSI(14)</span>&nbsp;<span class="report-value ${rsiClass}">${rsiLabel}</span></span>
      <span class="report-item"><span class="report-label">BB</span>&nbsp;<span class="report-value ${bbClass}">${bbLabel}</span></span>
      <span class="report-item"><span class="report-label">OBV</span>&nbsp;<span class="report-value ${obvClass}">${obvLabel}</span></span>
    </div>
    <div class="report-row">
      <span class="report-label">MA 이격률:</span>
      ${gapHtml(ma5Gap, 'MA5')} ${gapHtml(ma20Gap, 'MA20')} ${gapHtml(ma60Gap, 'MA60')}
    </div>
    <div class="report-section">
      <div class="report-section-title">🎯 핵심 판단</div>
      <div class="report-section-body">${judgment}</div>
    </div>
    <div class="report-section">
      <div class="report-section-title">📋 대응 시나리오</div>
      <div class="report-section-body">${scenario}</div>
    </div>
    <div class="report-section">
      <div class="report-section-title">💡 권고사항</div>
      <div class="report-section-body">${advice}</div>
    </div>
    <div class="report-section">
      <div class="report-section-title">👀 모니터링 포인트</div>
      <div class="report-section-body">${monitoring}</div>
    </div>
    <div class="report-section">
      <div class="report-section-title">🔍 다이버전스 분석</div>
      <div class="report-section-body">${divExplain}</div>
    </div>`;
}

// ============ 신호 분석 엔진 ============
// 다중 시그널을 구조화하여 빌더에서 조건부 텍스트 생성 가능하게 함
function analyzeSignals(indicators, boxLow, boxHigh) {
  const n = indicators.length;
  const last = indicators[n - 1];
  const prev = indicators[n - 2] || last;
  const w5  = indicators.slice(Math.max(0, n - 5));
  const w20 = indicators.slice(Math.max(0, n - 20));

  // 모멘텀 (1일/5일/20일)
  const mom1  = prev.close ? (last.close - prev.close) / prev.close * 100 : 0;
  const mom5  = w5[0]?.close  ? (last.close - w5[0].close)  / w5[0].close  * 100 : 0;
  const mom20 = w20[0]?.close ? (last.close - w20[0].close) / w20[0].close * 100 : 0;

  // RSI 7단계 + 방향
  const rsiVal = last.rsi;
  const rsiState = rsiVal == null ? 'unknown'
    : rsiVal < 25 ? 'extreme-oversold' : rsiVal < 30 ? 'oversold'
    : rsiVal < 45 ? 'weak'             : rsiVal <= 55 ? 'neutral'
    : rsiVal <= 70 ? 'strong'          : rsiVal <= 80 ? 'overbought'
    : 'extreme-overbought';
  const rsiDir = (prev.rsi != null && rsiVal != null)
    ? (rsiVal > prev.rsi + 1.5 ? 'rising' : rsiVal < prev.rsi - 1.5 ? 'falling' : 'flat')
    : 'flat';

  // BB %B + 폭 추세
  let bbPct = null, bbWidth = null, bbWidthTrend = 'unknown';
  if (last.bbUpper && last.bbLower && last.bbUpper > last.bbLower) {
    bbPct = (last.close - last.bbLower) / (last.bbUpper - last.bbLower) * 100;
    if (last.bbMiddle) bbWidth = (last.bbUpper - last.bbLower) / last.bbMiddle * 100;
    const old = w5[0];
    if (bbWidth && old?.bbUpper && old?.bbLower && old?.bbMiddle) {
      const oldW = (old.bbUpper - old.bbLower) / old.bbMiddle * 100;
      bbWidthTrend = bbWidth > oldW * 1.15 ? 'expanding'
                   : bbWidth < oldW * 0.85 ? 'squeezing' : 'stable';
    }
  }
  const bbState = bbPct == null ? 'unknown'
    : bbPct < 0    ? 'below-band'    : bbPct < 20  ? 'lower-touch'
    : bbPct < 45   ? 'lower-half'    : bbPct < 55  ? 'middle'
    : bbPct < 80   ? 'upper-half'    : bbPct < 100 ? 'upper-touch'
    : 'above-band';

  // OBV 강도
  const obvSlope5 = (w5.length >= 3 && w5[0].obv != null && last.obv != null)
    ? last.obv - w5[0].obv : 0;
  const obvVsMa = (last.obv != null && last.obvMa20 != null)
    ? (last.obv > last.obvMa20 ? 'above' : last.obv < last.obvMa20 ? 'below' : 'cross')
    : 'unknown';
  const obvStrength =
      obvVsMa === 'above' && obvSlope5 > 0 ? 'strong-inflow'
    : obvVsMa === 'above'                  ? 'inflow'
    : obvVsMa === 'below' && obvSlope5 < 0 ? 'strong-outflow'
    : obvVsMa === 'below'                  ? 'outflow'
    : 'neutral';

  // MA 정렬 + 크로스 이벤트
  const ma5 = last.ma5, ma20 = last.ma20, ma60 = last.ma60;
  let maAlign = 'unknown';
  if (ma5 && ma20 && ma60) {
    if      (ma5 > ma20 && ma20 > ma60) maAlign = 'perfect-bull';
    else if (ma5 > ma20 && ma20 < ma60) maAlign = 'short-bull';
    else if (ma5 < ma20 && ma20 < ma60) maAlign = 'perfect-bear';
    else if (ma5 < ma20 && ma20 > ma60) maAlign = 'short-bear';
    else maAlign = 'mixed';
  }
  let crossEvent = 'none';
  for (let i = Math.max(1, n - 5); i < n; i++) {
    const a = indicators[i - 1], b = indicators[i];
    if (a.ma5 && a.ma20 && b.ma5 && b.ma20) {
      if (a.ma5 <= a.ma20 && b.ma5 > b.ma20) { crossEvent = 'golden'; break; }
      if (a.ma5 >= a.ma20 && b.ma5 < b.ma20) { crossEvent = 'dead';   break; }
    }
  }

  // 거래량 — 20일 평균 대비
  const volMa20 = w20.length ? w20.reduce((s, d) => s + (d.volume || 0), 0) / w20.length : 0;
  const volRatio = volMa20 ? last.volume / volMa20 : 1;
  const volState = volRatio >= 2.0 ? 'surge'
                 : volRatio >= 1.5 ? 'elevated'
                 : volRatio >= 0.5 ? 'normal'
                 : 'low';

  // 박스권 9구역
  let boxZone = 'no-box';
  if (boxLow && boxHigh) {
    const c = last.close;
    if      (c < boxLow * 0.90)  boxZone = 'cut-loss';
    else if (c < boxLow * 0.93)  boxZone = 'breakdown';
    else if (c < boxLow)         boxZone = 'below-low';
    else if (c < boxLow * 1.07)  boxZone = 'lower-edge';
    else if (c < boxHigh * 0.93) boxZone = 'mid';
    else if (c < boxHigh)        boxZone = 'upper-edge';
    else if (c < boxHigh * 1.07) boxZone = 'above-high';
    else if (c < boxHigh * 1.10) boxZone = 'breakout';
    else                          boxZone = 'extended';
  }

  return {
    price: last.close, prevPrice: prev.close,
    mom1, mom5, mom20,
    rsi: { val: rsiVal, state: rsiState, dir: rsiDir },
    bb:  { pctB: bbPct, width: bbWidth, widthTrend: bbWidthTrend, state: bbState, upper: last.bbUpper, lower: last.bbLower },
    obv: { vsMa: obvVsMa, slope5: obvSlope5, strength: obvStrength },
    ma:  { ma5, ma20, ma60, align: maAlign, crossEvent },
    vol: { ratio: volRatio, state: volState, ma20: volMa20 },
    box: { low: boxLow, high: boxHigh, zone: boxZone,
           lowGap:  boxLow  ? (last.close - boxLow)  / boxLow  * 100 : null,
           highGap: boxHigh ? (last.close - boxHigh) / boxHigh * 100 : null }
  };
}

// ============ 종합 강도 점수 (-5 ~ +5) ============
function computeStrength(s) {
  let score = 0;
  // RSI 가중
  if (s.rsi.state === 'extreme-oversold')   score += 2;
  else if (s.rsi.state === 'oversold')      score += 1;
  else if (s.rsi.state === 'overbought')    score -= 1;
  else if (s.rsi.state === 'extreme-overbought') score -= 2;
  // BB 위치
  if (s.bb.state === 'below-band' || s.bb.state === 'lower-touch') score += 1;
  else if (s.bb.state === 'upper-touch' || s.bb.state === 'above-band') score -= 1;
  // OBV
  if (s.obv.strength === 'strong-inflow')  score += 2;
  else if (s.obv.strength === 'inflow')    score += 1;
  else if (s.obv.strength === 'outflow')   score -= 1;
  else if (s.obv.strength === 'strong-outflow') score -= 2;
  // MA 정렬
  if (s.ma.align === 'perfect-bull')  score += 1;
  else if (s.ma.align === 'perfect-bear') score -= 1;
  if (s.ma.crossEvent === 'golden') score += 1;
  else if (s.ma.crossEvent === 'dead') score -= 1;
  // 다이버전스
  if (s.divKind === 'bullish-rsi' || s.divKind === 'bullish-obv') score += 1;
  else if (s.divKind === 'bearish-rsi' || s.divKind === 'bearish-obv') score -= 1;
  // 박스권 위치
  if (s.box.zone === 'lower-edge' || s.box.zone === 'below-low') score += 1;
  else if (s.box.zone === 'upper-edge' || s.box.zone === 'above-high') score -= 1;
  else if (s.box.zone === 'cut-loss') score -= 2;
  else if (s.box.zone === 'breakout') score += 1;

  score = Math.max(-5, Math.min(5, score));
  const label = score >= 3 ? '<span style="color:#00ff88">강한 매수 신호</span>'
              : score >= 1 ? '<span style="color:#88ff88">약한 매수 우위</span>'
              : score === 0 ? '<span style="color:#a0a0a0">중립</span>'
              : score >= -2 ? '<span style="color:#ffaa88">약한 매도 우위</span>'
              : '<span style="color:#ff4444">강한 매도 신호</span>';
  return { score, label };
}

// ── 핵심 판단 ──
function buildJudgment(s) {
  const closeS = s.price.toLocaleString();
  if (s.box.zone === 'no-box') {
    return `<b>박스권 미설정</b> — 보유 현황에서 박스권 상/하단 입력 필요.<br>
      현재가 <b>${closeS}원</b> · RSI ${s.rsi.val != null ? s.rsi.val.toFixed(1) : '?'} · OBV ${obvText(s.obv.strength)} · 거래량 ${s.vol.ratio.toFixed(1)}배`;
  }
  const parts = [];
  // 구역별 헤드라인
  const zoneHeadline = {
    'cut-loss':   `<b style="color:#ff4444">🚨 손절선 -10% 이탈 (${s.box.lowGap.toFixed(1)}%)</b> — 무조건 청산 검토`,
    'breakdown':  `<b style="color:#ff8844">⚠ 박스권 하단 -7% 위기 진입 (${s.box.lowGap.toFixed(1)}%)</b>`,
    'below-low':  `<b>박스권 하단 이탈 (${s.box.lowGap.toFixed(1)}%)</b> — 손절선 ${Math.round(s.box.low * 0.93).toLocaleString()}원 사수 구간`,
    'lower-edge': `<b>박스권 하단 진입 구간 (+${s.box.lowGap.toFixed(1)}%)</b> — 분할매수 영역`,
    'mid':        `<b>박스권 중단 (${Math.round((s.price - s.box.low) / (s.box.high - s.box.low) * 100)}%)</b> — 방향성 대기`,
    'upper-edge': `<b>박스권 상단 근접 (${s.box.highGap.toFixed(1)}%)</b> — 익절 영역`,
    'above-high': `<b>박스권 상단 돌파 (+${s.box.highGap.toFixed(1)}%)</b> — 이슈 확인 필요`,
    'breakout':   `<b style="color:#00ff88">🚀 박스권 상단 +7% 돌파 (+${s.box.highGap.toFixed(1)}%)</b> — 이슈추격 구간`,
    'extended':   `<b>박스권 상단 +10% 이상 신고가 (+${s.box.highGap.toFixed(1)}%)</b> — 익절 우선`
  };
  parts.push(zoneHeadline[s.box.zone]);
  parts.push(`현재가 <b>${closeS}원</b> · 1일 ${signed(s.mom1)}% / 5일 ${signed(s.mom5)}% / 20일 ${signed(s.mom20)}%`);

  // 활성 보조 신호 추출
  const active = [];
  if (s.rsi.state === 'extreme-oversold')    active.push(`RSI ${s.rsi.val.toFixed(1)} <b>극과매도</b>`);
  else if (s.rsi.state === 'oversold')       active.push(`RSI ${s.rsi.val.toFixed(1)} 과매도`);
  else if (s.rsi.state === 'overbought')     active.push(`RSI ${s.rsi.val.toFixed(1)} 과매수`);
  else if (s.rsi.state === 'extreme-overbought') active.push(`RSI ${s.rsi.val.toFixed(1)} <b>극과매수</b>`);
  if (s.rsi.dir === 'rising' && s.rsi.val < 50)  active.push('RSI 반등 시작');
  if (s.rsi.dir === 'falling' && s.rsi.val > 50) active.push('RSI 하락 전환');

  if (s.bb.state === 'below-band')       active.push('BB 하단 이탈');
  else if (s.bb.state === 'lower-touch') active.push('BB 하단 터치');
  else if (s.bb.state === 'upper-touch') active.push('BB 상단 터치');
  else if (s.bb.state === 'above-band')  active.push('BB 상단 이탈');
  if (s.bb.widthTrend === 'squeezing')    active.push('BB 스퀴즈 (돌파 임박)');
  else if (s.bb.widthTrend === 'expanding') active.push('BB 변동성 확대');

  if (s.obv.strength === 'strong-inflow')        active.push('OBV <b>강한 매집</b>');
  else if (s.obv.strength === 'strong-outflow')  active.push('OBV <b>강한 분산</b>');

  if (s.ma.crossEvent === 'golden')     active.push('MA5/MA20 <b>골든크로스</b>');
  else if (s.ma.crossEvent === 'dead')  active.push('MA5/MA20 <b>데드크로스</b>');
  if (s.ma.align === 'perfect-bull')    active.push('MA 정배열');
  else if (s.ma.align === 'perfect-bear') active.push('MA 역배열');

  if (s.vol.state === 'surge')         active.push(`거래량 <b>${s.vol.ratio.toFixed(1)}배 급증</b>`);
  else if (s.vol.state === 'elevated') active.push(`거래량 ${s.vol.ratio.toFixed(1)}배 증가`);
  else if (s.vol.state === 'low')      active.push('거래량 위축');

  if (s.divKind === 'bullish-rsi') active.push('<span style="color:#00ff88">RSI 상승 다이버전스</span>');
  else if (s.divKind === 'bearish-rsi') active.push('<span style="color:#ff4444">RSI 하락 다이버전스</span>');
  else if (s.divKind === 'bullish-obv') active.push('<span style="color:#00ff88">OBV 상승 다이버전스</span>');
  else if (s.divKind === 'bearish-obv') active.push('<span style="color:#ff4444">OBV 하락 다이버전스</span>');

  if (active.length) parts.push(`<b>활성 신호</b>: ${active.join(' · ')}`);
  parts.push(`<b>종합 강도</b>: ${s.strength.label} (점수 ${s.strength.score > 0 ? '+' : ''}${s.strength.score})`);
  return parts.join('<br>');
}

function obvText(strength) {
  return ({ 'strong-inflow':'강한 매집', 'inflow':'매집', 'neutral':'중립',
            'outflow':'분산', 'strong-outflow':'강한 분산', 'unknown':'–' })[strength];
}
function signed(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }

// ── 대응 시나리오 — 9구역 + 신호 강도 기반 ──
function buildScenario(s) {
  if (s.box.zone === 'no-box') return '박스권 설정 후 시나리오가 생성됩니다.';
  const closeS = s.price.toLocaleString();
  const lowS   = s.box.low.toLocaleString();
  const highS  = s.box.high.toLocaleString();
  const stop   = Math.round(s.box.low * 0.93).toLocaleString();
  const cut    = Math.round(s.box.low * 0.90).toLocaleString();
  const target1= Math.round(s.box.high * 1.10).toLocaleString();
  const score  = s.strength.score;

  // 신호 강도에 따른 진입 비중 조정
  const aggressive = score >= 3;  // 강한 매수 → 비중 더, 단계 빠르게
  const cautious   = score <= -1; // 약세 → 비중 적게

  const lines = [];
  const header = (t) => `<b>${t}</b>`;
  const me = (price, ratio, why) => `• ${price} → <b>${ratio}</b> 매수 — ${why}`;
  const ex = (price, ratio, why) => `• ${price} → <b>${ratio}</b> 익절 — ${why}`;

  switch (s.box.zone) {
    case 'cut-loss':
      lines.push(header('🚨 즉시 청산 시나리오'));
      lines.push(`현재가 <b>${closeS}원</b> · 손절선 -10% (${cut}원) 이탈`);
      lines.push(`• 즉시 전량 청산 — 추가 손실 방지`);
      lines.push(`• 반등 시도(${lowS}원 회복 + 거래량 동반) 확인 전 재진입 금지`);
      lines.push(`<b>재진입 조건</b>: ${lowS}원 회복 + OBV MA20 상향 + RSI 30 돌파 (3개 충족)`);
      break;

    case 'breakdown':
      lines.push(header('⚠ 위기 대응 (하단 -7% 진입)'));
      lines.push(`현재가 <b>${closeS}원</b> · 최종 손절 ${cut}원`);
      if (s.obv.strength.includes('outflow') || s.rsi.dir === 'falling') {
        lines.push(`• OBV/RSI 하락 동반 — <b>매수 보류</b>, 손절선 모니터링`);
      } else if (s.divKind === 'bullish-rsi' || s.divKind === 'bullish-obv') {
        lines.push(`• 강세 다이버전스 출현 — 10% 시험매수 고려 (손절 엄수)`);
      } else {
        lines.push(`• 관망 우선, OBV MA20 상향 회복 시까지 신규 진입 금지`);
      }
      lines.push(`<b>최종 손절</b>: ${cut}원 (-10%) 이탈 시 무조건 청산`);
      break;

    case 'below-low':
      lines.push(header('매수 시나리오 — 하단 이탈 상태'));
      lines.push(`현재가 <b>${closeS}원</b> · 박스권 하단 <b>${lowS}원</b> · 손절선 <b>${stop}원</b>`);
      if (aggressive) {
        lines.push(me(`현재가 ${closeS}원`,           '30%', '강세 신호 확인됨'));
        lines.push(me(`OBV MA20 상향 회복 시`,        '40%', '수급 전환 신호'));
        lines.push(me(`박스권 하단 ${lowS}원 회복 시`, '30%', '구조 회복'));
      } else {
        lines.push(me(`손절선 ${stop}원 사수 확인 후`, '20%', '시험매수'));
        lines.push(me(`OBV MA20 상향 회복 시`,         '30%', '수급 전환'));
        lines.push(me(`${lowS}원 회복 시`,             '50%', '본진'));
      }
      lines.push(`<b>중단</b>: ${stop}원 이탈 시 즉시 손절`);
      break;

    case 'lower-edge':
      lines.push(header('매수 시나리오 — 하단 진입 구간'));
      lines.push(`현재가 <b>${closeS}원</b> · 박스권 하단 +${s.box.lowGap.toFixed(1)}%`);
      if (s.rsi.state === 'oversold' || s.rsi.state === 'extreme-oversold') {
        lines.push(me(`현재가 ${closeS}원`, aggressive ? '40%' : '30%', 'RSI 과매도 + 하단 근접'));
        lines.push(me(`${lowS}원 도달 시`,  '30%',                       '하단 터치 매수'));
      } else {
        lines.push(me(`${lowS}원 도달 시`, '30%', '하단 분할매수'));
        lines.push(me(`RSI 30 이하 + 거래량 동반 시`, '30%', '과매도 진입'));
      }
      lines.push(me(`MA5 상향 돌파 시`, '40%', '반등 확인 후 본진'));
      lines.push(`<b>중단</b>: ${stop}원 이탈 시 위기관리 전환`);
      break;

    case 'mid':
      lines.push(header('관망 시나리오 — 박스권 중단'));
      lines.push(`현재가 <b>${closeS}원</b> (하단 ${lowS} / 상단 ${highS})`);
      lines.push(`• ${lowS}원 접근 시 매수탐색 모드 진입`);
      lines.push(`• ${highS}원 접근 시 익절관리 모드 진입`);
      if (s.ma.crossEvent === 'golden')     lines.push('• MA5/MA20 골든크로스 발생 — 추세 시작 가능, 소량 진입 고려');
      else if (s.ma.crossEvent === 'dead')  lines.push('• MA5/MA20 데드크로스 발생 — 하락 추세 경계');
      if (s.bb.widthTrend === 'squeezing') lines.push('• BB 스퀴즈 진행 — 변동성 폭발 임박, 돌파 방향 관찰');
      if (s.vol.state === 'surge')          lines.push(`• 거래량 ${s.vol.ratio.toFixed(1)}배 급증 — 추세 시작 신호`);
      break;

    case 'upper-edge':
      lines.push(header('매도 시나리오 — 상단 근접'));
      lines.push(`현재가 <b>${closeS}원</b> · 박스권 상단 ${s.box.highGap.toFixed(1)}%`);
      lines.push(ex(`${highS}원 도달 시`, '30%', '상단 1차 익절'));
      if (s.rsi.state === 'overbought' || s.rsi.state === 'extreme-overbought') {
        lines.push(ex(`현재가 ${closeS}원`, '20%', 'RSI 과매수 — 선제 익절'));
      }
      lines.push(ex(`RSI 70 + BB 상단 터치 시`, '40%', '과매수 확정'));
      lines.push(ex(`거래량 급감/음봉 시`,       '30%', '모멘텀 소진 신호'));
      lines.push(`<b>홀딩 옵션</b>: 거래량 2배+ 동반 돌파 시 이슈추격 전환`);
      break;

    case 'above-high':
      lines.push(header('익절 시나리오 — 상단 돌파'));
      lines.push(`현재가 <b>${closeS}원</b> · 상단 +${s.box.highGap.toFixed(1)}%`);
      if (s.vol.state === 'surge' && s.obv.strength.includes('inflow')) {
        lines.push(`• 거래량 ${s.vol.ratio.toFixed(1)}배 + OBV 매집 — 이슈추격 모드 전환 검토`);
        lines.push(ex(`+${target1}원 도달 시`, '30%', '추격 익절'));
      } else {
        lines.push(ex(`즉시`,           '50%', '거래량 미동반 — 가짜 돌파 위험'));
        lines.push(ex(`${highS}원 회귀 시`, '50%', '나머지 청산'));
      }
      break;

    case 'breakout':
      lines.push(header('🚀 이슈추격 시나리오'));
      lines.push(`현재가 <b>${closeS}원</b> · 상단 +${s.box.highGap.toFixed(1)}% 돌파`);
      lines.push(`• 거래량 ${s.vol.ratio.toFixed(1)}배 · OBV ${obvText(s.obv.strength)}`);
      if (s.vol.state === 'surge' && s.obv.strength.includes('inflow')) {
        lines.push(`• 신규 매수: OBV 신고점 + 양봉 확인 후 20%`);
        lines.push(ex(`${target1}원 (+10%) 도달 시`, '30%', '1차 익절'));
      } else {
        lines.push(`<b>경계</b>: 거래량/OBV 미동반 — 가짜 돌파, 절반 즉시 익절`);
      }
      lines.push(`<b>손절 라인</b>: ${highS}원 회귀 시 즉시 청산`);
      break;

    case 'extended':
      lines.push(header('익절 우선 — 신고가 +10% 이상'));
      lines.push(`현재가 <b>${closeS}원</b> · 상단 +${s.box.highGap.toFixed(1)}%`);
      lines.push(ex(`즉시`,                  '50%', '신고가 영역 익절'));
      lines.push(ex(`거래량 급감 시 즉시`,   '30%', '모멘텀 소진'));
      lines.push(ex(`${highS}원 회귀 시`,    '20%', '청산'));
      break;
  }
  return lines.join('<br>');
}

// ── 권고사항 — 시그널 강도 기반 ──
function buildAdvice(s) {
  const list = [];
  const score = s.strength.score;
  const z = s.box.zone;

  // 1) 박스권 위치 기반 핵심 권고
  if (z === 'cut-loss') {
    list.push('<b style="color:#ff4444">최우선: 즉시 청산 — 추가 손실 방지</b>');
    list.push('재진입 욕구 억제 — 명확한 반등 신호 3개 확인 전 금지');
  } else if (z === 'breakdown') {
    list.push(`<b style="color:#ff8844">손절선 ${Math.round(s.box.low*0.90).toLocaleString()}원 사수 — 이탈 시 무조건 청산</b>`);
    list.push('신규 매수 보류 — OBV MA20 회복 + 양봉 확인 필요');
  } else if (z === 'below-low' || z === 'lower-edge') {
    list.push(`분할매수 영역 — 손절선 <b>${Math.round(s.box.low*0.93).toLocaleString()}원</b> 사전 설정`);
    list.push('3분할 이상으로 진입 — 단발 매수 금지');
  } else if (z === 'upper-edge' || z === 'above-high') {
    list.push('분할 익절 영역 — 최소 30% 우선 차익 실현');
    if (s.vol.state !== 'surge') list.push('거래량 미동반 돌파 — 가짜 돌파 경계, 즉시 절반 익절');
  } else if (z === 'breakout' || z === 'extended') {
    list.push('익절 우선 — 신고가 영역, 추격 매수 자제');
    list.push('박스권 상단 회귀 시 즉시 손절 라인 가동');
  } else { // mid
    list.push('현재 명확한 신호 없음 — 박스권 경계 접근 대기');
  }

  // 2) RSI 기반
  if (s.rsi.state === 'extreme-oversold') list.push('<b>RSI 극과매도</b> — 반등 임박, 분할매수 강도 ↑');
  else if (s.rsi.state === 'extreme-overbought') list.push('<b>RSI 극과매수</b> — 즉시 익절 검토');
  else if (s.rsi.state === 'oversold' && s.rsi.dir === 'rising') list.push('RSI 30 회복 진행 — 반등 시작 가능');
  else if (s.rsi.state === 'overbought' && s.rsi.dir === 'falling') list.push('RSI 70 이탈 진행 — 모멘텀 약화');

  // 3) OBV 기반
  if (s.obv.strength === 'strong-inflow') list.push('OBV 강한 매집 — 수급 우위 명확');
  else if (s.obv.strength === 'strong-outflow') list.push('<b>OBV 강한 분산 — 신규 매수 보류 권장</b>');

  // 4) MA 이벤트
  if (s.ma.crossEvent === 'golden') list.push('<b style="color:#00ff88">MA5/MA20 골든크로스</b> — 단기 추세 전환');
  else if (s.ma.crossEvent === 'dead') list.push('<b style="color:#ff4444">MA5/MA20 데드크로스</b> — 추세 약화');

  // 5) 거래량 / BB
  if (s.vol.state === 'surge') list.push(`거래량 ${s.vol.ratio.toFixed(1)}배 급증 — 추세 변화 신호, 방향 즉시 확인`);
  if (s.bb.widthTrend === 'squeezing') list.push('BB 스퀴즈 — 변동성 폭발 임박, 돌파 방향 베팅 준비');

  // 6) 다이버전스
  if (s.divKind === 'bearish-rsi' || s.divKind === 'bearish-obv')
    list.push('<b style="color:#ff4444">⚠ 약세 다이버전스 — 신규 매수 신중</b>');
  else if (s.divKind === 'bullish-rsi' || s.divKind === 'bullish-obv')
    list.push('<b style="color:#00ff88">✓ 강세 다이버전스 — 매수 신호 보강</b>');

  // 7) 종합 강도 마무리
  if (score >= 3)       list.push(`<b style="color:#00ff88">종합 강도 +${score} — 강한 매수 우위, 비중 확대 고려</b>`);
  else if (score <= -3) list.push(`<b style="color:#ff4444">종합 강도 ${score} — 강한 매도 우위, 신규 진입 금지</b>`);

  return list.map(x => `• ${x}`).join('<br>');
}

// ── 모니터링 포인트 — 시그널 기반 동적 ──
function buildMonitoring(s) {
  const list = [];
  if (s.box.zone !== 'no-box') {
    const lowDist  = s.box.lowGap.toFixed(1);
    const highDist = s.box.highGap.toFixed(1);
    list.push(`현재가 <b>${s.price.toLocaleString()}원</b> · 하단 ${signed(s.box.lowGap)}% (${s.box.low.toLocaleString()}원) · 상단 ${signed(s.box.highGap)}% (${s.box.high.toLocaleString()}원)`);
  }
  // 핵심 가격대 트리거
  if (s.box.low && s.box.high) {
    list.push(`손절 트리거: <b>${Math.round(s.box.low*0.93).toLocaleString()}원</b> (-7%) / <b>${Math.round(s.box.low*0.90).toLocaleString()}원</b> (-10%)`);
    list.push(`익절 트리거: <b>${s.box.high.toLocaleString()}원</b> 도달 / <b>${Math.round(s.box.high*1.10).toLocaleString()}원</b> 신고가`);
  }
  // BB 가격대
  if (s.bb.upper && s.bb.lower) {
    list.push(`BB: 상단 <b>${Math.round(s.bb.upper).toLocaleString()}원</b> · 하단 <b>${Math.round(s.bb.lower).toLocaleString()}원</b> 터치/이탈`);
  }
  list.push('OBV vs OBV MA20 교차 — 수급 방향 전환 신호');
  list.push('RSI 30/70 라인 진입/이탈 — 과매도/과매수 진입');
  list.push(`거래량 평균 대비 1.5배 이상 급증 (현재 ${s.vol.ratio.toFixed(2)}배) — 추세 변화 신호`);

  // 구역별 핵심 모니터링 추가
  const z = s.box.zone;
  if      (z === 'lower-edge' || z === 'below-low')  list.push('MA5 상향 돌파 + 양봉 — 단기 반등 시작 신호');
  else if (z === 'upper-edge' || z === 'above-high') list.push('상승 캔들 거래량 급감 — 매수세 소진 신호');
  else if (z === 'breakout'   || z === 'extended')   list.push('관련 뉴스/공시 모니터링 — 이슈 진행/소멸 여부');
  else if (z === 'cut-loss'   || z === 'breakdown')  list.push(`최종 손절 ${Math.round(s.box.low*0.90).toLocaleString()}원 — 이탈 시 무조건 청산`);
  if (s.ma.crossEvent !== 'none') list.push(`MA 크로스 이벤트 (${s.ma.crossEvent === 'golden' ? '골든' : '데드'}) — 5일 내 발생`);
  if (s.bb.widthTrend === 'squeezing') list.push('BB 스퀴즈 — 변동성 폭발 임박, 돌파 방향 관찰');

  return list.map(p => `• ${p}`).join('<br>');
}

// ── 다이버전스 상세 해설 ──
function buildDivergenceExplain(divKind) {
  const map = {
    'none': `<b>다이버전스 신호 없음</b> — 가격과 RSI/OBV가 동일 방향으로 움직이는 정상 추세 상태.
      <span class="div-detail">
        • 상승 추세에서 RSI/OBV도 상승 = 매수세 강함<br>
        • 하락 추세에서 RSI/OBV도 하락 = 매도세 강함<br>
        • 횡보에서 RSI/OBV도 횡보 = 박스권 유지<br>
        <b>의미</b>: 다이버전스 미발생은 현재 추세 추종이 유효함을 시사. 추세 전환 신호는 다이버전스 출현 시점부터 시작됨.
      </span>`,
    'bullish-rsi': `<b style="color:#00ff88">RSI 상승 다이버전스 — 강세 신호</b>
      <span class="div-detail">
        • <b>정의</b>: 가격은 신저점 갱신, RSI는 직전 저점보다 높음<br>
        • <b>의미</b>: 매도세 약화, 반등 가능성 높음<br>
        • <b>권고</b>: 거래량 동반 + 양봉 확인 후 분할 매수 검토
      </span>`,
    'bearish-rsi': `<b style="color:#ff4444">RSI 하락 다이버전스 — 약세 신호</b>
      <span class="div-detail">
        • <b>정의</b>: 가격은 신고점 갱신, RSI는 직전 고점보다 낮음<br>
        • <b>의미</b>: 매수세 약화, 조정 가능성 높음<br>
        • <b>권고</b>: 분할 익절 검토, 손절 라인 점검
      </span>`,
    'bullish-obv': `<b style="color:#00ff88">OBV 상승 다이버전스 — 강세 신호</b>
      <span class="div-detail">
        • <b>정의</b>: 가격은 하락하지만 OBV는 상승<br>
        • <b>의미</b>: 보이지 않는 수급 유입(매집 가능성), 반등 임박<br>
        • <b>권고</b>: 박스 하단 분할 매수 강도 증가 검토
      </span>`,
    'bearish-obv': `<b style="color:#ff4444">OBV 하락 다이버전스 — 약세 신호</b>
      <span class="div-detail">
        • <b>정의</b>: 가격은 상승하지만 OBV는 하락<br>
        • <b>의미</b>: 수급 이탈(분산 가능성), 가짜 상승 우려<br>
        • <b>권고</b>: 추격 매수 금지, 분할 익절 검토
      </span>`
  };
  return map[divKind] || map.none;
}

// ============ 보유현황 폼 채우기 ============

function populateHoldingsForm(h) {
  const set = (id, val) => { if (val != null) document.getElementById(id).value = val; };
  set('avg-price',      h.avg_price);
  set('quantity',       h.quantity);
  set('available-cash', h.available_cash);
  set('strategy',       h.strategy);
  set('expected-issue', h.expected_issue);
}

// ============ 스캐너 설정 UI ============

const SCANNER_CONFIG_STORAGE_KEY = 'scanner_config';

// 설정 파라미터 메타정보 (표시명, 타입, 단위 등)
const SCANNER_CONFIG_META = [
  { key: 'SCAN_PERIOD_MONTHS',      label: '분석 기간',           type: 'number', unit: '개월' },
  { key: 'MIN_CLOSE_PRICE',         label: '최소 종가',           type: 'number', unit: '원' },
  { key: 'MIN_AVG_TURNOVER',        label: '일평균 거래대금 최소', type: 'number', unit: '원 (0=비활성)' },
  { key: 'BOX_RANGE_MIN_PCT',       label: '박스폭 최소',         type: 'number', unit: '%' },
  { key: 'BOX_RANGE_MAX_PCT',       label: '박스폭 최대',         type: 'number', unit: '%' },
  { key: 'MAX_LAST_TOUCH_MONTHS',   label: '최근 터치 허용 기간', type: 'number', unit: '개월 (0=비활성)' },
  { key: 'PRICE_POSITION_FILTER',   label: '현재가 위치 필터',    type: 'select',
    options: ['none','lower','upper','inside','no_breakout'],
    optionLabels: ['사용 안함','하단 구간','상단 구간','박스 내부','이탈 제외'] },
  { key: 'LOWER_ZONE_PCT',          label: '하단 구간 폭',        type: 'number', unit: '%' },
  { key: 'UPPER_ZONE_PCT',          label: '상단 구간 폭',        type: 'number', unit: '%' },
  { key: 'BREAKOUT_THRESHOLD_PCT',  label: '이탈 기준 폭',        type: 'number', unit: '%' },
  { key: 'BOX_RESIDENCY_MIN_PCT',   label: '박스 체류 비율 최소', type: 'number', unit: '% (0=비활성)' },
  { key: 'TREND_SLOPE_MAX_PCT',     label: '추세 기울기 한계',    type: 'number', unit: '% (0=비활성)' },
  { key: 'SWING_WINDOW',            label: '스윙 윈도우',         type: 'number', unit: '거래일' },
  { key: 'CLUSTER_THRESHOLD',       label: '클러스터 병합 기준',  type: 'number', unit: '(예: 0.05=±5%)' },
  { key: 'TOUCH_THRESHOLD',         label: '터치존 폭',           type: 'number', unit: '(예: 0.04=±4%)' },
  { key: 'TOUCH_GROUP_DAYS',        label: '터치 묶음 기준',      type: 'number', unit: '거래일' },
  { key: 'MIN_TOUCHES_PER_YEAR',    label: '연간 최소 터치 횟수', type: 'number', unit: '회' },
  { key: 'MIN_TOUCHES_FLOOR',       label: '터치 횟수 하한선',    type: 'number', unit: '회' },
  { key: 'EXCLUDE_PREFERRED_STOCK', label: '우선주 제외',         type: 'boolean' },
  { key: 'EXCLUDE_SPAC',            label: '스팩 제외',           type: 'boolean' },
  { key: 'EXCLUDE_REIT',            label: '리츠 제외',           type: 'boolean' },
  { key: 'EXCLUDE_IRREGULAR_TICKER',label: '비정형 티커 제외',    type: 'boolean' },
];

// localStorage에서 사용자 설정 로드 (없으면 빈 객체)
function loadScannerConfig() {
  try {
    const raw = localStorage.getItem(SCANNER_CONFIG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// 사용자 설정 저장
function saveScannerConfig(cfg) {
  try {
    localStorage.setItem(SCANNER_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch (e) { console.warn('스캐너 설정 저장 실패:', e); }
}

// 스캔 실행 시 configOverride 생성 (기본값과 다른 값만 포함)
function buildScannerConfigOverride(defaults) {
  const userCfg = loadScannerConfig();
  const override = {};
  for (const [key, val] of Object.entries(userCfg)) {
    if (defaults[key] !== undefined && val !== defaults[key]) {
      override[key] = val;
    }
  }
  return override;
}

// 설정 UI 초기화 (앱 시작 시 1회)
async function initScannerConfigUI() {
  const result = await window.appAPI.getScannerDefaults();
  if (!result || !result.success) return;
  const defaults = result.defaults;

  // 전역에 defaults 보관 (스캔 실행 시 사용)
  window._scannerDefaults = defaults;

  const form = document.getElementById('scanner-config-form');
  if (!form) return;

  const userCfg = loadScannerConfig();

  form.innerHTML = SCANNER_CONFIG_META.map(meta => {
    const defVal  = defaults[meta.key];
    const curVal  = userCfg[meta.key] !== undefined ? userCfg[meta.key] : defVal;
    const isModified = curVal !== defVal;

    if (meta.type === 'boolean') {
      return `
        <div class="cfg-row" data-key="${meta.key}">
          <label class="cfg-label">${meta.label}</label>
          <div class="cfg-control">
            <input type="checkbox" class="cfg-input cfg-bool" data-key="${meta.key}"
              ${curVal ? 'checked' : ''}>
            <span class="cfg-default">기본값: ${defVal ? '켜짐' : '꺼짐'}</span>
          </div>
          <button class="cfg-reset-btn ${isModified ? 'modified' : ''}" data-key="${meta.key}" title="이 항목만 초기화">↺</button>
        </div>`;
    }
    if (meta.type === 'select') {
      const opts = meta.options.map((o, i) =>
        `<option value="${o}" ${curVal === o ? 'selected' : ''}>${meta.optionLabels[i]}</option>`
      ).join('');
      return `
        <div class="cfg-row" data-key="${meta.key}">
          <label class="cfg-label">${meta.label}</label>
          <div class="cfg-control">
            <select class="cfg-input cfg-select" data-key="${meta.key}">${opts}</select>
            <span class="cfg-default">기본값: ${defVal}</span>
          </div>
          <button class="cfg-reset-btn ${isModified ? 'modified' : ''}" data-key="${meta.key}" title="이 항목만 초기화">↺</button>
        </div>`;
    }
    // number
    return `
      <div class="cfg-row" data-key="${meta.key}">
        <label class="cfg-label">${meta.label}${meta.unit ? ` <span class="cfg-unit">(${meta.unit})</span>` : ''}</label>
        <div class="cfg-control">
          <input type="number" class="cfg-input cfg-number" data-key="${meta.key}"
            value="${curVal}" step="any">
          <span class="cfg-default">기본값: ${defVal}</span>
        </div>
        <button class="cfg-reset-btn ${isModified ? 'modified' : ''}" data-key="${meta.key}" title="이 항목만 초기화">↺</button>
      </div>`;
  }).join('');

  // 입력 변경 이벤트
  form.querySelectorAll('.cfg-input').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      const meta = SCANNER_CONFIG_META.find(m => m.key === key);
      let val;
      if (meta.type === 'boolean') val = input.checked;
      else if (meta.type === 'number') val = parseFloat(input.value);
      else val = input.value;

      const cfg = loadScannerConfig();
      cfg[key] = val;
      saveScannerConfig(cfg);

      // 수정 여부 표시
      const btn = form.querySelector(`.cfg-reset-btn[data-key="${key}"]`);
      if (btn) btn.classList.toggle('modified', val !== defaults[key]);
    });
  });

  // 항목별 초기화 버튼
  form.querySelectorAll('.cfg-reset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const defVal = defaults[key];
      const cfg = loadScannerConfig();
      delete cfg[key];
      saveScannerConfig(cfg);

      // 입력 필드 복원
      const input = form.querySelector(`.cfg-input[data-key="${key}"]`);
      if (input) {
        const meta = SCANNER_CONFIG_META.find(m => m.key === key);
        if (meta.type === 'boolean') input.checked = defVal;
        else input.value = defVal;
      }
      btn.classList.remove('modified');
    });
  });

  // 전체 초기화 버튼
  const btnResetAll = document.getElementById('btn-reset-all-config');
  if (btnResetAll) {
    btnResetAll.addEventListener('click', () => {
      saveScannerConfig({});
      initScannerConfigUI(); // UI 재렌더링
    });
  }
}

// ============ 박스권 스캔 ============

async function runBoxScanUI() {
  const btnScan  = document.getElementById('btn-box-scan');
  const statusEl = document.getElementById('scan-status');

  btnScan.disabled = true;
  statusEl.textContent = '스캔 중...';

  // localStorage 설정값을 configOverride로 전달
  const configOverride = window._scannerDefaults
    ? buildScannerConfigOverride(window._scannerDefaults)
    : {};

  const result = await window.appAPI.runBoxScan(configOverride);
  btnScan.disabled = false;

  if (!result || !result.success) {
    statusEl.textContent = '실패: ' + (result?.error || '알 수 없는 오류');
    return;
  }

  statusEl.textContent = `완료 (${result.totalTickers}종목)`;

  // DB 재조회로 stock_name JOIN 포함 결과 렌더링 (lastTimeEl/summary도 여기서 업데이트)
  await restoreScanResults();

  document.getElementById('scan-panel').style.display = 'flex';
  document.getElementById('btn-show-scan-results').style.display = '';
}

async function restoreScanResults() {
  const result = await window.appAPI.getBoxScanResults();
  if (!result || !result.success || !result.results || result.results.length === 0) return;

  const lastTimeEl = document.getElementById('scan-last-time');
  if (lastTimeEl && result.history) {
    const t = new Date(result.history.scanned_at).toLocaleString('ko-KR');
    lastTimeEl.textContent = `마지막: ${t}`;
  }

  renderScanTable(result.results);
  document.getElementById('btn-show-scan-results').style.display = '';

  const summary = document.getElementById('scan-panel-summary');
  if (summary && result.history) {
    summary.textContent = `${result.history.scan_from} ~ ${result.history.scan_to} | 총 ${result.results.length}종목`;
  }
}

function renderScanTable(results) {
  const tbody = document.getElementById('scan-result-tbody');
  if (!tbody) return;

  const STATUS = { confirmed: ['confirmed','확정'], rejected: ['rejected','제외'], pending: ['pending','대기'] };
  tbody.innerHTML = results.map(r => {
    const [statusClass, statusLabel] = STATUS[r.status] || STATUS.pending;
    const disabled  = r.status !== 'pending' ? 'disabled' : '';
    // 터치 횟수 20회 이상 → 강조 (년간 4회 이상 = 강한 박스권)
    const rTouchClass = (r.resistance_touches >= 20) ? 'touch-strong' : '';
    const sTouchClass = (r.support_touches    >= 20) ? 'touch-strong' : '';
    const lastTouch   = r.last_touch_date ? r.last_touch_date.slice(0, 10) : '-';
    return `
      <tr data-result-id="${r.id}" data-ticker="${escapeHtml(r.ticker)}">
        <td>${escapeHtml(r.ticker)}</td>
        <td>${escapeHtml(r.stock_name || r.ticker)}</td>
        <td>${Number(r.box_high).toLocaleString()}</td>
        <td>${Number(r.box_low).toLocaleString()}</td>
        <td>${Number(r.box_range_pct).toFixed(1)}%</td>
        <td class="${rTouchClass}">${r.resistance_touches ?? '-'}</td>
        <td class="${sTouchClass}">${r.support_touches    ?? '-'}</td>
        <td>${lastTouch}</td>
        <td>${r.data_days}</td>
        <td>${Number(r.close_at_scan).toLocaleString()}</td>
        <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
        <td>
          <button class="btn-confirm" ${disabled} onclick="handleScanConfirm(${r.id}, this)">확정</button>
          <button class="btn-reject"  ${disabled} onclick="handleScanReject(${r.id}, this)">제외</button>
        </td>
      </tr>`;
  }).join('');
}

async function handleScanConfirm(resultId, btn) {
  btn.disabled = true;
  const result = await window.appAPI.confirmBoxResult(resultId);
  if (!result || !result.success) {
    alert('확정 실패: ' + (result?.error || '오류'));
    btn.disabled = false;
    return;
  }
  // 행 상태 업데이트
  const row = btn.closest('tr');
  row.querySelector('.status-badge').className = 'status-badge confirmed';
  row.querySelector('.status-badge').textContent = '확정';
  row.querySelector('.btn-reject').disabled = true;

  // 종목 목록 갱신 (box_high/box_low 반영)
  await loadStockList();
}

async function handleScanReject(resultId, btn) {
  btn.disabled = true;
  const result = await window.appAPI.rejectBoxResult(resultId);
  if (!result || !result.success) {
    alert('제외 처리 실패: ' + (result?.error || '오류'));
    btn.disabled = false;
    return;
  }
  const row = btn.closest('tr');
  row.querySelector('.status-badge').className = 'status-badge rejected';
  row.querySelector('.status-badge').textContent = '제외';
  row.querySelector('.btn-confirm').disabled = true;
}

// ============ 후속 질문 제안 ============

/**
 * AI 응답 텍스트에서 [Q: ...] 태그 추출
 */
function extractFollowUpSuggestions(text) {
  return [...text.matchAll(/\[Q:\s*(.+?)\]/g)]
    .map(m => m[1].trim())
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * 후속 질문 버튼 렌더링 — 클릭 시 해당 질문 자동 전송
 */
function renderFollowUpButtons(suggestions, container) {
  const wrap = document.createElement('div');
  wrap.className = 'followup-suggestions';

  const label = document.createElement('div');
  label.className = 'followup-label';
  label.textContent = '💡 추천 다음 질문';
  wrap.appendChild(label);

  suggestions.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'followup-btn';
    btn.textContent = q;
    btn.addEventListener('click', () => {
      const input = document.getElementById('chat-input');
      if (input) {
        input.value = q;
        // 클릭 이벤트 — sendChat() 호출
        document.getElementById('btn-send-chat').click();
      }
    });
    wrap.appendChild(btn);
  });

  container.appendChild(wrap);
}

// ============ 백테스트 UI ============

async function runBacktestUI() {
  const btn = document.getElementById('btn-run-backtest');
  if (btn) { btn.disabled = true; btn.textContent = '분석 중...'; }

  try {
    const result = await window.appAPI.runBacktest({
      initialCapital: 10_000_000,
      periodYears:    3,
      touchThreshold: 0.04
    });

    if (!result || !result.success) {
      alert('백테스트 실패: ' + (result?.error || '오류'));
      return;
    }

    renderBacktestPanel(result);
    document.getElementById('scan-panel').style.display = 'none';
    document.getElementById('backtest-panel').style.display = 'flex';

  } catch (e) {
    alert('백테스트 오류: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '백테스트 (3년)'; }
  }
}

function renderBacktestPanel({ summary, results }) {
  // 요약 카드
  const cards = document.getElementById('backtest-summary-cards');
  const avgCls  = summary.avg_return_pct >= 0 ? 'positive' : 'negative';
  cards.innerHTML = `
    <div class="bt-card">
      <div class="bt-card-label">분석 기간</div>
      <div class="bt-card-value neutral">${summary.from_date} ~ ${summary.to_date}</div>
    </div>
    <div class="bt-card">
      <div class="bt-card-label">대상 종목</div>
      <div class="bt-card-value neutral">${summary.total_tickers}종목</div>
    </div>
    <div class="bt-card">
      <div class="bt-card-label">거래 발생</div>
      <div class="bt-card-value neutral">${summary.active_tickers}종목</div>
    </div>
    <div class="bt-card">
      <div class="bt-card-label">수익 종목</div>
      <div class="bt-card-value positive">${summary.positive_tickers}종목</div>
    </div>
    <div class="bt-card">
      <div class="bt-card-label">평균 수익률</div>
      <div class="bt-card-value ${avgCls}">${summary.avg_return_pct >= 0 ? '+' : ''}${summary.avg_return_pct}%</div>
    </div>
    ${summary.best ? `
    <div class="bt-card">
      <div class="bt-card-label">최고 종목</div>
      <div class="bt-card-value positive">${escapeHtml(summary.best.name)} +${summary.best.total_return_pct}%</div>
    </div>` : ''}
    ${summary.worst ? `
    <div class="bt-card">
      <div class="bt-card-label">최저 종목</div>
      <div class="bt-card-value negative">${escapeHtml(summary.worst.name)} ${summary.worst.total_return_pct}%</div>
    </div>` : ''}
  `;

  // 패널 헤더 요약
  const summaryEl = document.getElementById('backtest-panel-summary');
  if (summaryEl) {
    summaryEl.textContent =
      `종목별 1,000만원 | 3년 | 수수료 0.015%`;
  }

  // 결과 테이블
  const tbody = document.getElementById('backtest-result-tbody');
  tbody.innerHTML = results.map(r => {
    const noTrade = r.trades_count === 0;
    const retCls  = r.total_return_pct > 0 ? 'bt-positive'
                  : r.total_return_pct < 0 ? 'bt-negative' : 'bt-zero';
    const pnlCls  = r.realized_pnl > 0 ? 'bt-positive'
                  : r.realized_pnl < 0 ? 'bt-negative' : 'bt-zero';
    const unrCls  = r.unrealized_pnl > 0 ? 'bt-positive'
                  : r.unrealized_pnl < 0 ? 'bt-negative' : 'bt-zero';
    const retSign  = r.total_return_pct  > 0 ? '+' : '';
    const pnlSign  = r.realized_pnl      > 0 ? '+' : '';
    const unrSign  = r.unrealized_pnl    > 0 ? '+' : '';

    return `
      <tr class="${noTrade ? 'bt-no-trade' : ''}">
        <td>${escapeHtml(r.ticker)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${r.support.toLocaleString()}</td>
        <td>${r.resistance.toLocaleString()}</td>
        <td>${noTrade ? '-' : r.trades_count}</td>
        <td>${noTrade ? '-' : `${r.win_count}승 ${r.loss_count}패`}</td>
        <td>${noTrade ? '-' : r.win_rate + '%'}</td>
        <td class="${pnlCls}">${noTrade ? '-' : pnlSign + r.realized_pnl.toLocaleString() + '원'}</td>
        <td class="${unrCls}">${r.unrealized_pnl !== 0 ? unrSign + r.unrealized_pnl.toLocaleString() + '원' : '-'}</td>
        <td class="${retCls}">${noTrade ? '-' : retSign + r.total_return_pct + '%'}</td>
        <td>${noTrade ? '-' : r.avg_hold_days + '일'}</td>
        <td>${noTrade ? '-' : r.final_value.toLocaleString() + '원'}</td>
        <td>${r.in_position ? '<span class="bt-badge-holding">보유중</span>' : '-'}</td>
      </tr>`;
  }).join('');
}

// ============================================================
// 실시간 거래 (3.5단계) — 메인 창 UI
// ============================================================

// 실시간 거래 버튼 이벤트 + 창 상태 수신
function setupRealTradingUI() {
  const btn = document.getElementById('btn-real-trading');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await window.appAPI.realOpenWindow();
      if (!res.success) {
        document.getElementById('status-bar').textContent = `실시간 거래: ${res.error}`;
      }
    } catch (e) {
      document.getElementById('status-bar').textContent = `실시간 거래 오류: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // 실시간 창 열림/닫힘 알림 수신
  window.appAPI.onRealWindowStateChange((data) => {
    if (data.state === 'open') {
      document.body.classList.add('real-trading-open');
      document.getElementById('account-summary-panel').style.display = 'flex';
      btn.classList.add('active');
      btn.textContent = '거래창 열림';
    } else {
      document.body.classList.remove('real-trading-open');
      document.getElementById('account-summary-panel').style.display = 'none';
      btn.classList.remove('active');
      btn.textContent = '실시간 거래';
    }
  });

  // 실시간 시세 수신 → 계좌 패널 보유종목 현재가 갱신
  window.appAPI.onRealQuote((data) => {
    updateAccountPanelHoldingPrice(data.ticker, data.price, data.change);
  });
}

// 계좌 패널 갱신 (real:accountUpdated 또는 로그인 후 계좌 조회 시 호출)
function updateAccountPanel(account, holdings) {
  if (!account) return;
  const fmtNum = (n) => n != null ? Math.abs(n).toLocaleString('ko-KR') : '-';
  const fmtPct = (n) => {
    if (n == null) return '-';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${parseFloat(n).toFixed(2)}%`;
  };

  document.getElementById('acct-no').textContent      = account.account_no || '-';
  document.getElementById('acct-deposit').textContent = fmtNum(account.deposit) + '원';
  document.getElementById('acct-eval').textContent    = fmtNum(account.eval_total) + '원';
  const pnlEl = document.getElementById('acct-pnl');
  pnlEl.textContent = `${fmtNum(account.pnl_total)}원 (${fmtPct(account.rate_of_return)})`;
  pnlEl.className   = `acct-value ${(account.pnl_total || 0) >= 0 ? 'bullish' : 'bearish'}`;

  // 보유종목 목록
  const listEl = document.getElementById('acct-holdings-list');
  if (!holdings || holdings.length === 0) {
    listEl.innerHTML = '<div class="acct-empty">보유종목 없음</div>';
    return;
  }
  listEl.innerHTML = holdings.map(h => {
    const pnlCls = (h.pnl_rate || 0) >= 0 ? 'bullish' : 'bearish';
    return `<div class="acct-holding-item" data-ticker="${h.ticker}">
      <div class="acct-holding-ticker">${h.ticker}</div>
      <div class="acct-holding-price">${fmtNum(h.current_price)}원 · ${fmtNum(h.quantity)}주</div>
      <div class="acct-holding-pnl ${pnlCls}">${fmtPct(h.pnl_rate)} (${fmtNum(h.pnl_amount)}원)</div>
    </div>`;
  }).join('');
}

// 실시간 시세로 계좌 패널 보유종목 현재가 갱신 (DOM 직접 수정, DB 갱신 불필요)
function updateAccountPanelHoldingPrice(ticker, price, change) {
  const item = document.querySelector(`#acct-holdings-list [data-ticker="${ticker}"]`);
  if (!item) return;
  const priceEl = item.querySelector('.acct-holding-price');
  if (priceEl) {
    const qty = priceEl.textContent.split('·')[1] || '';
    priceEl.textContent = `${Math.abs(price).toLocaleString('ko-KR')}원 · ${qty.trim()}`;
  }
}

