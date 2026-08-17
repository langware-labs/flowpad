"""Auto-index trigger decisions — real Project.save(), real preferences.json.

Covers the three ``IndexTrigger`` modes, the enabled gate, and the default-when-absent
case that every existing install actually hits.

The one thing deliberately not exercised here is the walk itself: these tests assert
*whether* an index is dispatched, so they observe ``_auto_index_project`` on a stub
compute node rather than indexing a real tree (which
``tests/unit/test_fs_store/test_subprocess_scan.py`` and the index-handler suite
already cover). The preference reads, the marker, and the trigger logic are all real.
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.indexer import auto_index as ai
from flow_sdk.preferences import write_instance_pref

pytestmark = pytest.mark.timeout(10)


# Opt in to the shared records-root redirect (conftest defines it non-autouse so
# it only applies to files that ask). It also rebinds flow_sdk.builtin.shell's own
# import of get_default_records_data_root, which a local copy would miss.
@pytest.fixture(autouse=True)
def _records_root(tmp_records_root):
    return tmp_records_root


@pytest.fixture(autouse=True)
def prefs(tmp_path: Path, monkeypatch):
    """A real, initially EMPTY preferences.json for a real throwaway instance.

    Empty is the important starting state: ``default_prefs`` is only written for a
    missing/stub file, so every upgrading install reads these keys as absent and
    falls back to the in-code defaults.

    Uses the repo's env-based isolation (FLOW_HOME + a unique FLOW_INSTANCE +
    reset_instance_settings) rather than a settings stub, so every caller sees the
    tmp instance dir — including any module holding an early binding.
    """
    from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow_home"))
    monkeypatch.setenv("FLOW_INSTANCE", f"autoidx-{uuid.uuid4().hex[:8]}")
    reset_instance_settings()
    inst_dir = get_instance_settings().instance_dir
    inst_dir.mkdir(parents=True, exist_ok=True)
    (inst_dir / "preferences.json").write_text("{}", encoding="utf-8")
    try:
        yield inst_dir
    finally:
        reset_instance_settings()


class _StubNode:
    """Records dispatches instead of walking a filesystem."""

    def __init__(self, *, busy: bool = False) -> None:
        self.calls: list[dict] = []
        self._busy = busy

    async def _auto_index_project(
        self, project_id, *, force, trigger, scan_mode=None, project_record=None, on_started=None
    ):
        if self._busy:
            return False
        # The real method forwards on_started to _run_index_activity, which fires it
        # only after the activity is held — so a busy run never calls it.
        if on_started is not None:
            on_started()
        self.calls.append({"project_id": project_id, "force": force, "trigger": trigger})
        return True


@pytest.fixture()
def node(monkeypatch):
    stub = _StubNode()
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    async def _get_local(*_a, **_k):
        return stub

    monkeypatch.setattr(ComputeNode, "get_local", _get_local)
    return stub


async def _drain() -> None:
    """Let the detached hooks spawned by ``Project.save()`` finish.

    Awaits the actual task objects, so it returns as soon as they complete — this
    is task joining, not a wait budget.
    """
    import asyncio  # noqa: PLC0415

    for _ in range(5):
        pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


async def _make_project(tmp_path: Path) -> str:
    """Create a project for real — including the detached create-trigger hook
    ``Project.save()`` now spawns, which is why callers must reckon with it rather
    than invoking ``on_project_created`` by hand.
    """
    root = tmp_path / f"proj_{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True, exist_ok=True)
    pid = str(uuid.uuid4())
    await Project(id=pid, name=root.name, fs_storage_mount_path=str(root)).save()
    await _drain()
    return pid


def _set(trigger=None, *, enabled=None, index_type=None):
    if enabled is not None:
        write_instance_pref(ai.PREF_AUTO_INDEX_ENABLED, enabled)
    if trigger is not None:
        write_instance_pref(ai.PREF_AUTO_INDEX_TRIGGER, trigger)
    if index_type is not None:
        write_instance_pref(ai.PREF_AUTO_INDEX_TYPE, index_type)


# ── the marker ──────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_create_stamps_indexed_at_but_not_the_auto_index_marker(tmp_path):
    """The trap that forced a dedicated marker, locked down.

    ``Project.save()`` stamps the index sentinel on create so an empty project
    doesn't read as never-indexed — which makes ``indexed_at`` non-null from birth
    and therefore useless as a "never auto-indexed" signal. If someone later
    "simplifies" the marker back to ``indexed_at``, First Selection silently stops
    firing and this test is what says so.
    """
    pid = await _make_project(tmp_path)

    rec = FSRecord.load_or_none("project", pid)
    assert rec is not None
    assert rec.ensure_asset_ref().indexed_at is not None, "create should stamp the sentinel"
    assert ai.auto_index_marker(pid) is None, "create must NOT stamp the auto-index marker"


@pytest.mark.asyncio
async def test_marker_round_trips(tmp_path):
    pid = await _make_project(tmp_path)
    assert ai.auto_index_marker(pid) is None
    ai.write_auto_index_marker(pid, 1234567890123)
    assert ai.auto_index_marker(pid) == 1234567890123


@pytest.mark.asyncio
async def test_marker_write_does_not_make_the_project_stale(tmp_path):
    """The marker lives in the shadow dir, so it cannot perturb index_required.

    ``index_required`` compares the *asset's* mtime+size; writing metadata.json
    beside the record must not read as a content change, or every auto-index would
    immediately mark its own project dirty again.
    """
    pid = await _make_project(tmp_path)
    before = FSRecord.load_or_none("project", pid).ensure_asset_ref().index_required
    ai.write_auto_index_marker(pid, 1)
    after = FSRecord.load_or_none("project", pid).ensure_asset_ref().index_required
    assert after == before


# ── the enabled gate ────────────────────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("trigger", ["project_create", "first_selection", "every_selection"])
async def test_disabled_fires_nothing_under_any_trigger(tmp_path, node, trigger):
    _set(trigger, enabled=False)
    pid = await _make_project(tmp_path)  # includes the real create-trigger hook

    await ai.maybe_auto_index(pid, created=False)

    assert node.calls == []


# ── the three triggers ──────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_first_selection_fires_once_then_never(tmp_path, node):
    _set("first_selection", enabled=True)
    pid = await _make_project(tmp_path)

    await ai.maybe_auto_index(pid, created=False)
    assert len(node.calls) == 1
    assert node.calls[0]["trigger"] == "auto:first_selection"
    assert ai.auto_index_marker(pid) is not None

    await ai.maybe_auto_index(pid, created=False)
    await ai.maybe_auto_index(pid, created=False)
    assert len(node.calls) == 1, "the marker must suppress every later selection"


@pytest.mark.asyncio
async def test_every_selection_fires_each_time(tmp_path, node):
    _set("every_selection", enabled=True)
    pid = await _make_project(tmp_path)

    await ai.maybe_auto_index(pid, created=False)
    await ai.maybe_auto_index(pid, created=False)

    assert len(node.calls) == 2
    assert {c["trigger"] for c in node.calls} == {"auto:every_selection"}


@pytest.mark.asyncio
async def test_project_create_fires_from_save_and_selection_stays_inert(tmp_path, node):
    """The create trigger rides the real ``Project.save()`` path, not a hand call."""
    _set("project_create", enabled=True)
    pid = await _make_project(tmp_path)

    assert len(node.calls) == 1, "creating the project must fire the index itself"
    assert node.calls[0]["trigger"] == "auto:project_create"

    await ai.maybe_auto_index(pid, created=False)
    await ai.maybe_auto_index(pid, created=False)
    assert len(node.calls) == 1, "selection must be inert in project_create mode"


@pytest.mark.asyncio
async def test_create_hook_is_inert_in_selection_modes(tmp_path, node):
    _set("first_selection", enabled=True)
    pid = await _make_project(tmp_path)

    await ai.maybe_auto_index(pid, created=True)
    assert node.calls == []


@pytest.mark.asyncio
async def test_project_create_marker_suppresses_a_later_switch_to_first_selection(
    tmp_path, node
):
    """Flipping project_create → first_selection must not re-index old projects.

    The marker is stamped for every trigger mode precisely so a preference change
    doesn't replay a walk the project already had.
    """
    _set("project_create", enabled=True)
    pid = await _make_project(tmp_path)
    assert len(node.calls) == 1

    _set("first_selection")
    await ai.maybe_auto_index(pid, created=False)
    assert len(node.calls) == 1


# ── index depth ─────────────────────────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize(("index_type", "expect_force"), [("fast", False), ("full", True)])
async def test_index_type_maps_to_force(tmp_path, node, index_type, expect_force):
    _set("every_selection", enabled=True, index_type=index_type)
    pid = await _make_project(tmp_path)

    await ai.maybe_auto_index(pid, created=False)
    assert node.calls[0]["force"] is expect_force


# ── defaults + robustness ───────────────────────────────────────────────────
def test_defaults_when_preferences_json_is_empty():
    """The upgrader case: absent keys resolve to the shipped defaults."""
    cfg = ai.read_auto_index_config()
    assert cfg.enabled is True
    assert cfg.index_type is ai.IndexType.FAST
    assert cfg.trigger is ai.IndexTrigger.FIRST_SELECTION
    assert cfg.force is False


def test_unrecognized_stored_values_fall_back_to_defaults():
    """Nothing validates preference values on write, so garbage must degrade.

    A hand-edited file holding the display-cased "Every Selection" (or anything
    else) must not reach the indexer as an unknown trigger.
    """
    write_instance_pref(ai.PREF_AUTO_INDEX_TRIGGER, "Every Selection")
    write_instance_pref(ai.PREF_AUTO_INDEX_TYPE, "banana")
    cfg = ai.read_auto_index_config()
    assert cfg.trigger is ai.IndexTrigger.FIRST_SELECTION
    assert cfg.index_type is ai.IndexType.FAST


@pytest.mark.asyncio
async def test_cancel_auto_indexes_joins_detached_work(monkeypatch):
    """Factory reset can deterministically drain an index from the old graph."""
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def blocking_auto_index(_project_id: str, *, created: bool) -> None:
        assert created is False
        started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(ai, "maybe_auto_index", blocking_auto_index)

    task = ai.schedule_auto_index("project-id", created=False)
    await started.wait()
    await ai.cancel_auto_indexes()

    assert task.cancelled()
    assert cancelled.is_set()
    assert not ai._active_auto_index_tasks


@pytest.mark.asyncio
async def test_a_busy_index_skips_without_burning_first_selection(tmp_path, monkeypatch):
    """A user-initiated index holding the slot must not consume the one chance.

    The marker is stamped from ``on_started`` — i.e. only once the activity is
    actually held — so a skipped run leaves the project eligible next time.
    Otherwise a single unlucky switch would leave it unindexed forever.
    """
    busy = _StubNode(busy=True)
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    async def _get_local(*_a, **_k):
        return busy

    monkeypatch.setattr(ComputeNode, "get_local", _get_local)

    _set("first_selection", enabled=True)
    pid = await _make_project(tmp_path)

    await ai.maybe_auto_index(pid, created=False)
    assert busy.calls == []
    assert ai.auto_index_marker(pid) is None, "a skipped run must leave the marker unset"


@pytest.mark.asyncio
async def test_missing_compute_node_is_not_fatal(tmp_path, monkeypatch):
    """No @local node yet → skip quietly; never mint one as a side effect."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    async def _none(*_a, **_k):
        return None

    monkeypatch.setattr(ComputeNode, "get_local", _none)
    _set("every_selection", enabled=True)
    pid = await _make_project(tmp_path)

    await ai.maybe_auto_index(pid, created=False)  # must not raise
    assert ai.auto_index_marker(pid) is None
