"""API tests for the containment filters on /search (``top_level`` + ``parent_type_id``).

The bug: an Agent's own copy of an Mcp is a deliberate, self-contained asset
(``Agent.add_mcp`` writes it so a shared agent carries its servers) and the
indexer walks into it on purpose. Both are correct. What was wrong is that
``/search`` never put ``parent_type_id`` on the wire, so the asset tree could not
tell that copy from the project-level asset it was copied from and rendered both
as top-level rows of type ``mcp`` — one logical server, N rows.

Seeded through the REAL path: real folders on disk, the real ``repo_assets_fn``
walk, the real HTTP route. No mock stands in for the nesting.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
import pytest_asyncio

import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (register types)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

SPEC = McpSpec(name="pong-mcp-server", command="/usr/bin/python3", args=["/tmp/pong.py"])


@pytest_asyncio.fixture(autouse=True)
async def _isolate_records():
    """The api DB is session-scoped; drop the two types these tests seed so a
    sibling test's leftover agent/mcp rows cannot inflate the counts here."""
    from flow_sdk.db import get_db_driver

    driver = get_db_driver()
    for t in ("mcp", "agent"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass
    yield
    for t in ("mcp", "agent"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass


def _write_mcp(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "mcp.json").write_text(SPEC.model_dump_json(indent=2) + "\n", encoding="utf-8")


def _seed_duplicate_shape(root: Path, agent_name: str) -> None:
    """The exact on-disk shape the reported bug came from: ONE logical server
    living both at project level and as an agent's own attached copy."""
    _write_mcp(root / "agentic-assets" / "mcp" / SPEC.name)
    agent_dir = root / "agentic-assets" / "agent" / agent_name
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "agent.md").write_text(
        f"---\nname: {agent_name}\nworker_type: claude\n---\n\nA test agent.\n", encoding="utf-8"
    )
    _write_mcp(agent_dir / "agentic-assets" / "mcp" / SPEC.name)


async def _index(root: Path) -> None:
    from flow_sdk.builtin.flow_message_bundle import _reindex_root

    await _reindex_root(root, RecordType.USER_HOME_FOLDER, types=(RecordType.AGENT, RecordType.MCP))


@pytest_asyncio.fixture
async def seeded(tmp_path: Path) -> tuple[str, str]:
    """Index the duplicate shape; return ``(agent_name, agent_typeid)``."""
    from flow_sdk.builtin.agent import Agent

    agent_name = f"agent-{uuid.uuid4().hex[:8]}"
    _seed_duplicate_shape(tmp_path, agent_name)
    await _index(tmp_path)
    agent = await Agent.get_one({"name": agent_name})
    assert agent is not None, "the agent was not indexed"
    return agent_name, str(agent.typeid)


# ── the projection ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_parent_type_id_reaches_the_wire():
    """Without this field a consumer cannot tell a nested asset from a root one.

    ``parent_id`` is the legacy per-type pointer; ``parent_type_id`` is the
    canonical one on ``Entity`` that supersedes it.
    """
    from types import SimpleNamespace

    from flow_sdk.server.routes.search import _entity_to_result

    base = {"id": "11111111-1111-4111-8111-111111111111", "type": "mcp", "name": "pong", "asset_ref": "/tmp/pong"}
    owned = await _entity_to_result(SimpleNamespace(**base, parent_type_id="agent-2222"))
    orphan = await _entity_to_result(SimpleNamespace(**base))

    assert owned["parent_type_id"] == "agent-2222"
    assert "parent_type_id" not in orphan


# ── contract: the params are additive ────────────────────────────────────────


@pytest.mark.asyncio
async def test_absent_params_are_unchanged(bootstrapped_client, seeded):
    """Default off: an existing caller still sees BOTH copies, as before."""
    resp = await bootstrapped_client.get("/api/v1/search?record_type=mcp&limit=50")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data["results"]) == 2
    assert data["total"] == 2
    assert {r["name"] for r in data["results"]} == {SPEC.name}


@pytest.mark.asyncio
async def test_unknown_parent_returns_empty(bootstrapped_client):
    resp = await bootstrapped_client.get(
        "/api/v1/search?record_type=mcp&parent_type_id=agent-00000000-0000-4000-8000-000000000000&limit=5"
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["results"] == []
    assert resp.json()["data"]["total"] == 0


# ── the fix ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_top_level_collapses_the_duplicate(bootstrapped_client, seeded):
    """The reported symptom: one logical server must be one row."""
    resp = await bootstrapped_client.get("/api/v1/search?record_type=mcp&top_level=true&limit=50")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data["results"]) == 1, [r["asset_ref"] for r in data["results"]]
    # The survivor is the project-level asset, not the agent's copy.
    assert "agentic-assets/agent" not in data["results"][0]["asset_ref"].replace("\\", "/")
    # `total` drives the list view's pagination footer, so it has to move too —
    # a filtered page under an unfiltered total reads "Showing 1-1 of 2".
    assert data["total"] == 1


@pytest.mark.asyncio
async def test_the_agent_still_owns_its_copy(bootstrapped_client, seeded):
    """Dropped from the type root, but NOT lost: the owner hands it back."""
    _agent_name, agent_typeid = seeded
    resp = await bootstrapped_client.get(f"/api/v1/search?parent_type_id={agent_typeid}&limit=50")
    assert resp.status_code == 200
    results = resp.json()["data"]["results"]
    assert [r["name"] for r in results] == [SPEC.name]
    assert "agentic-assets/agent" in results[0]["asset_ref"].replace("\\", "/")
    assert results[0]["parent_type_id"] == agent_typeid


@pytest.mark.asyncio
async def test_a_project_parent_is_not_a_nesting(bootstrapped_client, seeded):
    """``project`` has no asset-tree root of its own, so its assets have nowhere
    else to appear and must stay top-level. Only a parent that IS browseable
    (an Agent) moves its children. This is the whole predicate."""
    resp = await bootstrapped_client.get("/api/v1/search?record_type=agent&top_level=true&limit=50")
    assert resp.status_code == 200
    names = {r["name"] for r in resp.json()["data"]["results"]}
    agent_name, _typeid = seeded
    assert agent_name in names


@pytest.mark.asyncio
async def test_the_badge_count_matches_the_list(seeded):
    """``asset-stats`` feeds the sidebar count chip. A count that still included
    the nested copy would read 2 over a 1-row list."""
    from flow_sdk.fs_store.indexer import index_log

    stats = await index_log.get_asset_stats()
    assert stats.per_type["mcp"] == 1
