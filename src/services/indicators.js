// src/services/indicators.js
// 기술 지표 계산 모음. OHLCV 배열 입력 → 12개 지표 출력.

/**
 * 전체 지표 계산 진입점
 *
 * @param {Array} ohlcvArr  - [{date, open, high, low, close, volume}, ...]
 * @param {string} fromDate - 반환 필터 시작일 (YYYY-MM-DD), 선택
 * @param {string} toDate   - 반환 필터 종료일 (YYYY-MM-DD), 선택
 * @returns {Array} 계산된 지표 배열
 */
function calculateAll(ohlcvArr, fromDate = null, toDate = null) {
  if (!ohlcvArr || ohlcvArr.length === 0) return [];

  if (ohlcvArr.length < 35) {
    console.warn('경고: 최소 35개 데이터 포인트 권장 (현재:', ohlcvArr.length, ')');
  }

  const closes  = ohlcvArr.map(r => r.close);
  const highs   = ohlcvArr.map(r => r.high);
  const lows    = ohlcvArr.map(r => r.low);
  const volumes = ohlcvArr.map(r => r.volume);

  const mas  = {
    ma5:   calcMA(closes, 5),
    ma20:  calcMA(closes, 20),
    ma60:  calcMA(closes, 60),
    ma120: calcMA(closes, 120)
  };
  const bb           = calcBB(closes, 20, 2);
  const obv          = calcOBV(closes, volumes);
  const rsi          = calcRSI(closes, 14);
  const macd         = calcMACD(closes, 12, 26, 9);
  const stoch        = calcStochastic(highs, lows, closes, 14, 3);
  const atr          = calcATR(highs, lows, closes, 14);
  const cci          = calcCCI(highs, lows, closes, 20);
  const vwap         = calcVWAP(highs, lows, closes, volumes);
  const divergences  = detectDivergence(closes, rsi, obv.obv);
  const candlePatterns = ohlcvArr.map((row, i) =>
    detectCandlePattern(row.open, row.high, row.low, row.close, i > 0 ? ohlcvArr[i - 1] : null)
  );

  const results = ohlcvArr.map((row, i) => ({
    date:   row.date || row.trade_date,
    open:   row.open,
    high:   row.high,
    low:    row.low,
    close:  row.close,
    volume: row.volume,

    ma5:   mas.ma5[i],
    ma20:  mas.ma20[i],
    ma60:  mas.ma60[i],
    ma120: mas.ma120[i],

    bbUpper:  bb.upper[i],
    bbMiddle: bb.middle[i],
    bbLower:  bb.lower[i],
    bbPctB:   bb.pctB[i],
    bbWidth:  bb.width[i],

    obv:     obv.obv[i],
    obvMa20: obv.obvMa20[i],

    rsi: rsi[i],

    macd:          macd.macd[i],
    macdSignal:    macd.signal[i],
    macdHistogram: macd.histogram[i],

    stochK: stoch.k[i],
    stochD: stoch.d[i],

    atr:  atr[i],
    cci:  cci[i],
    vwap: vwap[i],

    rsiDivergence: divergences.rsi[i],
    obvDivergence: divergences.obv[i],
    candlePattern: candlePatterns[i]
  }));

  // Input-based paging: 범위 필터링 후 반환
  if (fromDate && toDate) {
    return results.filter(r => r.date >= fromDate && r.date <= toDate);
  }
  if (fromDate) {
    return results.filter(r => r.date >= fromDate);
  }
  if (toDate) {
    return results.filter(r => r.date <= toDate);
  }

  return results;
}

// ============ 1. 이동평균 (MA) ============

function calcMA(data, period) {
  const ma = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    ma[i] = sum / period;
  }
  return ma;
}

// ============ 2. 볼린저밴드 (BB, 표본분산 N-1) ============

function calcBB(closes, period = 20, mult = 2) {
  const upper  = new Array(closes.length).fill(null);
  const middle = new Array(closes.length).fill(null);
  const lower  = new Array(closes.length).fill(null);
  const pctB   = new Array(closes.length).fill(null);
  const width  = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const ma = sum / period;
    middle[i] = ma;

    let sumSquares = 0;
    for (let j = i - period + 1; j <= i; j++) sumSquares += Math.pow(closes[j] - ma, 2);
    const stdDev = Math.sqrt(sumSquares / (period - 1)); // N-1 표본분산

    upper[i] = ma + mult * stdDev;
    lower[i] = ma - mult * stdDev;

    pctB[i]  = upper[i] !== lower[i] ? (closes[i] - lower[i]) / (upper[i] - lower[i]) : 0.5;
    width[i] = (upper[i] - lower[i]) / ma;
  }

  return { upper, middle, lower, pctB, width };
}

// ============ 3. OBV ============

function calcOBV(closes, volumes) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if      (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - volumes[i];
    else                                 obv[i] = obv[i - 1];
  }

  const obvMa20 = new Array(obv.length).fill(null);
  for (let i = 19; i < obv.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += obv[j];
    obvMa20[i] = sum / 20;
  }

  return { obv, obvMa20 };
}

// ============ 4. RSI (Wilder 평활 — 단순 EMA 아님) ============

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  const gains  = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains[i]  = change;
    else            losses[i] = -change;
  }

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { avgGain += gains[i]; avgLoss += losses[i]; }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = 100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));

  // Wilder 평활: avg_gain[t] = (avg_gain[t-1] × (period-1) + gain[t]) / period
  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i])  / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    rsi[i]  = 100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
  }

  return rsi;
}

// ============ 5. MACD ============

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ema12 = calcEMA(closes, fast);
  const ema26 = calcEMA(closes, slow);

  const macd = ema12.map((val, i) =>
    val !== null && ema26[i] !== null ? val - ema26[i] : null
  );

  const signalLine = calcEMA(macd, signal);

  const histogram = macd.map((val, i) =>
    val !== null && signalLine[i] !== null ? val - signalLine[i] : null
  );

  return { macd, signal: signalLine, histogram };
}

function calcEMA(data, period) {
  const ema = new Array(data.length).fill(null);
  const k   = 2 / (period + 1);

  let sum = 0, count = 0;
  for (let i = 0; i < period; i++) {
    if (data[i] !== null && data[i] !== undefined) { sum += data[i]; count++; }
  }
  if (count < period) return ema;

  ema[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    if (data[i] === null || data[i] === undefined) continue;
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

// ============ 6. 스토캐스틱 ============

function calcStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const k = new Array(closes.length).fill(null);
  const d = new Array(closes.length).fill(null);

  for (let i = kPeriod - 1; i < closes.length; i++) {
    let maxHigh = highs[i], minLow = lows[i];
    for (let j = i - kPeriod + 1; j < i; j++) {
      maxHigh = Math.max(maxHigh, highs[j]);
      minLow  = Math.min(minLow,  lows[j]);
    }
    k[i] = maxHigh !== minLow ? ((closes[i] - minLow) / (maxHigh - minLow)) * 100 : 50;
  }

  for (let i = kPeriod + dPeriod - 2; i < k.length; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) sum += k[j];
    d[i] = sum / dPeriod;
  }

  return { k, d };
}

// ============ 7. ATR (Wilder 평활) ============

function calcATR(highs, lows, closes, period = 14) {
  const atr = new Array(closes.length).fill(null);
  const tr  = new Array(closes.length).fill(null);

  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;

  for (let i = period + 1; i < closes.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  return atr;
}

// ============ 8. CCI ============

function calcCCI(highs, lows, closes, period = 20) {
  const cci = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    const tpArr = [];
    for (let j = i - period + 1; j <= i; j++) {
      tpArr.push((highs[j] + lows[j] + closes[j]) / 3);
    }

    const tpMa   = tpArr.reduce((a, b) => a + b, 0) / period;
    let   sumAbs = 0;
    for (const tp of tpArr) sumAbs += Math.abs(tp - tpMa);
    const mad = sumAbs / period;

    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cci[i]   = mad === 0 ? 0 : (tp - tpMa) / (0.015 * mad);
  }

  return cci;
}

// ============ 9. VWAP (누적, Typical Price) ============

function calcVWAP(highs, lows, closes, volumes) {
  const vwap = new Array(closes.length).fill(null);
  let cumTP = 0, cumVol = 0;

  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTP  += tp * volumes[i];
    cumVol += volumes[i];
    if (cumVol > 0) vwap[i] = cumTP / cumVol;
  }

  return vwap;
}

// ============ 10. 다이버전스 감지 ============

function detectDivergence(closes, rsiValues, obvValues) {
  const minGap = 5;
  const rsiDiv = new Array(closes.length).fill(null);
  const obvDiv = new Array(closes.length).fill(null);

  function findPrevLow(closes, i, minGap) {
    for (let j = i - minGap - 1; j >= minGap; j--) {
      let isPivot = true;
      for (let k = j - minGap; k <= j + minGap; k++) {
        if (k >= 0 && k !== j && closes[k] < closes[j]) { isPivot = false; break; }
      }
      if (isPivot) return j;
    }
    return -1;
  }

  for (let i = minGap; i < closes.length - minGap; i++) {
    let isLow = true;
    for (let j = i - minGap; j <= i + minGap; j++) {
      if (j !== i && closes[j] < closes[i]) { isLow = false; break; }
    }

    if (isLow) {
      const prev = findPrevLow(closes, i, minGap);

      if (prev >= 0 && rsiValues[i] !== null && rsiValues[prev] !== null) {
        if (closes[i] < closes[prev] && rsiValues[i] > rsiValues[prev])
          rsiDiv[i] = 'bullish_hidden';
        else if (closes[i] < closes[prev] && rsiValues[i] < rsiValues[prev])
          rsiDiv[i] = 'bearish_standard';
      }

      if (prev >= 0 && obvValues[i] !== null && obvValues[prev] !== null) {
        if (closes[i] < closes[prev] && obvValues[i] > obvValues[prev])
          obvDiv[i] = 'bullish_hidden';
        else if (closes[i] < closes[prev] && obvValues[i] < obvValues[prev])
          obvDiv[i] = 'bearish_standard';
      }
    }
  }

  return { rsi: rsiDiv, obv: obvDiv };
}

// ============ 11. 캔들 패턴 감지 ============

function detectCandlePattern(open, high, low, close, prevCandle) {
  const bodySize  = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const totalHeight = high - low;

  if (close > open && lowerWick > bodySize * 2 && upperWick < bodySize * 0.5)
    return 'bullish_tail';

  if (prevCandle && prevCandle.close < prevCandle.open &&
      open < prevCandle.close && close > prevCandle.open)
    return 'bullish_engulfing';

  if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5 && close > open)
    return 'hammer';

  if (prevCandle && open > prevCandle.close && close > open)
    return 'gap_up_bullish';

  if (bodySize < totalHeight * 0.1 && upperWick > bodySize && lowerWick > bodySize)
    return 'doji';

  if (close < open)
    return 'bearish';

  return null;
}

module.exports = {
  calculateAll,
  calcMA, calcBB, calcOBV, calcRSI,
  calcMACD, calcEMA, calcStochastic,
  calcATR, calcCCI, calcVWAP,
  detectDivergence, detectCandlePattern
};
