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
from flow_sdk.instance_settings import cookie_gate
from flow_sdk.utils.networking import is_loopback

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SECRET = "s3cret-gate"
LOOPBACK = "http://127.0.0.1:9007/api/v1/graph/agentic_process/abc/show"


def _armed(secret=SECRET):
    """This instance's cookie-gate token (FLOWPAD-2233), without touching the token file."""
    return patch.object(cookie_gate, "_token", return_value=secret)


def _header_name():
    with _armed():
        return cookie_gate.get_header().name


class _Resp:
    """Just enough of ``requests.Response`` for ``bad_response_message``."""

    def __init__(self, status_code, content_type="application/json", text="{}"):
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self.text = text


# ---------------------------------------------------------------------------
# get_header / is_loopback -- what is presented, and where it may go
# ---------------------------------------------------------------------------


def test_armed_instance_has_a_header_carrying_the_token():
    with _armed():
        assert cookie_gate.get_header().value == SECRET


def test_unarmed_instance_has_no_header():
    with _armed(None):
        assert cookie_gate.get_header() is None


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1", "[::1]"])
def test_every_loopback_spelling_is_this_machine(host):
    """`read_all_server_infos` builds `localhost` urls while the command modules
    build `127.0.0.1` ones -- both are this machine."""
    assert is_loopback(host) is True


@pytest.mark.parametrize("host", ["app.flowpad.ai", "evil.example", "", None])
def test_other_hosts_are_not_this_machine(host):
    assert is_loopback(host) is False


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
        assert _sent(json={}).get("headers") == {_header_name(): SECRET}


def test_local_post_never_sends_the_token_off_this_machine():
    """`setup_cmd` can be pointed at a configured remote host. A credential for
    THIS instance leaving the machine would be a real leak, not a nuisance."""
    captured = {}

    def fake_request(method, url, **kw):
        captured.update(kw)
        return _Resp(200)

    with _armed(), patch("requests.request", fake_request):
        _common.local_post("https://app.flowpad.ai/api/v1/graph/bootstrap", json={})
    assert SECRET not in str(captured.get("headers") or {})


def test_local_post_sends_no_headers_at_all_when_ungated():
    """Not an empty dict -- the kwarg is absent, so the call is identical to the
    bare `requests.post` it replaced."""
    with _armed(None):
        assert "headers" not in _sent(json={})


def test_an_explicit_header_wins():
    name = _header_name()
    with _armed():
        sent = _sent(json={}, headers={name: "caller-chose-this"})
    assert sent["headers"][name] == "caller-chose-this"


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


# ---------------------------------------------------------------------------
# get_header -- reads the real token file, creating it on first use
# ---------------------------------------------------------------------------


@pytest.fixture
def local_token(tmp_path, monkeypatch):
    path = tmp_path / ".cookie_gate"
    path.write_text("own-token", encoding="utf-8")
    monkeypatch.setattr(cookie_gate, "_token_path", lambda: path)
    return path


def test_the_token_file_is_what_is_sent(local_token):
    assert cookie_gate.get_header().value == "own-token"


def test_no_token_file_creates_one_and_sends_it(local_token):
    local_token.unlink()

    header = cookie_gate.get_header()

    assert header is not None and header.value == local_token.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# The installed opener -- every urllib.request.urlopen carries the gate cookie
# ---------------------------------------------------------------------------


def _opened(url):
    """``urlopen`` ``url`` with the network stubbed; return the Request's headers as sent."""
    import email.message
    import urllib.request

    sent = {}

    class _Ok:
        code, msg = 200, "OK"

        def info(self):
            return email.message.Message()  # the cookie processor reads Set-Cookie from it

    def fake_open(_handler, req):
        sent["req"] = req
        return _Ok()

    with patch.object(urllib.request, "_opener", None), patch.object(urllib.request.HTTPHandler, "http_open", fake_open):
        cookie_gate.install_gate_opener()  # what the CLI does at startup
        urllib.request.urlopen(urllib.request.Request(url))
    return {k.lower(): v for k, v in sent["req"].header_items()}


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
def test_urlopen_presents_the_cookie_on_loopback(host):
    with _armed():
        assert _opened(f"http://{host}:9007/x")["cookie"] == f"cookie-gate-9007={SECRET}"


def test_urlopen_presents_nothing_off_this_machine():
    with _armed():
        assert "cookie" not in _opened("http://example.com/x")
