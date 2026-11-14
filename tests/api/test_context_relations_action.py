"""``GET /api/v1/graph/<type>/<id>/context-relations`` — an entity's context, both directions.

One row per peer: what the entity holds (``out``), who holds it (``in``), ``both`` when each
holds the other. Rows carry the peer's name and the time the entry was made.
"""

from __future__ import annotations

import pytest


async def _task(client, title: str) -> dict:
    resp = await client.post("/api/v1/graph/task", json={"title": title})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def _share(client, holder: dict, held: dict, role: str | None = None) -> None:
    body = {"typeid": f"task-{held['id']}", **({"data": {"role": role}} if role else {})}
    resp = await client.post(f"/api/v1/graph/task/{holder['id']}/share-context", json=body)
    assert resp.status_code == 200, resp.text


async def _relations(client, task: dict) -> dict[str, dict]:
    resp = await client.get(f"/api/v1/graph/task/{task['id']}/context-relations")
    assert resp.status_code == 200, resp.text
    return {row["name"]: row for row in resp.json()["data"]}


@pytest.mark.asyncio
async def test_both_directions_with_name_role_and_time(bootstrapped_client):
    hub, held, holder, mutual = [await _task(bootstrapped_client, t) for t in ("rel-hub", "rel-held", "rel-holder", "rel-mutual")]
    await _share(bootstrapped_client, hub, held, role="plan")
    await _share(bootstrapped_client, holder, hub)
    await _share(bootstrapped_client, hub, mutual)
    await _share(bootstrapped_client, mutual, hub)

    rows = await _relations(bootstrapped_client, hub)
    assert {name: row["direction"] for name, row in rows.items() if name in ("rel-held", "rel-holder", "rel-mutual")} == {
        "rel-held": "out", "rel-holder": "in", "rel-mutual": "both",
    }
    assert rows["rel-held"]["role"] == "plan" and rows["rel-held"]["kind"] == "shared"
    assert rows["rel-held"]["typeid"] == f"task-{held['id']}" and rows["rel-held"]["type"] == "task"
    assert all(row["time"] for row in rows.values())
    # Newest first: the mutual entry was made last.
    assert next(iter(rows)) == "rel-mutual"

    # The other side sees the same entry from its end.
    assert (await _relations(bootstrapped_client, held))["rel-hub"]["direction"] == "in"
