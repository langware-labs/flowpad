"""Naming policy and durable cross-surface guarantees, using the real DB."""

import asyncio

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.naming.service import reconcile_name
from flow_sdk.builtin.agentic_process.naming.state import (
    NameObservation,
    NameOrigin,
    NamePhase,
    SessionNameState,
    reduce_name,
)
from flow_sdk.builtin.tab import Tab


def observation(title="Harness title", *, sequence=1, origin=NameOrigin.HARNESS_AUTO, session_id="session"):
    return NameObservation(title=title, origin=origin, source="provider_metadata", revision=str(sequence),
                           sequence=sequence, session_id=session_id)


async def session(*, legacy=False, name=None, auto_rename=True, context_data=None):
    process = AgenticProcess(id=mint_uuid(), session_id="session", name=name, auto_rename=auto_rename,
                             context_data=context_data or {},
                             naming_state=None if legacy else SessionNameState(session_id="session"))
    await process._db.save(process)
    tab = Tab(id=mint_uuid(), pointer=f"shell|{process.typeid}", target_type=process.type,
              target_id=str(process.id), name=name)
    await process._db.save(tab)
    return process, tab


def test_fallback_upgrades_and_preserves_first_prompt():
    state = reduce_name(SessionNameState(session_id="session"), first_prompt="  First\n prompt " + "x" * 100)
    assert state.phase is NamePhase.PROMPT_FALLBACK
    assert state.title.startswith("First prompt ") and len(state.title) == 81
    state = reduce_name(state, observation=observation())
    assert state.phase is NamePhase.HARNESS and state.title == "Harness title"
    assert reduce_name(state, first_prompt="Second prompt").fallback == state.fallback


def test_harness_replay_wrong_binding_and_empty_observation_do_not_regress():
    state = reduce_name(SessionNameState(session_id="session"), observation=observation("New", sequence=3))
    for item in (observation("Old"), observation("Other", session_id="another"), observation(" ", sequence=4)):
        assert reduce_name(state, observation=item) == state
    assert reduce_name(state, observation=observation("New", sequence=3)) == state
    assert reduce_name(state, observation=observation("Latest", sequence=4)).title == "Latest"


@pytest.mark.parametrize("origin,phase", [(NameOrigin.UNKNOWN, NamePhase.PROTECTED_UNKNOWN),
                                         (NameOrigin.EXPLICIT_USER, NamePhase.USER_PINNED)])
def test_protected_observation_survives_automatic_names(origin, phase):
    state = reduce_name(SessionNameState(session_id="session"), observation=observation("Keep", origin=origin))
    state = reduce_name(state, observation=observation("Automatic", sequence=2))
    assert state.title == "Keep" and state.phase is phase
    assert reduce_name(state, user_name="User replacement").phase is NamePhase.USER_PINNED


async def test_same_text_user_pin_survives_stale_save_and_bulk_save():
    process, tab = await session()
    await reconcile_name(process.id, observation=observation())
    stale = await AgenticProcess.get_by_id(process.id)
    await reconcile_name(process.id, user_name="Harness title")
    stale.name, stale.auto_rename = "Stale title", True
    await process._db.save(stale)
    stale.name, stale.auto_rename = "Stale bulk title", True
    await process._db.bulk_save([stale])
    durable = await AgenticProcess.get_by_id(process.id)
    assert durable.name == "Harness title" and durable.auto_rename is False
    assert durable.naming_state.phase is NamePhase.USER_PINNED
    assert (await Tab.get_by_id(tab.id)).name == durable.name


async def test_user_rename_baseline_rejects_old_native_manual_name_but_allows_new_choice():
    process, tab = await session()
    old_native = observation("Old native user title", origin=NameOrigin.EXPLICIT_USER)
    await reconcile_name(process.id, user_name="New Flowpad user title", baseline_observations=(old_native,))
    replayed = await reconcile_name(process.id, observation=old_native)
    assert replayed.changed is False and replayed.process.name == "New Flowpad user title"
    assert (await Tab.get_by_id(tab.id)).name == "New Flowpad user title"
    later_native = observation("Later native user title", sequence=2, origin=NameOrigin.EXPLICIT_USER)
    assert (await reconcile_name(process.id, observation=later_native)).process.name == "Later native user title"


async def test_noop_reconciles_every_tab_and_stale_tab_save_cannot_undo_it():
    process, tab = await session()
    await reconcile_name(process.id, first_prompt="First prompt")
    stale = await Tab.get_by_id(tab.id)
    second = Tab(id=mint_uuid(), pointer=f"shell|second-{process.id}", target_type=process.type,
                 target_id=process.id, name="Wrong label", visible=False)
    await process._db.save(second)
    result = await reconcile_name(process.id)
    assert result.changed is False and result.tabs_changed is True
    stale.name = "Late stale label"
    await process._db.bulk_save([stale])
    assert (await Tab.get_by_id(tab.id)).name == "First prompt"
    assert (await Tab.get_by_id(second.id)).name == "First prompt"


async def test_concurrent_user_rename_beats_harness_in_both_orders():
    for user_first in (False, True):
        process, tab = await session()
        calls = [reconcile_name(process.id, user_name="Human choice"),
                 reconcile_name(process.id, observation=observation())]
        await asyncio.gather(*(calls if user_first else reversed(calls)))
        durable = await AgenticProcess.get_by_id(process.id)
        assert durable.name == "Human choice" and durable.auto_rename is False
        assert (await Tab.get_by_id(tab.id)).name == durable.name


async def test_legacy_conflicts_are_preserved_once_then_canonicalized():
    process, tab = await session(legacy=True, name="Established process", context_data={"display_name": "Old header"})
    await process._db.update_existing_data_field(tab.id, tab.type, "name", "Old tab")
    result = await reconcile_name(process.id, observation=observation())
    state = result.process.naming_state
    assert state.title == "Established process" and state.phase is NamePhase.PROTECTED_UNKNOWN
    assert set(state.legacy_candidates.values()) == {"Established process", "Old tab", "Old header"}
    assert (await Tab.get_by_id(tab.id)).name == "Established process"
    assert (await reconcile_name(process.id, user_name="New user title")).process.name == "New user title"


@pytest.mark.parametrize("name", ["Codex", "Session", "  An exact user title  "])
async def test_legacy_pins_and_explicit_placeholder_names_are_kept(name):
    process, _ = await session(legacy=True, name=name, auto_rename=False)
    result = await reconcile_name(process.id, observation=observation())
    assert result.process.name == name and result.process.naming_state.phase is NamePhase.USER_PINNED


async def test_rebind_rejects_old_session_events_and_deleted_process_stays_deleted():
    process, tab = await session()
    await reconcile_name(process.id, first_prompt="Initial prompt")
    durable = await AgenticProcess.get_by_id(process.id)
    durable.session_id = "replacement"
    await process._db.save(durable)
    assert (await reconcile_name(process.id, observation=observation())).process.name == "Initial prompt"
    await reconcile_name(process.id, observation=observation("Replacement title", session_id="replacement"))
    await process._db.delete_by_id(process.id, process.type)
    assert (await reconcile_name(process.id, user_name="Cannot resurrect")).process is None
    assert await AgenticProcess.get_by_id(process.id) is None
    assert (await Tab.get_by_id(tab.id)).name == "Replacement title"


async def test_invalid_user_rename_rolls_back_without_changing_tabs():
    process, tab = await session()
    await reconcile_name(process.id, first_prompt="Keep this")
    with pytest.raises(ValueError, match="blank"):
        await reconcile_name(process.id, user_name="  ")
    assert (await AgenticProcess.get_by_id(process.id)).name == "Keep this"
    assert (await Tab.get_by_id(tab.id)).name == "Keep this"


async def test_history_projection_preserves_legacy_names_without_writing_or_healing_tabs():
    from datetime import datetime, timezone

    from flow_sdk.builtin.worker_history import WorkerHistoryEntry, WorkerType, _project_history_names

    process, tab = await session(legacy=True, name="  Exact legacy title  ")
    await process._db.update_existing_data_field(tab.id, tab.type, "name", "Stale tab")
    entry = WorkerHistoryEntry(worker_type=WorkerType.CLAUDE, worker_id=process.session_id,
                               agentic_process_id=process.id, last_active_time=datetime.now(timezone.utc))
    await _project_history_names([entry], [process])
    assert entry.name == "  Exact legacy title  "
    durable = await AgenticProcess.get_by_id(process.id)
    assert durable.naming_state is None and durable.updated_date == process.updated_date
    assert (await Tab.get_by_id(tab.id)).name == "Stale tab"


async def test_unmanaged_opencode_history_uses_native_title_without_projecting_transcript(tmp_path, monkeypatch):
    import sqlite3

    from flow_sdk.builtin.worker_history import WorkerType, get_worker_session_name
    from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    reset_instance_settings()
    try:
        path = get_instance_settings().opencode_data_dir / "opencode.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER)")
            connection.execute("INSERT INTO session VALUES (?, ?, ?)", ("ses_naming_test", "Native OpenCode title", 1))
        assert await get_worker_session_name(WorkerType.OPENCODE, "ses_naming_test", prompt_fallback=True) == "Native OpenCode title"
    finally:
        reset_instance_settings()


@pytest.mark.parametrize("request_bound", [False, True])
@pytest.mark.parametrize("rollback", [False, True])
async def test_names_and_tabs_commit_together_before_notifications(request_bound, rollback):
    from contextlib import asynccontextmanager

    from flow_sdk.request_context.execution_context import (
        ExecutionContext,
        get_execution_context,
        set_execution_context,
    )

    process, tab = await session()
    db, seen = process._db, []

    async def observed():
        seen.append(((await AgenticProcess.get_by_id(process.id)).name, (await Tab.get_by_id(tab.id)).name))

    @asynccontextmanager
    async def request_transaction():
        previous_context = get_execution_context()
        try:
            async with ExecutionContext.create(transaction_factory=db.get_transaction_factory()) as context:
                async with context.transaction_scope():
                    yield
        finally:
            set_execution_context(previous_context)

    try:
        async with request_transaction() if request_bound else db.write_transaction():
            await reconcile_name(process.id, user_name="Atomic title")
            await db.after_commit(observed)
            assert seen == []
            if rollback:
                raise ValueError("Abort enclosing operation")
    except ValueError:
        assert rollback
    expected = None if rollback else "Atomic title"
    assert (await AgenticProcess.get_by_id(process.id)).name == expected
    assert (await Tab.get_by_id(tab.id)).name == expected
    assert seen == ([] if rollback else [(expected, expected)])


async def test_legacy_title_consumes_preexisting_native_manual_revision():
    process, tab = await session(name="Legacy user choice", legacy=True)
    old = observation("Earlier native edit", origin=NameOrigin.EXPLICIT_USER)
    result = await reconcile_name(str(process.id), migration_observations=[old])
    assert result.process.name == "Legacy user choice"
    result = await reconcile_name(str(process.id), observation=old)
    assert result.process.name == "Legacy user choice"
    result = await reconcile_name(str(process.id), observation=observation(
        "New native edit", origin=NameOrigin.EXPLICIT_USER, sequence=2))
    assert result.process.name == "New native edit"
    assert (await Tab.get_by_id(tab.id)).name == "New native edit"


async def test_binding_new_session_retains_pin_against_inherited_manual_title():
    process, _ = await session()
    await reconcile_name(str(process.id), user_name="Keep my process name")
    process = await AgenticProcess.get_by_id(process.id)
    process.session_id = "replacement"
    await process._db.save(process)
    inherited = observation("Inherited native name", origin=NameOrigin.EXPLICIT_USER,
                            session_id="replacement")
    result = await reconcile_name(str(process.id), migration_observations=[inherited])
    assert result.process.name == "Keep my process name"
    result = await reconcile_name(str(process.id), observation=inherited)
    assert result.process.name == "Keep my process name"


async def test_driverless_process_still_accepts_explicit_names():
    process = AgenticProcess(id=mint_uuid(), worker_type="simple")
    await process._db.save(process)
    await process.rename("My function run")
    assert (await AgenticProcess.get_by_id(process.id)).name == "My function run"
    current = await process.reconcile_name()
    assert current.name == "My function run"


async def test_history_invalidation_tracks_titles_and_bindings_not_cursor_churn(monkeypatch):
    import json
    from unittest.mock import AsyncMock

    process, _ = await session()
    broadcast = AsyncMock()
    monkeypatch.setattr("flow_sdk.server.routes.websocket.broadcast", broadcast)
    await reconcile_name(str(process.id), first_prompt="My prompt")
    await reconcile_name(str(process.id), observation=observation("My prompt"))
    await reconcile_name(str(process.id), observation=observation("My prompt", sequence=2))
    events = [json.loads(call.args[0]).get("broadcast_type") for call in broadcast.call_args_list]
    assert events.count("worker_history_changed") == 1
    durable = await AgenticProcess.get_by_id(process.id)
    durable.session_id = "replacement"
    await durable._db.save(durable)
    await reconcile_name(str(process.id))
    events = [json.loads(call.args[0]).get("broadcast_type") for call in broadcast.call_args_list]
    assert events.count("worker_history_changed") == 2
