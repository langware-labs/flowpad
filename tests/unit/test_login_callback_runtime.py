"""``/auth/login_callback`` is the hub's only guaranteed channel into a running
sandbox, so it is how the hub tells an instance what it was launched AS.

The security property under test is the same one ``cookie-gate`` has: the label
is applied strictly AFTER the api-key validates. An anonymous caller who can
reach the port must not be able to relabel the instance — a box that paints
itself "Agent" is a box a user may trust differently.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from flow_sdk.models.bootstrap_models import RuntimeKind
from flow_sdk.server.routes import auth as auth_route

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def client():
    """The router on a bare app, driven over HTTP.

    Deliberately not called as a plain coroutine: the handler's unsupplied
    parameters would keep their ``Query(None)`` sentinels, which are truthy, so
    every optional branch would fire with a ``Query`` object in hand. Going
    through the router is also what exercises the ``flowpad-api-key`` alias.
    """
    app = FastAPI()
    app.include_router(auth_route.router)
    return TestClient(app)


@pytest.fixture
def assign_spy():
    """Spy on the single writer, so these tests are about the GATE rather than
    about config.json."""
    with patch("flow_sdk.instance_settings.runtime.set_assigned_runtime") as spy:
        spy.side_effect = lambda kind: RuntimeKind(kind)
        yield spy


@pytest.fixture(autouse=True)
def _secrets_enabled():
    """Skip the Electron keychain-approval redirect branch, which returns before
    any of this and is not what these tests are about."""
    with patch.object(auth_route, "is_secrets_enabled", return_value=True):
        yield


@pytest.fixture
def valid_key():
    """A key the hub would have minted: validation succeeds, login finalizes."""
    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(return_value={"id": "user-1"}),
        ),
        patch("flow_sdk.cli.auth.cloud_login._finalize_login", new=AsyncMock()),
    ):
        yield


@pytest.fixture
def rejected_key():
    """A key that does not validate — the hostile case."""
    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(side_effect=ValueError("bad key")),
        ),
        patch("flow_sdk.cli.auth.cloud_login._broadcast_oauth_error", new=AsyncMock()),
    ):
        yield


def _callback(client, **params):
    return client.get("/auth/login_callback", params=params, follow_redirects=False)


@pytest.mark.parametrize("kind", ["sandbox", "agent"])
def test_valid_key_assigns_the_runtime(client, valid_key, assign_spy, kind):
    _callback(client, **{"flowpad-api-key": "k", "next": "/", "runtime": kind})

    assign_spy.assert_called_once_with(kind)


def test_rejected_key_does_not_assign(client, rejected_key, assign_spy):
    _callback(client, **{"flowpad-api-key": "bad", "next": "/", "runtime": "agent"})

    assign_spy.assert_not_called()


def test_absent_key_does_not_assign(client, rejected_key, assign_spy):
    """No key at all — the route raises before reaching the assignment."""
    _callback(client, **{"next": "/", "runtime": "agent"})

    assign_spy.assert_not_called()


def test_unassignable_runtime_is_dropped_not_fatal(client, valid_key):
    """A login must not fail over a display label: an unassignable value is
    logged and ignored, and the login still completes."""
    with patch("flow_sdk.instance_settings.runtime.set_assigned_runtime", side_effect=ValueError):
        response = _callback(client, **{"flowpad-api-key": "k", "next": "/next", "runtime": "hub"})

    assert response.status_code == 302
    assert response.headers["location"] == "/next"


def test_no_runtime_param_leaves_the_instance_alone(client, valid_key, assign_spy):
    """Every non-sandbox login (the CLI flow, the deep-link flow) omits it."""
    _callback(client, **{"flowpad-api-key": "k", "next": "/"})

    assign_spy.assert_not_called()
