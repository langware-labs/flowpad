"""Deleting a placement leaves nothing running: a remote one is deleted on the hub FIRST, and a local one's
process is stopped.

A remote Deployment's hub row owns the machine (``owns_hub_delete``). If the hub refuses, the local row is
kept — the handle to retry — instead of being dropped while the machine keeps running. The hub is faked at
the client. No network.
"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from flow_sdk.builtin.deployment import KIND_AGENT, Deployment
from flow_sdk.cloud_client.shared.errors import HubError

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval


@pytest.fixture
def hub(monkeypatch):
    """The hub's answer to DELETE, and the paths it was asked for."""
    from flow_sdk.cli.auth import credentials
    from flow_sdk.cloud_client import client

    state = SimpleNamespace(status=200, deleted=[])

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def request(self, method, path, **kwargs):
            state.deleted.append((method, str(path)))
            return httpx.Response(state.status)

    monkeypatch.setattr(credentials, "load_credentials", lambda: SimpleNamespace(api_key="test-key"))
    monkeypatch.setattr(client, "FlowpadClient", _Client)
    return state


async def _placement(*, remote: bool, provider: str = "e2b") -> Deployment:
    row = Deployment(
        name=f"delete-test ({provider})",
        kind=KIND_AGENT,
        parent_type_id="agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d",
        target={"provider": provider, "scope": "machine", "location": "sandbox"},
    )
    row.remote = remote
    await row.save()
    return row


async def test_a_remote_placement_is_deleted_on_the_hub_first(hub):
    row = await _placement(remote=True)

    assert await Deployment.delete_by_id(row.id)

    assert [m for m, _ in hub.deleted] == ["DELETE"] and row.id in hub.deleted[0][1]
    assert await Deployment.get_by_id(row.id) is None


async def test_a_hub_refusal_keeps_the_local_row(hub):
    hub.status = 500
    row = await _placement(remote=True)

    with pytest.raises(HubError) as refused:
        await Deployment.delete_by_id(row.id)

    assert refused.value.status_code == 500
    assert await Deployment.get_by_id(row.id) is not None, "the handle to retry"


async def test_a_placement_already_gone_on_the_hub_is_deleted_here(hub):
    hub.status = 404
    row = await _placement(remote=True)

    assert await Deployment.delete_by_id(row.id)
    assert await Deployment.get_by_id(row.id) is None


async def test_a_local_placement_stops_its_process_and_never_asks_the_hub(hub, monkeypatch):
    from flow_sdk.builtin import deployment_process

    stopped = []
    monkeypatch.setattr(deployment_process, "alive", lambda d: True)
    monkeypatch.setattr(deployment_process, "stop", lambda d: stopped.append(d.id))
    row = await _placement(remote=False, provider="local")

    await row.delete()

    assert stopped == [row.id] and hub.deleted == []
    assert await Deployment.get_by_id(row.id) is None
