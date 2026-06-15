// src/services/backtest.js
// 박스권 백테스트 엔진. 최신 스캔 결과 종목별 독립 시뮬레이션.
// 전략: 지지선 터치 → 전액 매수, 저항선 터치 → 전량 매도, 손절 없음.

const { getPool } = require('../db/connection');
const { getLatestScanResults } = require('../db/queries');

const COMMISSION_RATE = 0.00015; // 편도 0.015%

/**
 * 박스권 백테스트 실행
 * @param {object} opts
 * @param {number} opts.initialCapital  - 종목별 초기 자금 (원)
 * @param {number} opts.periodYears     - 백테스트 기간 (년)
 * @param {number} opts.touchThreshold  - 터치존 비율 (0.04 = ±4%)
 */
async function runBacktest({ initialCapital = 10_000_000, periodYears = 3, touchThreshold = 0.04 } = {}) {
  const pool = getPool();

  const { history, results: scanResults } = await getLatestScanResults();
  if (!history || scanResults.length === 0) {
    throw new Error('스캔 결과 없음. 먼저 박스권 스캔을 실행하세요.');
  }

  const toDate   = new Date();
  const fromDate = new Date(toDate);
  fromDate.setFullYear(fromDate.getFullYear() - periodYears);
  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr   = toDate.toISOString().slice(0, 10);

  const tickerResults = [];

  for (const scan of scanResults) {
    const { ticker, support_center, resistance_center, stock_name } = scan;
    if (!support_center || !resistance_center || support_center >= resistance_center) continue;

    const [rows] = await pool.execute(
      `SELECT trade_date AS date, close
       FROM stock_daily
       WHERE ticker = ? AND trade_date BETWEEN ? AND ?
       ORDER BY trade_date ASC`,
      [ticker, fromStr, toStr]
    );

    if (rows.length < 60) continue;

    // 매수 기준: 종가 ≤ 지지선 × (1 + touchThreshold)
    // 매도 기준: 종가 ≥ 저항선 × (1 - touchThreshold)
    const entryZone = support_center    * (1 + touchThreshold);
    const exitZone  = resistance_center * (1 - touchThreshold);

    const trades   = [];
    let cash       = initialCapital;
    let shares     = 0;
    let entryPrice = 0;
    let entryDate  = null;
    let entryCost  = 0; // 매수 총비용 (수수료 포함)
    let inPosition = false;

    for (const row of rows) {
      const price = Number(row.close);
      const date  = row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10);

      if (!inPosition && price <= entryZone && cash >= price) {
        // 매수
        shares       = Math.floor(cash / price);
        if (shares === 0) continue;
        const cost   = shares * price;
        const buyFee = Math.round(cost * COMMISSION_RATE);
        entryCost    = cost + buyFee;
        cash        -= entryCost;
        entryPrice   = price;
        entryDate    = date;
        inPosition   = true;

      } else if (inPosition && price >= exitZone) {
        // 매도
        const proceeds = shares * price;
        const sellFee  = Math.round(proceeds * COMMISSION_RATE);
        const netProc  = proceeds - sellFee;
        const pnl      = netProc - entryCost;

        trades.push({
          entry_date:  entryDate,
          exit_date:   date,
          entry_price: entryPrice,
          exit_price:  price,
          shares,
          pnl:         Math.round(pnl),
          hold_days:   daysBetween(entryDate, date)
        });

        cash       += netProc;
        shares      = 0;
        inPosition  = false;
      }
    }

    // 미청산 포지션 — 기간 말 종가로 평가 (미실현)
    let unrealizedPnl = 0;
    let positionValue = 0;
    if (inPosition && rows.length > 0) {
      const lastPrice = Number(rows[rows.length - 1].close);
      positionValue   = shares * lastPrice;
      unrealizedPnl   = Math.round(positionValue - entryCost);
    }

    const realizedPnl  = trades.reduce((s, t) => s + t.pnl, 0);
    const winCount     = trades.filter(t => t.pnl > 0).length;
    const finalValue   = cash + positionValue;
    const totalReturn  = parseFloat(((finalValue - initialCapital) / initialCapital * 100).toFixed(2));
    const avgHoldDays  = trades.length > 0
      ? Math.round(trades.reduce((s, t) => s + t.hold_days, 0) / trades.length)
      : 0;

    tickerResults.push({
      ticker,
      name:             stock_name || ticker,
      support:          support_center,
      resistance:       resistance_center,
      trades_count:     trades.length,
      win_count:        winCount,
      loss_count:       trades.length - winCount,
      win_rate:         trades.length > 0 ? parseFloat((winCount / trades.length * 100).toFixed(1)) : 0,
      realized_pnl:     realizedPnl,
      unrealized_pnl:   unrealizedPnl,
      total_return_pct: totalReturn,
      avg_hold_days:    avgHoldDays,
      in_position:      inPosition,
      final_value:      Math.round(finalValue),
      trades
    });
  }

  // 수익률 내림차순 정렬
  tickerResults.sort((a, b) => b.total_return_pct - a.total_return_pct);

  // 전체 요약 (거래 발생 종목 기준)
  const active = tickerResults.filter(r => r.trades_count > 0);
  const avgReturn = active.length > 0
    ? parseFloat((active.reduce((s, r) => s + r.total_return_pct, 0) / active.length).toFixed(2))
    : 0;
  const positiveCount = active.filter(r => r.total_return_pct > 0).length;

  return {
    success: true,
    summary: {
      total_tickers:    tickerResults.length,
      active_tickers:   active.length,
      positive_tickers: positiveCount,
      avg_return_pct:   avgReturn,
      best:             active[0]                  || null,
      worst:            active[active.length - 1]  || null,
      period_years:     periodYears,
      initial_capital:  initialCapital,
      from_date:        fromStr,
      to_date:          toStr,
      scan_date:        history.scanned_at
    },
    results: tickerResults
  };
}

function daysBetween(d1, d2) {
  return Math.round(Math.abs(new Date(d2) - new Date(d1)) / 86_400_000);
}

module.exports = { runBacktest };
