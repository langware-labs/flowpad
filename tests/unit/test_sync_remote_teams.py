"""A hub team whose live push was missed is mirrored by the catch-up pull.

The share pickers offer only local ``remote=True`` team rows, and the hub never
replays a membership push — so a team created on the web or while this box was
offline was never offered until ``sync_remote_teams`` pulled it.
"""

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import membership_sync
from flow_sdk.builtin.team import Team
from flow_sdk.cloud_client.transport import hub_http
from flow_sdk.schema.type_info import register_all

register_all()


@pytest.mark.asyncio
async def test_sync_mirrors_hub_teams_missing_locally(monkeypatch):
    team_id = mint_uuid()
    asked = []

    async def fake_hub_get(entity_type, *args, **kwargs):
        asked.append(entity_type)
        return {"items": [{"id": team_id, "name": "AI Course"}]}

    monkeypatch.setattr(hub_http, "hub_get", fake_hub_get)
    assert await Team.get_one({"id": team_id}) is None

    assert await membership_sync.sync_remote_teams() == 1

    team = await Team.get_one({"id": team_id})
    assert asked == ["team"]
    assert team is not None and team.remote is True and team.name == "AI Course"


@pytest.mark.asyncio
async def test_sync_is_a_no_op_when_the_hub_is_unreachable(monkeypatch):
    async def unreachable(*args, **kwargs):
        return None

    monkeypatch.setattr(hub_http, "hub_get", unreachable)

    assert await membership_sync.sync_remote_teams() == 0
