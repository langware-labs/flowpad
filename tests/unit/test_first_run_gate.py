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
    begin_first_run,
    finish_first_run,
    first_run_block,
    first_run_gate_open,
    first_run_state,
    indexing_finished,
    indexing_started,
    require_first_run_setup,
    waive_for_session,
)
from flow_sdk.core.wizard.state import mark_first_run_done, read_state, record_result, reset_run
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


def _wizard(name: str = FIRST_RUN_WIZARD):
    return SimpleNamespace(id=WIZARD_ID, name=name)


def test_a_fresh_install_is_closed():
    assert first_run_gate_open(WIZARD_ID) is False


def test_the_stamp_opens_it():
    mark_first_run_done(WIZARD_ID)
    assert first_run_gate_open(WIZARD_ID) is True


def test_the_stamp_survives_every_later_run():
    mark_first_run_done(WIZARD_ID)
    reset_run(WIZARD_ID)  # "Run setup again" archives the run
    record_result(WIZARD_ID, WizardResult.not_yet("a person declined an install"))

    assert read_state(WIZARD_ID).get("first_run_done") is True
    assert first_run_gate_open(WIZARD_ID) is True, "a later run that falls short must not close the gate again"


def test_a_result_from_before_runs_were_tracked_counts_as_done():
    record_result(WIZARD_ID, WizardResult.not_yet("an older install ended short"))
    assert first_run_gate_open(WIZARD_ID) is True


def test_a_tracked_run_still_going_does_not_open_it():
    begin_first_run(_wizard())
    record_result(WIZARD_ID, WizardResult.not_yet("still running"))  # a run writes this as it goes

    assert first_run_gate_open(WIZARD_ID) is False


def test_an_older_install_keeps_its_standing_when_it_runs_the_wizard_again():
    record_result(WIZARD_ID, WizardResult.satisfied("ran under an older version"))

    begin_first_run(_wizard())  # the start about to archive that result
    reset_run(WIZARD_ID)

    assert first_run_gate_open(WIZARD_ID) is True


def test_only_a_green_finish_stamps_it():
    begin_first_run(_wizard())

    assert finish_first_run(_wizard(), WizardResult.not_yet("declined")) is False
    assert first_run_gate_open(WIZARD_ID) is False

    assert finish_first_run(_wizard(), WizardResult.satisfied("done")) is True, "stamped: the caller tells the watchers"
    assert first_run_gate_open(WIZARD_ID) is True


def test_another_wizard_never_gates_anything():
    assert first_run_gate_open(WIZARD_ID, "git-dependency") is True
    begin_first_run(_wizard("git-dependency"))
    finish_first_run(_wizard("git-dependency"), WizardResult.satisfied("done"))
    assert read_state(WIZARD_ID).get("first_run_done") is None


def test_continue_anyway_opens_it_for_this_session_only():
    waive_for_session(WIZARD_ID)
    assert first_run_gate_open(WIZARD_ID) is True
    assert read_state(WIZARD_ID).get("first_run_done") is None, "a waiver is never written down"

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

    monkeypatch.setattr(first_run, "read_state", broken)
    assert first_run_gate_open(WIZARD_ID) is True


async def test_no_first_run_wizard_installed_means_nothing_to_wait_for(monkeypatch):
    async def none():
        return None

    monkeypatch.setattr(first_run, "first_run_wizard", none)
    await require_first_run_setup()
    assert await first_run_block() is None


async def test_a_closed_gate_refuses_with_a_marker_a_client_can_read(monkeypatch):
    async def closed():
        return _wizard()

    monkeypatch.setattr(first_run, "first_run_wizard", closed)

    with pytest.raises(FirstRunSetupRequired):
        await require_first_run_setup()
    refused = await first_run_block()
    assert refused is not None
    assert refused.status_code == 412, "never 409: clients read that as a name collision"
    assert refused.data == {"blocked": BLOCKED_FIRST_RUN}


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
    assert (await first_run_block()) is not None


async def test_no_wizard_after_the_index_ended_is_not_installed_so_the_gate_is_open(monkeypatch):
    async def none():
        return None

    monkeypatch.setattr(first_run, "first_run_wizard", none)
    indexing_started()
    indexing_finished()

    await require_first_run_setup()
    assert await first_run_block() is None


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
