# bridge.py
# 목적: 키움 OpenAPI+ COM/ActiveX를 Electron(Node.js)에서 사용할 수 있도록 연결하는
#       Python HTTP 브릿지. Flask(메인 스레드)와 pykiwoom(QThread)을 분리해서 실행.
# 버전: V1
# 날짜: 2026-06-15
# 참조: RESEARCH.md 섹션 21, 24

import sys
# Windows CMD/PowerShell 한글 인코딩 오류 방지 (반드시 최상단)
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os
import json
import time
import queue
import threading
from datetime import datetime

from flask import Flask, request, jsonify, Response, stream_with_context

# PyQt5 + pykiwoom: 반드시 QApplication 생성 후 pykiwoom import
from PyQt5.QtWidgets import QApplication
from PyQt5.QtCore import QThread, pyqtSignal

# QApplication은 전역 1개만 허용
qt_app = QApplication(sys.argv)

from pykiwoom.kiwoom import Kiwoom

# ============================================================
# 전역 큐 (스레드 간 통신 — thread-safe)
# ============================================================
# Electron → Python: HTTP 요청을 KiwoomWorker에게 전달
request_queue = queue.Queue()
# Python → Electron: KiwoomWorker 처리 결과를 Flask 핸들러에게 반환
response_queue = queue.Queue()
# Python → Electron: 실시간 시세/체결 이벤트를 SSE 스트림으로 push
sse_queue = queue.Queue()

# ============================================================
# KiwoomWorker — QThread에서 pykiwoom 전용 실행
# Flask는 멀티스레드이므로 pykiwoom 호출은 반드시 이 워커 스레드에서만 수행
# ============================================================
class KiwoomWorker(QThread):
    # QThread가 살아있는 동안 pykiwoom 이벤트 루프 유지

    def __init__(self):
        super().__init__()
        self.kiwoom = None
        self.logged_in = False
        self.server_type = None  # "0"=모의투자, "1"=실투
        # SendOrder 속도 제한: 1초 5회 이하
        self._order_times = []
        # 구독 중인 종목 코드 세트 (재연결 시 재등록용)
        self._subscriptions = set()

    def run(self):
        # QThread 진입점 — pykiwoom 인스턴스 생성 및 요청 처리 루프
        self.kiwoom = Kiwoom()
        # OnReceiveRealData: 실시간 시세 콜백 등록
        self.kiwoom.OnReceiveRealData.connect(self._on_real_data)
        # OnReceiveChejanData: 주문/체결 통보 콜백 등록
        self.kiwoom.OnReceiveChejanData.connect(self._on_chejan_data)

        # 요청 처리 루프 (Flask 스레드에서 request_queue에 넣은 작업 처리)
        while True:
            try:
                task = request_queue.get(timeout=1)
                if task is None:
                    # 종료 신호
                    break
                self._process_task(task)
            except queue.Empty:
                continue
            except Exception as e:
                response_queue.put({'success': False, 'error': str(e)})

    def _process_task(self, task):
        action = task.get('action')
        try:
            if action == 'login':
                result = self._do_login()
            elif action == 'account':
                result = self._do_get_account(task)
            elif action == 'holdings':
                result = self._do_get_holdings(task)
            elif action == 'order':
                result = self._do_order(task)
            elif action == 'subscribe':
                result = self._do_subscribe(task)
            elif action == 'unsubscribe':
                result = self._do_unsubscribe(task)
            elif action == 'cancel_order':
                result = self._do_cancel_order(task)
            else:
                result = {'success': False, 'error': f'알 수 없는 액션: {action}'}
            response_queue.put(result)
        except Exception as e:
            response_queue.put({'success': False, 'error': str(e)})

    def _do_login(self):
        # CommConnect(block=True): GUI 팝업 — 자동 입력 금지(키움 이용약관 위반)
        # 사용자가 직접 아이디/비밀번호 입력 후 로그인 버튼 클릭
        ret = self.kiwoom.CommConnect(block=True)
        if ret == 0:
            self.server_type = self.kiwoom.GetLoginInfo("GetServerGubun")
            self.logged_in = True
            account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')
            # 모의투자 확인: "0"=모의, "1"=실투
            is_mock = (self.server_type == "0")
            return {
                'success': True,
                'loggedIn': True,
                'serverType': self.server_type,
                'isMock': is_mock,
                'accountNo': account_no
            }
        else:
            self.logged_in = False
            return {'success': False, 'error': f'CommConnect 실패: {ret}'}

    def _do_get_account(self, task):
        if not self.logged_in:
            return {'success': False, 'error': '로그인 필요'}
        account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')
        screen_no = '0101'

        # OPW00004: 계좌평가잔고내역 TR 조회
        # 입력값 설정
        self.kiwoom.SetInputValue("계좌번호", account_no)
        self.kiwoom.SetInputValue("비밀번호", os.environ.get('KIWOOM_ACCOUNT_PW', '0000'))
        self.kiwoom.SetInputValue("비밀번호입력매체구분", "00")
        self.kiwoom.SetInputValue("조회구분", "2")
        self.kiwoom.CommRqData("계좌평가잔고내역요청", "OPW00004", 0, screen_no)

        # output1: 계좌 요약 정보 (단일 레코드)
        deposit     = abs(int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", 0, "예수금").strip() or 0))
        eval_total  = abs(int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", 0, "총평가금액").strip() or 0))
        pnl_total   = int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", 0, "총평가손익금액").strip() or 0)
        rate_return = float(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", 0, "총수익률(%)").strip() or 0)

        # output2: 보유종목 목록 (반복 행)
        # GetRepeatCnt: 반복 데이터 행 수
        count = self.kiwoom.GetRepeatCnt("계좌평가잔고내역요청", "계좌평가잔고내역")
        holdings = []
        for i in range(count):
            # "종목번호": 6자리 코드, "A" 접두사 포함 가능 → lstrip('A')
            raw_ticker = self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", i, "종목번호").strip()
            ticker = raw_ticker.lstrip('A')
            # "평균단가": 매입평균단가 (주의: "매입단가" 아님)
            avg_price = abs(int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", i, "평균단가").strip() or 0))
            quantity  = abs(int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", i, "보유수량").strip() or 0))
            # "현재가": 음수=하한가, abs() 처리 필요
            current_price = abs(int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", i, "현재가").strip() or 0))
            eval_amount   = int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", i, "평가금액").strip() or 0)
            pnl_amount    = int(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", i, "평가손익").strip() or 0)
            # "평가손익율(%)": 주의 — "수익률(%)" 아님
            pnl_rate = float(self.kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역", i, "평가손익율(%)").strip() or 0)
            if ticker:
                holdings.append({
                    'ticker': ticker, 'quantity': quantity, 'avg_price': avg_price,
                    'current_price': current_price, 'eval_amount': eval_amount,
                    'pnl_amount': pnl_amount, 'pnl_rate': pnl_rate
                })

        return {
            'success': True,
            'account': {
                'deposit': deposit, 'eval_total': eval_total,
                'pnl_total': pnl_total, 'rate_of_return': rate_return,
                'account_no': account_no
            },
            'holdings': holdings
        }

    def _do_get_holdings(self, task):
        # _do_get_account에 holdings 포함 — 별도 TR 없이 동일 OPW00004 사용
        return self._do_get_account(task)

    def _do_order(self, task):
        if not self.logged_in:
            return {'success': False, 'error': '로그인 필요'}

        # SendOrder 속도 제한: 1초에 5회 이하
        now = time.time()
        self._order_times = [t for t in self._order_times if now - t < 1.0]
        if len(self._order_times) >= 5:
            return {'success': False, 'error': '주문 속도 제한 초과 (1초 5회)'}
        self._order_times.append(now)

        account_no  = os.environ.get('KIWOOM_ACCOUNT_NO', '')
        order_type  = task.get('order_type', 1)  # 1=매수, 2=매도, 3=매수취소, 4=매도취소
        ticker      = task.get('ticker', '')
        qty         = task.get('qty', 0)
        price       = task.get('price', 0)
        # sHogaGb: "00"=지정가, "03"=시장가
        hoga_gb     = "03" if price == 0 else "00"
        screen_no   = "0201"

        # SendOrder 반환값: 0=접수 성공 (실제 주문번호 아님 — FID 9001에서 수신)
        ret = self.kiwoom.SendOrder(
            "주문", screen_no, account_no, order_type,
            ticker, qty, price, hoga_gb, ""
        )
        if ret == 0:
            return {'success': True, 'status': 'submitted', 'ticker': ticker, 'qty': qty, 'price': price}
        else:
            return {'success': False, 'error': f'SendOrder 실패: {ret}'}

    def _do_cancel_order(self, task):
        if not self.logged_in:
            return {'success': False, 'error': '로그인 필요'}
        account_no    = os.environ.get('KIWOOM_ACCOUNT_NO', '')
        ticker        = task.get('ticker', '')
        qty           = task.get('qty', 0)
        # 취소 주문번호 (원래 주문의 kiwoom_order_no)
        org_order_no  = task.get('org_order_no', '')
        # order_type: 3=매수취소, 4=매도취소
        order_type    = task.get('order_type', 3)
        screen_no     = "0202"

        ret = self.kiwoom.SendOrder(
            "취소주문", screen_no, account_no, order_type,
            ticker, qty, 0, "00", org_order_no
        )
        if ret == 0:
            return {'success': True, 'status': 'cancel_submitted'}
        else:
            return {'success': False, 'error': f'취소주문 실패: {ret}'}

    def _do_subscribe(self, task):
        if not self.logged_in:
            return {'success': False, 'error': '로그인 필요'}
        tickers = task.get('tickers', [])
        if not tickers:
            return {'success': False, 'error': '종목코드 필요'}
        screen_no = "0301"
        # SetRealReg 종목코드 구분: 세미콜론(;) — 공백 아님
        ticker_str = ";".join(tickers)
        # FID 목록: 현재가(10), 등락률(12), 거래량(13),
        #   매도호가1~5(41~45), 매도잔량(46~50), 매수호가(51~55), 매수잔량(56~60)
        fid_list = "10;12;13;41;42;43;44;45;46;47;48;49;50;51;52;53;54;55;56;57;58;59;60"
        # "0"=최초 등록, "1"=추가 등록
        opt = "0" if not self._subscriptions else "1"
        self.kiwoom.SetRealReg(screen_no, ticker_str, fid_list, opt)
        for t in tickers:
            self._subscriptions.add(t)
        return {'success': True, 'subscribed': tickers}

    def _do_unsubscribe(self, task):
        tickers = task.get('tickers', [])
        screen_no = "0301"
        for t in tickers:
            self.kiwoom.SetRealRemove(screen_no, t)
            self._subscriptions.discard(t)
        return {'success': True, 'unsubscribed': tickers}

    def _on_real_data(self, sCode, sRealType, sRealData):
        # 실시간 시세 수신 콜백 (OnReceiveRealData)
        # sRealType: "주식체결", "주식호가잔량" 등
        if sRealType == "주식체결":
            # 현재가: FID 10 (음수=하한가, abs 처리)
            price  = abs(int(self.kiwoom.GetCommRealData(sCode, 10).strip() or 0))
            change = float(self.kiwoom.GetCommRealData(sCode, 12).strip() or 0)
            volume = abs(int(self.kiwoom.GetCommRealData(sCode, 13).strip() or 0))
            event  = {
                'type': 'quote',
                'data': {'ticker': sCode, 'price': price, 'change': change, 'volume': volume,
                         'ts': int(time.time() * 1000)}
            }
            sse_queue.put(json.dumps(event))

        elif sRealType == "주식호가잔량":
            # 매도/매수 5호가 수집
            asks = []
            bids = []
            for i in range(5):
                ask_price  = abs(int(self.kiwoom.GetCommRealData(sCode, 41 + i).strip() or 0))
                ask_volume = abs(int(self.kiwoom.GetCommRealData(sCode, 46 + i).strip() or 0))
                bid_price  = abs(int(self.kiwoom.GetCommRealData(sCode, 51 + i).strip() or 0))
                bid_volume = abs(int(self.kiwoom.GetCommRealData(sCode, 56 + i).strip() or 0))
                asks.append({'price': ask_price, 'volume': ask_volume})
                bids.append({'price': bid_price, 'volume': bid_volume})
            event = {
                'type': 'orderbook',
                'data': {'ticker': sCode, 'asks': asks, 'bids': bids,
                         'ts': int(time.time() * 1000)}
            }
            sse_queue.put(json.dumps(event))

    def _on_chejan_data(self, sGubun, nItemCnt, sFIdList):
        # 주문/체결 통보 콜백 (OnReceiveChejanData)
        # sGubun: "0"=주문/체결통보, "1"=잔고통보, "3"=특이신호
        if sGubun != "0":
            return

        # FID 9001: 주문번호 (주의: 9203 아님 — KOA Studio 확인값)
        order_no   = self.kiwoom.GetChejanData(9001).strip()
        # FID 9003: 종목코드 (체결통보), "A" 접두사 제거
        ticker_raw = self.kiwoom.GetChejanData(9003).strip()
        ticker     = ticker_raw.lstrip('A')
        # FID 910: 체결수량, FID 911: 체결가격, FID 913: 체결여부("0"=미체결,"2"=체결)
        exec_qty   = abs(int(self.kiwoom.GetChejanData(910).strip() or 0))
        exec_price = abs(int(self.kiwoom.GetChejanData(911).strip() or 0))
        status_cd  = self.kiwoom.GetChejanData(913).strip()

        event = {
            'type': 'execution',
            'data': {
                'order_no':   order_no,
                'ticker':     ticker,
                'exec_qty':   exec_qty,
                'exec_price': exec_price,
                'status':     'filled' if status_cd == '2' else 'pending',
                'ts':         int(time.time() * 1000)
            }
        }
        sse_queue.put(json.dumps(event))


# ============================================================
# Flask 앱 — 메인 스레드에서 실행
# ============================================================
flask_app = Flask(__name__)

# KiwoomWorker 인스턴스 (전역, Flask 핸들러에서 request_queue로 통신)
kiwoom_worker = KiwoomWorker()


def _send_to_worker(task, timeout=30):
    """Flask 핸들러에서 KiwoomWorker로 작업 위임 후 결과 대기"""
    request_queue.put(task)
    try:
        result = response_queue.get(timeout=timeout)
        return result
    except queue.Empty:
        return {'success': False, 'error': f'타임아웃 ({timeout}초)'}


@flask_app.route('/status', methods=['GET'])
def status():
    """브릿지 상태 확인 — Electron 폴링으로 ready 확인"""
    return jsonify({
        'ready': True,
        'loggedIn': kiwoom_worker.logged_in,
        'serverType': kiwoom_worker.server_type
    })


@flask_app.route('/login', methods=['POST'])
def login():
    """키움 로그인 — CommConnect(block=True) GUI 팝업"""
    result = _send_to_worker({'action': 'login'}, timeout=120)
    return jsonify(result)


@flask_app.route('/account', methods=['GET'])
def get_account():
    """계좌 잔고 + 보유종목 조회 (OPW00004)"""
    account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')
    result = _send_to_worker({'action': 'account', 'account_no': account_no}, timeout=30)
    return jsonify(result)


@flask_app.route('/holdings', methods=['GET'])
def get_holdings():
    """보유종목 조회 (OPW00004 — account와 동일 TR)"""
    account_no = os.environ.get('KIWOOM_ACCOUNT_NO', '')
    result = _send_to_worker({'action': 'holdings', 'account_no': account_no}, timeout=30)
    return jsonify(result)


def _safe_int(val, default=0):
    """비숫자 값에도 안전하게 정수 변환"""
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


@flask_app.route('/order/buy', methods=['POST'])
def order_buy():
    """매수 주문 (nOrderType=1)"""
    body   = request.get_json() or {}
    ticker = str(body.get('ticker', '')).strip()
    qty    = _safe_int(body.get('qty', 0))
    price  = _safe_int(body.get('price', 0))
    if not ticker or qty <= 0:
        return jsonify({'success': False, 'error': '종목코드와 수량(양수)을 확인하세요'})
    result = _send_to_worker({
        'action': 'order', 'order_type': 1,
        'ticker': ticker, 'qty': qty, 'price': price
    }, timeout=10)
    return jsonify(result)


@flask_app.route('/order/sell', methods=['POST'])
def order_sell():
    """매도 주문 (nOrderType=2)"""
    body   = request.get_json() or {}
    ticker = str(body.get('ticker', '')).strip()
    qty    = _safe_int(body.get('qty', 0))
    price  = _safe_int(body.get('price', 0))
    if not ticker or qty <= 0:
        return jsonify({'success': False, 'error': '종목코드와 수량(양수)을 확인하세요'})
    result = _send_to_worker({
        'action': 'order', 'order_type': 2,
        'ticker': ticker, 'qty': qty, 'price': price
    }, timeout=10)
    return jsonify(result)


@flask_app.route('/order/cancel', methods=['POST'])
def order_cancel():
    """주문 취소 (nOrderType=3=매수취소, 4=매도취소)"""
    body = request.get_json() or {}
    result = _send_to_worker({
        'action': 'cancel_order',
        'ticker':       str(body.get('ticker', '')).strip(),
        'qty':          _safe_int(body.get('qty', 0)),
        'org_order_no': body.get('org_order_no', ''),
        'order_type':   int(body.get('order_type', 3))
    }, timeout=10)
    return jsonify(result)


@flask_app.route('/realtime/subscribe', methods=['POST'])
def subscribe():
    """실시간 시세 구독 시작 (SetRealReg)"""
    body = request.get_json() or {}
    tickers = body.get('tickers', [])
    if isinstance(tickers, str):
        tickers = [tickers]
    result = _send_to_worker({'action': 'subscribe', 'tickers': tickers}, timeout=10)
    return jsonify(result)


@flask_app.route('/realtime/unsubscribe', methods=['POST'])
def unsubscribe():
    """실시간 시세 구독 해제 (SetRealRemove)"""
    body = request.get_json() or {}
    tickers = body.get('tickers', [])
    if isinstance(tickers, str):
        tickers = [tickers]
    result = _send_to_worker({'action': 'unsubscribe', 'tickers': tickers}, timeout=10)
    return jsonify(result)


@flask_app.route('/realtime/events', methods=['GET'])
def realtime_events():
    """SSE 스트림 — 실시간 시세/체결 이벤트를 Electron에 push"""
    def generate():
        last_heartbeat = time.time()
        while True:
            try:
                # 25초마다 heartbeat (연결 유지)
                now = time.time()
                if now - last_heartbeat > 25:
                    yield ": ping\n\n"
                    last_heartbeat = now

                # 이벤트 큐에서 데이터 꺼내기 (1초 타임아웃)
                data = sse_queue.get(timeout=1)
                yield f"data: {data}\n\n"
            except queue.Empty:
                continue
            except GeneratorExit:
                break

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    )


@flask_app.route('/shutdown', methods=['POST'])
def shutdown():
    """브릿지 종료 요청 (Electron 재시작 시 사용)"""
    request_queue.put(None)  # KiwoomWorker 종료 신호
    # Flask 종료는 Electron이 프로세스 kill로 처리
    return jsonify({'success': True, 'message': '종료 요청 수신'})


# ============================================================
# 진입점
# ============================================================
if __name__ == '__main__':
    port = int(os.environ.get('KIWOOM_BRIDGE_PORT', 5001))

    # KiwoomWorker QThread 시작 (Flask보다 먼저 시작)
    kiwoom_worker.start()

    print(f'[bridge] KiwoomWorker QThread 시작 완료')
    print(f'[bridge] Flask HTTP 서버 시작: 127.0.0.1:{port}')

    # Flask 서버: 127.0.0.1만 바인딩 (외부 접근 차단)
    # threaded=True: 각 HTTP 요청을 별도 스레드로 처리
    flask_app.run(
        host='127.0.0.1',
        port=port,
        debug=False,
        threaded=True,
        use_reloader=False  # QThread와 충돌 방지
    )
