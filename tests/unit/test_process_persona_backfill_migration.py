"""Declaring the persona of processes written before `process_persona_path`.

The renderer used to infer the identity from `len(agents_json) == 1`. Every row
persisted under that rule carries no declaration, so the new renderer re-renders
it as a flat catalogue with no identity — a live regression for the single-agent
chats, wizards, help desks and automations the old rule promoted, and one the
frontend cannot repair because it only embeds at process CREATION.

The migration replays the OLD rule once, and only where it applied: exactly one
materialized agent. Two or more got no persona then either, so inventing one now
would be the same "hand it to whoever is there" mistake moved into a migration.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.process_assets import ProcessAssets
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.migrations import migration_2026_09_process_persona_backfill as mig

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def instance(tmp_path):
    """An isolated DB + records root — the migration reads both."""
    cfg = DBConfig()
    cfg.database = str(tmp_path / "personas.db")
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances["sqlite"] = driver
    old_db = Entity.__dict__.get("_db")
    Entity._db = driver
    old_root = get_default_records_root()
    set_default_records_root(tmp_path / "records")

    yield driver

    set_default_records_root(old_root)
    db_driver_mod._driver_instances.clear()
    db_driver_mod._driver_instances.update(old_instances)
    if old_db is None:
        if "_db" in Entity.__dict__:
            delattr(Entity, "_db")
    else:
        Entity._db = old_db
    await driver.close()


async def _process(tmp_path, *agents: str, persona: str | None = None) -> AgenticProcess:
    """A saved process with `agents` already materialized under its assets dir.

    Writes the files the way the embed action does — `.claude/agents/<name>.md`
    directly under the process's own assets dir — rather than calling the embed
    action, so the row looks like one persisted BEFORE the field existed.
    """
    process = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=str(tmp_path / "workdir"),
        load_flowpad_assistant=False,
        pty_mode=False,
        process_persona_path=persona,
    )
    await process.save(notify=False)
    if agents:
        agents_dir = process.asset_workspace._process_assets_path() / ".claude" / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True)
        for name in agents:
            (agents_dir / f"{name}.md").write_text(
                f"---\nname: {name}\ndescription: probe\n---\n\nDo the thing.\n",
                encoding="utf-8",
            )
    return process


async def test_a_lone_embedded_agent_is_declared_the_persona(instance, tmp_path):
    """The regressed shape: one agent, promoted by the old count rule, now
    carrying no declaration. It gets exactly the identity it already had."""
    process = await _process(tmp_path, "standard")

    report = await mig.migrate(dry_run=False)

    assert report.declared == {str(process.id): ".claude/agents/standard.md"}
    assert report.changed
    reloaded = await AgenticProcess.get_one({"id": str(process.id)})
    assert reloaded.process_persona_path == ".claude/agents/standard.md"


async def test_two_embedded_agents_stay_persona_less(instance, tmp_path):
    """The bug's own shape. `len == 2` gave NO persona before, so there is no
    prior identity to restore — picking one here would invent it."""
    process = await _process(tmp_path, "vibe", "data-integrations")

    report = await mig.migrate(dry_run=False)

    assert report.declared == {}
    assert report.ambiguous == [str(process.id)]
    reloaded = await AgenticProcess.get_one({"id": str(process.id)})
    assert reloaded.process_persona_path is None


async def test_a_declared_process_and_an_agentless_one_are_left_alone(instance, tmp_path):
    """Idempotence, and the terminal-process case that must stay persona-less."""
    declared = await _process(tmp_path, "vibe", persona=".claude/agents/vibe.md")
    terminal = await _process(tmp_path)

    report = await mig.migrate(dry_run=False)

    assert report.declared == {}
    assert report.already_declared == 1
    assert report.no_agents == 1
    assert (await AgenticProcess.get_one({"id": str(declared.id)})).process_persona_path == ".claude/agents/vibe.md"
    assert (await AgenticProcess.get_one({"id": str(terminal.id)})).process_persona_path is None


async def test_dry_run_reports_without_writing(instance, tmp_path):
    """The default. A second pass after --apply reports zero — the idempotence
    that lets the recipe run on every upgrade."""
    process = await _process(tmp_path, "standard")

    dry = await mig.migrate()
    assert dry.declared == {str(process.id): ".claude/agents/standard.md"}
    assert (await AgenticProcess.get_one({"id": str(process.id)})).process_persona_path is None

    await mig.migrate(dry_run=False)
    again = await mig.migrate(dry_run=False)
    assert again.declared == {}
    assert again.already_declared == 1


async def test_the_backfilled_path_actually_resolves_to_a_persona(instance, tmp_path):
    """End to end: what the migration writes must be a path the RENDERER
    resolves. A backfill that stores a path the renderer then warns about would
    be worse than none — it would look repaired and still have no identity."""
    process = await _process(tmp_path, "standard")
    await mig.migrate(dry_run=False)

    reloaded = await AgenticProcess.get_one({"id": str(process.id)})
    agents = reloaded.asset_workspace._load_materialized_agents_json(reloaded.asset_workspace._process_assets_path())
    block = ProcessAssets._render_agents_instruction_block(agents, reloaded.process_persona_path)

    assert "# You are the 'standard' agent" in block
    assert "# Embedded agent specs" not in block
