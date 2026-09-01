"""MCP as an asset: filesystem → indexed → owned by an agent → on its processes.

The hop this file pins is the one argv assertions cannot see: an ``mcp.json``
sitting in an agent's folder becomes an indexed entity with a v4 id, is reachable
from the Agent as a child, and lands on every process that agent creates —
without the caller ever touching ``process.add_mcp``.

The per-harness rendering is ``test_process_mcp_runtime.py``; a real worker
actually calling the tool is ``long_tests/test_process_mcp_multi_vendor.py``.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (register types)
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.mcp import Mcp
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval

SPEC = McpSpec(name="dummy", command="/usr/bin/python3", args=["/tmp/dummy_mcp.py"])


@pytest.fixture
def agent_name() -> str:
    """Unique per test: the records root is per-test but the DB is session-scoped,
    so a fixed name accumulates rows and `get_one` starts raising."""
    return f"agent-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def home(tmp_path: Path, monkeypatch):
    """A sandbox user-scope root, so the repo-asset walker has a real root to
    scan. Mirrors ``test_repo_nested_tree_lifecycle``'s ``env`` fixture."""
    from flow_sdk.config import default_service_config
    from flow_sdk.fs_store.record_paths import (
        get_default_records_data_root,
        get_default_records_root,
        set_default_records_data_root,
        set_default_records_root,
    )
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    root = tmp_path / "home"
    root.mkdir()
    records = tmp_path / "records"
    records.mkdir()
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(records)
    set_default_records_data_root(records)
    monkeypatch.setenv("HOME", str(root))
    monkeypatch.setenv("USERPROFILE", str(root))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(root))
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(records / "blobs")))
    reset_instance_settings()
    try:
        yield root
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)
        reset_instance_settings()


async def _mcps_of(agent_name: str) -> list[Mcp]:
    """Scoped through the owning agent — the test DB is session-wide, so a
    bare name match would also see rows other tests left behind."""
    agent = await Agent.get_one({"name": agent_name})
    assert agent is not None, f"agent {agent_name!r} was not indexed"
    return await agent.mcp_assets()


async def _index(root: Path) -> None:
    from flow_sdk.builtin.flow_message_bundle import _reindex_root

    await _reindex_root(root, RecordType.USER_HOME_FOLDER, types=(RecordType.AGENT, RecordType.MCP))


def _write_agent(root: Path, name: str) -> Path:
    """An agent folder with one MCP asset nested inside it."""
    agent_dir = root / "agentic-assets" / "agent" / name
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "agent.md").write_text(
        f"---\nname: {name}\nworker_type: claude\n---\n\nA test agent.\n", encoding="utf-8"
    )
    mcp_dir = agent_dir / "agentic-assets" / "mcp" / "dummy"
    mcp_dir.mkdir(parents=True, exist_ok=True)
    (mcp_dir / "mcp.json").write_text(
        SPEC.model_dump_json(indent=2) + "\n", encoding="utf-8"
    )
    return agent_dir


# ── disk → entity ────────────────────────────────────────────────────────────


async def test_an_mcp_json_becomes_an_indexed_entity_with_a_v4_id(home, agent_name):
    """The id is MINTED and written into the folder's capsule — never derived.

    A derived id is what a read-only asset needs; this asset is ours, so the id
    goes in it. That is the whole reason this type is authored rather than
    scanned like ``MCP_SERVER``.
    """
    agent_dir = _write_agent(home, agent_name)
    await _index(home)

    rows = await _mcps_of(agent_name)
    assert len(rows) == 1, f"expected one indexed MCP, got {[r.name for r in rows]}"
    assert uuid.UUID(rows[0].id).version == 4

    capsule = agent_dir / "agentic-assets" / "mcp" / "dummy" / ".flow" / "capsules" / "identity.json"
    assert capsule.is_file(), "the id must be written into the asset, not recomputed each walk"
    assert json.loads(capsule.read_text())["data"]["id"] == rows[0].id


async def test_reindexing_twice_keeps_the_same_id(home, agent_name):
    """A rescan must not mint a second entity for the same server."""
    _write_agent(home, agent_name)
    await _index(home)
    first = (await _mcps_of(agent_name))[0].id
    await _index(home)
    rows = await _mcps_of(agent_name)
    assert [r.id for r in rows] == [first]


async def test_the_spec_round_trips_through_the_asset(home, agent_name):
    _write_agent(home, agent_name)
    await _index(home)
    spec = (await _mcps_of(agent_name))[0].to_spec()
    assert spec == SPEC


# ── entity → agent ───────────────────────────────────────────────────────────


async def test_the_agent_owns_the_nested_mcp(home, agent_name):
    """Parenting is the indexer's, not a list we maintain: ``repo_assets_fn``
    descends into the agent folder and stamps ``parent_type_id``."""
    _write_agent(home, agent_name)
    await _index(home)

    agent = await Agent.get_one({"name": agent_name})
    assert agent is not None
    assert [m.name for m in await agent.mcp_assets()] == ["dummy"]
    assert [s.name for s in await agent.resolved_mcp_specs()] == ["dummy"]


async def test_agent_has_no_mcp_servers_list():
    """The folder is the ONLY source of truth — a second list would drift."""
    assert "mcp_servers" not in Agent.model_fields

    from flow_sdk.builtin.agent import AgentSpec

    assert "mcp_servers" not in AgentSpec.model_fields


# ── agent → process ──────────────────────────────────────────────────────────


async def test_every_process_the_agent_creates_inherits_its_mcps(home, agent_name):
    """The point of the whole slice: no caller touches ``process.add_mcp``."""
    _write_agent(home, agent_name)
    await _index(home)
    agent = await (await Agent.get_one({"name": agent_name})).save()

    process = await agent.create_process("go", workdir=str(home))

    assert [s.name for s in process.resolved_mcp_servers()] == ["dummy"]
    runtime = process.driver.prepare_process_mcp(process.resolved_mcp_servers())
    assert "dummy" in runtime.mcp_config_json


async def test_a_process_may_add_its_own_on_top(home, agent_name):
    """Agent-owned and process-local coexist; first wins on a name clash."""
    _write_agent(home, agent_name)
    await _index(home)
    agent = await (await Agent.get_one({"name": agent_name})).save()

    process = await agent.create_process("go", workdir=str(home))
    process.mcp_servers = [*process.mcp_servers, McpSpec(name="extra", command="/bin/true")]

    assert [s.name for s in process.resolved_mcp_servers()] == ["dummy", "extra"]


# ── the bundled shape: code that ships inside the asset ──────────────────────


async def test_a_bundled_server_is_scaffolded_once_and_runs(home, agent_name):
    """"Write it here" must produce something that works before anything is typed."""
    from flow_sdk.builtin.mcp import MCP_DEFAULT_ENTRYPOINT

    row = await Mcp(
        name="probe", command="fastmcp", args=["run"], entrypoint=MCP_DEFAULT_ENTRYPOINT
    ).save(notify=False)

    server = row.folder / MCP_DEFAULT_ENTRYPOINT
    assert server.is_file(), "the bundled shape must scaffold its code file"

    # A later save must never clobber code the user has since written.
    server.write_text("# mine\n", encoding="utf-8")
    await row.save(notify=False)
    assert server.read_text() == "# mine\n"


async def test_the_entrypoint_resolves_against_the_asset_folder(home, agent_name):
    """The FILE keeps a relative path so it survives being shared; the LAUNCH
    payload gets the absolute one. Only the row knows ``asset_ref``."""
    from flow_sdk.builtin.mcp import MCP_DEFAULT_ENTRYPOINT

    row = await Mcp(
        name="resolved", command="fastmcp", args=["run"], entrypoint=MCP_DEFAULT_ENTRYPOINT
    ).save(notify=False)

    on_disk = json.loads((row.folder / "mcp.json").read_text())
    assert on_disk["entrypoint"] == MCP_DEFAULT_ENTRYPOINT, "the file must stay portable"
    assert on_disk.get("args") == ["run"], "the resolved path must not be persisted"

    # The serializer writes with exclude_defaults=True, so a server sitting on
    # its defaults has NO transport/env/url key at all. Pinned because every
    # READER has to tolerate it: the editor crashed on `Object.keys(undefined)`
    # for exactly this file until it filled the defaults back in on load.
    assert "env" not in on_disk and "url" not in on_disk and "transport" not in on_disk

    spec = row.to_spec()
    assert spec.is_bundled
    assert spec.args == ["run", str(row.folder / MCP_DEFAULT_ENTRYPOINT)]


async def test_a_command_shaped_server_scaffolds_nothing(home, agent_name):
    row = await Mcp(name="external", command="npx", args=["-y", "@some/mcp"]).save(notify=False)
    assert not (row.folder / "server.py").exists()
    assert row.to_spec().is_bundled is False


# ── the Test probe ───────────────────────────────────────────────────────────


async def test_probe_connects_and_lists_the_scaffolded_tool(home, agent_name, capsys):
    """The probe runs the SAME projection a worker launches, so a pass here is
    evidence about the real thing rather than about a second code path.

    ``capsys.disabled()`` is required, not cosmetic: spawning a stdio server
    needs a real ``fileno()`` on the inherited streams, and the suite's
    ``--capture=tee-sys`` swaps in an object that has none.
    """
    from flow_sdk.builtin.mcp import MCP_DEFAULT_ENTRYPOINT

    row = await Mcp(
        name="probe", command="fastmcp", args=["run"], entrypoint=MCP_DEFAULT_ENTRYPOINT
    ).save(notify=False)

    with capsys.disabled():
        result = (await row.test_action()).data
    assert result["ok"] is True, result["detail"]
    assert result["tools"] == ["hello"]


async def test_probe_reports_a_broken_command_instead_of_raising(home, agent_name):
    """A driver must not 500 the button — failure is a returned value."""
    row = await Mcp(name="broken", command="definitely-not-a-binary-xyz").save(notify=False)

    result = (await row.test_action()).data
    assert result["ok"] is False
    assert result["tools"] == []
    assert result["detail"], "a failure must say why"


async def test_probe_names_a_missing_entrypoint(home, agent_name):
    row = await Mcp(name="gone", command="fastmcp", args=["run"], entrypoint="nope.py").save(notify=False)
    (row.folder / "nope.py").unlink(missing_ok=True)

    result = (await row.test_action()).data
    assert result["ok"] is False
    assert "nope.py" in result["detail"]


# ── authoring ────────────────────────────────────────────────────────────────


async def test_add_mcp_writes_an_asset_and_is_idempotent(home, agent_name):
    agent_dir = home / "agentic-assets" / "agent" / agent_name
    agent_dir.mkdir(parents=True)
    (agent_dir / "agent.md").write_text(f"---\nname: {agent_name}\nworker_type: claude\n---\n")
    await _index(home)
    agent = await Agent.get_one({"name": agent_name})

    assert await agent.add_mcp(SPEC) is True
    assert (agent_dir / "agentic-assets" / "mcp" / "dummy" / "mcp.json").is_file()
    assert await agent.add_mcp(SPEC) is False, "re-adding an identical spec must be a no-op"
    assert [m.name for m in await agent.mcp_assets()] == ["dummy"]

    assert await agent.remove_mcp("dummy") is True
    assert await agent.remove_mcp("dummy") is False


async def test_add_mcp_is_idempotent_for_a_bundled_server(home, agent_name):
    """The command-shaped case above cannot catch this: a bundled row's
    ``to_spec()`` carries a resolved absolute path the incoming spec never has,
    so comparing launch payloads made every add look like a change."""
    from flow_sdk.builtin.mcp import MCP_DEFAULT_ENTRYPOINT

    agent_dir = home / "agentic-assets" / "agent" / agent_name
    agent_dir.mkdir(parents=True)
    (agent_dir / "agent.md").write_text(f"---\nname: {agent_name}\nworker_type: claude\n---\n")
    await _index(home)
    agent = await Agent.get_one({"name": agent_name})

    bundled = McpSpec(
        name="inhouse", command="fastmcp", args=["run"], entrypoint=MCP_DEFAULT_ENTRYPOINT
    )
    assert await agent.add_mcp(bundled) is True
    assert await agent.add_mcp(bundled) is False, "re-adding an identical bundled spec must be a no-op"


async def test_a_codex_agent_refuses_a_name_codex_cannot_address(home, agent_name):
    """Refused at author time, not at some later spawn: codex splits ``-c`` keys
    on dots, so a dotted name would nest the entry under the wrong table."""
    agent_dir = home / "agentic-assets" / "agent" / agent_name
    agent_dir.mkdir(parents=True)
    (agent_dir / "agent.md").write_text(f"---\nname: {agent_name}\nworker_type: codex\n---\n")
    await _index(home)
    agent = await Agent.get_one({"name": agent_name})

    with pytest.raises(ValueError, match="contains '.'"):
        await agent.add_mcp(McpSpec(name="claude.ai", command="/bin/true"))
    assert not (agent_dir / "agentic-assets" / "mcp").exists(), "must refuse BEFORE writing"
