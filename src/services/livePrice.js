// livePrice.js
// 목적: KR 종목 라이브 현재가 fetch (네이버 금융 모바일 API).
//       SearXNG snippet은 캐시 시점 불명 → 가격 신뢰 불가.
//       AI 채팅에서 현재가가 필요할 때 본 모듈로 라이브가를 컨텍스트 주입.
//
// 엔드포인트: https://m.stock.naver.com/api/stock/{ticker}/basic
//   - UTF-8 JSON 응답
//   - closePrice(장중엔 현재가) / compareToPreviousClosePrice / fluctuationsRatio
//   - marketStatus: OPEN / CLOSE / PRE_OPEN
//   - localTradedAt: ISO 8601 (KST)
//
// 캐시: 10초 TTL — 동일 종목 반복 채팅 시 폭주 방지.

const https = require('https');

const _cache = new Map(); // ticker → { ts, data }
const TTL_MS = 10_000;

/**
 * KR 종목 라이브 현재가 조회.
 * @param {string} ticker — 6자리 KR 종목코드 (예: '053800')
 * @returns {Promise<null | { ticker, name, price, change, changeRate, marketStatus, asOf, source }>}
 *          실패 시 null. price=0이면 호출 측에서 무시.
 */
function fetchKoreanLivePrice(ticker) {
  if (!/^\d{6}$/.test(String(ticker || ''))) return Promise.resolve(null);

  const cached = _cache.get(ticker);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return Promise.resolve(cached.data);
  }

  const url = `https://m.stock.naver.com/api/stock/${ticker}/basic`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (stock-talk/1.0)',
        'Accept':     'application/json'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const price  = parseInt(String(j.closePrice || '').replace(/,/g, ''), 10);
          const change = parseInt(String(j.compareToPreviousClosePrice || '0').replace(/,/g, ''), 10);
          if (!price || isNaN(price)) { resolve(null); return; }
          const data = {
            ticker,
            name:         j.stockName || '',
            price,
            change:       isNaN(change) ? 0 : change,
            changeRate:   Number(j.fluctuationsRatio) || 0,
            marketStatus: j.marketStatus || '',  // OPEN/CLOSE/PRE_OPEN
            asOf:         j.localTradedAt || '', // 거래 시점 ISO 8601
            source:       'naver.m.stock.basic'
          };
          _cache.set(ticker, { ts: Date.now(), data });
          resolve(data);
        } catch (e) {
          console.warn('[livePrice] JSON 파싱 실패:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.warn('[livePrice] 요청 실패:', e.message);
      resolve(null);
    });
    req.setTimeout(5000, () => {
      req.destroy();
      console.warn('[livePrice] 타임아웃 5s');
      resolve(null);
    });
  });
}

module.exports = { fetchKoreanLivePrice };
