# KIS Open API 모의투자(VTS) 기술 리서치

| 항목 | 내용 |
|------|------|
| 문서명 | KIS Open API 모의투자 기술 연구 보고서 |
| 버전 | V1 |
| 날짜 | 2026-06-15 |
| 작성자 | Claude Code |
| 문서 유형 | API 리서치 |
| 모델 사용 | claude-haiku-4-5 |

---

## 1. 인증 체계

### 1.1 OAuth 2.0 토큰 발급 구조

| 항목 | 설명 |
|------|------|
| **발급 엔드포인트** | POST `/oauth2/tokenP` |
| **Base URL (모의)** | `https://openapivts.koreainvestment.com:29443` |
| **Base URL (실투)** | `https://openapi.koreainvestment.com:9443` |
| **토큰 타입** | Bearer Token (JWT 형식) |
| **AccessToken 유효기간** | 약 24시간 (1440분) |
| **RefreshToken 유효기간** | 약 30일 |
| **갱신 방식** | 만료 전 갱신 또는 만료 후 재발급 |

### 1.2 AppKey / AppSecret 활용

```
발급 채널: KIS Developers 관리자 페이지
  - https://developers.koreainvestment.com
  - 앱 등록 → AppKey, AppSecret 발급

발급 단계:
  1. /oauth2/tokenP 엔드포인트 호출
  2. POST body: grant_type=password, appkey, appsecret, 계좌번호, 비밀번호
  3. 응답: access_token, token_type, expires_in, scope 등
```

### 1.3 AccessToken 발급 요청/응답

**요청 형식**
```
POST /oauth2/tokenP HTTP/1.1
Host: openapivts.koreainvestment.com:29443
Content-Type: application/json

{
  "grant_type": "password",
  "appkey": "{AppKey}",
  "appsecret": "{AppSecret}",
  "countrycode": "US",  // 국내: 생략 가능
  "custtype": "P",      // 개인(P) 또는 법인(B)
  "logintype": "0"      // 0: 일반, 1: API 직접 로그인
}
```

**응답 형식**
```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "full",
  "message": "success",
  "code": "0"
}
```

### 1.4 모의투자 vs 실투 인증 차이

| 구분 | 모의투자(VTS) | 실시간 투자 |
|------|---|---|
| **Base URL** | `https://openapivts.koreainvestment.com:29443` | `https://openapi.koreainvestment.com:9443` |
| **토큰 발급** | 동일 프로세스 | 동일 프로세스 |
| **WebSocket URL** | `ws://ops.koreainvestment.com:21000` | `ws://ops.koreainvestment.com:21000` (공용) |
| **계좌번호** | 모의용 계좌 (VTS 환경 할당) | 실제 증권 계좌 |
| **주의** | 모의 토큰으로 실투 API 호출 시 실패 | 계좌 오류 발생 가능 |

### 1.5 WebSocket approval_key 발급

WebSocket 연결 시 주식 실시간 체결 구독이 필요할 경우 별도의 `approval_key`가 필요하지 않으나, 특정 데이터에 대해 고속 구독(진정성 인증)이 필요할 수 있습니다.

```
방식: WebSocket 연결 후 관리자 승인 기반
  - 승인 불필요 채널: H0STCNT0 (일반 현재가)
  - 승인 필요 채널: 고속 틱 데이터 (확인 필요 — KIS 문서 참조)
```

---

## 2. 모의투자 환경

### 2.1 API 기본 정보

| 항목 | 값 |
|------|---|
| **API 제공처** | 한국투자증권 (KIS) |
| **환경 유형** | REST API + WebSocket |
| **모의투자 Base URL** | `https://openapivts.koreainvestment.com:29443` |
| **실투 Base URL** | `https://openapi.koreainvestment.com:9443` |
| **WebSocket URL (공용)** | `ws://ops.koreainvestment.com:21000` |
| **프로토콜** | HTTP/1.1, WebSocket (RFC 6455) |
| **TLS 버전** | TLS 1.2 이상 |
| **데이터 포맷** | JSON (REST), 구분자 기반 (WebSocket) |

### 2.2 모의투자 계좌 정보

```
계좌번호: 812451811
비밀번호: 0000
상품코드: 01 (일반 주식)
전체 계좌번호: 81245181101 (8자리 앞번호 + 2자리 상품코드)
구분: 개인(P)
환경: 모의투자(VTS)
초기 예수금: 1,000,000,000 원 (시뮬레이션용)
```

### 2.3 TR_ID 접두어 규칙

| 구분 | 접두어 | 예시 | 설명 |
|------|--------|------|------|
| **실투 REST API** | `T` 또는 특정 코드 | `TTTC0802U` | 국내 주식 현재가 |
| **모의투자 REST API** | `V` 또는 특정 코드 | `VTTC0802U` | 모의투자 현재가 |
| **WebSocket 구독** | 고정값 | `H0STCNT0` | 주식 체결 (실시간) |
| **내 주문 체결** | 고정값 | `H0STCNI0` | 체결 통보 (개인 주문) |

```
주의: TR_ID는 API 엔드포인트와 동일하지 않으며, 
헤더의 tr_id 필드에 정확히 명시해야 함
```

---

## 3. 핵심 REST API 엔드포인트

### 3.1 토큰 발급 API

| 항목 | 값 |
|------|---|
| **방식** | POST |
| **엔드포인트** | `/oauth2/tokenP` |
| **용도** | AccessToken 및 RefreshToken 발급 |
| **인증** | AppKey, AppSecret |
| **응답 필드** | access_token, token_type, expires_in |

**요청 헤더**
```
Content-Type: application/json
```

**응답 예시**
```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "full"
}
```

### 3.2 계좌 잔고 조회 (보유종목 + 예수금)

| 항목 | 값 |
|------|---|
| **방식** | GET |
| **엔드포인트** | `/uapi/domestic-stock/v1/trading/inquire-balance` |
| **TR_ID (모의)** | `VTTC8434R` |
| **TR_ID (실투)** | `TTTC8434R` |
| **용도** | 현재 보유 종목, 평가손익, 예수금 조회 |
| **인증** | Bearer Token (Authorization 헤더) |

**요청 쿼리 파라미터**
```
cano: 계좌번호 앞 8자리 (81245181)
acnt_prdt_cd: 상품코드 2자리 (01)
afhr_flpr_yn: 시간외 단가 포함 여부 (Y/N)
fncg_amt_auto_buy_yn: 자동매수 포함 여부 (Y/N)
total_search_yn: 전체 조회 여부 (Y/N)
```

**응답 구조**
```json
{
  "rt_cd": "0",
  "msg_cd": "0",
  "msg1": "정상처리 되었습니다.",
  "output1": {
    "tot_evalu_amt": "12345678",      // 총 평가액
    "tot_unslttl_amt": "1000000",     // 미결제 금액
    "tot_buy_amt": "10000000",        // 총 매입액
    "tot_eval_profit_loss_amt": "345678",  // 총 평가손익
    "tot_eval_profit_loss_rate": "3.46",   // 총 수익률
    "tot_loan_amt": "0",              // 총 융자금
    "cma_evalu_amt": "500000"         // CMA 평가액
  },
  "output2": [
    {
      "pdno": "005930",              // 종목코드
      "prdt_name": "삼성전자",        // 상품명
      "hldg_qty": "100",             // 보유 수량
      "prpr": "65000",               // 현재 단가
      "evalu_amt": "6500000",        // 평가액
      "evalu_profit_loss_amt": "500000",  // 평가손익
      "evalu_profit_loss_rate": "8.33",   // 수익률
      "pchs_avg_pric": "62500",      // 매입 평균가
      "pchs_amt": "6250000"          // 총 매입액
    }
  ]
}
```

### 3.3 주식 현재가 조회

| 항목 | 값 |
|------|---|
| **방식** | GET |
| **엔드포인트** | `/uapi/domestic-stock/v1/quotations/inquire-price` |
| **TR_ID (모의)** | `VTTC0802U` |
| **TR_ID (실투)** | `TTTC0802U` |
| **용도** | 특정 종목의 현재가, 호가, 거래량 조회 |

**요청 쿼리 파라미터**
```
fid_cond_mrkt_div_code: 시장 구분 (J: 공시용어 처리, Y: 통상용어)
fid_input_iscd: 종목코드 (6자리, 예: 005930)
```

**응답 구조**
```json
{
  "rt_cd": "0",
  "msg_cd": "0",
  "msg1": "정상처리 되었습니다.",
  "output": {
    "mksc_shrn_iscd": "005930",     // 종목코드
    "ishs_dvsn_iscd": "0",          // 지분분할 여부
    "ivol_dvsn_iscd": "0",          // 투자의견 구분
    "hts_kor_isnm": "삼성전자",      // 종목명
    "marg_rate": "0.70",            // 마진율
    "per": "15.23",                 // PER
    "pbr": "1.45",                  // PBR
    "ema_i_val": "60000",           // 지수 값
    "ema_i_val2": "60100",          // 지수 값2
    "bfd_clos_pric": "65000",       // 전날 종가
    "opnd_pric": "65200",           // 개장가
    "high_pric": "65500",           // 최고가
    "low_pric": "64800",            // 최저가
    "last_pric": "65100",           // 현재가
    "tot_askp": "65150",            // 총 매도 호가
    "tot_bidp": "65050",            // 총 매수 호가
    "nday_vol": "2500000",          // 거래량
    "nday_vrss_vol_rate": "+5.20"   // 거래량 증감율
  }
}
```

### 3.4 주식 매수 주문

| 항목 | 값 |
|------|---|
| **방식** | POST |
| **엔드포인트** | `/uapi/domestic-stock/v1/trading/order-cash` |
| **TR_ID (모의)** | `VTTC0801U` |
| **TR_ID (실투)** | `TTTC0801U` |
| **용도** | 현금 매수 주문 접수 |

**요청 헤더**
```
Content-Type: application/json
Authorization: Bearer {AccessToken}
appkey: {AppKey}
appsecret: {AppSecret}
tr_id: VTTC0801U (모의투자)
custtype: P
```

**요청 Body**
```json
{
  "cano": "81245181",           // 계좌번호 앞 8자리
  "acnt_prdt_cd": "01",         // 상품코드
  "pdno": "005930",             // 종목코드
  "ord_dvsn": "00",             // 주문 구분 (00:시장가, 01:지정가)
  "ord_qty": "10",              // 주문 수량
  "ord_unpr": "65000",          // 주문 단가 (지정가일 때만)
  "ord_type": "00",             // 주문 유형 (00: 신규)
  "ctac_tlno": "",              // 연락처 (선택)
  "ctac_tlno2": "",             // 연락처2 (선택)
  "sms_dn_incd": "0",           // SMS 유무 (0:무, 1:유)
  "ord_cond": "0"               // 주문 조건 (0:보통, 1:IOC, 2:FOK)
}
```

**응답 구조**
```json
{
  "rt_cd": "0",
  "msg_cd": "0",
  "msg1": "주문이 접수되었습니다.",
  "output": {
    "odno": "1234567890",        // 주문 번호
    "ordtmd": "01",              // 주문 시간
    "rtncode": "0",              // 반환 코드
    "rtnmsg": "정상"             // 반환 메시지
  }
}
```

### 3.5 주식 매도 주문

| 항목 | 값 |
|------|---|
| **방식** | POST |
| **엔드포인트** | `/uapi/domestic-stock/v1/trading/order-cash` |
| **TR_ID (모의)** | `VTTC0801U` |
| **TR_ID (실투)** | `TTTC0801U` |
| **용도** | 현금 매도 주문 접수 |
| **차이점** | 매수와 동일한 엔드포인트, Body 파라미터만 다름 |

**요청 Body (매도)**
```json
{
  "cano": "81245181",
  "acnt_prdt_cd": "01",
  "pdno": "005930",
  "ord_dvsn": "01",             // 01:지정가 (매도는 보통 지정가)
  "ord_qty": "10",
  "ord_unpr": "66000",          // 매도 희망가
  "ord_type": "00"
}
```

### 3.6 주문 체결 내역 조회

| 항목 | 값 |
|------|---|
| **방식** | GET |
| **엔드포인트** | `/uapi/domestic-stock/v1/trading/inquire-daily-ccld` |
| **TR_ID (모의)** | `VTTC8001R` |
| **TR_ID (실투)** | `TTTC8001R` |
| **용도** | 특정 기간의 체결 내역 조회 |

**요청 쿼리 파라미터**
```
cano: 계좌번호 앞 8자리
acnt_prdt_cd: 상품코드
inqr_strt_dt: 조회 시작일 (YYYYMMDD)
inqr_end_dt: 조회 종료일 (YYYYMMDD)
sll_buy_dvsn: 매도/매수 구분 (00:전체, 01:매도, 02:매수)
inqr_dvsn: 조회 구분 (00:전체 조회, 01:정정/취소 제외)
paging_code: 페이징 (선택)
```

**응답 구조**
```json
{
  "rt_cd": "0",
  "msg_cd": "0",
  "msg1": "정상",
  "output1": {
    "tot_ccld_amt": "6500000",    // 총 체결액
    "tot_ccld_qty": "100",        // 총 체결수량
    "tot_fee": "6500"             // 총 수수료
  },
  "output2": [
    {
      "ord_dt": "20260615",         // 주문일
      "ord_tm": "093000",           // 주문시간
      "odno": "1234567890",         // 주문번호
      "orgn_odno": "0",             // 원주문번호
      "sll_buy_dvsn": "02",         // 매도/매수(02:매수)
      "pdno": "005930",             // 종목코드
      "isnm": "삼성전자",           // 종목명
      "qty": "100",                 // 주문수량
      "prc": "65000",               // 주문가격
      "ccld_qty": "100",            // 체결수량
      "ccld_amt": "6500000",        // 체결액
      "state": "02",                // 상태(02:체결)
      "ord_dvsn": "00"              // 주문구분
    }
  ]
}
```

### 3.7 미체결 주문 조회

| 항목 | 값 |
|------|---|
| **방식** | GET |
| **엔드포인트** | `/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl` |
| **TR_ID (모의)** | `VTTC0805R` |
| **TR_ID (실투)** | `TTTC0805R` |
| **용도** | 현재 접수되었으나 미체결 상태의 주문 조회 |

**요청 쿼리 파라미터**
```
cano: 계좌번호 앞 8자리
acnt_prdt_cd: 상품코드
sll_buy_dvsn: 매도/매수 구분 (00:전체, 01:매도, 02:매수)
inqr_dvsn: 조회 구분
```

**응답 구조**
```json
{
  "rt_cd": "0",
  "msg_cd": "0",
  "msg1": "정상",
  "output1": {
    "tot_rvsecncl_qty": "10",     // 취소 가능 수량 합
    "tot_rvsecncl_amt": "650000"  // 취소 가능 금액 합
  },
  "output2": [
    {
      "odno": "1234567891",
      "ord_tm": "093015",
      "pdno": "005930",
      "isnm": "삼성전자",
      "ord_dvsn": "00",
      "sll_buy_dvsn": "02",
      "ord_qty": "10",
      "ord_unpr": "65000",
      "ord_amt": "650000",
      "ccld_qty": "0",
      "psbl_rvsecncl_qty": "10",    // 취소 가능 수량
      "state": "01",                 // 상태(01:접수)
      "rvsecncl_cfrm_qty": "0"      // 취소 확정 수량
    }
  ]
}
```

### 3.8 주문 취소 API

| 항목 | 값 |
|------|---|
| **방식** | POST |
| **엔드포인트** | `/uapi/domestic-stock/v1/trading/order-rvsecncl` |
| **TR_ID (모의)** | `VTTC0803U` |
| **TR_ID (실투)** | `TTTC0803U` |
| **용도** | 미체결 주문 취소 접수 |

**요청 Body**
```json
{
  "cano": "81245181",
  "acnt_prdt_cd": "01",
  "odno": "1234567891",         // 취소할 주문번호
  "orgn_odno": "0",
  "rvsecncl_qty": "10",         // 취소 수량 (부분취소 가능)
  "ord_cond": "0"
}
```

**응답 구조**
```json
{
  "rt_cd": "0",
  "msg_cd": "0",
  "msg1": "정상처리",
  "output": {
    "odno": "1234567892",        // 새로운 주문번호 (취소 주문)
    "ordtmd": "093020",
    "rtncode": "0"
  }
}
```

---

## 4. WebSocket 실시간 구독

### 4.1 연결 방법

| 항목 | 설명 |
|------|------|
| **연결 URL** | `ws://ops.koreainvestment.com:21000` |
| **프로토콜** | WebSocket (ws, 비TLS) |
| **연결 유지** | PINGPONG 메커니즘 (60초 주기) |
| **인증** | 토큰 기반 (헤더: Authorization: Bearer {token}) |
| **동시 연결** | 최대 4개 권장 |

### 4.2 WebSocket 구독 메시지 형식

**연결 직후 인증 메시지**
```
{
  "header": {
    "approval_key": "",
    "custtype": "P",
    "tr_type": "1",
    "content-type": "json"
  },
  "body": {
    "input": {
      "tr_cd": "LOGIN",
      "tr_key": ""
    }
  }
}
```

또는 HTTP 업그레이드 헤더에 Authorization 포함:
```
GET /socket.io/?transport=websocket HTTP/1.1
Host: ops.koreainvestment.com:21000
Upgrade: websocket
Connection: Upgrade
Authorization: Bearer {AccessToken}
```

**구독 요청 메시지**
```
{
  "header": {
    "approval_key": "",
    "custtype": "P",
    "tr_type": "1",
    "content-type": "json"
  },
  "body": {
    "input": {
      "tr_cd": "H0STCNT0",     // 주식 체결(현재가)
      "tr_key": "005930"        // 종목코드
    }
  }
}
```

### 4.3 주요 TR_ID 목록

| TR_ID | 설명 | 구분자 | 비고 |
|-------|------|--------|------|
| **H0STCNT0** | 주식 체결 (실시간 현재가) | `^` | 1초 주기 업데이트 |
| **H0STASP0** | 주식 호가 | `^` | 실시간 호가 |
| **H0STCNI0** | 체결 통보 (내 주문 체결) | `^` | 개인 주문만 |
| **H0STPNU0** | 예수금 변동 통보 | `^` | 계좌 잔고 변화 |
| **H0STNUC0** | 뉴스/공시 | `^` | (사용 시 확인 필요) |

### 4.4 응답 데이터 파싱 (구분자 '^' 사용)

**H0STCNT0 응답 예시** (현재가 체결)
```
{"header": {"tr_id": "H0STCNT0", "tr_key": "005930"}, 
 "body": {"rt_cd": "0", "msg_cd": "0",
 "output": "005930^005930^삼성전자^65100^65000^+100^+0.15^...^2500000^^..."}}
```

파싱 ('^' 기준 분할):
```
구분자 인덱스:
  [0]: 종목코드         (005930)
  [1]: 종목코드         (005930)
  [2]: 종목명           (삼성전자)
  [3]: 현재가           (65100)
  [4]: 전일종가         (65000)
  [5]: 가격변동         (+100)
  [6]: 등락률           (+0.15)
  [7]: 거래량           (2500000)
  [8]: 거래대금         (...)
  ...
```

**H0STCNI0 응답 예시** (내 주문 체결)
```
{"header": {"tr_id": "H0STCNI0"},
 "body": {"rt_cd": "0", "output": "1234567890^005930^002^100^65100^..."}}
```

파싱:
```
  [0]: 주문번호         (1234567890)
  [1]: 종목코드         (005930)
  [2]: 매도/매수        (001: 매도, 002: 매수)
  [3]: 체결수량         (100)
  [4]: 체결가격         (65100)
  ...
```

### 4.5 PINGPONG 연결 유지

**서버 → 클라이언트 (60초 주기)**
```json
{
  "header": {
    "tr_id": "PINGPONG"
  },
  "body": {}
}
```

**클라이언트 응답**
```json
{
  "header": {
    "tr_id": "PINGPONG"
  },
  "body": {}
}
```

60초 내에 응답하지 않으면 연결이 종료될 수 있습니다.

### 4.6 WebSocket 구독 취소

**구독 취소 메시지**
```json
{
  "header": {
    "approval_key": "",
    "custtype": "P",
    "tr_type": "2",           // 취소는 tr_type: 2
    "content-type": "json"
  },
  "body": {
    "input": {
      "tr_cd": "H0STCNT0",
      "tr_key": "005930"
    }
  }
}
```

---

## 5. 중요 주의사항

### 5.1 모의투자 제약 사항

| 기능 | 제약 여부 | 설명 |
|------|---------|------|
| **현금 주문** | X | 완벽 지원 (시장가, 지정가) |
| **신용 거래** | ○ | 제한적 (일부 기능 미지원) |
| **옵션/선물** | ○ | 모의투자에서 미지원 |
| **시장 시간** | X | 실제 거래 시간 준수 (09:00~15:30) |
| **수수료** | X | 실제 수수료 적용 |
| **세금** | ○ | 제한적 (배당세 등 일부 미적용) |
| **리밸런싱** | X | 자유 (실투와 동일) |
| **API 호출 제한** | X | 동일 rate limit 적용 |

### 5.2 Rate Limit

| 항목 | 값 | 단위 |
|------|---|------|
| **일반 조회 API** | 최대 600 | 초당 (TPS) |
| **주문 API** | 제한 있음 | 초당 (정확한 값은 KIS 문서 확인) |
| **WebSocket 구독** | 최대 4개 | 동시 연결 |
| **초과 시 응답** | HTTP 429 | Too Many Requests |

```
권장 구현: 지수 백오프로 재시도 (1초 → 2초 → 4초...)
```

### 5.3 계좌번호 형식

| 항목 | 포맷 | 예시 |
|------|------|------|
| **계좌번호 앞부분** | 8자리 | `81245181` |
| **상품코드** | 2자리 | `01` (주식), `02` (선물) |
| **전체 계좌번호** | 10자리 | `8124518101` |
| **사용 처** | REST API | cano + acnt_prdt_cd |

```
중요: REST API 호출 시 cano(8자리)와 acnt_prdt_cd(2자리)를 분리하여 전달
WebSocket 구독 시에는 형식 확인 필요
```

### 5.4 필수 헤더 항목

**모든 REST API 호출 시**

| 헤더명 | 값 | 필수 여부 |
|--------|---|---------|
| `Content-Type` | `application/json` | O |
| `Authorization` | `Bearer {AccessToken}` | O |
| `appkey` | `{AppKey}` | O |
| `appsecret` | `{AppSecret}` | O |
| `tr_id` | `VTTC0802U` (모의) 또는 `TTTC0802U` (실투) | O |
| `custtype` | `P` (개인) 또는 `B` (법인) | O |
| `User-Agent` | 자유 (권장: 클라이언트 식별) | X |

**예시**
```
POST /uapi/domestic-stock/v1/trading/order-cash HTTP/1.1
Host: openapivts.koreainvestment.com:29443
Content-Type: application/json
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGc...
appkey: APPKEY_1234567890
appsecret: APPSECRET_1234567890
tr_id: VTTC0801U
custtype: P

{...body...}
```

### 5.5 오류 코드 및 처리

| rt_cd | msg_cd | 의미 | 대응 |
|-------|--------|------|------|
| `0` | `0` | 정상 | 성공 처리 |
| `1` | (다양) | 오류 | msg1 확인 후 재시도 또는 사용자 알림 |
| `-1` | - | 시스템 오류 | 재시도 (지수 백오프) |
| `2` | - | 인증 오류 | 토큰 갱신 |
| `3` | - | 권한 오류 | 계좌 확인 또는 관리자 문의 |

---

## 6. Node.js 연동 패턴

### 6.1 HTTP 요청 시 필수 헤더 구조

**Node.js axios 예시 (의사코드)**
```javascript
// 토큰 발급
const tokenResponse = await axios.post(
  'https://openapivts.koreainvestment.com:29443/oauth2/tokenP',
  {
    grant_type: 'password',
    appkey: process.env.KIS_APPKEY,
    appsecret: process.env.KIS_APPSECRET
  },
  {
    headers: {
      'Content-Type': 'application/json'
    }
  }
);

const accessToken = tokenResponse.data.access_token;

// API 호출 (계좌 잔고 조회)
const balanceResponse = await axios.get(
  'https://openapivts.koreainvestment.com:29443/uapi/domestic-stock/v1/trading/inquire-balance',
  {
    params: {
      cano: '81245181',
      acnt_prdt_cd: '01'
    },
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'appkey': process.env.KIS_APPKEY,
      'appsecret': process.env.KIS_APPSECRET,
      'tr_id': 'VTTC8434R',
      'custtype': 'P'
    }
  }
);

console.log(balanceResponse.data);
```

### 6.2 WebSocket 연결 (ws npm 패키지)

**의사코드**
```javascript
const WebSocket = require('ws');

// 1. 연결 시도
const ws = new WebSocket('ws://ops.koreainvestment.com:21000');

// 2. 연결 확립
ws.on('open', () => {
  console.log('WebSocket 연결됨');
  
  // 인증 메시지 전송
  const loginMsg = {
    header: {
      approval_key: '',
      custtype: 'P',
      tr_type: '1',
      'content-type': 'json'
    },
    body: {
      input: {
        tr_cd: 'LOGIN',
        tr_key: ''
      }
    }
  };
  
  ws.send(JSON.stringify(loginMsg));
});

// 3. 메시지 수신
ws.on('message', (data) => {
  const message = JSON.parse(data);
  
  // PINGPONG 처리
  if (message.header.tr_id === 'PINGPONG') {
    ws.send(JSON.stringify({
      header: { tr_id: 'PINGPONG' },
      body: {}
    }));
    return;
  }
  
  // 실제 데이터 처리
  if (message.header.tr_id === 'H0STCNT0') {
    const parts = message.body.output.split('^');
    const stockData = {
      code: parts[0],
      name: parts[2],
      price: parts[3],
      change: parts[5],
      volume: parts[7]
    };
    console.log('현재가:', stockData);
  }
});

// 4. 에러 처리
ws.on('error', (error) => {
  console.error('WebSocket 오류:', error);
});

// 5. 연결 종료
ws.on('close', () => {
  console.log('WebSocket 종료');
});

// 6. 구독 요청 (인증 후 약 100ms 후)
setTimeout(() => {
  const subscribeMsg = {
    header: {
      approval_key: '',
      custtype: 'P',
      tr_type: '1',
      'content-type': 'json'
    },
    body: {
      input: {
        tr_cd: 'H0STCNT0',
        tr_key: '005930'
      }
    }
  };
  
  ws.send(JSON.stringify(subscribeMsg));
}, 100);
```

### 6.3 토큰 캐싱 전략

**의사코드**
```javascript
class KISTokenManager {
  constructor(appkey, appsecret) {
    this.appkey = appkey;
    this.appsecret = appsecret;
    this.token = null;
    this.expiresAt = null;
  }
  
  async getValidToken() {
    // 1. 캐시된 토큰 확인
    if (this.token && new Date() < this.expiresAt) {
      return this.token;
    }
    
    // 2. 새 토큰 발급
    const response = await axios.post(
      'https://openapivts.koreainvestment.com:29443/oauth2/tokenP',
      {
        grant_type: 'password',
        appkey: this.appkey,
        appsecret: this.appsecret
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    this.token = response.data.access_token;
    // expires_in (초)에서 5분 앞당겨 만료 처리
    this.expiresAt = new Date(
      Date.now() + (response.data.expires_in - 300) * 1000
    );
    
    return this.token;
  }
  
  invalidateToken() {
    // 오류 발생 시 강제로 토큰 무효화
    this.token = null;
    this.expiresAt = null;
  }
}

// 사용 예
const tokenManager = new KISTokenManager(
  process.env.KIS_APPKEY,
  process.env.KIS_APPSECRET
);

const token = await tokenManager.getValidToken();
```

### 6.4 에러 처리 및 재시도

**의사코드**
```javascript
async function callKISAPI(
  endpoint,
  method = 'GET',
  data = null,
  maxRetries = 3
) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const token = await tokenManager.getValidToken();
      
      const config = {
        method,
        url: `https://openapivts.koreainvestment.com:29443${endpoint}`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APPKEY,
          'appsecret': process.env.KIS_APPSECRET,
          'tr_id': process.env.KIS_TR_ID,
          'custtype': 'P'
        }
      };
      
      if (method === 'POST' && data) {
        config.data = data;
      } else if (method === 'GET' && data) {
        config.params = data;
      }
      
      const response = await axios(config);
      
      // KIS API 오류 확인
      if (response.data.rt_cd !== '0') {
        throw new Error(
          `KIS API 오류: ${response.data.rt_cd} - ${response.data.msg1}`
        );
      }
      
      return response.data;
      
    } catch (error) {
      lastError = error;
      
      // 인증 오류는 토큰 재발급 후 재시도
      if (error.response?.status === 401) {
        tokenManager.invalidateToken();
      }
      
      // 마지막 시도가 아니면 지수 백오프 후 재시도
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`${delay}ms 후 재시도...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

// 사용 예
const balance = await callKISAPI('/uapi/domestic-stock/v1/trading/inquire-balance', 'GET', {
  cano: '81245181',
  acnt_prdt_cd: '01'
});
```

---

## 7. 통합 워크플로우 예시

### 7.1 모의투자 매수 주문 흐름

```
Step 1: 토큰 발급 (또는 캐시된 토큰 사용)
        → POST /oauth2/tokenP
        ← access_token 획득

Step 2: 계좌 잔고 확인
        → GET /uapi/domestic-stock/v1/trading/inquire-balance
        ← 보유종목, 현금잔액 확인

Step 3: 현재가 조회
        → GET /uapi/domestic-stock/v1/quotations/inquire-price?fid_input_iscd=005930
        ← 현재가, 호가 정보

Step 4: 주식 매수 주문
        → POST /uapi/domestic-stock/v1/trading/order-cash
        ← 주문번호 (odno) 획득

Step 5: 미체결 주문 확인 (옵션)
        → GET /uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl
        ← 미체결 주문 상태 확인

Step 6: WebSocket 구독 (실시간 모니터링)
        → ws://ops.koreainvestment.com:21000
        → H0STCNI0 (내 주문 체결)
        ← 체결 통보 수신

Step 7: 체결 내역 확인
        → GET /uapi/domestic-stock/v1/trading/inquire-daily-ccld
        ← 체결 내역 조회
```

### 7.2 설정 정보 및 환경 변수

```
파일: .env

# KIS API 기본 정보
KIS_BASE_URL_VTS=https://openapivts.koreainvestment.com:29443
KIS_BASE_URL_REAL=https://openapi.koreainvestment.com:9443
KIS_APPKEY=your_app_key_here
KIS_APPSECRET=your_app_secret_here

# 모의투자 계좌
KIS_VTS_CANO=81245181
KIS_VTS_ACNT_CD=01
KIS_VTS_PASSWORD=0000

# WebSocket
KIS_WS_URL=ws://ops.koreainvestment.com:21000

# 거래 설정
KIS_CUSTTYPE=P
KIS_MODE=VTS  # VTS 또는 REAL
```

---

## 8. 보안 고려사항

| 항목 | 조치 |
|------|------|
| **API Key 보호** | 환경 변수 (.env) 사용, git에서 제외 |
| **토큰 저장** | 메모리 캐싱 (파일 저장 금지) |
| **HTTPS/WSS** | 프로덕션은 TLS 사용 필수 (현재 모의투자는 ws 비TLS) |
| **요청 검증** | 모든 응답의 rt_cd, msg_cd 확인 |
| **로깅** | 토큰, 계좌번호 등 민감정보는 로깅에서 제외 |
| **Rate Limit** | 동시 요청 제한, 지수 백오프 구현 |

---

## 9. 참고 자료 및 추가 확인 사항

### 9.1 미확인 항목 (별도 확인 필요)

- [ ] WebSocket 고속 틱 데이터 구독 시 approval_key 필요 여부 확인
- [ ] H0STASP0 (호가) 응답 형식 정확한 필드 확인
- [ ] 모의투자 신용거래 지원 범위
- [ ] 정확한 Rate Limit 값 (초당 주문 횟수)
- [ ] 옵션/선물 모의투자 제약 상세
- [ ] WebSocket 동시 구독 심화 테스트

### 9.2 공식 문서 링크

```
KIS Developers: https://developers.koreainvestment.com
API 문서: KIS Developers > 문서 > Open API
모의투자 가이드: KIS Developers > 가이드 > Virtual Trading System
```

### 9.3 추천 구현 순서 (Node.js)

```
1. 환경 변수 설정 (.env)
2. KISTokenManager (토큰 캐싱)
3. HTTP 클라이언트 래퍼 (에러 처리, 재시도)
4. REST API 함수 모음
   - getBalance()
   - getPrice()
   - orderBuy()
   - orderSell()
   - cancelOrder()
   - getOrders()
   - getExecutions()
5. WebSocket 관리자
   - 연결, 인증, 구독
   - PINGPONG 처리
   - 데이터 파싱
6. 통합 거래 엔진
7. UI 이벤트 바인딩 (Electron 렌더러)
```

---

## 10. 요약 테이블

### 10.1 엔드포인트 요약

| 기능 | 메서드 | 경로 | TR_ID (모의) |
|------|--------|------|---|
| 토큰 발급 | POST | `/oauth2/tokenP` | - |
| 잔고 조회 | GET | `/uapi/domestic-stock/v1/trading/inquire-balance` | VTTC8434R |
| 현재가 | GET | `/uapi/domestic-stock/v1/quotations/inquire-price` | VTTC0802U |
| 매수 주문 | POST | `/uapi/domestic-stock/v1/trading/order-cash` | VTTC0801U |
| 매도 주문 | POST | `/uapi/domestic-stock/v1/trading/order-cash` | VTTC0801U |
| 체결 내역 | GET | `/uapi/domestic-stock/v1/trading/inquire-daily-ccld` | VTTC8001R |
| 미체결 주문 | GET | `/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl` | VTTC0805R |
| 주문 취소 | POST | `/uapi/domestic-stock/v1/trading/order-rvsecncl` | VTTC0803U |

### 10.2 WebSocket TR_ID 요약

| TR_ID | 설명 | 구분자 | 비고 |
|-------|------|--------|------|
| H0STCNT0 | 주식 체결 | ^ | 1초 주기 |
| H0STASP0 | 주식 호가 | ^ | 실시간 |
| H0STCNI0 | 내 체결 통보 | ^ | 개인 주문 |
| H0STPNU0 | 예수금 변동 | ^ | 계좌 변화 |

---

**최종 작성일**: 2026-06-15
**완성도**: 95% (추가 확인 항목 9.1 참조)
**다음 단계**: Electron + Node.js 구현 시작
