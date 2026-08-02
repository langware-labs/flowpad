"""Hub integration: a shared skill is an owned hub node on both users' world map.

Runs against a real local hub (skipped by ``conftest`` when none is reachable).
Validates the graph-level contract that durable asset sharing relies on:

  * creating a ``skill`` mints ``creator ─[ROLE owner]→ skill`` (the hub's
    owner-on-create), and the skill shows on the creator's access-scoped
    ``org_graph`` world map;
  * a second user has NO path to the skill until they are invited — the skill is
    absent from their world map (access-scoped, not "see everything");
  * inviting them with a ``reader`` target on the skill immediately mints
    ``user ─[ROLE reader]→ skill`` so the skill appears on THEIR world map too,
    and ``GET /graph/skill/<id>/members`` lists them as a reader.

This mirrors ``test_org_login_and_invite``'s immediate-assignment flow, swapping the
org/team target for a ``skill`` asset and adding the world-map assertions. The
full share-through-a-conversation path is covered by the browser validation.
"""

from __future__ import annotations

import time

import httpx
import pytest

from tests.hub_tests._assignment import assert_auto_assigned
from tests.hub_tests.test_members_basic_operations import _alice_and_bob
from tests.hub_tests.test_org_login_and_invite import _invite


async def _create_skill(hub_base_url: str, token: str, name: str) -> str:
    """Create a ``skill`` on the hub as ``token``'s user; return its id.

    The creator gets the owner role (hub owner-on-create). Skips cleanly when
    the hub doesn't know the ``skill`` type yet (an un-updated hub), so this
    file is a no-op rather than a hard failure before the hub is redeployed.
    """
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/skill",
            headers=headers,
            json={"name": name},
        )
    if r.status_code == 404:
        pytest.skip("hub does not expose POST /graph/skill")
    if r.status_code == 400 and "unknown entity type" in r.text.lower():
        pytest.skip("hub has no 'skill' type registered yet (needs redeploy)")
    assert r.status_code == 200, r.text
    data = r.json().get("data") or {}
    skill_id = data.get("id") if isinstance(data, dict) else None
    assert skill_id, f"create skill returned no id: {r.text[:300]}"
    return skill_id


async def _org_graph(hub_base_url: str, token: str) -> dict:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/org_graph", headers=headers)
    assert r.status_code == 200, r.text
    return r.json().get("data") or {}


def _has_node(graph: dict, type_: str, id_: str) -> bool:
    return any(
        isinstance(n, dict) and n.get("type") == type_ and str(n.get("id")) == str(id_)
        for n in (graph.get("nodes") or [])
    )


def _edge_kind(graph: dict, src_id: str, dst_type: str, dst_id: str) -> str | None:
    """Role on the edge from ``src_id`` to the ``(dst_type, dst_id)`` node, if any."""
    for e in graph.get("edges") or []:
        if not isinstance(e, dict):
            continue
        frm, to = e.get("from") or {}, e.get("to") or {}
        if str(frm.get("id")) == str(src_id) and to.get("type") == dst_type and str(to.get("id")) == str(dst_id):
            return e.get("kind")
    return None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_shared_skill_on_world_map_of_owner_and_reader(hub_base_url, hub_login_payload, isolated_hub_keyring):
    """alice creates a skill → it's on her map as owner; bob can't see it until he
    receives a ``reader`` assignment, then it's on his map as reader too."""
    actors = await _alice_and_bob(hub_base_url, hub_login_payload)
    alice_token = actors["alice_token"]
    alice_id = actors["alice_id"]
    bob_token = actors["bob_token"]
    bob_id = actors["bob_id"]
    bob_email = actors["bob_email"]

    skill_id = await _create_skill(hub_base_url, alice_token, f"share-skill-{int(time.time())}")

    # Owner: the skill is on alice's world map with an owner edge from alice.
    alice_graph = await _org_graph(hub_base_url, alice_token)
    assert _has_node(alice_graph, "skill", skill_id), "skill missing from owner's world map"
    assert _edge_kind(alice_graph, alice_id, "skill", skill_id) == "owner", (
        f"owner edge missing/wrong on alice's map: {alice_graph.get('edges')}"
    )

    # Access-scoped: bob has no path to the skill yet → absent from his map.
    bob_graph_before = await _org_graph(hub_base_url, bob_token)
    assert not _has_node(bob_graph_before, "skill", skill_id), (
        "skill leaked onto a non-member's world map before any grant"
    )

    # Grant bob a durable reader edge on the skill (the asset target an invite
    # carries alongside the conversation member target).
    await _invite(hub_base_url, alice_token, "skill", skill_id, bob_email, role="reader")
    await assert_auto_assigned(
        hub_base_url,
        bob_token,
        entity_type="skill",
        entity_id=skill_id,
        user_id=bob_id,
        expected_role="reader",
        members_token=alice_token,
    )

    # Reader: the skill is now on bob's world map with a reader edge from bob.
    bob_graph_after = await _org_graph(hub_base_url, bob_token)
    assert _has_node(bob_graph_after, "skill", skill_id), "skill missing from reader's world map after assignment"
    assert _edge_kind(bob_graph_after, bob_id, "skill", skill_id) == "reader", (
        f"reader edge missing/wrong on bob's map: {bob_graph_after.get('edges')}"
    )

    # And the skill's member roster lists bob as a reader.
    headers_a = {"Authorization": f"Bearer {alice_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/skill/{skill_id}/members", headers=headers_a)
    assert r.status_code == 200, r.text
    members = r.json().get("data") or []
    by_id = {m.get("user_id"): m for m in members if isinstance(m, dict)}
    assert bob_id in by_id, f"bob not in skill members after assignment: {members}"
    assert by_id[bob_id].get("role") == "reader", f"bob's role on skill is not reader: {by_id[bob_id]}"
