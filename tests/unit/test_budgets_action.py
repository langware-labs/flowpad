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

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

REFLECT = {"Hub-Reflect": "true"}


@pytest.fixture()
async def org(monkeypatch):
    monkeypatch.setattr(reflect_mod, "is_logged_in", lambda: True)
    return await materialize_remote_organization({"id": mint_uuid(), "name": "Begin School"}, notify=False)
