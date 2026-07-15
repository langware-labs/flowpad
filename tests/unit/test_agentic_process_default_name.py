"""Unit tests for AgenticProcess.stamp_default_name — the lazy, non-pinning
default-name stamp that gives a nameless process the same title the Recent-
sessions history list shows, so the tab chip / footer / sidebar stop rendering
the ``agentic_process-<id>`` synthetic.

Contract:
  * stamps ``name`` from ``get_worker_session_name`` when a subject exists;
  * leaves ``auto_rename`` True (a stamp, NOT a user rename — a later real
    OSC/LLM title can still win);
  * first-writer-wins no-op once ``name`` is set, when the user pinned it
    (``auto_rename=False``), when there is no ``session_id``, or when the
    session has no subject yet (``get_worker_session_name`` → None).
"""

import uuid
from unittest.mock import AsyncMock, PropertyMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def _proc(**kwargs) -> AgenticProcess:
    return AgenticProcess(id=str(uuid.uuid4()), **kwargs)


def _patch_transcript_path(value=None):
    return patch.object(
        AgenticProcess, "transcript_path", new_callable=PropertyMock, return_value=value
    )


async def test_stamps_subject_and_keeps_auto_rename():
    proc = _proc(session_id=str(uuid.uuid4()))
    assert proc.auto_rename is True
    with _patch_transcript_path(), patch(
        "flow_sdk.builtin.worker_history.get_worker_session_name",
        new=AsyncMock(return_value="Base directory spec"),
    ), patch.object(AgenticProcess, "save", new=AsyncMock()) as save:
        changed = await proc.stamp_default_name()
    assert changed is True
    assert proc.name == "Base directory spec"
    # The critical invariant: a STAMP must NOT pin auto_rename (unlike rename()).
    assert proc.auto_rename is True
    save.assert_awaited_once()


async def test_stamp_mirrors_name_onto_open_tab():
    """The terminal chip renders Tab.name (not the live entity) and the generic
    entity→tab sync skips terminals — so the stamp must mirror onto the tab itself,
    else the chip never heals. set_label (not rename) keeps auto_rename intact."""
    proc = _proc(session_id=str(uuid.uuid4()))

    class _StubTab:
        def __init__(self):
            self.name = f"agentic_process-{proc.id[:4]}…{proc.id[-4:]}"  # frozen synthetic
            self.set_label = AsyncMock()

    tab = _StubTab()
    with _patch_transcript_path(), patch(
        "flow_sdk.builtin.worker_history.get_worker_session_name",
        new=AsyncMock(return_value="Base directory spec"),
    ), patch.object(AgenticProcess, "save", new=AsyncMock()), patch(
        "flow_sdk.builtin.tab.Tab.get_all", new=AsyncMock(return_value=[tab])
    ), patch("flow_sdk.builtin.tab.broadcast_tabs_changed", new=AsyncMock()) as broadcast:
        changed = await proc.stamp_default_name()
    assert changed is True
    tab.set_label.assert_awaited_once_with("Base directory spec")
    broadcast.assert_awaited_once()
    assert proc.auto_rename is True


async def test_noop_when_name_already_set():
    proc = _proc(session_id=str(uuid.uuid4()), name="Existing name")
    with patch(
        "flow_sdk.builtin.worker_history.get_worker_session_name",
        new=AsyncMock(return_value="Ignored"),
    ) as resolve, patch.object(AgenticProcess, "save", new=AsyncMock()) as save:
        changed = await proc.stamp_default_name()
    assert changed is False
    assert proc.name == "Existing name"
    resolve.assert_not_awaited()
    save.assert_not_awaited()


async def test_noop_when_user_pinned():
    proc = _proc(session_id=str(uuid.uuid4()))
    proc.auto_rename = False  # user rename pinned it
    with patch(
        "flow_sdk.builtin.worker_history.get_worker_session_name",
        new=AsyncMock(return_value="Ignored"),
    ) as resolve:
        changed = await proc.stamp_default_name()
    assert changed is False
    assert proc.name is None
    resolve.assert_not_awaited()


async def test_noop_when_no_session():
    proc = _proc()  # session_id defaults to None
    assert proc.session_id is None
    with patch(
        "flow_sdk.builtin.worker_history.get_worker_session_name",
        new=AsyncMock(return_value="Ignored"),
    ) as resolve:
        changed = await proc.stamp_default_name()
    assert changed is False
    resolve.assert_not_awaited()


def _write_headless_transcript(tmp_path, sid: str) -> "Path":
    """A real SDK-launched (headless print-mode) Claude transcript, mirroring the
    on-disk shape byte-for-byte in the fields that matter: ``entrypoint``
    ``sdk-cli`` envelope with a first user prompt, and — the defining trait of
    every headless session — NO ``slug`` and NO ``aiTitle`` anywhere. Interactive
    CLI sessions carry a ``slug``; ``-p``/stream-json sessions never do."""
    import json
    from pathlib import Path

    lines = [
        {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-07-14T09:20:27.516Z",
         "sessionId": sid, "content": "why is the tab name not proper?"},
        {"type": "queue-operation", "operation": "dequeue", "timestamp": "2026-07-14T09:20:27.516Z",
         "sessionId": sid},
        {"parentUuid": None, "isSidechain": False, "type": "user",
         "message": {"role": "user", "content": "why is the tab name not proper?"},
         "uuid": "fb6fd9d9-b711-4274-a248-358e8506ada8", "timestamp": "2026-07-14T09:20:27.523Z",
         "permissionMode": "bypassPermissions", "promptSource": "sdk", "userType": "external",
         "entrypoint": "sdk-cli", "cwd": "/repo", "sessionId": sid,
         "version": "2.1.209", "gitBranch": "main"},
        {"parentUuid": "fb6fd9d9-b711-4274-a248-358e8506ada8", "isSidechain": False, "type": "assistant",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "Looking into it."}]},
         "uuid": "0c1d2e3f-0000-4000-8000-000000000001", "timestamp": "2026-07-14T09:20:31.000Z",
         "cwd": "/repo", "sessionId": sid, "version": "2.1.209", "gitBranch": "main"},
    ]
    p = tmp_path / f"{sid}.jsonl"
    p.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    return p


async def test_headless_sdk_session_still_gets_a_default_name(tmp_path):
    """Captures the RCA'd bug: an SDK-launched (headless) Claude session never
    receives a ``slug``/``aiTitle`` in its transcript, so the stamp's only title
    source is empty and the process stays nameless FOREVER — the tab chip falls
    back to the generic "Claude Code tab" and the footer agents list to the raw
    id fragment. The transcript DOES carry a perfectly good subject (the first
    user prompt); the naming chain must produce a real name from it.

    Real mechanism end-to-end: real jsonl on disk → real
    ``get_worker_session_name`` → real ``extract_claude_session_from_path``.
    Only the transcript-path lookup is pointed at the tmp file (same harness as
    every other test in this file)."""
    sid = str(uuid.uuid4())
    jsonl = _write_headless_transcript(tmp_path, sid)
    proc = _proc(session_id=sid)

    with _patch_transcript_path(jsonl), patch.object(AgenticProcess, "save", new=AsyncMock()):
        changed = await proc.stamp_default_name()

    assert changed is True, (
        "stamp_default_name() no-opped on a headless (sdk-cli) transcript — no "
        "slug/aiTitle exists for these sessions, so the process stays nameless "
        "and the UI shows 'Claude Code tab' / the raw id fragment"
    )
    name = (proc.name or "").strip()
    assert name, "process must carry a real default name after the stamp"
    assert name != sid and proc.id not in name, "name must be a title, not an id fallback"
    # Non-pinning invariant holds for the fallback path too.
    assert proc.auto_rename is True


async def test_noop_when_no_subject_yet():
    """A fresh session with no first-prompt subject yet → resolver returns None →
    leave the name empty so the chip shows the provider label until later."""
    proc = _proc(session_id=str(uuid.uuid4()))
    with _patch_transcript_path(), patch(
        "flow_sdk.builtin.worker_history.get_worker_session_name",
        new=AsyncMock(return_value=None),
    ), patch.object(AgenticProcess, "save", new=AsyncMock()) as save:
        changed = await proc.stamp_default_name()
    assert changed is False
    assert proc.name is None
    save.assert_not_awaited()


# ── Footer rename action: user rename pins auto_rename AND mirrors onto the tab ──


async def test_rename_action_pins_and_mirrors_onto_open_tab():
    """POST /graph/agentic_process/<id>/rename is a user rename from the footer:
    it pins ``auto_rename=False`` (via rename()) and mirrors onto any open tab via
    ``set_label`` (not rename → no reflect loop). Bidirectional counterpart of
    Tab.rename → AgenticProcess.rename."""
    proc = _proc(session_id=str(uuid.uuid4()))

    class _StubTab:
        def __init__(self):
            self.name = "agentic_process-old"
            self.set_label = AsyncMock()

    tab = _StubTab()
    with patch(
        "flow_sdk.builtin.agentic_process.agentic_process._read_json_body",
        new=AsyncMock(return_value={"name": "My renamed run"}),
    ), patch.object(AgenticProcess, "save", new=AsyncMock()), patch.object(
        AgenticProcess, "notify_updated", new=AsyncMock()
    ) as notify, patch(
        "flow_sdk.builtin.tab.Tab.get_all", new=AsyncMock(return_value=[tab])
    ), patch(
        "flow_sdk.builtin.tab.broadcast_tabs_changed", new=AsyncMock()
    ) as broadcast:
        result = await proc._rename_action()

    assert proc.name == "My renamed run"
    assert proc.auto_rename is False  # user rename pins it
    tab.set_label.assert_awaited_once_with("My renamed run")
    broadcast.assert_awaited_once()
    notify.assert_awaited_once()
    assert getattr(result, "status", None) != "FAIL"


async def test_rename_action_headless_no_tab_still_persists():
    """A headless background worker has no open tab — the rename must still persist
    on the entity; the mirror is best-effort (no tab, no broadcast)."""
    proc = _proc(session_id=str(uuid.uuid4()))
    with patch(
        "flow_sdk.builtin.agentic_process.agentic_process._read_json_body",
        new=AsyncMock(return_value={"name": "Headless renamed"}),
    ), patch.object(AgenticProcess, "save", new=AsyncMock()), patch.object(
        AgenticProcess, "notify_updated", new=AsyncMock()
    ), patch(
        "flow_sdk.builtin.tab.Tab.get_all", new=AsyncMock(return_value=[])
    ), patch(
        "flow_sdk.builtin.tab.broadcast_tabs_changed", new=AsyncMock()
    ) as broadcast:
        await proc._rename_action()
    assert proc.name == "Headless renamed"
    assert proc.auto_rename is False
    broadcast.assert_not_awaited()


async def test_rename_action_rejects_empty_name():
    proc = _proc(session_id=str(uuid.uuid4()))
    with patch(
        "flow_sdk.builtin.agentic_process.agentic_process._read_json_body",
        new=AsyncMock(return_value={"name": "   "}),
    ):
        result = await proc._rename_action()
    assert getattr(result, "status", None) == "FAIL"
    assert proc.name is None
