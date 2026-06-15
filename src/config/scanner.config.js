// src/config/scanner.config.js
// 박스권 종목 스캔 및 필터링 파라미터 통합 설정 파일

const DEFAULTS = {
	// 분석 기간 (개월)
	SCAN_PERIOD_MONTHS: 60,

	// 유니버스 필터 — 제외 조건
	EXCLUDE_PREFERRED_STOCK: true,   // 우선주 제외 (이름 패턴: 우B, 1우, 2우, 우선 등)
	EXCLUDE_SPAC: true,              // 스팩 제외
	EXCLUDE_REIT: true,              // 리츠 제외
	EXCLUDE_IRREGULAR_TICKER: true,  // 비정형 티커 제외 (숫자 6자리 아닌 것)

	// 기본 필터
	MIN_CLOSE_PRICE: 2000,           // 최소 종가 (원)
	MIN_DATA_RATIO: 0.85,            // 기간 대비 최소 데이터 비율

	// 유동성 필터
	MIN_AVG_TURNOVER: 500000000,     // 일평균 거래대금 최소 (5억원), 0=비활성

	// 클러스터링
	SWING_WINDOW: 5,                 // 피크/밸리 탐지 윈도우 (거래일)
	CLUSTER_THRESHOLD: 0.05,         // 클러스터 병합 기준 (±5%)
	TOUCH_THRESHOLD: 0.04,           // 터치존 폭 (±4%)
	TOUCH_GROUP_DAYS: 5,             // 연속 터치 묶음 기준 (거래일)
	MIN_TOUCHES_PER_YEAR: 3,         // 연간 최소 터치 횟수
	MIN_TOUCHES_FLOOR: 9,            // 터치 횟수 하한선

	// 박스폭
	BOX_RANGE_MIN_PCT: 6,            // 박스 최소 폭 (%)
	BOX_RANGE_MAX_PCT: 25,           // 박스 최대 폭 (%)

	// 최근성 필터
	MAX_LAST_TOUCH_MONTHS: 6,        // 마지막 터치 허용 기간 (개월), 0=비활성

	// 현재가 위치 필터
	// 'none' | 'lower' | 'upper' | 'inside' | 'no_breakout'
	PRICE_POSITION_FILTER: 'none',   // 현재가 위치 필터 모드
	LOWER_ZONE_PCT: 15,              // 하단: 지지선 기준 +15% 이내
	UPPER_ZONE_PCT: 10,              // 상단: 저항선 기준 -10% 이내
	BREAKOUT_THRESHOLD_PCT: 10,      // 10% 이상 이탈 시 제외

	// 거짓 박스권 판별
	BOX_RESIDENCY_MIN_PCT: 55,       // 박스 내 체류 비율 최소 (%), 0=비활성
	TREND_SLOPE_MAX_PCT: 15,         // 연간 추세 기울기 한계 (%), 0=비활성
};

const CONFIG = {
	...DEFAULTS,
};

module.exports = { CONFIG, DEFAULTS };
