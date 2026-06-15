// src/services/boxScanner.js
// 박스권 스캐너 v4. 설정 파일(scanner.config.js) 기반 파라미터화.
// v4 변경: config 분리, 유니버스/유동성/최근성/위치/거짓박스권 필터 추가

const { getPool } = require('../db/connection');
const { CONFIG: DEFAULT_CONFIG } = require('../config/scanner.config');
const {
  insertScanHistory,
  insertScanResult,
  addOrUpdateStockInfo
} = require('../db/queries');

// ============ 유틸 ============

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

// ============ STEP 1: 로컬 피크/밸리 추출 ============

function findPeaksValleys(ohlcv, window) {
  const peaks   = [];
  const valleys = [];
  const n = ohlcv.length;

  for (let i = window; i < n - window; i++) {
    const high = ohlcv[i].high;
    const low  = ohlcv[i].low;
    const date = ohlcv[i].date;

    let isPeak = true, isValley = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (ohlcv[j].high >= high) { isPeak   = false; }
      if (ohlcv[j].low  <= low)  { isValley = false; }
      if (!isPeak && !isValley) break;
    }
    if (isPeak)   peaks.push({ price: high, date });
    if (isValley) valleys.push({ price: low,  date });
  }
  return { peaks, valleys };
}

// ============ STEP 2: 가격 클러스터링 ============

function clusterPrices(points, threshold) {
  if (points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let bucket = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const bucketCenter = bucket.reduce((s, p) => s + p.price, 0) / bucket.length;
    if (Math.abs(sorted[i].price - bucketCenter) / bucketCenter <= threshold) {
      bucket.push(sorted[i]);
    } else {
      clusters.push(bucket);
      bucket = [sorted[i]];
    }
  }
  clusters.push(bucket);

  return clusters
    .map(c => ({
      center: Math.round(c.reduce((s, p) => s + p.price, 0) / c.length),
      count:  c.length
    }))
    .sort((a, b) => b.count - a.count);
}

// ============ STEP 3: 터치 횟수 카운트 ============

function countTouches(ohlcv, center, threshold, groupDays, useHigh) {
  const lo = center * (1 - threshold);
  const hi = center * (1 + threshold);

  let touchCount    = 0;
  let lastTouchIdx  = -(groupDays + 1);
  let lastTouchDate = null;

  for (let i = 0; i < ohlcv.length; i++) {
    const val = useHigh ? ohlcv[i].high : ohlcv[i].low;
    if (val >= lo && val <= hi) {
      if (i - lastTouchIdx > groupDays) {
        touchCount++;
        lastTouchDate = ohlcv[i].date;
      }
      lastTouchIdx = i;
    }
  }
  return { count: touchCount, lastDate: lastTouchDate };
}

// ============ 거짓 박스권 판별: 체류 비율 ============

/**
 * 전체 기간 중 종가가 박스 구간 내에 있는 날의 비율 계산.
 * 터치존 폭(touchThreshold)을 박스 경계에 적용하여 약간의 여유를 둠.
 * @returns {number} 0~1 비율
 */
function calcBoxResidency(ohlcv, supportCenter, resistanceCenter, touchThreshold) {
  const loZone = supportCenter    * (1 - touchThreshold);
  const hiZone = resistanceCenter * (1 + touchThreshold);
  const inside = ohlcv.filter(d => d.close >= loZone && d.close <= hiZone).length;
  return inside / ohlcv.length;
}

// ============ 거짓 박스권 판별: 선형회귀 추세 기울기 ============

/**
 * 전체 종가에 최소자승법 선형회귀를 적용하여 연간 변화율(%) 절댓값 반환.
 * 기울기가 클수록 추세가 강한 종목 → 거짓 박스권.
 * @returns {number} 연간 변화율 절댓값 (%)
 */
function calcTrendSlopePct(ohlcv) {
  const n = ohlcv.length;
  if (n < 10) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += ohlcv[i].close;
    sumXY += i * ohlcv[i].close;
    sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const meanY = sumY / n;
  // 연간 변화율 = 기울기 * 연간 거래일(250) / 평균 종가 * 100
  return Math.abs(slope * 250 / meanY * 100);
}

// ============ 유니버스 필터 SQL 조건 생성 ============

function buildUniverseWhere(cfg) {
  const conds = [];
  if (cfg.EXCLUDE_PREFERRED_STOCK) {
    conds.push("s.name NOT REGEXP '우B$|[0-9]우B?$|우선주|우선$'");
  }
  if (cfg.EXCLUDE_SPAC) {
    conds.push("s.name NOT LIKE '%스팩%' AND s.name NOT LIKE '%SPAC%'");
  }
  if (cfg.EXCLUDE_REIT) {
    conds.push("s.name NOT LIKE '%리츠%'");
  }
  if (cfg.EXCLUDE_IRREGULAR_TICKER) {
    conds.push("d.ticker REGEXP '^[0-9]{6}$'");
  }
  return conds.length > 0 ? 'AND ' + conds.join(' AND ') : '';
}

// ============ 메인 스캔 ============

/**
 * 박스권 스캔 실행 (v4).
 * @param {object} configOverride - scanner.config.js CONFIG를 오버라이드할 값
 * @returns {{ scanId, results, totalTickers }}
 */
async function runBoxScan(configOverride = {}) {
  // configOverride가 없으면 DEFAULT_CONFIG 그대로 사용
  const cfg = { ...DEFAULT_CONFIG, ...configOverride };
  const pool = getPool();

  const scanTo   = new Date();
  const scanFrom = new Date(scanTo);
  scanFrom.setMonth(scanFrom.getMonth() - cfg.SCAN_PERIOD_MONTHS);

  const scanFromStr = toDateStr(scanFrom);
  const scanToStr   = toDateStr(scanTo);

  // 유니버스 필터 적용 — stock_info JOIN으로 이름 패턴 필터
  const universeWhere = buildUniverseWhere(cfg);
  const [tickerRows] = await pool.execute(
    `SELECT DISTINCT d.ticker
     FROM stock_daily d
     JOIN stock_info s ON s.ticker = d.ticker
     WHERE 1=1 ${universeWhere}
     ORDER BY d.ticker ASC`
  );
  const tickers = tickerRows.map(r => r.ticker);

  if (tickers.length === 0) {
    return { scanId: null, results: [], totalTickers: 0 };
  }

  // 최소 데이터 기준: 기간 × 월 20 거래일 × MIN_DATA_RATIO
  const minDataDays = Math.floor(cfg.SCAN_PERIOD_MONTHS * 20 * cfg.MIN_DATA_RATIO);

  const results = [];

  for (const ticker of tickers) {
    const [rows] = await pool.execute(
      `SELECT trade_date AS date, high, low, close, volume
       FROM stock_daily
       WHERE ticker = ? AND trade_date BETWEEN ? AND ?
       ORDER BY trade_date ASC`,
      [ticker, scanFromStr, scanToStr]
    );

    const data_days = rows.length;
    if (data_days < minDataDays) continue;

    // 최신 종가 MIN_CLOSE_PRICE 미만 → 스킵
    const close_at_scan = rows[rows.length - 1].close;
    if (close_at_scan < cfg.MIN_CLOSE_PRICE) continue;

    // 유동성 필터: 일평균 거래대금
    if (cfg.MIN_AVG_TURNOVER > 0) {
      const avgTurnover = rows.reduce((s, d) => s + d.close * d.volume, 0) / rows.length;
      if (avgTurnover < cfg.MIN_AVG_TURNOVER) continue;
    }

    // STEP 1: 피크/밸리 추출
    const { peaks, valleys } = findPeaksValleys(rows, cfg.SWING_WINDOW);
    if (peaks.length < 2 || valleys.length < 2) continue;

    // STEP 2: 클러스터링
    const resistanceClusters = clusterPrices(peaks,   cfg.CLUSTER_THRESHOLD);
    const supportClusters    = clusterPrices(valleys, cfg.CLUSTER_THRESHOLD);
    if (resistanceClusters.length === 0 || supportClusters.length === 0) continue;

    const resistanceZone = resistanceClusters[0];
    const supportZone    = supportClusters
                            .filter(c => c.center < resistanceZone.center)
                            .sort((a, b) => b.count - a.count)[0];
    if (!supportZone) continue;

    const resistance_center = resistanceZone.center;
    const support_center    = supportZone.center;
    const box_range_pct     = parseFloat(((resistance_center - support_center) / support_center * 100).toFixed(2));

    // 박스폭 범위 필터
    if (box_range_pct < cfg.BOX_RANGE_MIN_PCT || box_range_pct > cfg.BOX_RANGE_MAX_PCT) continue;

    // STEP 3: 터치 횟수 카운트
    const resistanceTouchResult = countTouches(rows, resistance_center, cfg.TOUCH_THRESHOLD, cfg.TOUCH_GROUP_DAYS, true);
    const supportTouchResult    = countTouches(rows, support_center,    cfg.TOUCH_THRESHOLD, cfg.TOUCH_GROUP_DAYS, false);

    const data_years  = data_days / 250;
    const minTouches  = Math.max(cfg.MIN_TOUCHES_FLOOR, Math.floor(data_years * cfg.MIN_TOUCHES_PER_YEAR));
    if (resistanceTouchResult.count < minTouches || supportTouchResult.count < minTouches) continue;

    const last_touch_date = [resistanceTouchResult.lastDate, supportTouchResult.lastDate]
                              .filter(Boolean).sort().at(-1) ?? null;

    // 최근성 필터
    if (cfg.MAX_LAST_TOUCH_MONTHS > 0 && last_touch_date) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - cfg.MAX_LAST_TOUCH_MONTHS);
      if (new Date(last_touch_date) < cutoff) continue;
    }

    // 현재가 위치 필터
    if (cfg.PRICE_POSITION_FILTER !== 'none') {
      const price      = close_at_scan;
      const loZone     = support_center    * (1 + cfg.LOWER_ZONE_PCT / 100);
      const hiZone     = resistance_center * (1 - cfg.UPPER_ZONE_PCT / 100);
      const breakoutLo = support_center    * (1 - cfg.BREAKOUT_THRESHOLD_PCT / 100);
      const breakoutHi = resistance_center * (1 + cfg.BREAKOUT_THRESHOLD_PCT / 100);

      if (cfg.PRICE_POSITION_FILTER === 'lower'      && price > loZone)    continue;
      if (cfg.PRICE_POSITION_FILTER === 'upper'      && price < hiZone)    continue;
      if (cfg.PRICE_POSITION_FILTER === 'inside'     && (price < support_center || price > resistance_center)) continue;
      if (cfg.PRICE_POSITION_FILTER === 'no_breakout'&& (price < breakoutLo || price > breakoutHi)) continue;
    }

    // 거짓 박스권 판별 A: 박스 내 체류 비율
    let box_residency_pct = null;
    if (cfg.BOX_RESIDENCY_MIN_PCT > 0) {
      const residency = calcBoxResidency(rows, support_center, resistance_center, cfg.TOUCH_THRESHOLD);
      box_residency_pct = Math.round(residency * 100);
      if (box_residency_pct < cfg.BOX_RESIDENCY_MIN_PCT) continue;
    }

    // 거짓 박스권 판별 B: 선형회귀 추세 기울기
    let trend_slope_pct = null;
    if (cfg.TREND_SLOPE_MAX_PCT > 0) {
      trend_slope_pct = parseFloat(calcTrendSlopePct(rows).toFixed(1));
      if (trend_slope_pct > cfg.TREND_SLOPE_MAX_PCT) continue;
    }

    // 일평균 거래대금 (결과에 포함)
    const avg_turnover = Math.round(
      rows.reduce((s, d) => s + d.close * d.volume, 0) / rows.length
    );

    // stock_info 없으면 자동 INSERT
    const [infoCheck] = await pool.execute(
      'SELECT ticker FROM stock_info WHERE ticker = ?', [ticker]
    );
    if (infoCheck.length === 0) {
      await addOrUpdateStockInfo({
        ticker, name: ticker, market: 'KOSDAQ',
        box_low: null, box_high: null, note: null
      });
    }

    results.push({
      ticker,
      box_high:           resistance_center,
      box_low:            support_center,
      box_range_pct,
      close_at_scan,
      data_days,
      resistance_center,
      support_center,
      resistance_touches: resistanceTouchResult.count,
      support_touches:    supportTouchResult.count,
      last_touch_date,
      avg_turnover,
      box_residency_pct,
      trend_slope_pct
    });
  }

  // 스캔 이력 저장
  const scanId = await insertScanHistory({
    period_months: cfg.SCAN_PERIOD_MONTHS,
    scan_from:     scanFromStr,
    scan_to:       scanToStr,
    total_tickers: results.length,
    memo: `filter:${cfg.PRICE_POSITION_FILTER},period:${cfg.SCAN_PERIOD_MONTHS}m`
  });

  // 종목별 결과 저장
  for (const r of results) {
    await insertScanResult({
      scan_id:            scanId,
      ticker:             r.ticker,
      scan_from:          scanFromStr,
      scan_to:            scanToStr,
      box_high:           r.box_high,
      box_low:            r.box_low,
      box_range_pct:      r.box_range_pct,
      close_at_scan:      r.close_at_scan,
      data_days:          r.data_days,
      resistance_center:  r.resistance_center,
      support_center:     r.support_center,
      resistance_touches: r.resistance_touches,
      support_touches:    r.support_touches,
      last_touch_date:    r.last_touch_date
    });
  }

  return { scanId, results, totalTickers: results.length };
}

module.exports = { runBoxScan };
