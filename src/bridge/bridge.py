# bridge.py
# 목적: 키움 OpenAPI+ COM/ActiveX 브릿지 — Flask(daemon) + Qt(메인)
# OnReceiveTrData 내부에서 즉시 데이터 캐싱 (record name 정확성 보장)

import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os
import json
import time
import queue
import threading
from datetime import datetime

from PyQt5.QtWidgets import QApplication
from PyQt5.QtCore import QTimer, QEventLoop

from flask import Flask, request as flask_request, jsonify, Response, stream_with_context

qt_app = QApplication(sys.argv)

from pykiwoom.kiwoom import Kiwoom

# ============================================================
# 전역 상태
# ============================================================
request_queue  = queue.Queue()
sse_queue      = queue.Queue()

kiwoom         = None
logged_in      = False
server_type    = None
_order_times   = []
_subscriptions = set()
_login_resp_q  = None

# ============================================================
# KiwoomBridge
# ============================================================
class KiwoomBridge(Kiwoom):
    """OnReceiveTrData 내부에서 즉시 데이터 캐싱 — record name 파라미터 정확성 보장"""

    def OnReceiveTrData(self, screen, rqname, trcode, record, next):
        """TR 수신 콜백 — GetCommData를 콜백 내부에서 즉시 호출 (record name 직접 사용)"""
        print(f'[TR] received rqname={rqname} trcode={trcode} record={repr(record)}')

        # OPW00001: 예수금상세현황 — 단일 레코드, 콜백 내부에서 추출
        if trcode == 'OPW00001':
            self._opw00001 = {
                f: self.GetCommData(trcode, record, 0, f)
                for f in ['예수금', '출금가능금액', '주문가능금액', 'd+2출금가능금액']
            }
            print(f'[TR] OPW00001 raw={self._opw00001}')

        # OPT10075: 실시간미체결요청 — 미체결 + 체결 통합 (체결구분=0)
        elif trcode == 'OPT10075':
            cnt = self.GetRepeatCnt(trcode, record)
            rows = []
            for i in range(cnt):
                raw_ticker = self.GetCommData(trcode, record, i, '종목코드')
                rows.append({
                    'orderNo':     self.GetCommData(trcode, record, i, '주문번호').strip(),
                    'origOrderNo': self.GetCommData(trcode, record, i, '원주문번호').strip(),
                    'ticker':      raw_ticker.strip().lstrip('A'),
                    'name':        self.GetCommData(trcode, record, i, '종목명').strip(),
                    'side':        self.GetCommData(trcode, record, i, '주문구분').strip(),       # +매수/-매도/매도/매수
                    'tradeType':   self.GetCommData(trcode, record, i, '매매구분').strip(),       # 보통/시장가/정정/취소
                    'state':       self.GetCommData(trcode, record, i, '주문상태').strip(),       # 접수/확인/체결
                    'orderQty':    self.GetCommData(trcode, record, i, '주문수량'),
                    'orderPrice':  self.GetCommData(trcode, record, i, '주문가격'),
                    'remainQty':   self.GetCommData(trcode, record, i, '미체결수량'),
                    'execTotal':   self.GetCommData(trcode, record, i, '체결누계금액'),
                    'execPrice':   self.GetCommData(trcode, record, i, '체결가'),
                    'execQty':     self.GetCommData(trcode, record, i, '체결량'),
                    'orderTime':   self.GetCommData(trcode, record, i, '시간').strip(),
                })
            self._opt10075 = rows
            print(f'[TR] OPT10075 count={cnt}')

        # OPW00004: 계좌평가잔고 — 요약 + 보유종목 다중 레코드
        elif trcode == 'OPW00004':
            cnt = self.GetRepeatCnt(trcode, record)
            rows = []
            for i in range(cnt):
                raw_ticker = self.GetCommData(trcode, record, i, '종목번호')
                # 키움 OPW00004 손익율 필드명 키움 버전마다 차이 — 다중 후보 fallback.
                # 우선순위: '손익율' > '평가손익율' > '수익률(%)' > '평가손익율(%)'
                pnl_rate_raw = ''
                for fname in ('손익율', '평가손익율', '수익률(%)', '평가손익율(%)', '수익률'):
                    v = self.GetCommData(trcode, record, i, fname).strip()
                    if v:
                        pnl_rate_raw = v
                        break
                rows.append({
                    'ticker':       raw_ticker.lstrip('A'),
                    'name':         self.GetCommData(trcode, record, i, '종목명'),
                    'qty':          self.GetCommData(trcode, record, i, '보유수량'),
                    'avgPrice':     self.GetCommData(trcode, record, i, '평균단가'),
                    'currentPrice': self.GetCommData(trcode, record, i, '현재가'),
                    'pnlRate':      pnl_rate_raw,
                })
                if i == 0:
                    print(f'[OPW00004 #0] ticker={raw_ticker.strip().lstrip("A")} pnlRate_raw={pnl_rate_raw!r}')
            # 총수익률 필드명 fallback
            rate_return_raw = ''
            for fname in ('총수익률(%)', '총수익율', '총수익률', '수익률(%)'):
                v = self.GetCommData(trcode, record, 0, fname).strip()
                if v:
                    rate_return_raw = v
                    break
            self._opw00004 = {
                'evalTotal':  self.GetCommData(trcode, record, 0, '총평가금액'),
                'pnlTotal':   self.GetCommData(trcode, record, 0, '총평가손익금액'),
                'rateReturn': rate_return_raw,
                'holdings':   rows,
            }
            print(f'[TR] OPW00004 evalTotal={self._opw00004["evalTotal"]} count={cnt} rateReturn_raw={rate_return_raw!r}')

        if hasattr(self, 'tr_event_loop') and self.tr_event_loop is not None:
            loop = self.tr_event_loop
            self.tr_event_loop = None
            loop.exit()

    def OnEventConnect(self, err_code):
        global logged_in, server_type, _login_resp_q
        print(f'[LOGIN-TIMING] OnEventConnect 진입 t={time.time():.3f} err_code={err_code}', flush=True)
        super().OnEventConnect(err_code)
        if err_code == 0:
            try:
                server_type = self.GetServerGubun()
            except Exception:
                server_type = '0'
            logged_in = True
            # 계좌비밀번호 등록 다이얼로그 자동 팝업 — 키움 OCX 재시작 시 비밀번호 휘발 대응.
            # KOA_Functions("ShowAccountWindow", "") = 계좌비밀번호 입력 창 표시.
            # 사용자가 [전체계좌에 등록] + AUTO 체크 시 다음부터 자동 보완.
            # OPW00001 등 TR 호출 시 빈 비밀번호("")로 호출되더라도 키움이 캐시된 값 사용.
            try:
                # pykiwoom Kiwoom 클래스는 self.ocx에 실제 QAxWidget OCX 보관.
                # KOA_Functions("ShowAccountWindow", "") = 계좌비밀번호 입력 다이얼로그 표시.
                self.ocx.dynamicCall("KOA_Functions(QString, QString)", "ShowAccountWindow", "")
                print('[LOGIN] KOA_Functions ShowAccountWindow 호출 — 계좌비밀번호 입력창 자동 팝업', flush=True)
            except Exception as e:
                print(f'[LOGIN] ShowAccountWindow 호출 실패: {e}', flush=True)
            # 디버그 — 로그인 직후 키움 계정/계좌 정보 raw 출력 (실계좌 누락 진단용)
            accno_list = []
            selected_account = ''
            try:
                user_id   = self.GetLoginInfo("USER_ID")
                user_name = self.GetLoginInfo("USER_NAME")
                acc_cnt   = self.GetLoginInfo("ACCOUNT_CNT")
                accno_raw = self.GetLoginInfo("ACCNO")
                if isinstance(accno_raw, list):
                    accno_list = [a.strip() for a in accno_raw if a and a.strip()]
                else:
                    accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                # 모드 기반 실제 사용 계좌 선택 — main.js/UI에 그대로 전달.
                # .env 폴백값(KIWOOM_ACCOUNT_NO)을 사용자에게 보여주는 사고 방지.
                selected_account = _pick_account_no(accno_list)
                print(f'[LOGIN-DEBUG] USER_ID={user_id!r} USER_NAME={user_name!r}')
                print(f'[LOGIN-DEBUG] ACCOUNT_CNT={acc_cnt!r}')
                print(f'[LOGIN-DEBUG] ACCNO raw type={type(accno_raw).__name__} value={accno_raw!r}')
                print(f'[LOGIN-DEBUG] serverType={server_type!r} 선택계좌={selected_account!r}')
            except Exception as e:
                print(f'[LOGIN-DEBUG] 진단 출력 실패: {e}')
            result = {
                'success': True,
                'serverType': server_type,
                'accountNo': selected_account,
                'accountList': accno_list
            }
        else:
            logged_in = False
            result = {'success': False, 'error': f'로그인 실패: {err_code}'}
        if _login_resp_q is not None:
            _login_resp_q.put(result)
            _login_resp_q = None

    def OnReceiveRealData(self, s_code, s_real_type, s_real_data):
        try:
            if s_real_type == '주식호가잔량':
                # 키움 호가 FID 매핑 (주식호가잔량 실시간 타입)
                # 41~45: 매도호가1~5   /  46~50: 매도호가6~10
                # 51~55: 매수호가1~5   /  56~60: 매수호가6~10
                # 61~65: 매도잔량1~5   /  66~70: 매도잔량6~10
                # 71~75: 매수잔량1~5   /  76~80: 매수잔량6~10
                # 페이로드 필드명: quote 이벤트와 일관성 위해 'volume' 사용
                asks, bids = [], []
                for i in range(1, 6):
                    asks.append({
                        'price':  abs(_safe_int(self.GetCommRealData(s_code, 40 + i))),  # fid 41~45 매도호가
                        'volume': abs(_safe_int(self.GetCommRealData(s_code, 60 + i)))   # fid 61~65 매도잔량
                    })
                    bids.append({
                        'price':  abs(_safe_int(self.GetCommRealData(s_code, 50 + i))),  # fid 51~55 매수호가
                        'volume': abs(_safe_int(self.GetCommRealData(s_code, 70 + i)))   # fid 71~75 매수잔량
                    })
                sse_queue.put({'type': 'orderbook', 'ticker': s_code,
                               'asks': asks, 'bids': bids})
            else:
                # 키움 실시간 fid 표준 매핑 (주식체결):
                #   10 현재가 / 11 전일대비(가격) / 12 등락율(%, float)
                #   13 누적거래량 / 14 누적거래대금 / 15 시가 / 16 고가 / 17 저가
                # 직전 버그: 11/12/13을 12/13/15로 한 칸씩 밀려 매핑 — 거래량(78000)이 등락률로 들어가 78000% 표시.
                p10 = self.GetCommRealData(s_code, 10)
                p11 = self.GetCommRealData(s_code, 11)
                p12 = self.GetCommRealData(s_code, 12)
                p13 = self.GetCommRealData(s_code, 13)
                # 첫 quote 한 번만 raw fid 출력 — 실제 키움 응답 형식 확인용
                if not getattr(self, '_quote_debug_done', False):
                    print(f'[REAL DEBUG] {s_code} fid10={p10!r} fid11={p11!r} fid12={p12!r} fid13={p13!r}')
                    self._quote_debug_done = True
                sse_queue.put({
                    'type':       'quote',
                    'ticker':     s_code,
                    'price':      abs(_safe_int(p10)),
                    'change':     _safe_int(p11),     # 전일대비 (가격)
                    'changeRate': _safe_float(p12),   # 등락률 (%)
                    'volume':     _safe_int(p13),     # 누적거래량
                    'ts':         datetime.now().isoformat()
                })
        except Exception as e:
            print(f'[real_data] 처리 오류: {e}')

    def OnReceiveMsg(self, s_screen, s_rqname, s_trcode, s_msg):
        """키움 서버 메시지 (주문 거부, TR 처리 결과, 호가단위 오류 등)"""
        print(f'[MSG] screen={s_screen} rqname={s_rqname} trcode={s_trcode} msg={s_msg}')
        try:
            sse_queue.put({
                'type':    'message',
                'screen':  s_screen,
                'rqname':  s_rqname,
                'trcode':  s_trcode,
                'message': s_msg,
                'ts':      datetime.now().isoformat()
            })
        except Exception as e:
            print(f'[msg] SSE 전달 오류: {e}')

    def OnReceiveChejanData(self, s_gubun, n_item_cnt, s_fid_list):
        try:
            sse_queue.put({
                'type':      'execution',
                'orderNo':   self.GetChejanData(9001).strip(),
                'ticker':    self.GetChejanData(9003).strip().lstrip('A'),
                'execQty':   _safe_int(self.GetChejanData(910)),
                'execPrice': _safe_int(self.GetChejanData(911)),
                'isFilled':  self.GetChejanData(913).strip() == '1',
                'ts':        datetime.now().isoformat()
            })
        except Exception as e:
            print(f'[chejan] 처리 오류: {e}')

# ============================================================
# 유틸
# ============================================================
def _pick_account_no(accno_list):
    """server_type 기반 계좌 선택 — 모의/실투 분리.
       모의(server_type='1'): KIWOOM_ACCOUNT_NO_MOCK 정확 매칭 우선
       실투(그 외): KIWOOM_ACCOUNT_NO_REAL_PREFIX startswith 매칭 → 풀 10자리 자동 보완
       매칭 실패 시 첫 계좌 또는 .env KIWOOM_ACCOUNT_NO 폴백."""
    fallback = os.environ.get('KIWOOM_ACCOUNT_NO', '')
    if server_type == '1':
        target = os.environ.get('KIWOOM_ACCOUNT_NO_MOCK') or fallback
        if accno_list:
            for a in accno_list:
                if a == target:
                    return a
            return accno_list[0]
        return target
    # 실투
    prefix = os.environ.get('KIWOOM_ACCOUNT_NO_REAL_PREFIX', '')
    if accno_list:
        if prefix:
            for a in accno_list:
                if a.startswith(prefix):
                    return a
        return accno_list[0]
    return fallback

def _safe_int(val):
    try:
        return int(str(val).replace(',', '').strip())
    except (ValueError, TypeError):
        return 0

def _safe_float(val):
    try:
        return float(str(val).replace(',', '').strip())
    except (ValueError, TypeError):
        return 0.0

def _call_kiwoom(action, payload=None):
    """키움 OCX 호출 — action별 timeout 분기.
    login: 사용자가 키움 로그인 창에서 ID/PW/인증서 입력 시간 필요 — 120초.
    그 외: TR 응답 대기 — 30초."""
    resp_q = queue.Queue()
    request_queue.put({'action': action, 'payload': payload or {}, 'resp_q': resp_q})
    timeout_sec = 120 if action == 'login' else 30
    try:
        return resp_q.get(timeout=timeout_sec)
    except queue.Empty:
        return {'success': False, 'error': f'타임아웃 ({timeout_sec}s)'}

# ============================================================
# Flask 엔드포인트
# ============================================================
flask_app = Flask(__name__)

@flask_app.route('/status', methods=['GET'])
def get_status():
    return jsonify({
        'ready':      kiwoom is not None,
        'loggedIn':   logged_in,
        'serverType': server_type
    })

@flask_app.route('/login', methods=['POST'])
def do_login():
    return jsonify(_call_kiwoom('login'))

@flask_app.route('/logout', methods=['POST'])
def do_logout():
    return jsonify(_call_kiwoom('logout'))

@flask_app.route('/account', methods=['GET'])
def get_account():
    return jsonify(_call_kiwoom('get_account'))

@flask_app.route('/executions', methods=['GET'])
def get_executions():
    return jsonify(_call_kiwoom('get_executions'))

@flask_app.route('/order/buy', methods=['POST'])
def order_buy():
    data = flask_request.get_json() or {}
    return jsonify(_call_kiwoom('order', {**data, 'order_type': 1}))

@flask_app.route('/order/sell', methods=['POST'])
def order_sell():
    data = flask_request.get_json() or {}
    return jsonify(_call_kiwoom('order', {**data, 'order_type': 2}))

@flask_app.route('/order/cancel', methods=['POST'])
def order_cancel():
    data = flask_request.get_json() or {}
    return jsonify(_call_kiwoom('cancel_order', data))

@flask_app.route('/realtime/subscribe', methods=['POST'])
def subscribe():
    data = flask_request.get_json() or {}
    return jsonify(_call_kiwoom('subscribe', data))

@flask_app.route('/realtime/unsubscribe', methods=['POST'])
def unsubscribe():
    data = flask_request.get_json() or {}
    return jsonify(_call_kiwoom('unsubscribe', data))

@flask_app.route('/realtime/events', methods=['GET'])
def sse_stream():
    def generate():
        last_heartbeat = time.time()
        while True:
            try:
                event = sse_queue.get(timeout=1)
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            except queue.Empty:
                pass
            if time.time() - last_heartbeat >= 25:
                yield ": heartbeat\n\n"
                last_heartbeat = time.time()
    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )

# ============================================================
# QTimer 핸들러 — 100ms마다 메인 스레드에서 request_queue 소비
# ============================================================
def _process_requests():
    global _order_times

    while not request_queue.empty():
        try:
            task = request_queue.get_nowait()
        except queue.Empty:
            break

        action  = task['action']
        payload = task['payload']
        resp_q  = task['resp_q']

        try:
            if action == 'login':
                global _login_resp_q
                _login_resp_q = resp_q
                print(f'[LOGIN-TIMING] CommConnect 호출 직전 t={time.time():.3f}', flush=True)
                kiwoom.CommConnect(block=False)
                print(f'[LOGIN-TIMING] CommConnect 호출 직후 t={time.time():.3f} (block=False, 콜백 대기)', flush=True)

            elif action == 'logout':
                global logged_in
                for ticker in list(_subscriptions):
                    try:
                        kiwoom.SetRealRemove('9001', ticker)
                    except Exception:
                        pass
                _subscriptions.clear()
                logged_in = False
                print('[bridge] 로그아웃 완료')
                resp_q.put({'success': True})

            elif action == 'get_account':
                print(f'[get_account] 진입 t={time.time():.3f} logged_in={logged_in}', flush=True)
                if not logged_in:
                    resp_q.put({'success': False, 'error': '로그인 필요'})
                    continue

                # 실제 로그인 계좌번호 조회 (ACCNO + 모드 기반 분기, env 폴백)
                try:
                    accno_raw = kiwoom.GetLoginInfo("ACCNO")
                    # pykiwoom은 list 또는 세미콜론 구분 문자열 반환
                    if isinstance(accno_raw, list):
                        accno_list = [a.strip() for a in accno_raw if a.strip()]
                    else:
                        accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                    account_no = _pick_account_no(accno_list)
                    print(f'[bridge] 계좌번호 목록={accno_list} 모드={"모의" if server_type=="1" else "실투"} 선택={account_no}')
                except Exception as e:
                    account_no = _pick_account_no([])
                    print(f'[bridge] GetLoginInfo 실패, env 폴백 계좌 사용: {account_no} ({e})')

                # ── OPW00001: 예수금상세현황 ──────────────────────────
                kiwoom._opw00001 = {}
                try:
                    tr_loop1 = QEventLoop()
                    kiwoom.tr_event_loop = tr_loop1
                    kiwoom.SetInputValue("계좌번호",            account_no)
                    kiwoom.SetInputValue("비밀번호",            "")
                    kiwoom.SetInputValue("비밀번호입력매체구분", "00")
                    kiwoom.SetInputValue("조회구분",            "2")
                    kiwoom.CommRqData("예수금상세현황요청", "OPW00001", 0, "0101")
                    QTimer.singleShot(15000, tr_loop1.quit)
                    tr_loop1.exec_()
                except Exception as e:
                    print(f'[bridge] OPW00001 오류: {e}')

                d1 = kiwoom._opw00001
                deposit      = abs(_safe_int(d1.get('예수금', '')))
                withdrawable = abs(_safe_int(d1.get('출금가능금액', '')))
                orderable    = abs(_safe_int(d1.get('주문가능금액', '')))
                deposit_d2   = abs(_safe_int(d1.get('d+2출금가능금액', '')))
                print(f'[bridge] OPW00001: 예수금={deposit} 출금가능={withdrawable} 주문가능={orderable}')

                # ── OPW00004: 계좌평가잔고 ────────────────────────────
                kiwoom._opw00004 = {'evalTotal': '', 'pnlTotal': '', 'rateReturn': '', 'holdings': []}
                try:
                    tr_loop2 = QEventLoop()
                    kiwoom.tr_event_loop = tr_loop2
                    kiwoom.SetInputValue("계좌번호",            account_no)
                    kiwoom.SetInputValue("비밀번호",            "")
                    # 상장폐지조회구분 1 = 상장폐지 종목 제외 (사용자 요구).
                    # 0=전체(폐지 포함), 1=폐지 제외.
                    kiwoom.SetInputValue("상장폐지조회구분",    "1")
                    kiwoom.SetInputValue("비밀번호입력매체구분", "00")
                    kiwoom.SetInputValue("거래소구분",          "")
                    kiwoom.CommRqData("계좌평가잔고내역요청", "OPW00004", 0, "0102")
                    QTimer.singleShot(15000, tr_loop2.quit)
                    tr_loop2.exec_()
                except Exception as e:
                    print(f'[bridge] OPW00004 오류: {e}')

                d2 = kiwoom._opw00004

                # 키움 OPW00004 손익율 스케일 자동 보정:
                # 키움 응답은 통상 1/10000 스케일 정수 — 예: -1.7% → "-17000".
                # 일부 버전 1/1000 또는 1/100 또는 소수 직접. 절대값으로 자동 분기.
                def _norm_pct(s):
                    v = _safe_float(s)
                    av = abs(v)
                    if av >= 10000: return v / 10000.0   # 1/10000 스케일 (가장 일반)
                    if av >= 1000:  return v / 1000.0    # 1/1000
                    if av >= 100:   return v / 100.0     # 1/100
                    return v                              # 소수 직접

                eval_total  = abs(_safe_int(d2.get('evalTotal', '')))
                pnl_total   = _safe_int(d2.get('pnlTotal', ''))
                rate_return = _norm_pct(d2.get('rateReturn', ''))
                holdings = [
                    {
                        'ticker':       h['ticker'],
                        'name':         h['name'],
                        'qty':          _safe_int(h['qty']),
                        'avgPrice':     _safe_int(h['avgPrice']),
                        'currentPrice': abs(_safe_int(h['currentPrice'])),
                        'pnlRate':      _norm_pct(h['pnlRate']),
                    }
                    for h in d2.get('holdings', [])
                ]
                # 디버그 — 첫 보유종목 raw + 정규화 후 값 확인
                if holdings:
                    raw0 = d2.get('holdings', [{}])[0].get('pnlRate', '')
                    print(f'[bridge] OPW00004 #0 pnlRate raw={raw0!r} → norm={holdings[0]["pnlRate"]:.2f}%')
                print(f'[bridge] OPW00004: 총평가={eval_total} 손익={pnl_total} 종목수={len(holdings)} rateReturn={rate_return:.2f}%')

                resp_q.put({
                    'success':      True,
                    'deposit':      deposit,
                    'withdrawable': withdrawable,
                    'orderable':    orderable,
                    'depositD2':    deposit_d2,
                    'evalTotal':    eval_total,
                    'pnlTotal':     pnl_total,
                    'rateOfReturn': rate_return,
                    'holdings':     holdings
                })

            elif action == 'order':
                if not logged_in:
                    resp_q.put({'success': False, 'error': '로그인 필요'})
                    continue

                now = time.time()
                _order_times = [t for t in _order_times if now - t < 1.0]
                if len(_order_times) >= 5:
                    resp_q.put({'success': False, 'error': '주문 속도 초과'})
                    continue
                _order_times.append(now)

                # 계좌번호 동적 조회 (모드 기반 분기 + env 폴백)
                try:
                    accno_raw = kiwoom.GetLoginInfo("ACCNO")
                    if isinstance(accno_raw, list):
                        accno_list = [a.strip() for a in accno_raw if a.strip()]
                    else:
                        accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                    account_no = _pick_account_no(accno_list)
                except Exception:
                    account_no = _pick_account_no([])

                ticker     = payload.get('ticker', '')
                qty        = _safe_int(payload.get('qty', 0))
                price      = _safe_int(payload.get('price', 0))
                order_type = payload.get('order_type', 1)
                hoga       = '00' if price > 0 else '03'

                print(f'[order] SendOrder accno={account_no} type={order_type} ticker={ticker} qty={qty} price={price} hoga={hoga}')
                ret = kiwoom.SendOrder("주문", '0201', account_no,
                                       order_type, ticker, qty, price,
                                       hoga, "")
                print(f'[order] SendOrder return={ret}')
                if ret == 0:
                    # 키움 SendOrder 반환 0은 "요청 전송 성공"이지 주문 체결 보장이 아님.
                    # 실제 주문번호/거부 사유는 OnReceiveMsg + OnReceiveChejanData(FID 9001)로 수신.
                    resp_q.put({'success': True, 'note': '주문 요청 전송 완료. 실제 결과는 OPT10075 재조회로 확인.'})
                else:
                    resp_q.put({'success': False, 'error': f'SendOrder 실패: ret={ret} (모의서버 거부 또는 계좌/종목 오류)'})

            elif action == 'cancel_order':
                if not logged_in:
                    resp_q.put({'success': False, 'error': '로그인 필요'})
                    continue

                # 계좌번호 동적 조회 (모드 기반 분기)
                try:
                    accno_raw = kiwoom.GetLoginInfo("ACCNO")
                    if isinstance(accno_raw, list):
                        accno_list = [a.strip() for a in accno_raw if a.strip()]
                    else:
                        accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                    account_no = _pick_account_no(accno_list)
                except Exception:
                    account_no = _pick_account_no([])
                order_no   = payload.get('orderNo', '')
                ticker     = payload.get('ticker', '')
                qty        = _safe_int(payload.get('qty', 0))

                ret = kiwoom.SendOrder("주문취소", '0202', account_no, 3,
                                       ticker, qty, 0, '00', order_no)
                if ret == 0:
                    resp_q.put({'success': True})
                else:
                    resp_q.put({'success': False, 'error': f'취소실패: {ret}'})

            elif action == 'get_executions':
                if not logged_in:
                    resp_q.put({'success': False, 'error': '로그인 필요'})
                    continue

                # 계좌번호 동적 조회 (모드 기반 분기)
                try:
                    accno_raw = kiwoom.GetLoginInfo("ACCNO")
                    if isinstance(accno_raw, list):
                        accno_list = [a.strip() for a in accno_raw if a.strip()]
                    else:
                        accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                    account_no = _pick_account_no(accno_list)
                except Exception:
                    account_no = _pick_account_no([])

                # OPT10075 — 체결구분=0 (전체) 호출
                kiwoom._opt10075 = []
                try:
                    tr_loop = QEventLoop()
                    kiwoom.tr_event_loop = tr_loop
                    kiwoom.SetInputValue("계좌번호",  account_no)
                    kiwoom.SetInputValue("전체종목구분", "0")
                    kiwoom.SetInputValue("매매구분",    "0")
                    kiwoom.SetInputValue("종목코드",    "")
                    kiwoom.SetInputValue("체결구분",    "0")
                    kiwoom.CommRqData("실시간미체결요청", "OPT10075", 0, "0103")
                    QTimer.singleShot(15000, tr_loop.quit)
                    tr_loop.exec_()
                except Exception as e:
                    print(f'[bridge] OPT10075 오류: {e}')

                print(f'[bridge] OPT10075 raw rows={len(kiwoom._opt10075)}')
                pending, filled = [], []
                for r in kiwoom._opt10075:
                    side_raw = r['side']
                    if '+' in side_raw or '매수' in side_raw:
                        side = 'buy'
                    elif '-' in side_raw or '매도' in side_raw:
                        side = 'sell'
                    else:
                        side = 'unknown'

                    item = {
                        'orderNo':    r['orderNo'],
                        'origOrderNo': r['origOrderNo'],
                        'ticker':     r['ticker'],
                        'name':       r['name'],
                        'side':       side,
                        'tradeType':  r['tradeType'],
                        'state':      r['state'],
                        'orderQty':   _safe_int(r['orderQty']),
                        'orderPrice': _safe_int(r['orderPrice']),
                        'remainQty':  _safe_int(r['remainQty']),
                        'execTotal':  _safe_int(r['execTotal']),
                        'execPrice':  _safe_int(r['execPrice']),
                        'execQty':    _safe_int(r['execQty']),
                        'orderTime':  r['orderTime'],
                    }
                    # 주문상태 기준 분리: 체결완료(미체결수량=0 & 체결량>0) → filled
                    # 그 외 접수/확인 & 잔량 남음 → pending
                    if r['state'] == '체결' and item['remainQty'] == 0:
                        filled.append(item)
                    elif item['remainQty'] > 0:
                        pending.append(item)
                    else:
                        # 일부 체결된 행도 filled에 포함 (잔량 0)
                        filled.append(item)

                print(f'[bridge] OPT10075 분리: pending={len(pending)} filled={len(filled)}')
                resp_q.put({'success': True, 'pending': pending, 'filled': filled})

            elif action == 'subscribe':
                tickers = payload.get('tickers', [])
                if not tickers:
                    resp_q.put({'success': False, 'error': 'tickers 필요'})
                    continue
                ticker_str = ';'.join(tickers)
                # 시세(10:현재가, 11:전일대비, 12:등락율, 13:누적거래량) + 호가(41~45, 51~55, 61~65, 71~75)
                fid_str = '10;11;12;13;41;42;43;44;45;51;52;53;54;55;61;62;63;64;65;71;72;73;74;75'
                kiwoom.SetRealReg('9001', ticker_str, fid_str, '1')
                for t in tickers:
                    _subscriptions.add(t)
                resp_q.put({'success': True, 'subscribed': list(_subscriptions)})

            elif action == 'unsubscribe':
                tickers = payload.get('tickers', [])
                for t in tickers:
                    kiwoom.SetRealRemove('9001', t)
                    _subscriptions.discard(t)
                resp_q.put({'success': True, 'subscribed': list(_subscriptions)})

            else:
                resp_q.put({'success': False, 'error': f'알 수 없는 action: {action}'})

        except Exception as e:
            resp_q.put({'success': False, 'error': str(e)})
            print(f'[process_requests] 오류 ({action}): {e}')

# ============================================================
# Flask daemon 스레드
# ============================================================
def _run_flask():
    port = int(os.environ.get('KIWOOM_BRIDGE_PORT', '5001'))
    flask_app.run(host='127.0.0.1', port=port, threaded=True, use_reloader=False)

# ============================================================
# 메인 진입점
# ============================================================
if __name__ == '__main__':
    print('[bridge] Kiwoom 인스턴스 생성 중...')
    kiwoom = KiwoomBridge()
    print('[bridge] Kiwoom 초기화 완료')

    flask_thread = threading.Thread(target=_run_flask, daemon=True)
    flask_thread.start()
    port = os.environ.get('KIWOOM_BRIDGE_PORT', '5001')
    print(f'[bridge] Flask 서버 시작: 127.0.0.1:{port}')

    timer = QTimer()
    timer.timeout.connect(_process_requests)
    timer.start(100)

    sys.exit(qt_app.exec_())
