"""The desktop's ``deployment/<id>/funding``: the hub's answer, not the deployment row.

Without a local ``funding`` action the bare path fell through to the row itself, so the hub page's
"Funded by" cell (``FundedBy`` reads ``kind``/``name``) printed the deployment's own name.
"""

from __future__ import annotations

from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.hub_proxy import HubProxy

FUNDING = {"kind": "default", "endpoint_typeid": "llm_endpoint-x", "name": "me default", "size": "lg",
           "model": "m", "exhausted": ""}


async def test_funding_is_the_hubs_answer(client, monkeypatch):
    row = Deployment(name="Funded placement (e2b)", remote=True, target={"provider": "e2b", "scope": "machine"})
    await row.save()
    asked = []

    async def hub(method, entity_type, entity_id=None, action=None, *_, **__):
        asked.append((method, entity_type, entity_id, action))
        return FUNDING

    monkeypatch.setattr(HubProxy, "try_call", staticmethod(hub))
    resp = await client.get(f"/api/v1/graph/deployment/{row.id}/funding")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == FUNDING
    assert asked == [("GET", "deployment", row.id, "funding")]
