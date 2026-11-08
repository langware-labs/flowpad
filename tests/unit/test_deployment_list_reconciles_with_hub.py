"""The Deployments list is local + the hub's, like the conversation list: the hub's list is read in the
background, a placement made elsewhere is adopted, and one the hub no longer has is dropped — only when the
hub sent the whole list, and never this computer's own. The hub is faked at ``HubProxy.walk``. No network.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from flow_sdk._compat import UTC
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.hub_proxy import HubProxy, HubWalk

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval

AGENT = "agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d"
E2B = {"provider": "e2b", "scope": "machine", "location": "sandbox"}


@pytest.fixture
def hub(monkeypatch):
    from flow_sdk.cli.auth import hub_login
    from flow_sdk.cloud_client.transport import hub_http

    walk = HubWalk(complete=True)
    monkeypatch.setattr(hub_http, "hub_base_url", lambda: "http://hub.test")
    monkeypatch.setattr(hub_login, "hub_auth_available", lambda: True)

    async def fake_walk(entity_type, **kwargs):
        assert kwargs["match"] == {"parent_type_id": AGENT}
        return walk

    monkeypatch.setattr(HubProxy, "walk", staticmethod(fake_walk))
    return walk


async def _row(*, remote: bool, target=E2B) -> Deployment:
    row = Deployment(name="here", parent_type_id=AGENT, target=target)
    row.remote = remote
    await row.save()
    return row


async def test_a_placement_made_elsewhere_is_adopted_and_announced(hub, monkeypatch):
    announced = []
    monkeypatch.setattr(Deployment, "announce_synced", staticmethod(announced.append))
    made = Deployment(name="elsewhere", parent_type_id=AGENT, target=E2B).model_dump(mode="json")
    hub.rows = [made]

    assert await Deployment.reconcile_with_hub(AGENT)
    adopted = await Deployment.get_by_id(made["id"])
    assert adopted is not None and adopted.remote
    assert announced == [AGENT]


async def test_a_newer_hub_row_refreshes_and_an_echo_does_not(hub):
    row = await _row(remote=True)
    hub.rows = [{**row.model_dump(mode="json"), "name": "renamed",
                 "updated_date": (datetime.now(UTC) + timedelta(minutes=1)).isoformat()}]
    assert await Deployment.reconcile_with_hub(AGENT)
    assert (await Deployment.get_by_id(row.id)).name == "renamed"

    hub.rows = [(await Deployment.get_by_id(row.id)).model_dump(mode="json")]
    assert not await Deployment.reconcile_with_hub(AGENT), "an echo is no change"


async def test_gone_on_the_hub_is_dropped_only_on_a_whole_list(hub):
    gone = await _row(remote=True)
    mine = await _row(remote=False, target={"provider": "local", "scope": "machine", "location": "here"})

    hub.complete = False
    assert not await Deployment.reconcile_with_hub(AGENT)
    assert await Deployment.get_by_id(gone.id) is not None, "a partial list never saw it"

    hub.complete = True
    assert await Deployment.reconcile_with_hub(AGENT)
    assert await Deployment.get_by_id(gone.id) is None
    assert await Deployment.get_by_id(mine.id) is not None, "this computer's placement is not the hub's"
