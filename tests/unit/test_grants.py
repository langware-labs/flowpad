"""``server/grants.py`` — a ticket becomes a grant, a grant dies with the process or a revocation."""

from __future__ import annotations

import time
import uuid
from unittest.mock import patch

import pytest

from flow_sdk.server import grants
from flow_sdk.server.service_proxy import GRANT_MAX_AGE, TICKET_MAX_AGE, Grant, sign_grant
from tests.utils.gate import ENDPOINT, SECRET, armed

NOW = int(time.time())

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _armed():
    with armed():
        yield


def _grant(caller="user-alice", audience="app") -> Grant:
    return Grant(caller, audience, ENDPOINT)


def test_a_ticket_is_read_with_the_gate_secret_and_lives_a_minute():
    ticket = sign_grant(_grant(), SECRET, now=NOW)
    assert grants.read_ticket(ticket, now=NOW) == _grant()
    assert grants.read_ticket(ticket, now=NOW + TICKET_MAX_AGE + 1) is None
    assert grants.read_ticket(sign_grant(_grant(), "other", now=NOW), now=NOW) is None


def test_a_grant_is_this_processs_own_and_outlives_the_ticket():
    value = grants.mint_grant(_grant(), now=NOW)
    assert grants.read_grant(value, now=NOW) == _grant()
    assert grants.read_grant(value, now=NOW + TICKET_MAX_AGE + 1) == _grant()
    assert grants.read_grant(value, now=NOW + GRANT_MAX_AGE + 1) is None


def test_a_ticket_is_not_a_grant_and_a_grant_is_not_a_ticket():
    ticket = sign_grant(_grant(), SECRET, now=NOW)
    assert grants.read_grant(ticket, now=NOW) is None, "the secret itself never signs a cookie"
    assert grants.read_ticket(grants.mint_grant(_grant(), now=NOW), now=NOW) is None


def test_a_restart_invalidates_every_grant():
    value = grants.mint_grant(_grant(), now=NOW)
    with patch.object(grants, "_BOOT_NONCE", "another-boot"):
        assert grants.read_grant(value, now=NOW) is None


def test_unarmed_there_is_nothing_to_sign_with_or_verify():
    with patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", return_value=None):
        assert grants.mint_grant(_grant(), now=NOW) is None
        assert grants.read_ticket(sign_grant(_grant(), SECRET, now=NOW), now=NOW) is None


def test_revocation_is_per_caller_per_endpoint_or_for_everyone():
    mine, theirs = _grant("user-alice"), _grant("user-bob")
    other = Grant("user-alice", "app", str(uuid.uuid4()))
    assert grants.revoke("user-alice", [ENDPOINT]) == 1
    assert grants.is_revoked(mine) and not grants.is_revoked(theirs) and not grants.is_revoked(other)
    grants.revoke(None, [ENDPOINT])
    assert grants.is_revoked(theirs) and grants.is_revoked(Grant("visitor", "app", ENDPOINT))
    assert grants.read_grant(grants.mint_grant(theirs, now=NOW), now=NOW) is None


def test_a_revocation_outlives_the_grants_it_refuses_and_no_longer():
    grants.revoke("user-alice", [ENDPOINT], now=NOW)
    assert grants.is_revoked(_grant(), now=NOW + GRANT_MAX_AGE - 1)
    assert not grants.is_revoked(_grant(), now=NOW + GRANT_MAX_AGE + 1)


def test_the_exchange_is_one_trade_for_every_door():
    """A ticket for the door becomes its cookie and a redirect; another door's ticket is nothing."""
    # ``exchange`` reads the real clock, so the ticket is signed now: ``NOW`` is when this file was
    # imported, and a one-minute ticket from then has expired by the time a full run gets here.
    now = int(time.time())
    traded = grants.exchange(sign_grant(_grant(), SECRET, now=now), audience="app", landing="/x")
    assert traded is not None and traded.status_code == 302 and traded.headers["location"] == "/x"
    assert traded.headers["set-cookie"].startswith(grants.COOKIE_NAME)
    assert grants.exchange(sign_grant(_grant(), SECRET, now=now), audience="admin", landing="/") is None
    assert grants.exchange("junk", audience="app", landing="/") is None


@pytest.mark.parametrize("hostile", ["//evil.com", "https://x", "evil.com/x", "", None, "/__flowpad/session"])
def test_a_landing_that_leaves_the_door_or_names_the_platform_is_the_root(hostile):
    assert grants.safe_next(hostile) == "/"
    assert grants.safe_next("/some/page?a=1") == "/some/page?a=1"


def test_the_cookie_line_is_host_only_partitioned_and_a_session_cookie():
    line = grants.set_cookie_header("v1.x")
    assert line.startswith(f"{grants.COOKIE_NAME}=")
    for attribute in ("Path=/", "Secure", "HttpOnly", "SameSite=None", "Partitioned"):
        assert attribute in line
    assert "Domain=" not in line and "Max-Age=" not in line and "Expires=" not in line
