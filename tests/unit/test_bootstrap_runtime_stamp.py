"""`runtime` is stamped onto the bootstrap response OUTSIDE the payload cache.

The bootstrap payload is memoized for 30s, but `runtime` belongs to the CALLER,
not to the server: the Electron shell and a localhost browser tab hit the same
instance concurrently and must each get their own answer. If the field were
built with the rest of the payload, whichever client happened to miss the cache
first would define the runtime for everyone else for the next 30 seconds.

These tests drive `_with_runtime` against a pre-seeded cache, so they exercise
the cached path specifically — the one where the bug would live.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from flow_sdk.models.bootstrap_models import BootstrapInfo, RuntimeKind
from flow_sdk.server.routes import bootstrap as bootstrap_route

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def cached_payload():
    """A cached payload as the route stores it: no `runtime` baked in."""
    return BootstrapInfo(records_root="/tmp/records")


@pytest.fixture(autouse=True)
def _no_assignment():
    """No hub assignment, so the electron flag is what decides the kind."""
    from flow_sdk.instance_settings import runtime

    runtime.reset_cache()
    with patch.object(runtime.app_config, "get_config", return_value=None):
        yield
    runtime.reset_cache()


@pytest.mark.asyncio
async def test_same_cached_payload_yields_different_kinds(cached_payload):
    """The whole point: one cached payload, two clients, two answers."""
    shell = await bootstrap_route._with_runtime(cached_payload, True)
    tab = await bootstrap_route._with_runtime(cached_payload, False)

    assert shell.data.runtime.kind == RuntimeKind.DESKTOP
    assert tab.data.runtime.kind == RuntimeKind.BROWSER


@pytest.mark.asyncio
async def test_stamping_does_not_write_through_to_the_cached_object(cached_payload):
    """`model_copy`, not mutation — otherwise the first caller's kind is written
    into the cache and served to the next one.

    Must be awaited: an un-awaited coroutine never runs, so the assertion below
    would hold no matter how the function behaved — a green test proving
    nothing. That is exactly what it did when `_with_runtime` went async.
    """
    await bootstrap_route._with_runtime(cached_payload, True)

    assert cached_payload.runtime is None


@pytest.mark.asyncio
async def test_rest_of_the_payload_still_comes_from_the_cache(cached_payload):
    """Only `runtime` is per-request; nothing else is recomputed or dropped."""
    stamped = (await bootstrap_route._with_runtime(cached_payload, False)).data

    assert stamped.records_root == cached_payload.records_root
    assert stamped.supported_pages == cached_payload.supported_pages


def test_over_http_the_electron_flag_selects_the_kind(cached_payload):
    """End-to-end on the wire: `?electron=true` vs `?electron=false` against a
    warm cache, which is the exact sequence two concurrent clients produce.

    Seeding the cache is what keeps this a unit test — it exercises the route's
    fast path (and FastAPI's query parsing) without running a full bootstrap.
    """
    import time

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(bootstrap_route.router)
    client = TestClient(app)

    with (
        patch.object(bootstrap_route, "_bootstrap_cache", cached_payload),
        patch.object(bootstrap_route, "_bootstrap_cache_ts", time.monotonic()),
    ):
        shell = client.get("/api/v1/graph/bootstrap", params={"electron": "true"}).json()
        tab = client.get("/api/v1/graph/bootstrap", params={"electron": "false"}).json()
        omitted = client.get("/api/v1/graph/bootstrap").json()

    assert shell["data"]["runtime"]["kind"] == RuntimeKind.DESKTOP
    assert tab["data"]["runtime"]["kind"] == RuntimeKind.BROWSER
    # A client that sends nothing is not an Electron shell.
    assert omitted["data"]["runtime"]["kind"] == RuntimeKind.BROWSER


@pytest.mark.asyncio
async def test_hub_assignment_overrides_the_electron_flag(cached_payload):
    """A sandbox launched by the hub reports `sandbox` to every client, whether
    or not that client happens to be an Electron shell."""
    from flow_sdk.instance_settings import runtime

    with patch.object(runtime, "get_assigned_runtime", return_value=RuntimeKind.AGENT):
        shell = await bootstrap_route._with_runtime(cached_payload, True)
        tab = await bootstrap_route._with_runtime(cached_payload, False)
        assert shell.data.runtime.kind == RuntimeKind.AGENT
        assert tab.data.runtime.kind == RuntimeKind.AGENT


_SENTRY = {"dsn": "https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/11", "environment": "staging"}


@pytest.mark.parametrize(
    ("assigned", "electron", "reports"),
    [
        (RuntimeKind.SANDBOX, False, True),
        (RuntimeKind.AGENT, False, False),  # agent boxes stay off for now
        (None, True, False),  # desktop
        (None, False, False),  # local browser tab
    ],
)
@pytest.mark.asyncio
async def test_only_a_sandbox_reports_errors(cached_payload, assigned, electron, reports):
    """`sentry_info` is stamped per request: the stored value on a sandbox, null everywhere else --
    even when a value is stored, so a desktop can never start Sentry."""
    from flow_sdk.instance_settings import runtime, sentry_info
    from flow_sdk.schema.data_spec.sentry_info_spec import SentryInfo

    with (
        patch.object(runtime, "get_assigned_runtime", return_value=assigned),
        patch.object(sentry_info, "get_sentry_info", return_value=SentryInfo(**_SENTRY)),
    ):
        stamped = (await bootstrap_route._with_runtime(cached_payload, electron)).data
    assert (stamped.sentry_info == SentryInfo(**_SENTRY)) is reports
    if not reports:
        assert stamped.sentry_info is None


def test_sentry_info_is_on_the_wire_as_an_explicit_null_and_never_cached(cached_payload):
    """Off is an explicit `null` in the JSON (not a missing key), and a value stored after the
    payload was cached shows up on the very next request -- no 30s wait."""
    import time

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from flow_sdk.instance_settings import runtime, sentry_info
    from flow_sdk.schema.data_spec.sentry_info_spec import SentryInfo

    app = FastAPI()
    app.include_router(bootstrap_route.router)
    client = TestClient(app)
    with (
        patch.object(bootstrap_route, "_bootstrap_cache", cached_payload),
        patch.object(bootstrap_route, "_bootstrap_cache_ts", time.monotonic()),
        patch.object(runtime, "get_assigned_runtime", return_value=RuntimeKind.SANDBOX),
    ):
        with patch.object(sentry_info, "get_sentry_info", return_value=None):
            off = client.get("/api/v1/graph/bootstrap").json()["data"]
        with patch.object(sentry_info, "get_sentry_info", return_value=SentryInfo(**_SENTRY)):
            on = client.get("/api/v1/graph/bootstrap").json()["data"]
    assert "sentry_info" in off and off["sentry_info"] is None
    assert on["sentry_info"] == _SENTRY
