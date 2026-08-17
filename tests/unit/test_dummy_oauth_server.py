"""The harness, testing itself.

Every OAuth assertion downstream is only as trustworthy as this server. If
`/authorize` silently stopped echoing `state`, or `/token` handed out the same
token twice, the sync tests would go green while proving nothing. So the fake
gets the same scrutiny as the product.
"""

from __future__ import annotations

import httpx
import pytest

from tests.utils.dummy_oauth_server import dummy_oauth_server

REDIRECT = "http://127.0.0.1:9999/callback"

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _authorize(server, state="st-1", redirect=REDIRECT, client_id="dummy-client"):
    """Play the browser: follow nothing, read the Location."""
    return httpx.get(
        server.authorize_url,
        params={
            "client_id": client_id,
            "redirect_uri": redirect,
            "state": state,
            "response_type": "code",
            "scope": "read write",
        },
        follow_redirects=False,
    )


def _code_from(response) -> tuple[str, str]:
    location = httpx.URL(response.headers["Location"])
    return location.params.get("code", ""), location.params.get("state", "")


def _exchange(server, code, redirect=REDIRECT, client_id="dummy-client"):
    return httpx.post(
        server.token_url,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect,
            "client_id": client_id,
            "client_secret": "dummy-secret",
        },
    )


def test_authorize_approves_without_a_consent_page():
    """No HTML, no password, no passkey — a 302 straight back with a code.
    That is the only thing 'dummy' removes."""
    with dummy_oauth_server() as server:
        response = _authorize(server)
        assert response.status_code == 302
        code, _ = _code_from(response)
        assert code.startswith("dmy_code_")
        assert server.counts["authorize"] == 1


def test_state_is_echoed_byte_for_byte():
    """The hub raises on any mismatch, so an approximate echo would surface as a
    confusing hub error rather than as a harness bug."""
    odd = "a b+c/d=e&f%20g"
    with dummy_oauth_server() as server:
        _, echoed = _code_from(_authorize(server, state=odd))
        assert echoed == odd


def test_token_endpoint_returns_json_200():
    with dummy_oauth_server() as server:
        code, _ = _code_from(_authorize(server))
        response = _exchange(server, code)
        assert response.status_code == 200
        body = response.json()
        assert body["access_token"] == server.latest_token
        assert body["token_type"] == "bearer"


def test_every_issuance_is_a_distinct_value():
    """Otherwise 'latest login wins' is invisible, and a stale token could pass
    by coinciding with the fresh one."""
    with dummy_oauth_server() as server:
        for _ in range(3):
            code, _ = _code_from(_authorize(server))
            _exchange(server, code)
        tokens = server.issued_tokens()
        assert len(tokens) == 3
        assert len(set(tokens)) == 3


def test_a_replayed_code_is_refused():
    """A code is single-use. A fake that mints a second token for a replayed
    code would hide a real double-exchange bug."""
    with dummy_oauth_server() as server:
        code, _ = _code_from(_authorize(server))
        assert _exchange(server, code).status_code == 200
        replay = _exchange(server, code)
        assert replay.status_code == 400
        assert replay.json()["error"] == "invalid_grant"
        assert len(server.issued_tokens()) == 1


def test_a_mismatched_redirect_uri_is_refused():
    with dummy_oauth_server() as server:
        code, _ = _code_from(_authorize(server))
        response = _exchange(server, code, redirect="http://127.0.0.1:1/elsewhere")
        assert response.status_code == 400
        assert response.json()["error"] == "redirect_uri_mismatch"
        assert server.latest_token is None


def test_an_unknown_code_is_refused():
    with dummy_oauth_server() as server:
        assert _exchange(server, "dmy_code_never_issued").status_code == 400


def test_userinfo_accepts_only_a_token_this_server_issued():
    with dummy_oauth_server() as server:
        code, _ = _code_from(_authorize(server))
        token = _exchange(server, code).json()["access_token"]

        ok = httpx.get(server.userinfo_url, headers={"Authorization": f"Bearer {token}"})
        assert ok.status_code == 200 and ok.json()["id"] == "dummy-user-1"

        bad = httpx.get(server.userinfo_url, headers={"Authorization": "Bearer not-a-token"})
        assert bad.status_code == 401


def test_introspection_reports_exactly_what_was_issued():
    """The reporting endpoint IS the sync assertion's source of truth, so it has
    to agree with what came back over the wire."""
    with dummy_oauth_server() as server:
        code, _ = _code_from(_authorize(server, state="st-xyz"))
        token = _exchange(server, code).json()["access_token"]

        report = httpx.get(f"{server.base_url}/_introspect").json()
        assert report["latest_token"] == token
        assert report["counts"] == {"authorize": 1, "token": 1, "userinfo": 0}
        assert report["codes_outstanding"] == [], "an exchanged code must not stay outstanding"

        issued = report["issuances"][0]
        assert issued["token"] == token
        assert issued["code"] == code
        assert issued["state"] == "st-xyz"
        assert issued["redirect_uri"] == REDIRECT


def test_a_mutated_state_still_round_trips_the_original_to_the_token_endpoint():
    """The knob that lets a test force the hub's state-mismatch path: the
    BROWSER gets a corrupted state while the server still knows the real one."""
    with dummy_oauth_server(state_mutator=lambda s: s + "X") as server:
        code, echoed = _code_from(_authorize(server, state="st-1"))
        assert echoed == "st-1X"
        _exchange(server, code)
        assert server.state.issuances[0].state == "st-1"


def test_auto_approve_off_redirects_with_an_error_and_issues_nothing():
    with dummy_oauth_server(auto_approve=False) as server:
        response = _authorize(server)
        assert response.status_code == 302
        location = httpx.URL(response.headers["Location"])
        assert location.params.get("error") == "access_denied"
        assert location.params.get("code") is None
        assert server.latest_token is None
        assert server.counts["token"] == 0


def test_reset_clears_the_log_for_a_reused_server():
    """The hub tier's server outlives a single test; without this, one test's
    issuances would satisfy the next test's assertions."""
    with dummy_oauth_server() as server:
        code, _ = _code_from(_authorize(server))
        _exchange(server, code)
        assert server.latest_token is not None

        httpx.post(f"{server.base_url}/_reset")
        assert server.latest_token is None
        assert server.counts == {"authorize": 0, "token": 0, "userinfo": 0}
