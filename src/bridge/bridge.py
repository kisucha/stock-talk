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
                rows.append({
                    'ticker':       raw_ticker.lstrip('A'),
                    'name':         self.GetCommData(trcode, record, i, '종목명'),
                    'qty':          self.GetCommData(trcode, record, i, '보유수량'),
                    'avgPrice':     self.GetCommData(trcode, record, i, '평균단가'),
                    'currentPrice': self.GetCommData(trcode, record, i, '현재가'),
                    'pnlRate':      self.GetCommData(trcode, record, i, '평가손익율(%)'),
                })
            self._opw00004 = {
                'evalTotal':  self.GetCommData(trcode, record, 0, '총평가금액'),
                'pnlTotal':   self.GetCommData(trcode, record, 0, '총평가손익금액'),
                'rateReturn': self.GetCommData(trcode, record, 0, '총수익률(%)'),
                'holdings':   rows,
            }
            print(f'[TR] OPW00004 evalTotal={self._opw00004["evalTotal"]} count={cnt}')

        if hasattr(self, 'tr_event_loop') and self.tr_event_loop is not None:
            loop = self.tr_event_loop
            self.tr_event_loop = None
            loop.exit()

    def OnEventConnect(self, err_code):
        global logged_in, server_type, _login_resp_q
        super().OnEventConnect(err_code)
        if err_code == 0:
            try:
                server_type = self.GetServerGubun()
            except Exception:
                server_type = '0'
            logged_in = True
            result = {'success': True, 'serverType': server_type}
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
                sse_queue.put({
                    'type':   'quote',
                    'ticker': s_code,
                    'price':  abs(_safe_int(self.GetCommRealData(s_code, 10))),
                    'change': _safe_int(self.GetCommRealData(s_code, 12)),
                    'volume': _safe_int(self.GetCommRealData(s_code, 13)),
                    'ts':     datetime.now().isoformat()
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
    resp_q = queue.Queue()
    request_queue.put({'action': action, 'payload': payload or {}, 'resp_q': resp_q})
    try:
        return resp_q.get(timeout=30)
    except queue.Empty:
        return {'success': False, 'error': '타임아웃 (30s)'}

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
                kiwoom.CommConnect(block=False)

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
                if not logged_in:
                    resp_q.put({'success': False, 'error': '로그인 필요'})
                    continue

                # 실제 로그인 계좌번호 조회 (ACCNO 우선, env 폴백)
                try:
                    accno_raw = kiwoom.GetLoginInfo("ACCNO")
                    # pykiwoom은 list 또는 세미콜론 구분 문자열 반환
                    if isinstance(accno_raw, list):
                        accno_list = [a.strip() for a in accno_raw if a.strip()]
                    else:
                        accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                    account_no = accno_list[0] if accno_list else os.environ.get('KIWOOM_ACCOUNT_NO', '')
                    print(f'[bridge] 계좌번호 목록={accno_list} 사용={account_no}')
                except Exception as e:
                    account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')
                    print(f'[bridge] GetLoginInfo 실패, env 계좌 사용: {account_no} ({e})')

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
                    QTimer.singleShot(5000, tr_loop1.quit)
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
                    kiwoom.SetInputValue("상장폐지조회구분",    "0")
                    kiwoom.SetInputValue("비밀번호입력매체구분", "00")
                    kiwoom.SetInputValue("거래소구분",          "")
                    kiwoom.CommRqData("계좌평가잔고내역요청", "OPW00004", 0, "0102")
                    QTimer.singleShot(5000, tr_loop2.quit)
                    tr_loop2.exec_()
                except Exception as e:
                    print(f'[bridge] OPW00004 오류: {e}')

                d2 = kiwoom._opw00004
                eval_total  = abs(_safe_int(d2.get('evalTotal', '')))
                pnl_total   = _safe_int(d2.get('pnlTotal', ''))
                rate_return = _safe_float(d2.get('rateReturn', ''))
                holdings = [
                    {
                        'ticker':       h['ticker'],
                        'name':         h['name'],
                        'qty':          _safe_int(h['qty']),
                        'avgPrice':     _safe_int(h['avgPrice']),
                        'currentPrice': abs(_safe_int(h['currentPrice'])),
                        'pnlRate':      _safe_float(h['pnlRate']),
                    }
                    for h in d2.get('holdings', [])
                ]
                print(f'[bridge] OPW00004: 총평가={eval_total} 손익={pnl_total} 종목수={len(holdings)}')

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

                # 계좌번호 동적 조회 (GetLoginInfo 우선, env 폴백)
                try:
                    accno_raw = kiwoom.GetLoginInfo("ACCNO")
                    if isinstance(accno_raw, list):
                        accno_list = [a.strip() for a in accno_raw if a.strip()]
                    else:
                        accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                    account_no = accno_list[0] if accno_list else os.environ.get('KIWOOM_ACCOUNT_NO', '')
                except Exception:
                    account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')

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

                account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')
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

                # 계좌번호 동적 조회
                try:
                    accno_raw = kiwoom.GetLoginInfo("ACCNO")
                    if isinstance(accno_raw, list):
                        accno_list = [a.strip() for a in accno_raw if a.strip()]
                    else:
                        accno_list = [a.strip() for a in str(accno_raw).split(';') if a.strip()]
                    account_no = accno_list[0] if accno_list else os.environ.get('KIWOOM_ACCOUNT_NO', '')
                except Exception:
                    account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')

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
                    QTimer.singleShot(5000, tr_loop.quit)
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
                # 시세(10,12,13) + 매도호가1~5(41~45) + 매수호가1~5(51~55) + 매도잔량1~5(61~65) + 매수잔량1~5(71~75)
                fid_str = '10;12;13;41;42;43;44;45;51;52;53;54;55;61;62;63;64;65;71;72;73;74;75'
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
