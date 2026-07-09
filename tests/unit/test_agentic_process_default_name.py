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
