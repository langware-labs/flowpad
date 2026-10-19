"""The boot sweep removes trigger ROWS whose asset is gone — never files, never seeds."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from flow_sdk.server.builtin_triggers import reap_stale_trigger_rows, stale_trigger_reason
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import rule

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _foreign(root: Path) -> Path:
    return (root / "gone-env" / "site-packages" / "flow_sdk" / "system_projects"
            / "flowpad_assistant" / "agentic-assets" / "trigger" / "on-app-ready")


def test_foreign_copy_with_its_install_removed_is_stale(tmp_path):
    # The whole install folder is gone — the parent is missing too, and location
    # is the evidence, so the row still goes.
    row = rule(TriggerType.TAG, asset_ref=str(_foreign(tmp_path)))
    assert stale_trigger_reason(row) == "foreign install copy, file gone"


def test_deleted_asset_under_a_present_folder_is_stale(tmp_path):
    (tmp_path / "trigger").mkdir()
    row = rule(TriggerType.TAG, asset_ref=str(tmp_path / "trigger" / "gone"))
    assert stale_trigger_reason(row) == "asset folder deleted"


def test_missing_parent_outside_an_install_is_kept(tmp_path):
    # Could be an unmounted volume: "can't tell" keeps the row.
    row = rule(TriggerType.TAG, asset_ref=str(tmp_path / "unmounted" / "trigger" / "x"))
    assert stale_trigger_reason(row) is None


def test_present_asset_is_kept(tmp_path):
    folder = tmp_path / "here"
    folder.mkdir()
    assert stale_trigger_reason(rule(TriggerType.TAG, asset_ref=str(folder))) is None


def test_foreign_copy_still_on_disk_is_kept(tmp_path):
    folder = _foreign(tmp_path)
    folder.mkdir(parents=True)
    assert stale_trigger_reason(rule(TriggerType.TAG, asset_ref=str(folder))) is None


def test_seeds_rowless_and_hook_rules_are_never_stale(tmp_path):
    (tmp_path / "t").mkdir()
    gone = str(tmp_path / "t" / "gone")
    assert stale_trigger_reason(rule(TriggerType.SCHEDULE, uname="builtin_system_heartbeat", asset_ref=gone)) is None
    assert stale_trigger_reason(rule(TriggerType.HOOK, asset_ref=gone)) is None
    assert stale_trigger_reason(rule(TriggerType.TAG, asset_ref="")) is None


@async_context
async def test_sweep_deletes_only_stale_rows_and_no_files(tmp_path):
    parent = tmp_path / "trigger"
    parent.mkdir()
    sibling = parent / "keep.txt"
    sibling.write_text("x")
    kept_folder = parent / "kept"
    kept_folder.mkdir()

    stale = rule(TriggerType.TAG, asset_ref=str(parent / "gone"))
    foreign = rule(TriggerType.TAG, asset_ref=str(_foreign(tmp_path)))
    kept = rule(TriggerType.TAG, asset_ref=str(kept_folder))
    for row in (stale, foreign, kept):
        await row.save()
    # Saving writes each rule's folder; remove the two the way a deleted asset
    # and an uninstalled tool env would leave them.
    shutil.rmtree(parent / "gone")
    shutil.rmtree(tmp_path / "gone-env")

    assert await reap_stale_trigger_rows() >= 2
    assert await Trigger.get_by_id(stale.id) is None
    assert await Trigger.get_by_id(foreign.id) is None
    assert await Trigger.get_by_id(kept.id) is not None
    assert sibling.read_text() == "x" and kept_folder.is_dir()
    await kept.delete()


@async_context
async def test_sweep_disarms_before_deleting(tmp_path):
    from flow_sdk.builtin import tag_triggers

    (tmp_path / "trigger").mkdir()
    stale = rule(TriggerType.TAG, asset_ref=str(tmp_path / "trigger" / "gone"))
    await stale.save()
    shutil.rmtree(tmp_path / "trigger" / "gone", ignore_errors=True)
    tag_triggers.register_tag_trigger(stale)
    assert stale.id in tag_triggers._subscriptions
    await reap_stale_trigger_rows()
    assert stale.id not in tag_triggers._subscriptions
