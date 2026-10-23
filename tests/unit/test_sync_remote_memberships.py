"""A hub organization or team whose live push was missed is mirrored by the catch-up pull.

The surfaces that read local ``remote=True`` rows only (the share pickers, People & teams)
never saw an organization or team created on the web or while this box was offline, because
the hub never replays a membership push — until ``sync_remote_memberships`` pulled it.
"""

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import membership_sync
from flow_sdk.builtin.organization import Organization
from flow_sdk.builtin.team import Team
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.schema.type_info import register_all

register_all()


@pytest.mark.asyncio
async def test_sync_mirrors_hub_organizations_and_teams_missing_locally(monkeypatch):
    org_id, team_id = mint_uuid(), mint_uuid()
    rows = {"organization": [{"id": org_id, "name": "Begin School"}], "team": [{"id": team_id, "name": "AI Course"}]}
    asked = []

    async def fake_hub_get(_method, entity_type, *args, **kwargs):
        asked.append(str(entity_type))
        return {"items": rows[str(entity_type)]}

    monkeypatch.setattr(HubProxy, "call", staticmethod(fake_hub_get))
    assert await Organization.get_one({"id": org_id}) is None
    assert await Team.get_one({"id": team_id}) is None

    assert await membership_sync.sync_remote_memberships() == 2

    org = await Organization.get_one({"id": org_id})
    team = await Team.get_one({"id": team_id})
    assert asked == ["organization", "team"]
    assert org is not None and org.remote is True and org.name == "Begin School"
    assert team is not None and team.remote is True and team.name == "AI Course"


@pytest.mark.asyncio
async def test_an_unreachable_hub_keeps_every_local_row(monkeypatch):
    kept = Organization(id=mint_uuid(), name="Still mine", remote=True)
    await kept.save()

    async def unreachable(*args, **kwargs):
        raise HubError(0, "unreachable")

    monkeypatch.setattr(HubProxy, "call", staticmethod(unreachable))

    assert await membership_sync.sync_remote_memberships() == 0
    assert await Organization.get_one({"id": kept.id}) is not None


@pytest.mark.asyncio
async def test_an_organization_the_hub_no_longer_lists_is_dropped(monkeypatch):
    """Removed from an organization (no one pushes that): the next sync drops the local row,
    and keeps the ones the hub still lists and the local-only ones."""
    stays, removed = mint_uuid(), mint_uuid()
    for org_id, name in ((stays, "Still in"), (removed, "Removed from")):
        await Organization(id=org_id, name=name, remote=True).save()
    local_only = Organization(id=mint_uuid(), name="Never shared", remote=False)
    await local_only.save()

    async def hub_lists(_method, entity_type, *args, **kwargs):
        return {"items": [{"id": stays, "name": "Still in"}]} if str(entity_type) == "organization" else {"items": []}

    monkeypatch.setattr(HubProxy, "call", staticmethod(hub_lists))

    await membership_sync.sync_remote_memberships()
    assert await Organization.get_one({"id": stays}) is not None
    assert await Organization.get_one({"id": removed}) is None
    assert await Organization.get_one({"id": local_only.id}) is not None
