"""A hub organization or team whose live push was missed is mirrored by the catch-up pull.

The surfaces that read local ``remote=True`` rows only (the share pickers, People & teams)
never saw an organization or team created on the web or while this box was offline, because
the hub never replays a membership push — until ``sync_remote_memberships`` pulled it.

The hub pages every list, so the pull walks it (``HubProxy.walk``), and a row is dropped for its
absence ONLY after a complete walk: a failed or cut-short walk never saw the rows it is missing.

Real echo hub (tests/unit/hub_proxy), real local DB — nothing patched.
"""

import json
from urllib.parse import parse_qs

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import membership_sync
from flow_sdk.builtin.organization import Organization
from flow_sdk.builtin.team import Team
from flow_sdk.schema.type_info import register_all

register_all()

pytestmark = [pytest.mark.asyncio]

ORGS = "/api/v1/graph/organization"
TEAMS = "/api/v1/graph/team"


async def test_sync_mirrors_hub_organizations_and_teams_missing_locally(echo_hub, signed_in):
    org_id, team_id = mint_uuid(), mint_uuid()
    echo_hub.paged[ORGS] = [{"id": org_id, "name": "Begin School"}]
    echo_hub.paged[TEAMS] = [{"id": team_id, "name": "AI Course"}]
    assert await Organization.get_one({"id": org_id}) is None
    assert await Team.get_one({"id": team_id}) is None

    assert await membership_sync.sync_remote_memberships() == 2

    org = await Organization.get_one({"id": org_id})
    team = await Team.get_one({"id": team_id})
    assert [r.raw_path for r in echo_hub.received] == [ORGS, TEAMS]
    # The paging rides inside ``filter`` (a plain ?limit is refused by the hub).
    for rec in echo_hub.received:
        query = parse_qs(rec.query)
        assert set(query) == {"filter"}
        assert json.loads(query["filter"][0])["limit"] == 200
    assert org is not None and org.remote is True and org.name == "Begin School"
    assert team is not None and team.remote is True and team.name == "AI Course"


async def test_an_unreachable_hub_keeps_every_local_row(echo_hub, signed_in):
    kept = Organization(id=mint_uuid(), name="Still mine", remote=True)
    await kept.save()
    echo_hub.paged[ORGS] = []
    echo_hub.paged[TEAMS] = []
    echo_hub.paged_fail_at.update({ORGS: 0, TEAMS: 0})

    assert await membership_sync.sync_remote_memberships() == 0
    assert await Organization.get_one({"id": kept.id}) is not None


async def test_an_organization_the_hub_no_longer_lists_is_dropped(echo_hub, signed_in):
    """Removed from an organization (no one pushes that): the next sync drops the local row,
    and keeps the ones the hub still lists and the local-only ones — but only after the walk
    reached the end of the list. A walk cut short, by a failing page, drops nothing."""
    stays, removed = mint_uuid(), mint_uuid()
    for org_id, name in ((stays, "Still in"), (removed, "Removed from")):
        await Organization(id=org_id, name=name, remote=True).save()
    local_only = Organization(id=mint_uuid(), name="Never shared", remote=False)
    await local_only.save()
    # 250 listed organizations: two pages. The second page fails — the walk is cut short.
    filler = [{"id": mint_uuid(), "name": f"Org {i}"} for i in range(249)]
    echo_hub.paged[ORGS] = [{"id": stays, "name": "Still in"}, *filler]
    echo_hub.paged[TEAMS] = []
    echo_hub.paged_fail_at[ORGS] = 200

    await membership_sync.sync_remote_memberships()
    assert await Organization.get_one({"id": removed}) is not None, "a truncated walk deleted a row"
    assert await Organization.get_one({"id": stays}) is not None

    # The hub answers the whole list now: the walk completes and the removed row goes.
    del echo_hub.paged_fail_at[ORGS]
    await membership_sync.sync_remote_memberships()
    assert len([r for r in echo_hub.received if r.raw_path == ORGS]) == 4  # 2 + 2 pages
    assert await Organization.get_one({"id": stays}) is not None
    assert await Organization.get_one({"id": removed}) is None
    assert await Organization.get_one({"id": local_only.id}) is not None
    assert await Organization.get_one({"id": filler[-1]["id"]}) is not None  # the second page was mirrored
