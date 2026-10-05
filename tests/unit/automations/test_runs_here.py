"""A shipped trigger under ANOTHER install is never armed — on any of the four arming paths.

The 4× "Developer toolchain (app.ready)" rows were the same shipped asset indexed
from an old python3.10 tool env, a python3.13 one, the repo checkout and the
running install — each armed as a live rule, each firing the wizard.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin import tag_triggers
from flow_sdk.builtin.trigger_arming import is_foreign_copy, runs_here, trigger_runs_here
from flow_sdk.config import system_projects_root
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from flow_sdk.server.fsop_watcher import FSOpWatcher
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import rule

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _foreign(tmp_path: Path) -> str:
    return str(tmp_path / "py3.10" / "site-packages" / "flow_sdk" / "system_projects"
               / "flowpad_assistant" / "agentic-assets" / "trigger" / "on-app-ready")


def _running() -> str:
    return str(system_projects_root() / "flowpad_assistant" / "agentic-assets" / "trigger" / "on-app-ready")


def test_foreign_copy_is_recognised_by_location(tmp_path):
    assert is_foreign_copy(_foreign(tmp_path))


def test_running_install_copy_is_not_foreign():
    # In this editable checkout the running install IS the repo — it still arms.
    assert not is_foreign_copy(_running())


@pytest.mark.parametrize("ref", ["", None, "/Users/someone/project/agentic-assets/trigger/x"])
def test_user_and_project_rules_are_not_foreign(ref):
    assert not is_foreign_copy(ref)


def test_trigger_runs_here_reads_asset_ref(tmp_path):
    assert not trigger_runs_here(rule(TriggerType.TAG, asset_ref=_foreign(tmp_path)))
    assert trigger_runs_here(rule(TriggerType.TAG, asset_ref=_running()))


@async_context
async def test_tag_rule_from_a_foreign_copy_is_not_armed(tmp_path):
    trigger = rule(TriggerType.TAG, asset_ref=_foreign(tmp_path))
    await trigger.save()
    tag_triggers.register_tag_trigger(trigger)
    try:
        assert trigger.id not in tag_triggers._subscriptions
    finally:
        tag_triggers.unregister_tag_trigger(trigger.id)


@async_context
async def test_file_rule_from_a_foreign_copy_gets_no_watch(tmp_path):
    trigger = rule(TriggerType.FSOP, asset_ref=_foreign(tmp_path), watch_path=str(tmp_path))
    await trigger.save()
    watcher = FSOpWatcher()
    watcher._spawn_task(trigger)
    assert len(watcher) == 0


@async_context
async def test_schedule_from_a_foreign_copy_does_not_run_here(tmp_path):
    assert not await runs_here(rule(TriggerType.SCHEDULE, asset_ref=_foreign(tmp_path)))
    assert await runs_here(rule(TriggerType.SCHEDULE, asset_ref=_running()))
