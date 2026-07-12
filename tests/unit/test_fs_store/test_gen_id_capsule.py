"""Capsule-v4 per-type ``gen_uuid_fn`` coverage (Area 3).

For every shareable type: adopt a valid v4/v5 capsule id, else mint a fresh v4
and write it (frontmatter for file types, ``.flow/id`` for folder types) — never
persist uuid5(name/path). Plus the two type-specific regressions: agent must
write the UUID (not the name) into ``id:``; folder types persist their capsule.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions._folder_capsule import read_folder_capsule_id
from flow_sdk.fs_store.indexer.functions.agent import agent_gen_id
from flow_sdk.fs_store.indexer.functions.dataset import _dataset_id_from_path, dataset_gen_id
from flow_sdk.fs_store.indexer.functions.task import task_gen_id
from flow_sdk.fs_store.indexer.functions.whiteboard import _whiteboard_id_from_name, whiteboard_gen_id
from flow_sdk.fs_store.indexer.functions.workflow import workflow_gen_id

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V7 = "018f0000-0000-7000-8000-000000000000"


def _ver(u: str) -> int:
    return uuid.UUID(u).version


def _frontmatter_id(md: Path):
    fm = _extract_frontmatter(md.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


# ── per-type harness ─────────────────────────────────────────────────────────
# Each spec: build(dir, id) -> ref ; gen(ref) -> id ; capsule(ref) -> stored id ;
# legacy(ref) -> the old uuid5(name/path) value (must NOT be the minted id).

def _agent(d: Path, fm_id: str | None):
    p = d / "a.md"
    idline = f"id: {fm_id}\n" if fm_id else ""
    p.write_text(f"---\n{idline}name: My Agent\n---\n\nprompt", encoding="utf-8")
    return FSRef(p)


def _workflow(d: Path, fm_id: str | None):
    p = d / "wf.md"
    idline = f"id: {fm_id}\n" if fm_id else ""
    p.write_text(f"---\n{idline}type: workflow\n---\n\nx", encoding="utf-8")
    return FSRef(p)


def _whiteboard(d: Path, cap_id: str | None):
    wb = d / "board"
    wb.mkdir()
    (wb / "WHITE_BOARD.md").write_text("---\nname: Board\n---\n\nx", encoding="utf-8")
    if cap_id:
        (wb / ".flow").mkdir()
        (wb / ".flow" / "id").write_text(cap_id, encoding="utf-8")
    return FSRef(wb)


def _task(d: Path, cap_id: str | None):
    tk = d / "My Task"
    tk.mkdir()
    (tk / "task.md").write_text("---\ntitle: T\n---\n\nbody", encoding="utf-8")
    if cap_id:
        (tk / ".flow").mkdir()
        (tk / ".flow" / "id").write_text(cap_id, encoding="utf-8")
    return FSRef(tk)


def _dataset(d: Path, cap_id: str | None):
    ds = d / "ds"
    ds.mkdir()
    (ds / "dataset.json").write_text('{"metadata": {}}', encoding="utf-8")
    if cap_id:
        (ds / ".flow").mkdir()
        (ds / ".flow" / "id").write_text(cap_id, encoding="utf-8")
    return FSRef(ds)


SPECS = {
    "agent": (_agent, agent_gen_id, lambda r: _frontmatter_id(r._path),
              lambda r: str(uuid.uuid5(uuid.NAMESPACE_DNS, "agent:My Agent"))),
    "workflow": (_workflow, workflow_gen_id, lambda r: _frontmatter_id(r._path),
                 lambda r: str(uuid.uuid5(uuid.NAMESPACE_URL, str(r._path.resolve())))),
    "whiteboard": (_whiteboard, whiteboard_gen_id, lambda r: read_folder_capsule_id(r._path),
                   lambda r: _whiteboard_id_from_name("Board")),
    "task": (_task, task_gen_id, lambda r: read_folder_capsule_id(r._path),
             lambda r: str(uuid.uuid5(uuid.NAMESPACE_DNS, "task:My Task"))),
    "dataset": (_dataset, dataset_gen_id, lambda r: read_folder_capsule_id(r._path),
                lambda r: _dataset_id_from_path(r._path)),
}
TYPES = list(SPECS)


@pytest.mark.parametrize("t", TYPES)
def test_valid_v4_capsule_adopted(tmp_path: Path, t: str) -> None:
    build, gen, capsule, _ = SPECS[t]
    ref = build(tmp_path, V4)
    assert gen(ref) == V4


@pytest.mark.parametrize("t", TYPES)
def test_foreign_id_rejected_mints_v4(tmp_path: Path, t: str) -> None:
    build, gen, capsule, _ = SPECS[t]
    ref = build(tmp_path, V7)
    got = gen(ref)
    assert _ver(got) == 4 and got != V7
    assert capsule(ref) == got, "the fresh v4 is written into the capsule"


@pytest.mark.parametrize("t", TYPES)
def test_no_id_mints_v4_persists_and_idempotent(tmp_path: Path, t: str) -> None:
    build, gen, capsule, legacy = SPECS[t]
    ref = build(tmp_path, None)
    first = gen(ref)
    assert _ver(first) == 4, f"{t}: miss must mint v4"
    assert first != legacy(ref), f"{t}: minted id must NOT be uuid5(name/path)"
    assert capsule(ref) == first, f"{t}: v4 written to the capsule"
    assert gen(ref) == first, f"{t}: idempotent"


# ── type-specific regressions ────────────────────────────────────────────────

def test_agent_writes_uuid_not_name_into_frontmatter(tmp_path: Path) -> None:
    """The bug: agent_gen_id used to write the raw NAME into `id:`, so agents
    re-derived every index and never self-healed."""
    ref = _agent(tmp_path, None)
    got = agent_gen_id(ref)
    fm_id = _frontmatter_id(ref._path)
    assert fm_id == got and _ver(fm_id) == 4
    assert fm_id not in ("My Agent", "a"), "frontmatter must hold the UUID, not the name/stem"
    # self-heals: second index adopts the written UUID, no rewrite
    mtime = ref._path.stat().st_mtime
    assert agent_gen_id(ref) == got
    assert ref._path.stat().st_mtime == mtime


def test_dataset_manifest_id_backfilled_into_capsule(tmp_path: Path) -> None:
    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "dataset.json").write_text(f'{{"metadata": {{"id": "{V4}"}}}}', encoding="utf-8")
    assert dataset_gen_id(FSRef(ds)) == V4
    assert read_folder_capsule_id(ds) == V4, "valid manifest id migrates onto .flow/id"
