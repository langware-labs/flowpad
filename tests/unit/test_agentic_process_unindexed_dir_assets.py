"""Captures the RCA'd bug: a folder handed to a process via ``additional_dirs``
contributes zero assets unless something has already INDEXED it, even though its
``.claude/skills`` and ``.claude/agents`` are real and on disk.

``AgenticProcess.get_asset_descriptors`` discovers path assets through
``Entity.assets_by_path()`` — a DB query — so a folder with no entity rows yields
nothing. That is what the Assets popover showed for the flowpad-oss project:
23 skill folders + 3 agent files on disk, 0 rows in the DB, and
``{"assets": []}`` from ``/get-assets``.

Entered through ``get_assets_action`` — the same HTTP action the popover calls.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import AssetSource

SKILL_MD = """---
name: {name}
description: a real skill sitting in an unindexed folder
---

Body.
"""

AGENT_MD = """---
name: {name}
description: a real persona sitting in an unindexed folder
---

You are a test persona.
"""


@pytest.fixture
async def unindexed_dir(tmp_path: Path, monkeypatch):
    """A real, on-disk asset folder that NOTHING has ever indexed.

    Deliberately no ``Skill``/``SubAgent`` rows are saved — the absence of DB
    rows IS the condition under test. ``user_home`` is pointed at an empty tmp
    dir so the developer's own instance cannot contribute descriptors.
    """
    from flow_sdk.instance_settings import reset_instance_settings

    user_home = tmp_path / "user_home"
    user_home.mkdir()
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(user_home))
    reset_instance_settings()

    suffix = uuid.uuid4().hex[:6]
    root = tmp_path / "unindexed_project"
    skill_dir = root / ".claude" / "skills" / f"lonely_skill_{suffix}"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(SKILL_MD.format(name=f"lonely_skill_{suffix}"))
    agent_md = root / ".claude" / "agents" / f"lonely_agent_{suffix}.md"
    agent_md.parent.mkdir(parents=True)
    agent_md.write_text(AGENT_MD.format(name=f"lonely_agent_{suffix}"))

    yield {"root": root, "skill_dir": skill_dir, "agent_md": agent_md}

    reset_instance_settings()


async def _rows_for(root: Path) -> list[dict]:
    """Drive the real HTTP action and return its ``assets`` rows."""
    proc = AgenticProcess(id=str(uuid.uuid4()), additional_dirs=[str(root)])
    response = await proc.get_assets_action()
    return response.data["assets"]


@pytest.mark.asyncio
async def test_unindexed_additional_dir_skill_is_listed(unindexed_dir):
    """The on-disk skill in an unindexed ``additional_dirs`` folder is listed."""
    rows = await _rows_for(unindexed_dir["root"])

    assert str(unindexed_dir["skill_dir"]) in {r["posix_path"] for r in rows}


@pytest.mark.asyncio
async def test_unindexed_additional_dir_skill_attribution(unindexed_dir):
    """...and is attributed to ADDITIONAL_DIR, pointing at the folder we added."""
    rows = await _rows_for(unindexed_dir["root"])
    row = next(
        (r for r in rows if r["posix_path"] == str(unindexed_dir["skill_dir"])), None
    )

    assert row is not None, f"skill folder missing from {rows}"
    assert row["source"] == AssetSource.ADDITIONAL_DIR.value
    assert row["source_dir"] == str(unindexed_dir["root"])
    assert row["typeid"].startswith("skill-")


@pytest.mark.asyncio
async def test_unindexed_additional_dir_agent_attribution(unindexed_dir):
    """The on-disk agent gets the same ADDITIONAL_DIR attribution."""
    rows = await _rows_for(unindexed_dir["root"])
    row = next(
        (r for r in rows if r["posix_path"] == str(unindexed_dir["agent_md"])), None
    )

    assert row is not None, f"agent file missing from {rows}"
    assert row["source"] == AssetSource.ADDITIONAL_DIR.value
    assert row["source_dir"] == str(unindexed_dir["root"])
    assert row["typeid"].startswith("subagent-")
