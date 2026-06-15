# db.py — MariaDB(pymysql) 연결 및 헬퍼
# 책임: 싱글톤 연결 + 자동 재연결 + 파라미터 바인딩 쿼리 + 배치 INSERT IGNORE.
# 보안: SQL 문자열 포맷 금지 — 항상 %s 플레이스홀더 사용.
# 작성일: 2026-06-13

from contextlib import contextmanager
from typing import Any, Iterable, List, Optional, Sequence, Tuple

import pymysql
from pymysql.connections import Connection
from pymysql.cursors import DictCursor

from . import config
from .log import get_logger

logger = get_logger(__name__)

_conn: Optional[Connection] = None


def _new_connection() -> Connection:
    """pymysql 연결 1개 생성. autocommit=False, charset=utf8mb4."""
    return pymysql.connect(
        host=config.DB_HOST,
        port=config.DB_PORT,
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        database=config.DB_NAME,
        charset="utf8mb4",
        autocommit=False,
        cursorclass=DictCursor,
        connect_timeout=10,
        read_timeout=60,
        write_timeout=60,
    )


def get_conn() -> Connection:
    """싱글톤 연결 반환. ping(reconnect=True)로 끊김 자동 복구."""
    global _conn
    if _conn is None:
        _conn = _new_connection()
        logger.info("DB connected: %s@%s:%d/%s",
                    config.DB_USER, config.DB_HOST, config.DB_PORT, config.DB_NAME)
    else:
        try:
            _conn.ping(reconnect=True)
        except pymysql.MySQLError as e:
            logger.warning("DB ping failed, reconnecting: %s", e)
            try:
                _conn.close()
            except Exception:
                pass
            _conn = _new_connection()
    return _conn


def close_conn() -> None:
    """프로세스 종료 시 명시적 close."""
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
        finally:
            _conn = None


@contextmanager
def transaction():
    """트랜잭션 컨텍스트. 예외 발생 시 자동 롤백."""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def fetch_all(sql: str, params: Optional[Sequence[Any]] = None) -> List[dict]:
    """SELECT 결과 dict 리스트 반환. 파라미터는 항상 %s 바인딩."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchall() or []


def fetch_one(sql: str, params: Optional[Sequence[Any]] = None) -> Optional[dict]:
    """SELECT 단일 행."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchone()


def execute(sql: str, params: Optional[Sequence[Any]] = None) -> int:
    """단일 INSERT/UPDATE/DELETE. 영향 행수 반환. 커밋 포함."""
    with transaction() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            return cur.rowcount


def executemany(sql: str, seq_params: Iterable[Sequence[Any]]) -> int:
    """배치 INSERT/UPDATE. 영향 행수 반환. 커밋 포함."""
    rows = list(seq_params)
    if not rows:
        return 0
    with transaction() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, rows)
            return cur.rowcount


def ping() -> bool:
    """헬스 체크용. 실패 시 False."""
    try:
        conn = get_conn()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        return True
    except Exception as e:
        logger.error("DB ping failed: %s", e)
        return False
