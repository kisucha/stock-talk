# Kiwoom OpenAPI+ 오답노트

| 항목 | 내용 |
|------|------|
| 문서명 | Kiwoom OpenAPI+ 반복 오류 사례집 |
| 버전 | V1 |
| 날짜 | 2026-06-16 |
| 작성자 | Claude Sonnet 4.6 |
| 문서 유형 | 오답노트 / 디버깅 참조 |
| 사용 모델 | claude-sonnet-4-6 |

> 이 파일은 Kiwoom OpenAPI+ 연동 시 자주 발생하는 오류를 기록한 참조 문서다.
> 새 오류 발생 시 맨 아래에 추가하고, 디버깅 전에 반드시 검토한다.

---

## 목차

1. [GetCommData — record name 오류 (핵심 주의)](#1-getcommdata--record-name-오류)
2. [GetLoginInfo — 반환 타입 list vs string](#2-getlogininfo--반환-타입-list-vs-string)
3. [CommRqData — 반환값 None (pykiwoom 특이사항)](#3-commrqdata--반환값-none)
4. [eventsource v4 — require() 구조 변경](#4-eventsource-v4--require-구조-변경)
5. [Python stdout 버퍼링 — print 출력 지연](#5-python-stdout-버퍼링)
6. [QEventLoop — 중첩 루프 및 타이밍 주의](#6-qeventloop--중첩-루프-타이밍)
7. [Kiwoom 모의투자 — TR 빈 데이터 vs 실제 잔액 없음](#7-모의투자--tr-빈-데이터)
8. [FID / 필드명 오타 — GetCommRealData](#8-fid--필드명-오타)

---

## 1. GetCommData — record name 오류

### 현상
`GetCommData()` 호출 후 항상 빈 문자열 반환. `OnReceiveTrData`는 정상 호출됨.

```
[TR] received rqname=예수금상세현황요청 trcode=OPW00001 record=''
[DEBUG] GetCommData 예수금=''   ← 항상 빈값
```

### 원인
Kiwoom COM API 실제 시그니처:
```
GetCommData(sTrCode, sRecordName, nIndex, sFIDName)
```
`sRecordName`은 **TR 스펙의 레코드명** (OnReceiveTrData 콜백의 `record` 파라미터).  
pykiwoom이 이 파라미터를 `rqname`이라 명명해서 혼동을 유발함.

**잘못된 호출 (rqname을 record name으로 오해):**
```python
kiwoom.GetCommData("OPW00001", "예수금상세현황요청", 0, "예수금")
#                              ^^^^^^^^^^^^^^^^^^^ 이건 rqname이지 record name이 아님
```

**실제 record name 확인 방법:**
`OnReceiveTrData` 콜백의 `record` 파라미터가 실제 record name임.  
OPW00001, OPW00004 등 많은 TR에서 record name = `""` (빈 문자열).

**올바른 패턴 — 콜백 내부에서 즉시 추출:**
```python
def OnReceiveTrData(self, screen, rqname, trcode, record, next):
    if trcode == 'OPW00001':
        self._opw00001 = {
            f: self.GetCommData(trcode, record, 0, f)  # record 직접 사용
            for f in ['예수금', '출금가능금액', '주문가능금액', 'd+2출금가능금액']
        }
    # QEventLoop 종료는 데이터 추출 후
    if hasattr(self, 'tr_event_loop') and self.tr_event_loop is not None:
        loop = self.tr_event_loop
        self.tr_event_loop = None
        loop.exit()
```

### 교훈
- `GetCommData` 두 번째 파라미터 = **sRecordName** (pykiwoom이 rqname으로 표기해도 실제론 record name)
- record name은 TR 스펙 문서 또는 `OnReceiveTrData`의 `record` 파라미터에서 확인
- **가장 안전한 방법**: 콜백 내부에서 즉시 추출 → record 변수 직접 전달

---

## 2. GetLoginInfo — 반환 타입 list vs string

### 현상
```python
accno_raw = kiwoom.GetLoginInfo("ACCNO")
accno_list = accno_raw.split(';')  # TypeError: 'list' object has no attribute 'split'
```

### 원인
pykiwoom의 `GetLoginInfo("ACCNO")`가 **list** 반환:
```python
# 실제 반환값
['8124515811', '8128566911']  # 계좌번호 목록
```
Kiwoom 공식 문서는 세미콜론 구분 문자열 `"8124515811;8128566911"`을 명시하지만,
pykiwoom은 내부에서 파싱 후 list로 반환함.

### 올바른 처리
```python
accno_raw = kiwoom.GetLoginInfo("ACCNO")
if isinstance(accno_raw, list):
    accno_list = [a.strip() for a in accno_raw if a.strip()]
else:
    accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
account_no = accno_list[0] if accno_list else os.environ.get('KIWOOM_ACCOUNT_NO', '')
```

### 교훈
- pykiwoom의 반환값이 공식 Kiwoom 문서와 다를 수 있음 (파싱 후 Python 타입으로 변환)
- `GetLoginInfo` 반환값은 항상 타입 체크 후 사용
- 환경변수 계좌번호는 폴백용으로만 사용 → `GetLoginInfo("ACCNO")` 우선

---

## 3. CommRqData — 반환값 None

### 현상
```python
ret = kiwoom.CommRqData("예수금상세현황요청", "OPW00001", 0, "0101")
if ret == 0:  # 항상 False → QEventLoop 미실행
    tr_loop.exec_()
```
데이터 조회가 아예 시작 안 됨.

### 원인
pykiwoom의 `CommRqData` 함수에 **return 문이 없음** → `None` 반환.  
Kiwoom COM API는 성공 시 0 반환이지만, pykiwoom 래퍼가 return을 누락.

```python
# pykiwoom 소스 (실제)
def CommRqData(self, rqname, trcode, next, screen_no):
    self.dynamicCall("CommRqData(QString, QString, int, QString)", ...)
    # return 문 없음 → None 반환
```

### 올바른 처리
```python
kiwoom.CommRqData("예수금상세현황요청", "OPW00001", 0, "0101")
# ret 체크 없이 바로 QEventLoop 실행
tr_loop.exec_()

# 또는 None 허용:
ret = kiwoom.CommRqData(...)
if ret is None or ret == 0:
    tr_loop.exec_()
```

### 교훈
- pykiwoom 함수의 반환값 == `None` ≠ 오류. pykiwoom 소스를 직접 확인할 것.
- TR 요청 후 QEventLoop는 ret 체크 없이 즉시 실행해도 무방

---

## 4. eventsource v4 — require() 구조 변경

### 현상
```
TypeError: EventSource is not a constructor
```
또는 SSE 연결이 무한 루프 (폴링 20회 반복) 후 타임아웃.

### 원인
`eventsource` v4.x에서 exports 구조 변경:
```javascript
// v3 이하: default export
const EventSource = require('eventsource');  // 클래스 직접 반환

// v4 이상: named export
const { EventSource } = require('eventsource');  // 객체에서 destructure
```
`new EventSource(url)` 호출이 try/catch 내부에 있으면 에러가 삼켜져서
폴링 루프가 계속 돌다가 타임아웃 → 연결 완료 메시지가 20번 출력되는 현상.

### 올바른 처리
```javascript
let EventSource;
try {
  ({ EventSource } = require('eventsource'));
} catch (e) {
  console.error('[SSE] eventsource 패키지 없음');
  return;
}
// new EventSource() 호출을 try/catch 외부에서
const client = new EventSource(url);
```
또한 `connectSSE()`는 `pollBridgeReady()`의 try/catch 블록 **외부**에서 호출.

### 교훈
- npm 패키지 major 버전 업시 반드시 exports 구조 변경 확인
- SSE 연결 실패가 무한 루프로 보이면 → EventSource 생성자 오류를 의심

---

## 5. Python stdout 버퍼링

### 현상
bridge.py의 `print()` 출력이 Node.js(Electron)에서 보이지 않거나
긴 지연 후 한꺼번에 출력됨.

### 원인
Python이 파이프 출력 시 **블록 버퍼링** 적용 → 4KB 쌓일 때까지 flush 안 함.
`subprocess.spawn`으로 실행된 Python 프로세스에서 자주 발생.

### 해결
```javascript
// Node.js spawn 시 -u 플래그 (unbuffered) 추가
const proc = spawn('python', ['-u', 'bridge.py'], { ... });
```
또는 bridge.py 파일 상단:
```python
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
# 또는
import functools; print = functools.partial(print, flush=True)
```

### 교훈
- Python subprocess + pipe 조합 → 항상 `-u` 플래그 또는 `flush=True`
- print 출력이 안 보이면 버퍼링 먼저 의심

---

## 6. QEventLoop — 중첩 루프 및 타이밍

### 현상
TR 요청 후 QEventLoop가 종료되지 않고 5초 타임아웃까지 대기.
또는 `OnReceiveTrData`가 호출되지 않음.

### 주의사항

**QEventLoop 설정 순서:**
```python
# 반드시 CommRqData 호출 전에 tr_event_loop 설정
tr_loop = QEventLoop()
kiwoom.tr_event_loop = tr_loop   # ← 먼저
kiwoom.CommRqData(...)           # ← 나중에 (콜백이 즉시 올 수 있음)
QTimer.singleShot(5000, tr_loop.quit)  # 타임아웃 보험
tr_loop.exec_()
```

**잘못된 순서:**
```python
kiwoom.CommRqData(...)           # ← 먼저 (콜백이 여기서 올 수 있음)
kiwoom.tr_event_loop = tr_loop   # ← 너무 늦음 → 콜백이 loop를 못 찾음
tr_loop.exec_()                  # ← 영원히 대기
```

**모든 Kiwoom 작업은 메인 스레드에서:**
- `QAxWidget`, `CommRqData`, `GetCommData` 등 COM 호출 → Qt 메인 스레드 전용
- Flask 스레드에서 직접 호출 금지 → `request_queue`를 통해 메인 스레드에 위임

### 교훈
- `tr_event_loop` 설정 → `CommRqData` 호출 → `exec_()` 순서 엄수
- 5초 타임아웃 `QTimer.singleShot`은 항상 설정 (무한 대기 방지)

---

## 7. 모의투자 — TR 빈 데이터

### 현상
`OnReceiveTrData` 정상 호출, 계좌번호도 맞는데 `GetCommData`가 빈 값 반환.

### 원인 후보
1. **모의투자 계좌 미신청**: 키움 HTS에서 별도 모의투자 신청 필요.
   신청 안 하면 계좌번호가 존재해도 잔액 데이터 없음.
2. **실서버 계좌번호로 모의서버 조회**: `GetServerGubun()` 반환값으로 서버 구분.
   - `""` (빈 문자열) 또는 `"0"` = 실투자 서버
   - `"1"` = 모의투자 서버
3. **잔액 실제 0원**: 모의투자 초기 자금 입금이 필요한 경우.

### 확인 방법
```python
print(f'[서버구분] {kiwoom.GetServerGubun()}')  # "0"=실투 "1"=모의
print(f'[계좌목록] {kiwoom.GetLoginInfo("ACCNO")}')  # 실제 계좌번호 확인
```

### 교훈
- 데이터 빈값 = 계좌번호 틀림 OR 모의투자 미신청 OR 진짜 잔액 0
- TR 콜백 정상 호출 + 빈 데이터 → 계좌번호/서버 구분 먼저 확인

---

## 8. FID / 필드명 오타

### 현상
`GetCommData` 또는 `GetCommRealData`가 항상 빈 값 반환.  
계좌번호와 서버가 모두 맞는데도 빈값.

### 원인
Kiwoom OpenAPI TR 스펙의 FID명과 다른 이름 사용.

**OPW00004 필드명 주의:**
```python
# 틀린 예
kiwoom.GetCommData("OPW00004", record, 0, "평가손익율")    # % 없음
kiwoom.GetCommData("OPW00004", record, 0, "총수익률")      # (%) 없음

# 맞는 예
kiwoom.GetCommData("OPW00004", record, 0, "평가손익율(%)")  # % 포함
kiwoom.GetCommData("OPW00004", record, 0, "총수익률(%)")    # (%) 포함
```

**실시간 FID (GetCommRealData):**
```
10 = 현재가
11 = 전일대비
12 = 등락률
13 = 누적거래량
41~45 = 매도호가 1~5
51~55 = 매수호가 1~5
46~50 = 매도호가수량 1~5  (주의: 41~45가 아님)
56~60 = 매수호가수량 1~5
```

### 확인 방법
1. KOA Studio (키움 개발자 툴) → TR 조회 → 출력 필드 목록 확인
2. `GetCommDataEx(trcode, record)` 로 실제 반환 데이터 구조 덤프
3. 필드명 한 글자라도 다르면 빈값 반환 (에러 없이 조용히 실패)

### 교훈
- `%`, `(%)`, 공백, 괄호 포함 여부까지 정확히 일치해야 함
- 빈값 반환 시 KOA Studio에서 실제 필드명 재확인 필수

---

## 빠른 진단 체크리스트

문제 발생 시 이 순서로 확인:

```
□ 1. OnReceiveTrData 콜백 호출 여부 확인
     → 호출 안 됨: CommRqData 파라미터, 화면번호, 계좌번호 확인
     → 호출 됨 → 다음 단계

□ 2. GetLoginInfo("ACCNO")로 실제 계좌번호 확인
     → isinstance(result, list) 처리 필수

□ 3. GetServerGubun()으로 실서버/모의 확인
     → 계좌번호가 서버와 일치하는지 확인

□ 4. OnReceiveTrData의 record 파라미터값 출력
     → GetCommData 두 번째 파라미터로 이 값 사용

□ 5. 콜백 내부에서 즉시 GetCommData 호출 테스트
     → 타이밍 문제 배제

□ 6. KOA Studio에서 실제 필드명 대조
     → 특수문자(%,괄호,공백) 포함 여부 확인

□ 7. Python -u 플래그 확인 (출력 버퍼링 문제인 경우)
```
