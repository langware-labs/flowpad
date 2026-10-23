"""Fixtures for the HubProxy suite: a real echo hub and a real desktop server, no mocks.

``echo_hub``  — a real uvicorn echo hub (session).
``desktop``   — the real desktop graph server (middleware + graph router + WS router), pointed
               at the echo hub and signed in through the production ``login_as`` funnel.
"""

from __future__ import annotations

import contextvars
import uuid

import httpx
import pytest

from tests.unit.hub_proxy._servers import EchoHub, ThreadedServer, build_desktop_app

# The current test's tag. The test's own HTTP client stamps it on every request (only in the
# test's context); the desktop forwards it to the hub verbatim; stray requests from background
# tasks other tests left running carry none — so ``echo_hub.received`` is this test's alone.
_TAG: contextvars.ContextVar[str | None] = contextvars.ContextVar("echo_tag", default=None)
_build_request = httpx.AsyncClient.build_request


def _tagged_build_request(self, method, url, **kwargs):
    request = _build_request(self, method, url, **kwargs)
    tag = _TAG.get()
    if tag and "x-echo-tag" not in request.headers:
        request.headers["x-echo-tag"] = tag
    return request

pytestmark = pytest.mark.timeout(60)

ECHO_TOKEN = "echo-hub-token-0001"
ECHO_USER = {"id": "11111111-2222-4333-8444-555555555555", "email": "proxy-tester@local.test", "name": "Proxy Tester"}


@pytest.fixture(scope="session")
def echo_app() -> EchoHub:
    return EchoHub()


@pytest.fixture(scope="session")
def echo_server(echo_app):
    server = ThreadedServer(echo_app).start()
    yield server
    server.stop()


@pytest.fixture(scope="session")
def desktop_server():
    server = ThreadedServer(build_desktop_app()).start()
    yield server
    server.stop()


# Between tests the hub address must never fall back to the one inherited from the shell
# (``FLOWPAD_HUB_URL`` — often the REAL hub): background work still running across a test
# boundary (an outbox drain the offline tests set off) would send this suite's credentials there,
# and its "unauthenticated" answer signs the next test out. Nothing listens on port 9.
DEAD_HUB = "http://127.0.0.1:9"


@pytest.fixture(scope="package", autouse=True)
def _no_real_hub_in_this_suite():
    from flow_sdk.config import default_service_config

    inherited = default_service_config.flowpad_hub_url
    default_service_config.flowpad_hub_url = DEAD_HUB
    yield
    default_service_config.flowpad_hub_url = inherited


@pytest.fixture
def echo_hub(echo_app, echo_server, monkeypatch):
    """The echo hub, configured as this box's hub, its request log cleared."""
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", echo_server.url)
    monkeypatch.setattr(httpx.AsyncClient, "build_request", _tagged_build_request)
    tag = uuid.uuid4().hex
    token = _TAG.set(tag)
    echo_app.tag = tag
    echo_app.all_received.clear()
    echo_app.sse_closed.clear()
    echo_app.scripted.clear()
    yield echo_app
    _TAG.reset(token)
    echo_app.tag = None


@pytest.fixture
def signed_in(sod_env, echo_hub):
    """Signed in to the echo hub the way production signs in (token + user record)."""
    from tests.hub_tests._local_login import login_as

    login_as({"token": ECHO_TOKEN, "user": ECHO_USER})
    return ECHO_TOKEN


@pytest.fixture
def desktop(desktop_server, signed_in) -> str:
    """Base URL of the desktop server, signed in, hub = echo hub."""
    return desktop_server.url
