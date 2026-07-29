"""Installed (received) transcripts must be indexed where they land.

A shared transcript is an ordinary file-backed asset, so it installs to the
placement destination for its type — ``<scope root>/<harness prefix>/transcripts/
<id>.jsonl`` — which is nowhere near the harness's own session store. The
per-worker walkers only glob that own store, so without a walker for the install
location the file sits on disk with no row behind it and the attachment chip has
nothing to resolve (it renders dashed forever).

Worker-generic: claude / codex / copilot enroll purely by declaring
``family=TRANSCRIPTS_FAMILY``.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.builtin import build_default_indexer
from flow_sdk.fs_store.indexer.functions.copilot_sessions import (
    copilot_session_identity_key,
)
from flow_sdk.fs_store.indexer.functions.installed_transcripts import (
    installed_transcripts_fn,
    transcript_subdir_to_info,
)
from flow_sdk.fs_store.placement import TRANSCRIPTS_FAMILY
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# The install subdir each worker's transcripts land in, per its declared
# harness. Spelled out here on purpose: the registry derives these, and this
# test is what catches a harness value silently falling back to ``.claude/``.
EXPECTED_SUBDIRS = {
    ".claude/transcripts": RecordType.CLAUDE_SESSION,
    ".agents/transcripts": RecordType.CODEX_SESSION,
    ".github/transcripts": RecordType.COPILOT_SESSION,
}


def test_every_transcript_subdir_maps_to_its_type():
    got = {subdir: RecordType(info.type_name) for subdir, info in transcript_subdir_to_info().items()}
    assert got == EXPECTED_SUBDIRS


def test_registry_family_lookup_stays_domain_free():
    """``main_subdir_to_info`` is a generic registry capability — it takes the
    family from the caller. The transcripts vocabulary lives in the walker
    module, so the registry never learns about one domain's families."""
    assert SchemaRegistry.main_subdir_to_info(TRANSCRIPTS_FAMILY) == transcript_subdir_to_info()
    assert SchemaRegistry.main_subdir_to_info("no-such-family") == {}


def test_walker_emits_one_ref_per_installed_transcript(tmp_path):
    """One walker covers all three workers, typed by the subdir it came from."""
    expected = {}
    for subdir, record_type in EXPECTED_SUBDIRS.items():
        sid = str(uuid.uuid4())
        d = tmp_path / subdir
        d.mkdir(parents=True)
        (d / f"{sid}.jsonl").write_text(f'{{"sessionId":"{sid}"}}\n', encoding="utf-8")
        expected[sid] = record_type

    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    refs = installed_transcripts_fn([node], None)

    assert {r._path.stem: r.record_type for r in refs} == expected
    # Parented to the scope root, so the walk-time project_id/scope stamp binds
    # the transcript to the RECEIVER's project, not the sender's embedded cwd.
    assert all(r._parent is node for r in refs)


def test_walker_ignores_non_transcript_files(tmp_path):
    d = tmp_path / ".claude" / "transcripts"
    d.mkdir(parents=True)
    (d / "notes.md").write_text("not a transcript\n", encoding="utf-8")
    (tmp_path / ".claude" / "skills").mkdir(parents=True)

    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    assert installed_transcripts_fn([node], None) == []


@pytest.mark.parametrize(
    "root",
    [RecordType.USER_HOME_FOLDER, RecordType.REAL_PROJECT_CWD, RecordType.CWD_ROOT],
)
def test_walker_is_registered_on_every_installable_root(root):
    """The bug this guards: the file installed fine, but no walker ran over the
    install location, so ``claude_session`` had zero rows and the chip stayed
    dashed. A transcript can install into project scope (REAL_PROJECT_CWD /
    CWD_ROOT) or user scope (USER_HOME_FOLDER) — all three must be walked."""
    idx = build_default_indexer()
    registered = [fn for fn, _ in idx._functions.get(root, [])]
    assert installed_transcripts_fn in registered


def test_walker_output_types_annotated_for_typed_scan_pruning():
    """Without the annotation a ``?type=…`` scan can't prune this walker."""
    idx = build_default_indexer()
    outputs = {types for fn, types in idx._functions[RecordType.REAL_PROJECT_CWD] if fn is installed_transcripts_fn}
    assert outputs == {frozenset(EXPECTED_SUBDIRS.values())}


def test_every_session_type_declares_the_transcripts_family():
    """Enrollment is by declaration — a new worker gets walked for free."""
    families = {t: SchemaRegistry.get(t).family for t in ("claude_session", "codex_session", "copilot_session")}
    assert set(families.values()) == {TRANSCRIPTS_FAMILY}


_TRANSCRIPT_LINE = (
    '{{"sessionId":"{sid}","cwd":"{cwd}","type":"user",'
    '"timestamp":"2026-07-28T10:00:00Z","message":{{"role":"user","content":"hi"}}}}\n'
)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_install_materializes_a_row_for_the_receiver(tmp_path: Path):
    """The end-to-end bug: the bytes landed but nothing indexed them.

    Drives the REAL call the install path makes (``_reindex_received_assets``)
    over a transcript sitting at its real install destination, and asserts a row
    exists — bound to the RECEIVER's project, not the sender's ``cwd`` embedded
    in the transcript.
    """
    from flow_sdk.builtin.flow_message_bundle import _reindex_received_assets

    receiver_root = tmp_path / "cyber-course-2"
    receiver_root.mkdir(parents=True)
    proj = Project(
        id=Project.derive_id_for_path(str(receiver_root)),
        name="cyber-course-2",
        fs_storage_mount_path=str(receiver_root),
    )
    await proj.save()

    sid = str(uuid.uuid4())
    installed_dir = receiver_root / ".claude" / "transcripts"
    installed_dir.mkdir(parents=True)
    (installed_dir / f"{sid}.jsonl").write_text(
        _TRANSCRIPT_LINE.format(sid=sid, cwd=str(tmp_path / "cyber-course-1")),
        encoding="utf-8",
    )

    await _reindex_received_assets(receiver_root, (RecordType.CLAUDE_SESSION,), project_id=proj.id)

    session_cls = SchemaRegistry.get_entity_cls("claude_session")
    rows = await session_cls.get_all({"id": sid})
    assert rows, "install reindex left the transcript unindexed — the chip has nothing to resolve"
    row = rows[0]
    assert row.project_id == proj.id, (
        f"installed transcript not bound to the receiver's project: got {row.project_id!r}"
    )
    assert row.scope == "project", f"expected project scope, got {row.scope!r}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_install_wakes_the_chip_with_a_create_op(tmp_path: Path, monkeypatch):
    """Indexing alone is not enough — the open conversation must be told.

    The indexer persists with ``notify=False`` (a bulk walk must not flood the
    WS), so the chip's ``useEntity`` would sit on the 404 it negative-cached
    before install and stay dashed until a manual reload. Install therefore
    announces its own imports via ``_notify_received_assets``, and it must be a
    CREATE: the receiver never had the entity cached, and the frontend's UPDATE
    handler bails on an uncached entity.
    """
    from flow_sdk.builtin.flow_message_bundle import (
        _notify_received_assets,
        _reindex_received_assets,
    )

    receiver_root = tmp_path / "cyber-course-3"
    receiver_root.mkdir(parents=True)
    proj = Project(
        id=Project.derive_id_for_path(str(receiver_root)),
        name="cyber-course-3",
        fs_storage_mount_path=str(receiver_root),
    )
    await proj.save()

    sid = str(uuid.uuid4())
    installed_dir = receiver_root / ".claude" / "transcripts"
    installed_dir.mkdir(parents=True)
    (installed_dir / f"{sid}.jsonl").write_text(
        _TRANSCRIPT_LINE.format(sid=sid, cwd=str(tmp_path / "sender")), encoding="utf-8"
    )
    await _reindex_received_assets(receiver_root, (RecordType.CLAUDE_SESSION,), project_id=proj.id)

    ops = []
    import flow_sdk.core.network.resource_tracker as tracker

    async def _capture(op):
        ops.append(op)

    monkeypatch.setattr(tracker, "handle_entity_op", _capture)

    await _notify_received_assets({("claude_session", sid)})

    assert ops, "install announced nothing — the chip stays dashed until reload"
    op = ops[0]
    assert str(op.op).endswith("create"), f"must be CREATE, got {op.op!r}"
    assert str(op.to_entity) == f"claude_session-{sid}"


def test_copilot_identity_key_reads_both_layouts(tmp_path):
    """Copilot's own store names the DIRECTORY; an installed transcript is a flat
    file named for the id. Keying blindly off the parent would collapse every
    installed copilot transcript onto the id derived from ``transcripts``.

    The discriminator is the ``events.jsonl`` filename, not id-validity — a
    Copilot session dir whose name isn't a UUID must still key off the dir
    (hashed), never off the stem ``events``."""
    sid = str(uuid.uuid4())

    own = tmp_path / ".copilot" / "session-state" / sid
    own.mkdir(parents=True)
    own_events = own / "events.jsonl"
    own_events.write_text("{}\n", encoding="utf-8")

    installed_dir = tmp_path / ".github" / "transcripts"
    installed_dir.mkdir(parents=True)
    installed = installed_dir / f"{sid}.jsonl"
    installed.write_text("{}\n", encoding="utf-8")

    assert copilot_session_identity_key(own_events) == sid
    assert copilot_session_identity_key(installed) == sid

    # Non-UUID session dir: still the dir (hashed downstream), never "events".
    odd = tmp_path / ".copilot" / "session-state" / "raw-copilot"
    odd.mkdir(parents=True)
    odd_events = odd / "events.jsonl"
    odd_events.write_text("{}\n", encoding="utf-8")
    assert copilot_session_identity_key(odd_events) == "raw-copilot"
