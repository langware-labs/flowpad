"""PR3: a nested repo asset re-indexed purely from disk inherits its parent from
physical enclosure — the safety net when no ``entities.json`` envelope is present.

Fast: real fs + real DB + real FSIndexer, no mocks/network.
"""
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase without approval


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    from flow_sdk.config import default_service_config
    from flow_sdk.fs_store.record_paths import (
        get_default_records_data_root,
        get_default_records_root,
        set_default_records_data_root,
        set_default_records_root,
    )
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    home = tmp_path / "home"
    home.mkdir()
    records = tmp_path / "records"
    records.mkdir()
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(records)
    set_default_records_data_root(records)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(home))
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(records / "blobs")))
    reset_instance_settings()
    try:
        yield tmp_path
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)
        reset_instance_settings()


async def test_nested_child_parent_derived_from_enclosure(env):
    from flow_sdk.builtin.flow_message_bundle import _reindex_root
    from flow_sdk.builtin.task import Task
    from flow_sdk.fs_store.record_types import RecordType

    home = env / "home"
    parent = Task(title="P", status="in_progress")
    await parent.save(notify=False)
    child = Task(title="C", status="in_progress", parent_type_id=f"task-{parent.id}")
    await child.save(notify=False)
    await _reindex_root(home, RecordType.USER_HOME_FOLDER, types=(RecordType.TASK,))

    # Drop the rows — a purely-from-disk re-index must re-derive the parent link
    # from physical nesting (there is NO entities.json in this pure-index path).
    await (await Task.get_one({"id": child.id})).destroy()
    await (await Task.get_one({"id": parent.id})).destroy()
    assert await Task.get_one({"id": child.id}) is None

    await _reindex_root(home, RecordType.USER_HOME_FOLDER, types=(RecordType.TASK,))
    c2 = await Task.get_one({"id": child.id})
    p2 = await Task.get_one({"id": parent.id})
    assert p2 is not None and c2 is not None, "both levels must re-materialize from disk"
    assert c2.parent_type_id == f"task-{parent.id}", "child lost enclosure-derived parent"
    # A top-level asset has no enclosure parent.
    assert not p2.parent_type_id
