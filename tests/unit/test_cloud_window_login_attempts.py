"""A browser sign-in's timeout fails only ITS OWN attempt, and Cancel stops the wait.

Every attempt shares one "the callback arrived" event and starts its own timeout. A second click
(or the dialog firing the same click twice, which it did) left the first attempt's timer running;
when it expired it broadcast "Login timed out" and set LOGIN_FAILED while the person was still
signing in to the newer attempt. Cancel had no backend at all: the only way out of "Starting…" was
that 5-minute timeout.
"""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.cli.auth import cloud_login
from flow_sdk.server import state

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.fixture
def window(monkeypatch):
    """No browser, no hub: record what the attempt would have told the UI."""
    told: list = []

    async def _error(message):
        told.append(("error", message))

    async def _status(status, **_):
        told.append(("status", getattr(status, "value", status)))

    monkeypatch.setattr(cloud_login.webbrowser, "open", lambda _url: True)
    monkeypatch.setattr(cloud_login, "get_login_url", lambda _cb: "https://hub/login")
    monkeypatch.setattr(cloud_login, "desktop_login_callback_url", lambda: "http://127.0.0.1/cb")
    monkeypatch.setattr(cloud_login, "_broadcast_oauth_error", _error)
    import flow_sdk.cloud_client.auth_state as auth_state

    monkeypatch.setattr(auth_state, "set_login_status", _status)
    yield told
    state.login_received.set()  # release any waiter still parked on the event


@pytest.mark.asyncio
async def test_an_older_attempts_timer_does_not_fail_the_newer_one(window):
    await cloud_login._login_by_window(0.05)  # the first click; the person never finishes it
    await cloud_login._login_by_window(5.0)  # the second click, still in progress

    await asyncio.sleep(0.3)  # well past the first attempt's timeout

    assert ("error", "Login timed out after 0s — please try again") not in window
    assert not [t for t in window if t[0] == "error"]


@pytest.mark.asyncio
async def test_a_lone_attempt_still_times_out(window):
    await cloud_login._login_by_window(0.05)

    await asyncio.sleep(0.3)

    assert [t for t in window if t[0] == "error"], "an attempt nobody finishes still ends"


@pytest.mark.asyncio
async def test_cancel_leaves_logging_in_and_silences_the_timer(window):
    await cloud_login._login_by_window(0.05)

    await cloud_login.cancel_window_login()
    await asyncio.sleep(0.3)

    assert ("status", "logged_out") in window
    assert not [t for t in window if t[0] == "error"], "a cancelled attempt must not later report a timeout"


@pytest.mark.asyncio
async def test_a_chosen_profile_opens_the_sign_in_there_not_in_the_default_browser(window, monkeypatch):
    import flow_sdk.core.browser_profiles as browser_profiles

    opened: list = []
    monkeypatch.setattr(cloud_login.webbrowser, "open", lambda url: opened.append(("default", url)))
    monkeypatch.setattr(browser_profiles, "open_in_profile", lambda req: opened.append(("profile", req)))

    choice = browser_profiles.ProfileChoice(browser="chrome", profile="Profile 1")
    await cloud_login._login_by_window(5.0, choice)

    assert opened == [
        ("profile", browser_profiles.OpenInProfileRequest(browser="chrome", profile="Profile 1", url="https://hub/login"))
    ]


@pytest.mark.asyncio
async def test_login_cancel_without_an_id_stops_the_browser_sign_in(monkeypatch):
    """`POST /login/cancel` pairs with plain `POST /login`; an id still means a correlated session."""
    from flow_sdk.server.routes import cloud

    calls: list = []

    async def _window():
        calls.append("window")

    monkeypatch.setattr(cloud_login, "cancel_window_login", _window)
    monkeypatch.setattr(state, "cancel_cloud_login_session", lambda rid: calls.append(("session", rid)) or True)

    await cloud.login_cancel(oauth_request_id=None)
    assert calls == ["window"]

    await cloud.login_cancel(oauth_request_id="req-1")
    assert calls == ["window", ("session", "req-1")], "a correlated cancel must not touch the browser sign-in"
