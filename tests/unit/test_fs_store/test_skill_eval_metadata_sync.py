"""RCA: re-indexing a skill must propagate a NEW frontmatter key onto the entity.

Reproduces the live symptom behind the skill ``eval`` flag: adding ``eval: "true"``
to a skill's ``SKILL.md`` and re-indexing left the served ``Skill`` entity's
``metadata`` WITHOUT ``eval`` (so ``isEval`` stayed false and nothing fired).

The flag→entity path has two hops; this splits them so a failure points at the
exact one:

  hop 1  re-extract on a frontmatter-only edit   (freshness / scan)
  hop 2  re-sync the new metadata onto the entity (Entity.from_record)

``test_resync_propagates_new_metadata_key`` exercises hop 2 directly.
``test_full_index_flow_propagates_eval`` exercises both through the real
``FSIndexer`` + ``skill_fn`` path — the closest reproduction of the UI scan.

All ≤5s, real FSRecord/FSIndexer + SQLite, no mocks.
"""
from __future__ import annotations

import os
import time as _time
from pathlib import Path

import pytest

from flow_sdk.builtin.skill import Skill
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.record_types import RecordType

# `sync_db` fixture + `register_all()` come from the package conftest.

SKILL_ID = "11111111-2222-4333-8444-555555555555"  # valid v4 entity id


def _eval_of(entity) -> object:
    return (getattr(entity, "metadata", None) or {}).get("eval")


# ── hop 2: re-sync propagates a new metadata key ─────────────────────────────

@pytest.mark.asyncio
async def test_resync_propagates_new_metadata_key(sync_db):
    """Entity.from_record on an already-synced skill must adopt a newly-added
    metadata key (``eval``), not keep the stale metadata."""
    base = {"id": SKILL_ID, "name": "skillit", "description": "d", "tags": ""}

    await Entity.from_record(FSRecord(type="skill", id=SKILL_ID, name="skillit", metadata=dict(base)))
    e1 = await Skill.get_one({"id": SKILL_ID})
    assert e1 is not None
    assert _eval_of(e1) is None, "baseline: skill is not flagged yet"

    # Flag it: the re-extracted record now carries eval.
    flagged = {**base, "eval": "true"}
    await Entity.from_record(FSRecord(type="skill", id=SKILL_ID, name="skillit", metadata=flagged))
    e2 = await Skill.get_one({"id": SKILL_ID})
    assert _eval_of(e2) == "true", f"re-sync dropped eval: metadata={getattr(e2, 'metadata', None)}"


# ── both hops: full indexer flow (write → index → flag → re-index) ───────────

def _write_skill_md(folder: Path, *, eval_flag: bool) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    fm = [
        "---",
        f'id: "{SKILL_ID}"',
        "name: skillit",
        "description: d",
        "tags: \"\"",
    ]
    if eval_flag:
        fm.append('eval: "true"')
    fm += ["---", "", "# Skillit", "", "body", ""]
    (folder / "SKILL.md").write_text("\n".join(fm), encoding="utf-8")


async def _index_skills(idx: FSIndexer) -> None:
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.SKILL]))


@pytest.mark.asyncio
async def test_full_index_flow_propagates_eval(sync_db, tmp_path):
    """The real UI scan path: index a skill, flag its SKILL.md, re-index — the
    Skill entity's metadata must now carry eval."""
    root = tmp_path / "proj"
    skill_dir = root / ".claude" / "skills" / "skillit"
    _write_skill_md(skill_dir, eval_flag=False)

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.SKILL))

    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn, RecordType.SKILL)

    await _index_skills(idx)
    e1 = await Skill.get_one({"id": SKILL_ID})
    assert e1 is not None, "skill was not indexed"
    assert _eval_of(e1) is None, "baseline: not flagged"

    # Flag it via the file (what the header toggle does) + bump mtime so the
    # freshness sentinel invalidates, then re-index.
    _write_skill_md(skill_dir, eval_flag=True)
    new_ts = _time.time() + 5
    os.utime(skill_dir / "SKILL.md", (new_ts, new_ts))

    await _index_skills(idx)
    e2 = await Skill.get_one({"id": SKILL_ID})
    assert _eval_of(e2) == "true", (
        f"flag did not reach the entity after re-index: metadata={getattr(e2, 'metadata', None)}"
    )
