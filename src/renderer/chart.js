// src/renderer/chart.js
// Chart.js 3패널 차트 (캔들+MA5/20/60 / 캔들+거래량+BB / OBV+BB%B+RSI 다이버전스)
// 캔들: floating bar(몸통) + wickPlugin(심)
// 팬: 마우스 드래그로 3패널 동시 이동 + y축 동적 재계산
// 기본 6개월 윈도우 (캔들 두께 확보)

/* global window */

const { Chart } = require('../../node_modules/chart.js/auto');
window.Chart = Chart;
require('../../node_modules/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.js');
const annotationPlugin = require('../../node_modules/chartjs-plugin-annotation');
Chart.register(annotationPlugin);

// ============ wick 플러그인 (심 두께 절반: 0.5px) ============
const wickPlugin = {
  id: 'candleWicks',
  afterDatasetsDraw(chart) {
    if (!chart._candleWicks || !chart._candleWicks.length) return;
    const { ctx, scales, chartArea } = chart;
    if (!scales.x || !scales.y) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
    ctx.clip();
    ctx.lineWidth = 0.5;
    chart._candleWicks.forEach(d => {
      const xPos  = scales.x.getPixelForValue(d.x);
      const highY = scales.y.getPixelForValue(d.h);
      const lowY  = scales.y.getPixelForValue(d.l);
      ctx.strokeStyle = d.c >= d.o ? '#00ff88' : '#ff4444';
      ctx.beginPath();
      ctx.moveTo(xPos, highY);
      ctx.lineTo(xPos, lowY);
      ctx.stroke();
    });
    ctx.restore();
  }
};
Chart.register(wickPlugin);

// ============ Chart 인스턴스 & 전체 데이터 캐시 ============
let maChart    = null;   // 패널 0: 캔들 + MA5/20/60
let priceChart = null;   // 패널 1: 캔들 + 거래량 + BB
let divChart   = null;   // 패널 2: OBV + BB%B + RSI
let _allIndicators = [];
let _stockInfo     = {};

// 초기 가시 윈도우 — 6개월(약 180일). 전체 데이터는 좌측 드래그로 탐색.
const DISPLAY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

// 캔들 몸통/거래량 고정 픽셀 두께. 값 하나로 전체 조절.
const BAR_THICKNESS = 5;

// ============ x/y축 공통 — 그리드 제거 ============
function buildXAxis(minVal, maxVal) {
  const axis = {
    type: 'timeseries',
    time: { unit: 'day' },
    offset: true,
    ticks: { display: false },
    grid: { display: false }
  };
  if (minVal != null) axis.min = minVal;
  if (maxVal != null) axis.max = maxVal;
  return axis;
}

// 통화 prefix — KRW='₩', USD='$'. setChartCurrency()로 변경.
let _currencySymbol = '₩';
function setChartCurrency(currency) {
  _currencySymbol = currency === 'USD' ? '$' : '₩';
}
function _fmtPrice(v) {
  if (v == null) return '';
  if (_currencySymbol === '$') {
    return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return '₩' + Number(v).toLocaleString('ko-KR');
}

function buildYAxis(size = 10) {
  return {
    position: 'right',
    ticks: {
      color: '#a0a0a0',
      font: { size },
      callback: (v) => _fmtPrice(v)
    },
    grid: { display: false }
  };
}

// ============ 팬 상태 ============
const pan = { active: false, startX: 0, startMinMs: 0, startMaxMs: 0 };

function allCharts() {
  return [maChart, priceChart, divChart].filter(Boolean);
}

// ============ y축 동적 재계산 — 윈도우 내 데이터만 기준 ============
function recalcYRanges(winMin, winMax) {
  if (!_allIndicators.length) return;
  const inWin = _allIndicators.filter(d => {
    const t = new Date(d.date).getTime();
    return t >= winMin && t <= winMax;
  });
  if (!inWin.length) return;

  if (priceChart || maChart) {
    // 가격 + BB 라인까지 포함하여 y축 산정
    const lows  = inWin.map(d => Math.min(d.low,  d.bbLower ?? d.low));
    const highs = inWin.map(d => Math.max(d.high, d.bbUpper ?? d.high));
    const yLow  = Math.min(...lows);
    const yHigh = Math.max(...highs);
    const yPad  = Math.max((yHigh - yLow) * 0.06, 10);
    const yMin  = Math.floor(yLow - yPad);
    const yMax  = Math.ceil(yHigh + yPad);
    if (priceChart) {
      priceChart.options.scales.y.min = yMin;
      priceChart.options.scales.y.max = yMax;
      const maxVol = Math.max(...inWin.map(d => d.volume || 0));
      priceChart.options.scales.y2.max = maxVol * 3.0;
    }
    // maChart는 가격 패널과 동일 y 범위 사용 (MA선은 close 범위 이내)
    if (maChart) {
      maChart.options.scales.y.min = yMin;
      maChart.options.scales.y.max = yMax;
    }
  }

  if (divChart) {
    const obvVals = inWin.map(d => d.obv).filter(v => v != null);
    if (obvVals.length) {
      const obvMin = Math.min(...obvVals);
      const obvMax = Math.max(...obvVals);
      const obvPad = (obvMax - obvMin) * 0.1 || 1;
      divChart.options.scales.yObv.min = obvMin - obvPad;
      divChart.options.scales.yObv.max = obvMax + obvPad;
    }
  }
}

function applyWindow(minMs, maxMs) {
  allCharts().forEach(chart => {
    chart.options.scales.x.min = minMs;
    chart.options.scales.x.max = maxMs;
  });
  recalcYRanges(minMs, maxMs);
  allCharts().forEach(chart => chart.update('none'));
}

// ============ 팬 이벤트 ============
function initPan() {
  const canvas = document.getElementById('chart-price');
  if (!canvas) return;
  canvas.style.cursor = 'grab';

  canvas.addEventListener('mousedown', e => {
    if (!priceChart || !priceChart.scales.x) return;
    pan.active     = true;
    pan.startX     = e.clientX;
    pan.startMinMs = priceChart.scales.x.min;
    pan.startMaxMs = priceChart.scales.x.max;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!pan.active || !priceChart) return;
    const dx      = e.clientX - pan.startX;
    const chartW  = priceChart.chartArea?.width || 600;
    const rangeMs = pan.startMaxMs - pan.startMinMs;
    const msPerPx = rangeMs / chartW;
    const shiftMs = -dx * msPerPx;

    const allDates = _allIndicators.map(d => new Date(d.date).getTime());
    const dataMin  = Math.min(...allDates);
    const dataMax  = Math.max(...allDates);

    let newMin = pan.startMinMs + shiftMs;
    let newMax = pan.startMaxMs + shiftMs;

    if (newMin < dataMin) { newMin = dataMin; newMax = dataMin + rangeMs; }
    if (newMax > dataMax) { newMax = dataMax; newMin = dataMax - rangeMs; }

    applyWindow(newMin, newMax);
  });

  window.addEventListener('mouseup', () => {
    if (pan.active) {
      pan.active = false;
      canvas.style.cursor = 'grab';
    }
  });
}

// ============ Chart 초기화 ============
function initCharts() {
  // ── 패널 0: 캔들 + MA5/20/60 ──
  maChart = new Chart(document.getElementById('chart-ma'), {
    type: 'bar',
    data: { datasets: [] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, position: 'top', labels: { color: '#a0a0a0', font: { size: 10 }, boxWidth: 14, padding: 8 } }, annotation: { annotations: {} } },
      datasets: { bar: { grouped: false } },
      scales: {
        x: buildXAxis(),
        y: buildYAxis(10)
      }
    }
  });

  priceChart = new Chart(document.getElementById('chart-price'), {
    type: 'bar',
    data: { datasets: [] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, annotation: { annotations: {} } },
      datasets: { bar: { grouped: false } },
      scales: {
        x: buildXAxis(),
        y: buildYAxis(10),
        y2: { position: 'left', display: false, min: 0, grid: { display: false } }
      }
    }
  });

  divChart = new Chart(document.getElementById('chart-divergence'), {
    type: 'line',
    data: { datasets: [] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true, position: 'top',
          labels: { color: '#a0a0a0', font: { size: 10 }, boxWidth: 14, padding: 8 }
        },
        annotation: {
          annotations: {
            rsi30: { type: 'line', yMin: 30, yMax: 30, borderColor: 'rgba(68,255,68,0.4)',  borderWidth: 0.7, borderDash: [4,4] },
            rsi70: { type: 'line', yMin: 70, yMax: 70, borderColor: 'rgba(255,68,68,0.4)',  borderWidth: 0.7, borderDash: [4,4] },
            bb50:  { type: 'line', yMin: 50, yMax: 50, borderColor: 'rgba(150,150,150,0.25)', borderWidth: 0.7, borderDash: [2,4] }
          }
        }
      },
      scales: {
        x: buildXAxis(),
        y: { position: 'right', min: 0, max: 100, ticks: { color: '#a0a0a0', font: { size: 9 }, stepSize: 25 }, grid: { display: false } },
        yObv: {
          position: 'left',
          ticks: {
            color: '#3a7a9a', font: { size: 8 }, maxTicksLimit: 4,
            callback: v => Math.abs(v) >= 1e6 ? (v/1e6).toFixed(1)+'M' : (v/1e3).toFixed(0)+'K'
          },
          grid: { display: false }
        }
      }
    }
  });

  initPan();
}

// ============ 차트 업데이트 ============
function updateCharts(indicators, stockInfo) {
  if (!indicators || !indicators.length || !priceChart) return;

  _allIndicators = indicators;
  _stockInfo     = stockInfo || {};
  const labels   = indicators.map(d => new Date(d.date));

  // ── 윈도우: 최근 6개월 캡, 그 이전은 드래그로 ──
  // 데이터가 6개월보다 길게 들어오면 초기 화면은 최근 6개월만 보이고
  // 사용자는 좌측으로 드래그하여 더 이전 시점을 탐색할 수 있다.
  const dates   = labels.map(d => d.getTime());
  const dataMin = Math.min(...dates);
  const dataMax = Math.max(...dates);
  let winMin, winMax;
  if (dataMax - dataMin > DISPLAY_WINDOW_MS) {
    winMin = dataMax - DISPLAY_WINDOW_MS;
    winMax = dataMax;
  } else {
    winMin = dataMin;
    winMax = dataMax;
  }

  // MA 패널 x축 동기화
  if (maChart) maChart.options.scales.x = buildXAxis(winMin, winMax);

  priceChart.options.scales.x = buildXAxis(winMin, winMax);

  // wick 데이터 공유 — maChart, priceChart 모두 동일 캔들 심 사용
  const wickData = indicators.map(d => ({
    x: new Date(d.date), o: d.open, h: d.high, l: d.low, c: d.close
  }));
  if (maChart)    maChart._candleWicks    = wickData;
  priceChart._candleWicks = wickData;

  // ── maChart 데이터셋: 캔들 몸통 + MA5/20/60 ──
  if (maChart) {
    maChart.data.datasets = [
      // 캔들 몸통 (priceChart와 동일)
      {
        type: 'bar', label: '캔들',
        data: indicators.map(d => ({
          x: new Date(d.date),
          y: [Math.min(d.open, d.close), Math.max(d.open, d.close)]
        })),
        backgroundColor: indicators.map(d =>
          d.close >= d.open ? 'rgba(0,255,136,0.08)' : 'rgba(255,68,68,0.88)'
        ),
        borderColor: indicators.map(d =>
          d.close >= d.open ? '#00ff88' : '#ff4444'
        ),
        borderWidth: 1, borderSkipped: false,
        barThickness: BAR_THICKNESS, order: 2
      },
      // MA5 — 빨강 (단기)
      {
        type: 'line', label: 'MA5',
        data: indicators.map((d, i) => ({ x: labels[i], y: d.ma5 ?? null })),
        borderColor: '#ff6b6b', borderWidth: 1.2,
        backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 1
      },
      // MA20 — 노랑 (중기)
      {
        type: 'line', label: 'MA20',
        data: indicators.map((d, i) => ({ x: labels[i], y: d.ma20 ?? null })),
        borderColor: '#ffd93d', borderWidth: 1.2,
        backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 1
      },
      // MA60 — 파랑 (장기)
      {
        type: 'line', label: 'MA60',
        data: indicators.map((d, i) => ({ x: labels[i], y: d.ma60 ?? null })),
        borderColor: '#6bcbff', borderWidth: 1.2,
        backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 1
      },
      // MA120 — 보라 (초장기), 체크박스로 토글. 기본 숨김.
      {
        type: 'line', label: 'MA120',
        data: indicators.map((d, i) => ({ x: labels[i], y: d.ma120 ?? null })),
        borderColor: '#b39ddb', borderWidth: 1.2,
        backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 1,
        hidden: !(document.getElementById('chk-ma120')?.checked ?? false)
      }
    ];

  }

  priceChart.data.datasets = [
    // 거래량 (배경)
    {
      type: 'bar', label: '거래량',
      data: indicators.map(d => ({ x: new Date(d.date), y: d.volume ?? 0 })),
      yAxisID: 'y2',
      backgroundColor: indicators.map(d =>
        d.close >= d.open ? 'rgba(0,255,136,0.20)' : 'rgba(255,68,68,0.20)'
      ),
      borderWidth: 0,
      barThickness: BAR_THICKNESS, order: 3
    },
    // 캔들 몸통
    {
      type: 'bar', label: '캔들',
      data: indicators.map(d => ({
        x: new Date(d.date),
        y: [Math.min(d.open, d.close), Math.max(d.open, d.close)]
      })),
      backgroundColor: indicators.map(d =>
        d.close >= d.open ? 'rgba(0,255,136,0.08)' : 'rgba(255,68,68,0.88)'
      ),
      borderColor: indicators.map(d =>
        d.close >= d.open ? '#00ff88' : '#ff4444'
      ),
      borderWidth: 1, borderSkipped: false,
      barThickness: BAR_THICKNESS, order: 2
    },
    // BB Upper / Lower — 옅고 얇게
    {
      type: 'line', label: 'BB Upper',
      data: indicators.map((d, i) => ({ x: labels[i], y: d.bbUpper ?? null })),
      borderColor: 'rgba(100,150,255,0.45)', borderWidth: 0.7,
      backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 1
    },
    {
      type: 'line', label: 'BB Lower',
      data: indicators.map((d, i) => ({ x: labels[i], y: d.bbLower ?? null })),
      borderColor: 'rgba(100,150,255,0.45)', borderWidth: 0.7,
      backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 1
    }
  ];

  // 박스권 annotation — 두께 감소
  const annotations = {};
  if (_stockInfo.box_low) {
    annotations.boxLow = {
      type: 'line', yMin: _stockInfo.box_low, yMax: _stockInfo.box_low,
      borderColor: '#00ff88', borderWidth: 1, borderDash: [6, 3],
      label: { enabled: true, content: `하단 ${Number(_stockInfo.box_low).toLocaleString()}`, color: '#00ff88', backgroundColor: 'rgba(0,0,0,0.6)', position: 'start', font: { size: 10 } }
    };
  }
  if (_stockInfo.box_high) {
    annotations.boxHigh = {
      type: 'line', yMin: _stockInfo.box_high, yMax: _stockInfo.box_high,
      borderColor: '#ff4444', borderWidth: 1, borderDash: [6, 3],
      label: { enabled: true, content: `상단 ${Number(_stockInfo.box_high).toLocaleString()}`, color: '#ff4444', backgroundColor: 'rgba(0,0,0,0.6)', position: 'start', font: { size: 10 } }
    };
  }
  priceChart.options.plugins.annotation.annotations = annotations;
  // MA 패널에도 동일한 박스권 라인 표시
  if (maChart) maChart.options.plugins.annotation.annotations = annotations;

  // divChart x 동기화
  if (divChart) divChart.options.scales.x = buildXAxis(winMin, winMax);

  // BB%B (0-100)
  const bbPctData = indicators.map((d, i) => {
    if (!d.bbUpper || !d.bbLower || d.bbUpper === d.bbLower) return { x: labels[i], y: null };
    const pct = (d.close - d.bbLower) / (d.bbUpper - d.bbLower) * 100;
    return { x: labels[i], y: Math.max(0, Math.min(100, pct)) };
  });

  if (divChart) {
    divChart.data.datasets = [
      {
        label: 'RSI(14)',
        data: indicators.map((d, i) => ({ x: labels[i], y: d.rsi ?? null })),
        borderColor: '#c678dd', borderWidth: 0.9,
        backgroundColor: 'transparent', pointRadius: 0, fill: false,
        yAxisID: 'y'
      },
      {
        label: 'BB%B',
        data: bbPctData,
        borderColor: '#5bc8f5', borderWidth: 0.9,
        backgroundColor: 'transparent', pointRadius: 0, fill: false,
        yAxisID: 'y'
      },
      {
        label: 'OBV',
        data: indicators.map((d, i) => ({ x: labels[i], y: d.obv ?? null })),
        borderColor: 'rgba(80,160,200,0.55)', borderWidth: 0.7,
        backgroundColor: 'transparent', pointRadius: 0, fill: false,
        yAxisID: 'yObv'
      },
      {
        label: 'OBV MA20',
        data: indicators.map((d, i) => ({ x: labels[i], y: d.obvMa20 ?? null })),
        borderColor: '#ff914d', borderWidth: 0.9, borderDash: [4, 3],
        backgroundColor: 'transparent', pointRadius: 0, fill: false,
        yAxisID: 'yObv'
      }
    ];
  }

  // 윈도우 기준 y축 동적 재계산
  recalcYRanges(winMin, winMax);

  if (maChart)   maChart.update('none');
  priceChart.update('none');
  if (divChart)  divChart.update('none');
}

window.initCharts   = initCharts;
window.updateCharts = updateCharts;
window.setChartCurrency = setChartCurrency;

// maChart 인스턴스 외부 접근 (MA120 체크박스 토글용)
Object.defineProperty(window, 'maChart', { get: () => maChart });
