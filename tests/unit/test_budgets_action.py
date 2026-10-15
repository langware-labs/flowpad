"""``organization/<id>/budgets`` on the desktop: it reaches the hub, and a hub refusal reaches the screen.

Before ``budgets`` was registered locally, the path parser dropped the unknown segment and
dispatched the request as a plain ``read``: it was reflected to the hub as ``/read`` and
answered 200 with the ORGANIZATION — so People & teams showed "could not be read" to the
owner, and a member's 403 never arrived to become the read-only card. And even once
reflected, a GET swallowed any hub failure into a local read, so the refusal was lost there
too.

Real request middleware + graph dispatcher; the hub is a stub.
"""

from __future__ import annotations

import pytest

import flow_sdk.server.routes._hub_reflect as reflect_mod
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.membership_sync import materialize_remote_organization
from flow_sdk.utils.hub import HubError
from tests.unit._graph_client import call_local

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

REFLECT = {"Hub-Reflect": "true"}


@pytest.fixture()
async def org(monkeypatch):
    monkeypatch.setattr(reflect_mod, "is_logged_in", lambda: True)
    return await materialize_remote_organization({"id": mint_uuid(), "name": "Begin School"}, notify=False)


@pytest.mark.asyncio
async def test_budgets_reaches_the_hub_as_budgets(monkeypatch, org):
    asked = []

    async def hub(entity_type, entity_id=None, action=None, sub_path=None, **kwargs):
        asked.append((str(entity_type), entity_id, action))
        return {"org": {"id": entity_id, "name": "Begin School"}, "teams": [], "people": []}

    monkeypatch.setattr(reflect_mod, "hub_get_or_raise", hub)

    resp = await call_local("GET", f"organization/{org.id}/budgets", headers=REFLECT)

    assert resp.status_code == 200, resp.text
    assert asked == [("organization", org.id, "budgets")]
    assert resp.json()["data"]["org"]["name"] == "Begin School"


@pytest.mark.asyncio
async def test_a_hub_refusal_reaches_the_caller(monkeypatch, org):
    async def refused(*args, **kwargs):
        raise HubError(403, "not an admin here")

    monkeypatch.setattr(reflect_mod, "hub_get_or_raise", refused)

    resp = await call_local("GET", f"organization/{org.id}/budgets", headers=REFLECT)

    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_an_outage_falls_through_to_the_local_refusal(monkeypatch, org):
    async def offline(*args, **kwargs):
        raise HubError(0, "connection refused")

    monkeypatch.setattr(reflect_mod, "hub_get_or_raise", offline)

    resp = await call_local("GET", f"organization/{org.id}/budgets", headers=REFLECT)

    assert resp.status_code == 409, resp.text
    assert "require Flowpad Cloud" in resp.text
