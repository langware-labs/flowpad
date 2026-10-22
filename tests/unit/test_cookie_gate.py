"""cookie-gate secret store — get/set/clear on the instance's token file."""

from __future__ import annotations

import pytest

from flow_sdk.instance_settings import cookie_gate

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


# ---------------------------------------------------------------------------
# Unarmed
# ---------------------------------------------------------------------------


def test_unset_instance_has_no_token(sod_env):
    assert cookie_gate.get_cookie_gate() is None


# ---------------------------------------------------------------------------
# Arming
# ---------------------------------------------------------------------------


def test_set_then_get_roundtrip(sod_env):
    cookie_gate.set_cookie("s3cret")

    assert cookie_gate.get_cookie_gate() == "s3cret"
    assert cookie_gate.get_cookie_gate() is not None


def test_set_rejects_empty(sod_env):
    """Storing "" would read back as unset — open while looking locked."""
    with pytest.raises(ValueError):
        cookie_gate.set_cookie("")

    assert cookie_gate.get_cookie_gate() is None


# ---------------------------------------------------------------------------
# verify_cookie / add_query_param
# ---------------------------------------------------------------------------


def test_verify_cookie_accepts_the_token_and_nothing_else(sod_env):
    cookie_gate.set_cookie("s3cret")

    assert cookie_gate.verify_cookie("s3cret") is True
    assert cookie_gate.verify_cookie("s3cre") is False
    assert cookie_gate.verify_cookie("") is False


def test_verify_cookie_creates_the_token_on_first_use(sod_env):
    assert cookie_gate.get_cookie_gate() is None

    assert cookie_gate.verify_cookie("guess") is False
    assert cookie_gate.get_cookie_gate() is not None


def test_add_query_param_carries_the_token(sod_env):
    from starlette.datastructures import URL, QueryParams

    cookie_gate.set_cookie("s3cret")
    url = cookie_gate.add_query_param(URL("http://127.0.0.1:9007/auth/gate?next=/x"))
    query = QueryParams(url.query)

    assert url.path == "/auth/gate" and query["next"] == "/x"
    assert any(cookie_gate.verify_cookie(v) for v in query.values())


# ---------------------------------------------------------------------------
# Desktop refusal
# ---------------------------------------------------------------------------


def test_set_refused_on_a_desktop_instance(sod_env):
    """The gate exempts no path, so arming a desktop instance rejects the
    Electron shell's own /health/status poll and the app never launches."""
    sod_env.instance_dir.mkdir(parents=True, exist_ok=True)
    sod_env.desktop_marker_path.touch()

    with pytest.raises(cookie_gate.DesktopGateRefused):
        cookie_gate.set_cookie("s3cret")


def test_desktop_refusal_leaves_the_instance_open(sod_env):
    """Refusing must not half-arm: no secret written."""
    sod_env.instance_dir.mkdir(parents=True, exist_ok=True)
    sod_env.desktop_marker_path.touch()

    with pytest.raises(cookie_gate.DesktopGateRefused):
        cookie_gate.set_cookie("s3cret")

    assert cookie_gate.get_cookie_gate() is None


def test_desktop_refusal_is_a_value_error(sod_env):
    """The CLI reports it through its existing `except ValueError` handler."""
    assert issubclass(cookie_gate.DesktopGateRefused, ValueError)


def test_sandbox_without_a_desktop_marker_still_arms(sod_env):
    """The refusal keys on positive desktop evidence, not on the absence of a
    hub runtime assignment — a box that has not finished starting has neither."""
    assert not sod_env.desktop_marker_path.exists()

    cookie_gate.set_cookie("s3cret")

    assert cookie_gate.get_cookie_gate() == "s3cret"


# ---------------------------------------------------------------------------
# Recording the desktop fact — what makes the refusal above reachable from a
# `flow` CLI process, which never sees FLOWPAD_DESKTOP itself.
# ---------------------------------------------------------------------------


def test_marks_desktop_instance_under_electron(sod_env, monkeypatch):
    from flow_sdk.server.startup import mark_desktop_managed

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    mark_desktop_managed()

    assert sod_env.desktop_marker_path.exists()


def test_does_not_mark_without_electron(sod_env, monkeypatch):
    """A sandbox or a plain CLI install must stay armable."""
    from flow_sdk.server.startup import mark_desktop_managed

    monkeypatch.delenv("FLOWPAD_DESKTOP", raising=False)
    mark_desktop_managed()

    assert not sod_env.desktop_marker_path.exists()
    cookie_gate.set_cookie("s3cret")
    assert cookie_gate.get_cookie_gate() is not None


def test_marking_then_arming_is_refused(sod_env, monkeypatch):
    """The end-to-end shape of the incident: desktop backend boots, then a CLI
    call tries to arm the gate and is turned away."""
    from flow_sdk.server.startup import mark_desktop_managed

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    mark_desktop_managed()

    with pytest.raises(cookie_gate.DesktopGateRefused):
        cookie_gate.set_cookie("s3cret")

    assert cookie_gate.get_cookie_gate() is None


def test_marking_is_idempotent(sod_env, monkeypatch):
    from flow_sdk.server.startup import mark_desktop_managed

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    mark_desktop_managed()
    first = sod_env.desktop_marker_path.stat().st_mtime_ns
    mark_desktop_managed()

    assert sod_env.desktop_marker_path.stat().st_mtime_ns == first


# ---------------------------------------------------------------------------
# Clearing
# ---------------------------------------------------------------------------


def test_clear_disarms_the_instance(sod_env):
    cookie_gate.set_cookie("s3cret")
    assert cookie_gate.get_cookie_gate() is not None

    assert cookie_gate.clear_cookie_gate() is True

    assert cookie_gate.get_cookie_gate() is None


def test_clear_takes_effect_in_this_process_immediately(sod_env):
    """No restart — a server that kept enforcing a deleted token would be locked
    shut with no way back in."""
    cookie_gate.set_cookie("s3cret")
    assert cookie_gate.get_cookie_gate() == "s3cret"

    cookie_gate.clear_cookie_gate()

    assert cookie_gate.get_cookie_gate() is None


def test_clear_on_an_unarmed_instance_reports_nothing_changed(sod_env):
    """So a caller can say "already open" instead of implying it did something."""
    assert cookie_gate.clear_cookie_gate() is False
    assert cookie_gate.get_cookie_gate() is None


# ---------------------------------------------------------------------------
# CookieGateAuthHttpx
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "carries"),
    [
        ("http://127.0.0.1:9007/api/v1/x", True),
        ("http://localhost:9007/api/v1/x", True),
        ("https://hub.example/api/v1/x", False),
    ],
)
def test_httpx_auth_presents_the_token_on_loopback_only(sod_env, url, carries):
    import httpx

    cookie_gate.set_cookie("s3cret")
    seen = []
    transport = httpx.MockTransport(lambda request: seen.append(request) or httpx.Response(200))

    with httpx.Client(auth=cookie_gate.CookieGateAuthHttpx(), transport=transport) as client:
        client.get(url)

    presented = seen[0].headers.get(cookie_gate.get_header().name)
    assert cookie_gate.verify_cookie(presented or "") is carries
