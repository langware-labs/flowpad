"""The sandbox's browser error-reporting config: validated, pulled from the hub, fresh or off.

The value only ever comes from the hub (``HubProxy``); the ``@local`` action is a trigger that
never reads a body. A value the hub stops vouching for goes stale and turns off.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.instance_settings import sentry_info as box
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind
from flow_sdk.schema.data_spec.sentry_info_spec import SentryInfo, parse_sentry_info

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DSN_A = "https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/11"
DSN_B = "https://fedcba9876543210fedcba9876543210@o1.ingest.us.sentry.io/22"
A = {"dsn": DSN_A, "environment": "staging"}
B = {"dsn": DSN_B, "environment": "production"}


@pytest.fixture(autouse=True)
def instance(monkeypatch: pytest.MonkeyPatch, tmp_path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "sentryinfotest")
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    box.reset_cache()
    yield
    box.reset_cache()
    reset_instance_settings()


@pytest.fixture
def announced(monkeypatch: pytest.MonkeyPatch):
    """Every (invalidate + broadcast) the module makes, as the value it announced."""
    calls: list = []

    async def _spy(info):
        calls.append(info.model_dump() if info else None)

    monkeypatch.setattr(box, "_announce", _spy)
    return calls


def _hub(answer):
    """Stand in for ``HubProxy.call``: a dict is the hub's ``data``, an exception is raised."""

    async def _call(*_args, **_kwargs):
        if isinstance(answer, BaseException):
            raise answer
        return answer

    return patch("flow_sdk.cloud_client.hub_proxy.HubProxy.call", side_effect=_call)


# ── the schema ─────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw",
    [
        {"dsn": "http://0123456789abcdef0123456789abcdef@o1.sentry.io/1", "environment": "staging"},
        {"dsn": "https://key:secret@o1.sentry.io/1", "environment": "staging"},  # legacy secret DSN
        {"dsn": DSN_A + "?x=1", "environment": "staging"},
        {"dsn": DSN_A, "environment": "local"},
        {"dsn": DSN_A + "\n", "environment": "staging"},  # a trailing newline must not slip past `$`
        {"dsn": DSN_A.replace("/11", "/\u0661\u0662"), "environment": "staging"},  # non-ASCII digits
        {"dsn": DSN_A, "environment": "qa"},  # an environment this wheel does not know
        {"environment": "staging"},  # no dsn
        "not a dict",
    ],
)
def test_invalid_values_read_as_off_and_never_raise(raw):
    assert parse_sentry_info(raw) is None


def test_fields_a_newer_hub_adds_are_ignored_not_fatal():
    """The hub's answer is a FOREIGN dict: only `dsn` and `environment` are read, so a later hub that
    adds a field cannot switch Sentry off on every box still running this wheel."""
    answer = {**A, "release": "0.2.300", "sample_rate": 0.5}
    assert parse_sentry_info(answer) == SentryInfo(**A)


def test_a_public_dsn_is_accepted():
    assert parse_sentry_info(A) == SentryInfo(**A)


# ── pulling from the hub ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_value_from_the_hub_is_stored_and_announced_once(announced):
    with _hub({"sentry_info": A}):
        assert await box.sync_sentry_info_from_hub() == box.SyncOutcome.UPDATED
        assert await box.sync_sentry_info_from_hub() == box.SyncOutcome.UNCHANGED
    assert box.get_sentry_info() == SentryInfo(**A)
    assert announced == [A]


@pytest.mark.asyncio
async def test_a_changed_dsn_replaces_the_old_one(announced):
    with _hub({"sentry_info": A}):
        await box.sync_sentry_info_from_hub()
    with _hub({"sentry_info": B}):
        assert await box.sync_sentry_info_from_hub() == box.SyncOutcome.UPDATED
    assert box.get_sentry_info() == SentryInfo(**B)
    assert announced == [A, B]


@pytest.mark.parametrize(
    ("answer", "outcome"),
    [
        ({"sentry_info": None}, box.SyncOutcome.CLEARED),
        ({"sentry_info": {"dsn": "https://key:secret@x/1", "environment": "staging"}}, box.SyncOutcome.CLEARED),
        # The real answer of a hub without the action (measured on a release/v0.29 hub): 422, for anyone.
        (
            HubError(
                422,
                "Unknown resource type or action: sentry-info for /api/v1/graph/compute_node/sentry-info",
                kind=HubFailureKind.REJECTED,
            ),
            box.SyncOutcome.UNSUPPORTED,
        ),
        (HubError(404, "not found", kind=HubFailureKind.REJECTED), box.SyncOutcome.UNSUPPORTED),
    ],
)
@pytest.mark.asyncio
async def test_an_authoritative_no_turns_it_off(announced, answer, outcome):
    with _hub({"sentry_info": A}):
        await box.sync_sentry_info_from_hub()
    with _hub(answer):
        assert await box.sync_sentry_info_from_hub() == outcome
    assert box.get_sentry_info() is None
    assert announced == [A, None]


@pytest.mark.parametrize(
    ("error", "outcome"),
    [
        (HubError(0, "offline", kind=HubFailureKind.OFFLINE), box.SyncOutcome.KEPT),
        (HubError(503, "down", kind=HubFailureKind.SERVER_ERROR), box.SyncOutcome.KEPT),
        (HubError(0, "no hub", kind=HubFailureKind.NOT_CONFIGURED), box.SyncOutcome.KEPT),
        (HubError(0, "signed out", kind=HubFailureKind.SIGNED_OUT), box.SyncOutcome.SIGNED_OUT),
        # A refusal that is not "no such action" says nothing about the hub's support: a policy
        # change, a gateway rule, an agent key ("sign in first") must not switch a good value off.
        (HubError(400, "Invalid request", kind=HubFailureKind.REJECTED), box.SyncOutcome.KEPT),
        (HubError(401, "sign in first", kind=HubFailureKind.REJECTED), box.SyncOutcome.KEPT),
        (HubError(403, "Forbidden access", kind=HubFailureKind.REJECTED), box.SyncOutcome.KEPT),
    ],
)
@pytest.mark.asyncio
async def test_no_answer_keeps_the_value_and_does_not_renew_it(announced, error, outcome):
    with _hub({"sentry_info": A}):
        await box.sync_sentry_info_from_hub()
    _, confirmed_at = box._read()
    with _hub(error):
        assert await box.sync_sentry_info_from_hub() == outcome
    assert box.get_sentry_info() == SentryInfo(**A)
    assert box._read()[1] == confirmed_at
    assert announced == [A]


@pytest.mark.asyncio
async def test_local_privacy_mode_never_asks_the_hub(announced):
    with (
        patch("flow_sdk.instance_settings.privacy_mode.is_local_mode", return_value=True),
        _hub({"sentry_info": A}) as call,
    ):
        assert await box.sync_sentry_info_from_hub() == box.SyncOutcome.PRIVACY_LOCAL
    call.assert_not_called()


@pytest.mark.asyncio
async def test_concurrent_triggers_share_one_hub_read(announced):
    gate = asyncio.Event()

    async def _slow(*_a, **_k):
        await gate.wait()
        return {"sentry_info": A}

    with patch("flow_sdk.cloud_client.hub_proxy.HubProxy.call", side_effect=_slow) as call:
        runs = [asyncio.ensure_future(box.sync_sentry_info_from_hub()) for _ in range(3)]
        await asyncio.sleep(0)
        gate.set()
        outcomes = await asyncio.gather(*runs)
    assert call.call_count == 1
    assert set(outcomes) == {box.SyncOutcome.UPDATED}


@pytest.mark.asyncio
async def test_an_unexpected_failure_never_reaches_the_caller(announced):
    with _hub(RuntimeError("boom")):
        assert await box.sync_sentry_info_from_hub() == box.SyncOutcome.KEPT


# ── freshness ──────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_value_the_hub_stopped_vouching_for_goes_stale_then_comes_back(announced):
    with _hub({"sentry_info": A}):
        await box.sync_sentry_info_from_hub()
    later = time.time() + box.MAX_STALENESS_SECONDS + 60
    with patch.object(box.time, "time", return_value=later):
        assert box.get_sentry_info() is None
        assert box.sentry_info_status().expired is True
        with _hub({"sentry_info": A}):
            # Re-confirmed after going stale: on again, and the clients are told.
            assert await box.sync_sentry_info_from_hub() == box.SyncOutcome.UPDATED
        assert box.get_sentry_info() == SentryInfo(**A)
    assert announced == [A, A]


def test_a_corrupt_record_reads_as_off():
    from flow_sdk.cli import app_config

    app_config.set_config(box._CONFIG_KEY, {"value": {"dsn": 3}, "synced_at": "yesterday"})
    assert box.get_sentry_info() is None


# ── the @local action: a trigger, never a write ───────────────────────────────────────


def _request(method: str, sub_path: str, body: dict | None = None):
    return SimpleNamespace(
        request=SimpleNamespace(method=method),
        sub_path=sub_path,
        get_post_data=AsyncMock(return_value=body or {}),
    )


async def _call_action(method: str, sub_path: str, body: dict | None = None):
    from flow_sdk.builtin.faas import compute_node as module

    with patch.object(module, "get_current_request_info", return_value=_request(method, sub_path, body)):
        return await module.ComputeNode._sentry_info_action(None)


@pytest.mark.asyncio
async def test_a_caller_cannot_set_the_dsn_through_the_action(announced):
    """The body is never read: whatever a browser or a worker sends, the stored value is the hub's."""
    evil = {"sentry_info": {"dsn": DSN_B, "environment": "production"}, "dsn": DSN_B}
    with _hub({"sentry_info": A}):
        response = await _call_action("POST", "sync", evil)
    assert response.data["outcome"] == "updated"
    assert box.get_sentry_info() == SentryInfo(**A)


@pytest.mark.parametrize(("method", "sub_path"), [("POST", ""), ("POST", "set"), ("PUT", ""), ("DELETE", "")])
@pytest.mark.asyncio
async def test_anything_but_get_and_sync_is_refused_and_stores_nothing(announced, method, sub_path):
    with _hub({"sentry_info": A}) as call:
        response = await _call_action(method, sub_path, A)
    assert response.status != "success"
    call.assert_not_called()
    assert box.get_sentry_info() is None


@pytest.mark.asyncio
async def test_a_newer_hub_answer_with_extra_fields_still_syncs(announced):
    with _hub({"sentry_info": {**A, "release": "0.2.300"}, "something_else": True}):
        assert await box.sync_sentry_info_from_hub() == box.SyncOutcome.UPDATED
    assert box.get_sentry_info() == SentryInfo(**A)


def test_the_ws_frame_and_the_action_results_are_typed_values_with_the_shape_the_ui_reads():
    import json

    from flow_sdk.api.messages import SentryInfoMessage
    from flow_sdk.schema.data_spec.sentry_info_spec import SentryInfoStatus, SentryInfoSyncResult

    frame = json.loads(SentryInfoMessage(sentry_info=SentryInfo(**A)).model_dump_json())
    assert frame["message_type"] == "sentry_info_msg"
    assert frame["sentry_info"] == A
    assert json.loads(SentryInfoMessage().model_dump_json())["sentry_info"] is None

    status = SentryInfoStatus(sentry_info=SentryInfo(**A), synced_at="2026-11-16T10:00:00+00:00")
    assert status.model_dump(mode="json") == {
        "sentry_info": A,
        "synced_at": "2026-11-16T10:00:00+00:00",
        "expired": False,
    }
    result = SentryInfoSyncResult(outcome="updated", **status.model_dump())
    assert result.model_dump(mode="json")["outcome"] == "updated"
