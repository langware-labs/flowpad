"""C5: AgenticProcess._process_transcript_entries detects FileRead/Write/Edit
markdown ops, emits file.read/file.write events, and cross-links the markdown
entity to the process via the generic primitives (Entity.get_by_asset_ref +
cross_link_entities).

Tests drive the flush helper directly so they don't have to fake the lifecycle
``status`` field (``status`` is owned by the start/stop paths, not the test
harness). Non-markdown paths are skipped. FileEditEntry maps to file.write.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer.entries.file_edit import FileEditEntry
from flow_sdk.transcript_analyzer.entries.file_read import FileReadEntry
from flow_sdk.transcript_analyzer.entries.file_write import FileWriteEntry


pytestmark = pytest.mark.timeout(30)


def _make_ap() -> AgenticProcess:
    return AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-000000000010",
        worker_type=WorkerType.CLAUDE_CODE,
    )


def _entry_base(eid: str) -> dict:
    """Minimal kwargs for any TranscriptEntry constructor."""
    return dict(
        id=eid,
        session_id="00000000-0000-0000-0000-000000000010",
        timestamp="2026-05-23T00:00:00.000Z",
        worker="claude",
    )


def _install_capture(ap: AgenticProcess, monkeypatch) -> list:
    """Capture emit_entity_event + cross-link calls into a shared event log.

    Stubs ``Entity.get_by_asset_ref`` (so resolution returns a dummy entity
    without a DB row) and ``cross_link_entities`` (so the link is recorded
    rather than executed)."""
    from flow_sdk.core.entity.entity_model import Entity

    events: list[tuple[str, dict]] = []

    async def _fake_emit(self, name, payload=None):
        events.append((name, dict(payload or {})))

    _dummy_md = object()

    async def _fake_get_by_asset_ref(path):
        return _dummy_md

    async def _fake_cross_link(a, b, *, a_data=None, b_data=None, save=True):
        events.append(("cross_link", {"path": (b_data or {}).get("path"), "proc_id": getattr(b, "id", None)}))
        return True

    monkeypatch.setattr(type(ap), "emit_entity_event", _fake_emit, raising=False)
    monkeypatch.setattr(Entity, "get_by_asset_ref", staticmethod(_fake_get_by_asset_ref), raising=False)
    monkeypatch.setattr(
        "flow_sdk.core.entity.cross_link.cross_link_entities",
        _fake_cross_link,
    )
    return events


@pytest.mark.asyncio
async def test_emits_file_write_for_markdown_write(initialize_test_db, monkeypatch) -> None:
    ap = _make_ap()
    events = _install_capture(ap, monkeypatch)

    await ap._process_transcript_entries(
        [FileWriteEntry(path="/tmp/hello.md", tool_name="Write", **_entry_base("e1"))],
    )

    write_events = [(n, p) for n, p in events if n == "file.write"]
    assert write_events, f"expected file.write, got {events}"
    assert write_events[0][1]["path"] == "/tmp/hello.md"
    assert write_events[0][1]["tool_name"] == "Write"
    assert ("cross_link", {"path": "/tmp/hello.md", "proc_id": ap.id}) in events


@pytest.mark.asyncio
async def test_emits_file_read_for_markdown_read(initialize_test_db, monkeypatch) -> None:
    ap = _make_ap()
    events = _install_capture(ap, monkeypatch)

    await ap._process_transcript_entries(
        [FileReadEntry(path="/tmp/doc.md", tool_name="Read", **_entry_base("e2"))],
    )

    assert any(n == "file.read" for n, _ in events)


@pytest.mark.asyncio
async def test_maps_file_edit_to_file_write_event(initialize_test_db, monkeypatch) -> None:
    """FileEditEntry semantically means 'file changed' — emit file.write."""
    ap = _make_ap()
    events = _install_capture(ap, monkeypatch)

    await ap._process_transcript_entries(
        [FileEditEntry(path="/tmp/notes.md", tool_name="Edit", **_entry_base("e3"))],
    )

    assert any(n == "file.write" for n, _ in events)
    assert not any(n == "file.edit" for n, _ in events)


async def _stub_save(ap: AgenticProcess, monkeypatch) -> None:
    """Stub Entity.save so markdown_docs tracking doesn't hit the DB."""
    async def _noop_save(self, *a, **k):
        return self
    monkeypatch.setattr(type(ap), "save", _noop_save, raising=False)


@pytest.mark.asyncio
async def test_tracks_markdown_create_for_hello_md(initialize_test_db, monkeypatch) -> None:
    """Writing hello.md tracks a 'create' doc and emits markdown.create."""
    ap = _make_ap()
    events = _install_capture(ap, monkeypatch)
    await _stub_save(ap, monkeypatch)

    await ap._process_transcript_entries(
        [FileWriteEntry(path="/tmp/hello.md", tool_name="Write", **_entry_base("e1"))],
    )

    assert ap.markdown_docs == [
        {"path": "/tmp/hello.md", "name": "hello.md", "change": "create"}
    ]
    create_events = [(n, p) for n, p in events if n == "markdown.create"]
    assert create_events, f"expected markdown.create, got {events}"
    assert create_events[0][1]["path"] == "/tmp/hello.md"
    assert create_events[0][1]["name"] == "hello.md"


@pytest.mark.asyncio
async def test_markdown_rewrite_upserts_to_update(initialize_test_db, monkeypatch) -> None:
    """A later write/edit to the same doc upgrades it to 'update' in place."""
    ap = _make_ap()
    events = _install_capture(ap, monkeypatch)
    await _stub_save(ap, monkeypatch)

    await ap._process_transcript_entries(
        [FileWriteEntry(path="/tmp/hello.md", tool_name="Write", **_entry_base("e1"))],
    )
    await ap._process_transcript_entries(
        [FileEditEntry(path="/tmp/hello.md", tool_name="Edit", **_entry_base("e2"))],
    )

    assert ap.markdown_docs == [
        {"path": "/tmp/hello.md", "name": "hello.md", "change": "update"}
    ]
    assert any(n == "markdown.update" for n, _ in events)


@pytest.mark.asyncio
async def test_excludes_plan_and_internal_docs(initialize_test_db, monkeypatch) -> None:
    """Plan files and agent-internal docs never reach the docs chip."""
    from flow_sdk.instance_settings import get_instance_settings

    ap = _make_ap()
    events = _install_capture(ap, monkeypatch)
    await _stub_save(ap, monkeypatch)

    plan_path = str(get_instance_settings().claude_plans_dir / "codex-abc.md")

    await ap._process_transcript_entries(
        [
            FileWriteEntry(path=plan_path, tool_name="Write", **_entry_base("e1")),
            FileWriteEntry(path="/repo/CLAUDE.md", tool_name="Write", **_entry_base("e2")),
            FileWriteEntry(path="/repo/docs/guide.md", tool_name="Write", **_entry_base("e3")),
        ],
    )

    assert [d["path"] for d in ap.markdown_docs] == ["/repo/docs/guide.md"]
    md_events = [n for n, _ in events if n.startswith("markdown.")]
    assert md_events == ["markdown.create"]


@pytest.mark.asyncio
async def test_filters_non_markdown_paths(initialize_test_db, monkeypatch) -> None:
    ap = _make_ap()
    events = _install_capture(ap, monkeypatch)

    await ap._process_transcript_entries(
        [
            FileReadEntry(path="/tmp/script.py", tool_name="Read", **_entry_base("e4")),
            FileWriteEntry(path="/tmp/data.json", tool_name="Write", **_entry_base("e5")),
            FileWriteEntry(path="/tmp/keep.md", tool_name="Write", **_entry_base("e6")),
        ],
    )

    file_events = [(n, p) for n, p in events if n.startswith("file.")]
    assert len(file_events) == 1
    assert file_events[0][1]["path"] == "/tmp/keep.md"
    cross_links = [p for n, p in events if n == "cross_link"]
    assert len(cross_links) == 1 and cross_links[0]["path"] == "/tmp/keep.md"
