"""cookie-gate middleware — the credential lookup at the system door.

Two credentials, three transports. The middleware only decides pass/deny; the
exchange lives at ``GET /auth/gate``.
"""

from __future__ import annotations

import pytest
from starlette.requests import HTTPConnection

from flow_sdk.server import grants
from flow_sdk.server.middleware.cookie_gate_middleware import _presents
from tests.utils.gate import ENDPOINT, SECRET, armed, grant_cookie, ticket

COOKIE_NAME = grants.COOKIE_NAME
QUERY_NAME = grants.TICKET_PARAM

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _armed():
    with armed():
        yield


def _conn(*, cookie=None, header=None, query=""):
    headers = []
    if cookie:
        headers.append((b"cookie", f"{COOKIE_NAME}={cookie}".encode()))
    if header:
        headers.append((b"x-cookie-gate", header.encode()))
    return HTTPConnection({"type": "http", "path": "/", "query_string": query.encode(), "headers": headers})


def _ticket(audience="system", secret=SECRET):
    return ticket(audience, secret=secret)


def _grant(audience="system"):
    return grant_cookie(audience)


def test_header_presents_the_secret():
    assert _presents(_conn(header=SECRET), SECRET) is True


def test_a_system_grant_cookie_presents():
    assert _presents(_conn(cookie=_grant()), SECRET) is True


def test_a_system_ticket_in_the_query_presents():
    assert _presents(_conn(query=f"{QUERY_NAME}={_ticket()}"), SECRET) is True


def test_nothing_presented():
    assert _presents(_conn(), SECRET) is False


def test_the_secret_itself_is_no_longer_a_cookie_or_a_query():
    """The raw secret used to be the cookie and could ride ``?cookie-gate=``. Neither is a credential now."""
    assert _presents(_conn(cookie=SECRET), SECRET) is False
    assert _presents(_conn(query=f"cookie-gate={SECRET}"), SECRET) is False
    assert _presents(_conn(query=f"{QUERY_NAME}={SECRET}"), SECRET) is False


@pytest.mark.parametrize("audience", ["admin", "app"])
def test_a_grant_for_an_audience_door_does_not_open_the_system_door(audience):
    assert _presents(_conn(cookie=_grant(audience)), SECRET) is False
    assert _presents(_conn(query=f"{QUERY_NAME}={_ticket(audience)}"), SECRET) is False


def test_a_ticket_signed_with_another_secret_does_not_present():
    assert _presents(_conn(query=f"{QUERY_NAME}={_ticket(secret='other')}"), SECRET) is False


@pytest.mark.parametrize("wrong", ["s3cre", "s3crett", "S3CRET", "", "x"])
def test_wrong_value_in_any_transport(wrong):
    assert _presents(_conn(cookie=wrong), SECRET) is False
    assert _presents(_conn(header=wrong), SECRET) is False
    assert _presents(_conn(query=f"{QUERY_NAME}={wrong}"), SECRET) is False


def test_a_revoked_grant_no_longer_presents():
    value = _grant()
    assert _presents(_conn(cookie=value), SECRET) is True
    grants.revoke("user-alice", [ENDPOINT])
    assert _presents(_conn(cookie=value), SECRET) is False


def test_a_wrong_cookie_does_not_veto_a_right_header():
    """The transports are alternatives, not a precedence chain that can be
    poisoned — a stale cookie must not lock out a caller with a valid header."""
    assert _presents(_conn(cookie="stale", header=SECRET), SECRET) is True
