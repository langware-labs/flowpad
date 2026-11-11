"""Deleting a hub-shared child (a team under an organization) from the desktop.

The delete removes the hub row first (``unshare``), and the hub's ``child_deleted`` fan-out can
drop the local mirror before the local delete reaches it. The row this request set out to delete
is gone — that is success. It used to answer 403 "Delete entity failed", so People & teams told
the admin a team they had just deleted could not be deleted.

Real request middleware + graph dispatcher; only the hub call is replaced.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.membership_sync import materialize_remote_membership_entity
from flow_sdk.builtin.team import Team
from tests.unit._graph_client import call_local

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _remote_team() -> Team:
    org_id = mint_uuid()
    team = await materialize_remote_membership_entity(Team, {"id": mint_uuid(), "name": "Grade 7"}, notify=False)
    team.parent_type_id = f"organization-{org_id}"
    await team.save(notify=False)
    return team


@pytest.mark.asyncio
async def test_a_child_whose_mirror_the_hub_removed_first_is_reported_deleted(monkeypatch):
    team = await _remote_team()

    async def unshare_and_fan_out(self, recursive=False):
        # The hub deletes its row and its child_deleted push removes ours.
        await Team.delete_by_id(self.id)

    monkeypatch.setattr(Team, "unshare", unshare_and_fan_out)

    resp = await call_local("DELETE", f"team/{team.id}")

    assert resp.status_code == 200, resp.text
    assert await Team.get_one({"id": team.id}) is None


@pytest.mark.asyncio
async def test_a_plain_delete_of_a_shared_child_still_removes_it(monkeypatch):
    team = await _remote_team()

    async def unshare_only(self, recursive=False):
        return None

    monkeypatch.setattr(Team, "unshare", unshare_only)

    resp = await call_local("DELETE", f"team/{team.id}")

    assert resp.status_code == 200, resp.text
    assert await Team.get_one({"id": team.id}) is None


@pytest.mark.asyncio
async def test_deleting_an_organization_deletes_it_on_the_hub(monkeypatch):
    """A top-level org has no parent, so the child auto-unshare never ran: the local row went
    and the hub row stayed — the next listing brought the "deleted" org back."""
    from flow_sdk.builtin.organization import Organization  # noqa: PLC0415

    org = await materialize_remote_membership_entity(Organization, {"id": mint_uuid(), "name": "Gone"}, notify=False)
    asked = []

    async def fake_unshare(self, recursive=False):
        asked.append(self.id)

    monkeypatch.setattr(Organization, "unshare", fake_unshare)

    resp = await call_local("DELETE", f"organization/{org.id}")

    assert resp.status_code == 200, resp.text
    assert asked == [org.id]
    assert await Organization.get_one({"id": org.id}) is None
