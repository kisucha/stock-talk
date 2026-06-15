# notify.py — 텔레그램 알림 전송
# 책임: BOT_TOKEN/CHAT_ID 설정 시 sendMessage 호출. 미설정 시 graceful skip.
# 외부 호출 실패가 수집 작업 자체를 막지 않도록 모든 예외를 흡수.
# 작성일: 2026-06-13

from typing import Optional

import requests

from . import config
from .log import get_logger

logger = get_logger(__name__)

_TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
_TIMEOUT_SEC = 10
# Telegram 메시지 최대 4096자 — 안전하게 4000으로 클램프
_MAX_LEN = 4000


def send_telegram(message: str, parse_mode: Optional[str] = None) -> bool:
    """텔레그램 메시지 전송.
    Returns: 전송 성공 여부. 미설정/실패 모두 False 반환 (예외 비전파).
    """
    if not config.TELEGRAM_ENABLED:
        logger.debug("telegram skipped: not configured")
        return False

    if not message:
        return False

    # 길이 클램프 + 말머리 보존
    if len(message) > _MAX_LEN:
        message = message[: _MAX_LEN - 50] + "\n... (메시지가 잘렸습니다)"

    url = _TELEGRAM_API.format(token=config.TELEGRAM_BOT_TOKEN)
    payload = {
        "chat_id": config.TELEGRAM_CHAT_ID,
        "text": message,
        "disable_web_page_preview": True,
    }
    if parse_mode:
        payload["parse_mode"] = parse_mode

    try:
        resp = requests.post(url, json=payload, timeout=_TIMEOUT_SEC)
        if resp.status_code == 200 and resp.json().get("ok"):
            logger.info("telegram sent (%d chars)", len(message))
            return True
        logger.warning(
            "telegram failed: status=%s body=%s",
            resp.status_code,
            resp.text[:200],
        )
        return False
    except requests.RequestException as e:
        logger.warning("telegram request error: %s", e)
        return False
    except Exception as e:
        # 토큰/JSON 파싱 등 예측 못한 모든 실패를 흡수
        logger.warning("telegram unexpected error: %s", e)
        return False
