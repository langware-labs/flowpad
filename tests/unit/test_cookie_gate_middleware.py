"""cookie-gate middleware — the credential lookup.

One credential, three transports. The middleware only decides pass/deny; the
exchange lives at ``GET /auth/gate``.
"""

from __future__ import annotations

import pytest
from starlette.requests import HTTPConnection

from flow_sdk.server.middleware.cookie_gate_middleware import (
    COOKIE_NAME,
    _presents,
)

SECRET = "s3cret"

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _conn(*, cookie=None, header=None, query=""):
    headers = []
    if cookie:
        headers.append((b"cookie", f"{COOKIE_NAME}={cookie}".encode()))
    if header:
        headers.append((b"x-cookie-gate", header.encode()))
    return HTTPConnection(
        {"type": "http", "path": "/", "query_string": query.encode(), "headers": headers}
    )


def test_cookie_presents():
    assert _presents(_conn(cookie=SECRET), SECRET) is True


def test_header_presents():
    assert _presents(_conn(header=SECRET), SECRET) is True


def test_query_presents():
    assert _presents(_conn(query=f"cookie-gate={SECRET}"), SECRET) is True


def test_nothing_presented():
    assert _presents(_conn(), SECRET) is False


@pytest.mark.parametrize("wrong", ["s3cre", "s3crett", "S3CRET", "", "x"])
def test_wrong_value_in_any_transport(wrong):
    assert _presents(_conn(cookie=wrong), SECRET) is False
    assert _presents(_conn(header=wrong), SECRET) is False
    assert _presents(_conn(query=f"cookie-gate={wrong}"), SECRET) is False


def test_a_wrong_cookie_does_not_veto_a_right_header():
    """The transports are alternatives, not a precedence chain that can be
    poisoned — a stale cookie must not lock out a caller with a valid header."""
    conn = _conn(cookie="stale", header=SECRET)

    assert _presents(conn, SECRET) is True
