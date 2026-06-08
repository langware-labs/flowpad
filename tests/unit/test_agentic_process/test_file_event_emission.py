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
