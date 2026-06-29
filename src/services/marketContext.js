// src/services/marketContext.js
// 매크로/시장 컨텍스트 fetch — 네이버 금융 기반.
// AI 채팅 "시장 흐름/분위기" 섹션의 사실 근거 제공.
// 데이터 소스:
//   KR 지수(KOSPI/KOSDAQ): polling.finance.naver.com (실시간)
//   USD-KRW 환율 + DXY 달러인덱스: api.stock.naver.com/marketindex/exchange (10분 지연)
// 캐시: 10분 — 매 채팅 요청에 외부 호출 폭주 방지.
// 실패 시 null 반환 — buildSystemPrompt가 [H] 블록 생략.
//
// 참고: Yahoo Finance v7 quote API는 2024년 이후 401 차단 → 네이버로 변경.
// VIX/US10Y는 네이버 polling에서 지원 안 함 → 추후 별도 소스 추가 검토.

const https = require('https');

const CACHE_TTL_MS = 10 * 60 * 1000;
let _cache = null;
let _cachedAt = 0;

// ─────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────
function _getJson(hostname, path, referer = 'https://finance.naver.com/') {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (stock-talk macro)',
        'Accept':     '*/*',  // polling.finance.naver.com이 application/json 거부(406) — 와일드카드 사용
        'Referer':    referer
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error(`${hostname} timeout`)));
    req.end();
  });
}

// ─────────────────────────────────────────────
// KR 지수 — KOSPI/KOSDAQ (polling.finance.naver.com)
// 응답 nv=현재값(소수점 1자리 스케일 가정), cv=등락폭, cr=등락률(%)
// ─────────────────────────────────────────────
async function _fetchKrIndices() {
  try {
    const j = await _getJson(
      'polling.finance.naver.com',
      '/api/realtime?query=SERVICE_INDEX:KOSPI,KOSDAQ,KPI200'
    );
    const datas = j?.result?.areas?.[0]?.datas || [];
    const by = {};
    datas.forEach(d => {
      // 네이버 nv는 정수 표현 (실제 값 × 100). 일반적으로 /100 으로 환산.
      const price = d.nv != null ? d.nv / 100 : null;
      by[d.cd] = {
        price,
        change:        d.cv != null ? d.cv / 100 : null,
        changePercent: d.cr != null ? d.cr : null,
        marketStatus:  d.ms || null
      };
    });
    return by;
  } catch (e) {
    console.warn('[macro] KR indices fetch 실패:', e.message);
    return {};
  }
}

// ─────────────────────────────────────────────
// 환율/달러인덱스 (api.stock.naver.com/marketindex/exchange)
// 응답 normalList[].symbolCode, closePrice, fluctuationsRatio
// ─────────────────────────────────────────────
async function _fetchExchange() {
  try {
    const j = await _getJson(
      'api.stock.naver.com',
      '/marketindex/exchange',
      'https://m.stock.naver.com/'
    );
    const list = j?.normalList || [];
    const wanted = { USD: 'usdkrw', DXY: 'dxy' };
    const by = {};
    list.forEach(r => {
      const key = wanted[r.symbolCode];
      if (!key) return;
      const price = parseFloat(String(r.closePrice).replace(/,/g, ''));
      const pct   = parseFloat(r.fluctuationsRatio);
      by[key] = {
        price:         isFinite(price) ? price : null,
        changePercent: isFinite(pct) ? pct : null,
        marketStatus:  r.marketStatus || null
      };
    });
    return by;
  } catch (e) {
    console.warn('[macro] exchange fetch 실패:', e.message);
    return {};
  }
}

/**
 * 매크로 컨텍스트 fetch — 10분 캐시.
 * @returns {Promise<Object|null>}
 *   { kospi, kosdaq, kpi200, usdkrw, dxy, fetchedAt }
 *   하나도 못 가져오면 null.
 */
async function fetchMacroContext() {
  const now = Date.now();
  if (_cache && (now - _cachedAt) < CACHE_TTL_MS) return _cache;

  const [kr, fx] = await Promise.all([_fetchKrIndices(), _fetchExchange()]);
  const out = {
    kospi:  kr.KOSPI  || null,
    kosdaq: kr.KOSDAQ || null,
    kpi200: kr.KPI200 || null,
    usdkrw: fx.usdkrw || null,
    dxy:    fx.dxy    || null,
    fetchedAt: new Date(now).toISOString()
  };
  const anyData = Object.values(out).some(v => v && typeof v === 'object' && v.price != null);
  if (!anyData) return null;
  _cache    = out;
  _cachedAt = now;
  return out;
}

/** [H] 블록 텍스트 포맷 */
function formatMacroBlock(macro) {
  if (!macro) return '';
  const fmt = (v, suffix = '', digits = 2) => {
    if (!v || v.price == null) return 'N/A';
    const p = Number(v.price).toLocaleString('en-US', { maximumFractionDigits: digits });
    const ch = v.changePercent != null
      ? ` (${v.changePercent >= 0 ? '+' : ''}${Number(v.changePercent).toFixed(2)}%)`
      : '';
    return `${p}${suffix}${ch}`;
  };
  return `[매크로 / 시장 컨텍스트 — 최근 시세, 10분 캐시]
※ 아래 값은 사실 근거 데이터. AI는 이를 바탕으로 "시장 흐름/분위기 추정" 섹션에서 추정·판단을 작성.
KOSPI 지수:    ${fmt(macro.kospi)}
KOSDAQ 지수:   ${fmt(macro.kosdaq)}
KOSPI200:      ${fmt(macro.kpi200)}
USD/KRW 환율:  ${fmt(macro.usdkrw)}
DXY (달러지수): ${fmt(macro.dxy)}
fetchedAt:     ${macro.fetchedAt}
※ VIX/US10Y 등 미국 거시 지표는 별도 소스 미연동 — 인터넷 검색 결과([F])에서 추정 보조 활용.`;
}

module.exports = { fetchMacroContext, formatMacroBlock };
