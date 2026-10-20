"""Project setup begins only after the first-run wizard is done -- and "done" is a stamp, not the last answer.

The wizard's last run is archived on every start (``reset_run``) and a declined install never ends all green,
so a gate on that answer would close again on every "Run setup again" and never open for someone who said no.
These pin the stamp, what keeps it, and every way the gate opens.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.core.wizard import first_run
from flow_sdk.core.wizard.first_run import (
    _WAIVED,
    BLOCKED_FIRST_RUN,
    FIRST_RUN_WIZARD,
    FirstRunSetupRequired,
    finish_first_run,
    first_run_gate_open,
    first_run_state,
    indexing_finished,
    indexing_started,
    require_first_run_setup,
    waive_for_session,
)
from flow_sdk.core.wizard.state import first_run_done, mark_first_run_done, record_result, reset_run, run_dir
from flow_sdk.fs_store import record_paths
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

WIZARD_ID = "5f0c1d3e-9a41-4e0a-8f64-0b6a1f2d7c11"


@pytest.fixture(autouse=True)
def _instance(monkeypatch, tmp_path):
    """A fresh instance: its own records_data, no skip switch, not a hub-launched box."""
    root: Path = tmp_path / "records_data"
    monkeypatch.setattr(record_paths, "get_default_records_data_root", lambda: root)
    monkeypatch.delenv(first_run.SKIP_FIRST_RUN_SETUP_ENV, raising=False)
    _WAIVED.clear()
    monkeypatch.setattr(first_run, "_INDEXING", False)
    monkeypatch.setattr(first_run, "_INDEXED", None)
    monkeypatch.setattr("flow_sdk.instance_settings.runtime.get_assigned_runtime", lambda: None)


def _wizard(gates: bool = True):
    return SimpleNamespace(id=WIZARD_ID, name=FIRST_RUN_WIZARD, gates_project_setup=gates)


def test_a_fresh_install_is_closed():
    assert first_run_gate_open(WIZARD_ID) is False


def test_the_stamp_opens_it():
    mark_first_run_done(WIZARD_ID)
    assert first_run_gate_open(WIZARD_ID) is True


def test_the_stamp_survives_every_later_run():
    mark_first_run_done(WIZARD_ID)
    reset_run(WIZARD_ID)  # "Run setup again" archives the run
    record_result(WIZARD_ID, WizardResult.not_yet("a person declined an install"))

    assert first_run_done(WIZARD_ID) is True
    assert first_run_gate_open(WIZARD_ID) is True, "a later run that falls short must not close the gate again"


def test_a_result_on_disk_proves_nothing_there_is_no_migration():
    """An install that ran the wizard before this gate existed sees it once more; no result is read as "done"."""
    record_result(WIZARD_ID, WizardResult.satisfied("an older install ran fully"))
    assert first_run_gate_open(WIZARD_ID) is False


def test_a_run_still_going_does_not_open_it():
    record_result(WIZARD_ID, WizardResult.not_yet("still running"))  # a run writes this as it goes
    assert first_run_gate_open(WIZARD_ID) is False


def test_stamping_never_waits_on_the_run_lock():
    """`execute_wizard` holds `run.lock` for a whole run; a writer waiting on it from the event loop froze the
    server for as long as the run took. The stamp lives in a file of its own, so it needs no such wait."""
    from filelock import FileLock

    run_dir(WIZARD_ID).mkdir(parents=True, exist_ok=True)
    with FileLock(str(run_dir(WIZARD_ID) / "run.lock")):  # a run is in flight
        mark_first_run_done(WIZARD_ID)  # returns at once (the module timeout is the proof)
        assert first_run_gate_open(WIZARD_ID) is True


def test_only_a_green_finish_stamps_it():
    assert finish_first_run(_wizard(), WizardResult.not_yet("declined")) is False
    assert first_run_gate_open(WIZARD_ID) is False

    assert finish_first_run(_wizard(), WizardResult.satisfied("done")) is True, "stamped: the caller tells the watchers"
    assert first_run_gate_open(WIZARD_ID) is True


def test_another_wizard_never_gates_anything():
    assert first_run_gate_open(WIZARD_ID, False) is True
    finish_first_run(_wizard(False), WizardResult.satisfied("done"))
    assert first_run_done(WIZARD_ID) is False


def test_continue_anyway_opens_it_for_this_session_only():
    waive_for_session(WIZARD_ID)
    assert first_run_gate_open(WIZARD_ID) is True
    assert first_run_done(WIZARD_ID) is False, "a waiver is never written down"

    _WAIVED.clear()  # what a restart does
    assert first_run_gate_open(WIZARD_ID) is False


def test_the_test_backend_switch_opens_it(monkeypatch):
    monkeypatch.setenv(first_run.SKIP_FIRST_RUN_SETUP_ENV, "true")
    assert first_run_gate_open(WIZARD_ID) is True


def test_a_box_the_hub_launched_is_open(monkeypatch):
    monkeypatch.setattr("flow_sdk.instance_settings.runtime.get_assigned_runtime", lambda: "e2b")
    assert first_run_gate_open(WIZARD_ID) is True


def test_a_gate_that_cannot_read_its_state_stays_open(monkeypatch):
    def broken(_wizard_id):
        raise OSError("disk gone")

    monkeypatch.setattr(first_run, "first_run_done", broken)
    assert first_run_gate_open(WIZARD_ID) is True


async def test_no_first_run_wizard_installed_means_nothing_to_wait_for(monkeypatch):
    async def none():
        return None

    monkeypatch.setattr(first_run, "first_run_wizard", none)
    await require_first_run_setup()


async def test_a_closed_gate_refuses_with_a_marker_a_client_can_read(monkeypatch):
    async def closed():
        return _wizard()

    monkeypatch.setattr(first_run, "first_run_wizard", closed)

    with pytest.raises(FirstRunSetupRequired):
        await require_first_run_setup()


def test_the_refusal_is_a_412_a_client_can_read():
    import json

    from flow_sdk.server.flow_server import _first_run_required

    refused = _first_run_required(None, FirstRunSetupRequired())  # type: ignore[arg-type]

    assert refused.status_code == 412, "never 409: clients read that as a name collision"
    assert json.loads(refused.body)["data"] == {"blocked": BLOCKED_FIRST_RUN}


async def test_start_setup_is_refused_before_it_derives_or_starts_anything(monkeypatch):
    from flow_sdk.builtin.project_setup import _RUNS, start_setup

    async def closed():
        return _wizard()

    monkeypatch.setattr(first_run, "first_run_wizard", closed)

    with pytest.raises(FirstRunSetupRequired):
        await start_setup(SimpleNamespace(id="p-1"))
    assert ("p-1", "") not in _RUNS


async def test_a_wizard_not_indexed_yet_is_not_ready_so_the_gate_is_closed(monkeypatch):
    """On a fresh database the shipped wizard's row appears when the system-content index ends. "No row" read as
    "open" let a project setup through ahead of the wizard in that window."""

    async def none():
        return None

    monkeypatch.setattr(first_run, "first_run_wizard", none)
    indexing_started()

    with pytest.raises(FirstRunSetupRequired):
        await require_first_run_setup()


async def test_no_wizard_after_the_index_ended_is_not_installed_so_the_gate_is_open(monkeypatch):
    async def none():
        return None

    monkeypatch.setattr(first_run, "first_run_wizard", none)
    indexing_started()
    indexing_finished()

    await require_first_run_setup()


async def test_the_state_is_not_answered_until_the_index_ended_then_says_closed_or_open(monkeypatch):
    import asyncio

    row = {"wizard": None}

    async def current():
        return row["wizard"]

    monkeypatch.setattr(first_run, "first_run_wizard", current)
    indexing_started()
    asked = asyncio.ensure_future(first_run_state())
    await asyncio.sleep(0)
    assert not asked.done(), "held while the shipped wizards are being indexed -- never answered from a missing row"

    row["wizard"] = _wizard()  # the index created its row...
    indexing_finished()  # ...and ended
    assert await asyncio.wait_for(asked, 1) == "closed"

    mark_first_run_done(WIZARD_ID)
    assert await first_run_state() == "open"


async def test_a_process_that_never_indexes_answers_at_once(monkeypatch):
    """A CLI or a test never starts the index: "no wizard row" keeps meaning "this install has none"."""

    async def none():
        return None

    monkeypatch.setattr(first_run, "first_run_wizard", none)

    assert await first_run_state() == "open"
    await require_first_run_setup()


async def test_the_type_level_action_answers_with_the_state(monkeypatch):
    from flow_sdk.builtin.wizard import Wizard

    async def closed():
        return _wizard()

    monkeypatch.setattr(first_run, "first_run_wizard", closed)

    answer = await Wizard.first_run_state_action()

    assert answer.data == {"state": "closed"}


async def test_an_instance_that_never_runs_the_wizard_is_not_held_for_the_index(monkeypatch):
    """A test backend (skip switch) or a hub-launched box has no one to run the wizard: neither the state nor a
    setup waits on an index that has not ended."""
    indexing_started()  # the index is running and its wizard row does not exist yet

    async def none():
        return None

    monkeypatch.setattr(first_run, "first_run_wizard", none)
    monkeypatch.setenv(first_run.SKIP_FIRST_RUN_SETUP_ENV, "true")
    assert await first_run_state() == "open"
    await require_first_run_setup()

    monkeypatch.delenv(first_run.SKIP_FIRST_RUN_SETUP_ENV)
    monkeypatch.setattr("flow_sdk.instance_settings.runtime.get_assigned_runtime", lambda: "e2b")
    assert await first_run_state() == "open"
    await require_first_run_setup()
