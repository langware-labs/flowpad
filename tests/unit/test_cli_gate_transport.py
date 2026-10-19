"""The CLI's transport and the cookie gate.

The `flow` CLI is the machine caller the gate's header transport exists for --
it is what an agent inside a gated sandbox runs. Every command used to build a
bare `requests` call with no credential, so on a gated instance the gate refused
all of them (it has NO path and NO loopback exemption) and each one reported the
first 200 characters of an HTML page as its error. These pin the two halves of
the fix: the header goes out, and it goes out to this machine only.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from flow_sdk.cli.commands import _common
from flow_sdk.instance_settings.cookie_gate import gate_headers
from flow_sdk.server.middleware.cookie_gate_middleware import HEADER_NAME

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SECRET = "s3cret-gate"
LOOPBACK = "http://127.0.0.1:9007/api/v1/graph/agentic_process/abc/show"


def _armed(secret=SECRET):
    return patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", return_value=secret)


class _Resp:
    """Just enough of ``requests.Response`` for ``bad_response_message``."""

    def __init__(self, status_code, content_type="application/json", text="{}"):
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self.text = text


# ---------------------------------------------------------------------------
# gate_headers -- what is presented, and to whom
# ---------------------------------------------------------------------------


def test_armed_instance_presents_the_secret_on_loopback():
    with _armed():
        assert gate_headers(LOOPBACK) == {HEADER_NAME: SECRET}


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_every_loopback_spelling_is_covered(host):
    """`read_all_server_infos` builds `localhost` urls while the command modules
    build `127.0.0.1` ones -- both are this machine and both must pass."""
    url = f"http://[{host}]:9007/x" if host == "::1" else f"http://{host}:9007/x"
    with _armed():
        assert gate_headers(url) == {HEADER_NAME: SECRET}


def test_secret_never_rides_a_request_off_this_machine():
    """`setup_cmd` can be pointed at a configured remote host. A credential for
    THIS instance leaving the machine would be a real leak, not a nuisance."""
    with _armed():
        assert gate_headers("https://app.flowpad.ai/api/v1/graph/bootstrap") == {}


def test_unarmed_instance_sends_nothing():
    """Every desktop install. The request must be what it was before the gate
    existed -- no header, and no keychain access to discover that."""
    with _armed(None):
        assert gate_headers(LOOPBACK) == {}


def test_an_unreadable_gate_degrades_to_no_header():
    """Being unable to read the secret is a reason to call without it, never a
    reason to raise -- the CLI has to keep working on an instance whose secret
    store is unavailable."""
    with patch(
        "flow_sdk.instance_settings.cookie_gate.get_cookie_gate",
        side_effect=RuntimeError("sod unreadable"),
    ):
        assert gate_headers(LOOPBACK) == {}


# ---------------------------------------------------------------------------
# local_request -- the transport every command goes through
# ---------------------------------------------------------------------------


def _sent(**kwargs):
    """Run ``local_post`` against a stubbed requests.request and return its kwargs."""
    captured = {}

    def fake_request(method, url, **kw):
        captured.update(method=method, url=url, **kw)
        return _Resp(200)

    with patch("requests.request", fake_request):
        _common.local_post(LOOPBACK, **kwargs)
    return captured


def test_local_post_attaches_the_gate_header():
    with _armed():
        assert _sent(json={}).get("headers") == {HEADER_NAME: SECRET}


def test_local_post_sends_no_headers_at_all_when_ungated():
    """Not an empty dict -- the kwarg is absent, so the call is identical to the
    bare `requests.post` it replaced."""
    with _armed(None):
        assert "headers" not in _sent(json={})


def test_an_explicit_header_wins():
    with _armed():
        sent = _sent(json={}, headers={HEADER_NAME: "caller-chose-this"})
    assert sent["headers"][HEADER_NAME] == "caller-chose-this"


# ---------------------------------------------------------------------------
# bad_response_message -- what the agent is told when it is refused anyway
# ---------------------------------------------------------------------------


def test_a_gate_refusal_is_named_rather_than_quoted():
    """The symptom this whole change came from: `Bad response: <!doctype html>`,
    200 characters of a page written for a human, naming neither cause nor fix."""
    message = _common.bad_response_message(
        _Resp(403, content_type="text/html; charset=utf-8", text="<!doctype html><title>Forbidden</title>")
    )

    assert "cookie-gate" in message
    assert "doctype" not in message


def test_an_action_403_is_not_mistaken_for_the_gate():
    """Actions refuse with a JSON envelope (`share_action`, `cron_event`). Those
    are the caller's problem to report, not a gate diagnosis."""
    message = _common.bad_response_message(_Resp(403, text='{"message": "local mode"}'))

    assert "cookie-gate" not in message
    assert "local mode" in message
