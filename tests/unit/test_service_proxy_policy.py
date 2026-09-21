"""The service proxy's last hop — FlowPad → the service over loopback — as pure rules.

Twin of the hub's ``test_service_proxy_headers`` / ``test_service_caller_signature``.
The signature format is the one contract the two repos share without sharing code,
so a vector minted by the hub's algorithm is checked here byte for byte.
"""

import hashlib
import hmac
import uuid

import pytest

from flow_sdk.server.middleware.json_body_relabel_middleware import is_raw_body_path
from flow_sdk.server.service_proxy import (
    CALLER_HEADER,
    CALLER_MAX_AGE,
    GATE_HEADER,
    USER_HEADER,
    inbound_headers,
    outbound_headers,
    sign_caller,
    upstream_path,
    verify_caller,
)

SECRET = "gate-secret-123"
CALLER = f"user-{uuid.uuid4()}"
NOW = 1_800_000_000


@pytest.mark.parametrize(
    "name",
    [
        "authorization",
        "cookie",
        "host",
        GATE_HEADER,
        CALLER_HEADER,
        USER_HEADER,
        "connection",
        "transfer-encoding",
        "upgrade",
        "x-forwarded-for",
        "forwarded",
        "hub-reflect",
        "x-flow-connection-id",
    ],
)
def test_outbound_never_carries_flowpad_credentials_or_spoofable_identity(name):
    out = outbound_headers([(name, "attacker"), ("x-keep", "1")], user=None)
    assert "attacker" not in [v for _, v in out]
    assert ("x-keep", "1") in out


def test_a_verified_user_is_the_only_identity_the_service_sees():
    out = outbound_headers([(USER_HEADER, "forged"), ("Accept", "text/event-stream")], user="user-1")
    assert (USER_HEADER, "user-1") in out
    assert ("accept", "text/event-stream") in out
    assert [v for n, v in out if n == USER_HEADER] == ["user-1"]


def test_no_verified_user_means_no_user_header():
    assert USER_HEADER not in dict(outbound_headers([], user=None))


def test_websocket_drops_the_whole_handshake():
    """The relay dials its own handshake; the subprotocol offer travels as a parameter."""
    out = outbound_headers(
        [("sec-websocket-key", "k"), ("sec-websocket-protocol", "graphql-ws"), ("origin", "http://x"), ("x-a", "1")],
        user=None,
        websocket=True,
    )
    assert out == [("x-a", "1")]


def test_inbound_keeps_duplicates_and_never_lets_a_service_set_a_cookie():
    headers = [("x-trace", "a"), ("x-trace", "b"), ("set-cookie", "s=1"), ("transfer-encoding", "chunked")]
    assert inbound_headers(headers) == [("x-trace", "a"), ("x-trace", "b")]


@pytest.mark.parametrize(
    "sub, query, expected",
    [
        ("", "", "/"),
        ("v1/chat/completions", "", "/v1/chat/completions"),
        ("assets/", "a=1&b=%20x", "/assets/?a=1&b=%20x"),
        ("files/a b#c?.txt", "", "/files/a%20b%23c%3F.txt"),
    ],
)
def test_upstream_path(sub, query, expected):
    assert upstream_path(sub, query) == expected


@pytest.mark.parametrize("sub", ["..", "../etc", "a/../../b", "a/./b"])
def test_upstream_path_refuses_dot_segments(sub):
    with pytest.raises(ValueError):
        upstream_path(sub, "")


# ── the caller signature — the contract with the hub ────────────────────────


def test_a_hub_minted_vector_verifies_here():
    """The hub's algorithm, spelled out: v1.<caller>.<ts>.<hmac-sha256 hex over the first three>."""
    message = f"v1.{CALLER}.{NOW}"
    minted = f"{message}.{hmac.new(SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()}"
    assert verify_caller(minted, SECRET, now=NOW) == CALLER
    assert sign_caller(CALLER, SECRET, now=NOW) == minted


def test_forged_stale_or_unsigned_callers_never_verify():
    signed = sign_caller(CALLER, SECRET, now=NOW)
    assert verify_caller(signed, "other", now=NOW) is None
    assert verify_caller(signed.replace(CALLER, "user-evil"), SECRET, now=NOW) is None
    assert verify_caller(signed, SECRET, now=NOW + CALLER_MAX_AGE + 1) is None
    assert verify_caller(signed, None, now=NOW) is None, "no gate secret, nothing to verify against"
    assert verify_caller("junk", SECRET, now=NOW) is None


def test_only_the_service_route_is_raw():
    assert is_raw_body_path("/api/v1/graph/service_endpoint/abc/service")
    assert is_raw_body_path("/api/v1/graph/service_endpoint/abc/service/x/y")
    assert not is_raw_body_path("/api/v1/graph/service_endpoint/abc/direct-url")
    assert not is_raw_body_path("/api/v1/graph/service_endpoint/abc/services")
    assert not is_raw_body_path("/api/v1/graph/project/abc/service")
