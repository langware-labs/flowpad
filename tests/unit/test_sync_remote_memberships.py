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
from flow_sdk.cloud_client.transport import hub_http
from flow_sdk.schema.type_info import register_all

register_all()


@pytest.mark.asyncio
async def test_sync_mirrors_hub_organizations_and_teams_missing_locally(monkeypatch):
    org_id, team_id = mint_uuid(), mint_uuid()
    rows = {"organization": [{"id": org_id, "name": "Begin School"}], "team": [{"id": team_id, "name": "AI Course"}]}
    asked = []

    async def fake_hub_get(entity_type, *args, **kwargs):
        asked.append(str(entity_type))
        return {"items": rows[str(entity_type)]}

    monkeypatch.setattr(hub_http, "hub_get", fake_hub_get)
    assert await Organization.get_one({"id": org_id}) is None
    assert await Team.get_one({"id": team_id}) is None

    assert await membership_sync.sync_remote_memberships() == 2

    org = await Organization.get_one({"id": org_id})
    team = await Team.get_one({"id": team_id})
    assert asked == ["organization", "team"]
    assert org is not None and org.remote is True and org.name == "Begin School"
    assert team is not None and team.remote is True and team.name == "AI Course"


@pytest.mark.asyncio
async def test_sync_is_a_no_op_when_the_hub_is_unreachable(monkeypatch):
    async def unreachable(*args, **kwargs):
        return None

    monkeypatch.setattr(hub_http, "hub_get", unreachable)

    assert await membership_sync.sync_remote_memberships() == 0
