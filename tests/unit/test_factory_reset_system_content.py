import sys
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, Mock

import pytest

from flow_sdk import system_tools
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.compute.providers import get_compute_provider
from flow_sdk.compute.providers.desktop.pty_session_manager import PtyRegistry
from flow_sdk.config import ComputeProviderType
from flow_sdk.core.capabilities import discovery as capability_discovery
from flow_sdk.db import database
from flow_sdk.db.db_entity import DBEntity
from flow_sdk.db.db_relationship import DBRelationship
from flow_sdk.db.drivers import db_driver
from flow_sdk.server.routes import bootstrap as bootstrap_module


@pytest.mark.asyncio
async def test_system_content_pass_indexes_all_shipped_assets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pass reused by factory reset must include agents after base state."""
    user = object()
    project = object()
    system_project = object()
    events: list[str] = []

    async def init_db() -> None:
        events.append("init_db")

    async def local_user() -> object:
        events.append("local_user")
        return user

    async def local_project(**_kwargs) -> object:
        events.append("local_project")
        return project

    async def system_projects(**_kwargs) -> list[object]:
        events.append("system_projects")
        return [system_project]

    async def reap() -> None:
        events.append("reap")

    async def system_markdowns(_projects) -> None:
        events.append("system_markdowns")

    async def get_compute_node(**_kwargs) -> object:
        events.append("compute_node")
        return compute_node

    async def system_assets() -> None:
        events.append("system_assets")

    async def onboarding(_user) -> None:
        events.append("onboarding")

    compute_node = type(
        "ComputeNodeStub",
        (),
        {"_index_system_assets": AsyncMock(side_effect=system_assets)},
    )()

    monkeypatch.setattr(bootstrap_module, "init_db", AsyncMock(side_effect=init_db))
    monkeypatch.setattr(
        bootstrap_module,
        "get_or_create_local_user",
        AsyncMock(side_effect=local_user),
    )
    monkeypatch.setattr(
        bootstrap_module,
        "get_or_create_local_project",
        AsyncMock(side_effect=local_project),
    )
    ensure_projects = AsyncMock(side_effect=system_projects)
    monkeypatch.setattr(bootstrap_module, "_ensure_system_projects", ensure_projects)
    monkeypatch.setattr(
        bootstrap_module,
        "_reap_protected_path_projects",
        AsyncMock(side_effect=reap),
    )
    index_markdowns = AsyncMock(side_effect=system_markdowns)
    monkeypatch.setattr(
        bootstrap_module,
        "_index_system_project_markdowns",
        index_markdowns,
    )
    get_compute_node_mock = AsyncMock(side_effect=get_compute_node)
    monkeypatch.setattr(
        bootstrap_module,
        "get_or_create_local_compute_node",
        get_compute_node_mock,
    )
    monkeypatch.setattr(
        bootstrap_module,
        "create_onboarding_assets",
        AsyncMock(side_effect=onboarding),
    )

    await bootstrap_module.index_system_content()

    ensure_projects.assert_awaited_once_with(desktop_user=user)
    index_markdowns.assert_awaited_once_with([system_project])
    get_compute_node_mock.assert_awaited_once_with(
        local_project=project,
        desktop_user=user,
    )
    compute_node._index_system_assets.assert_awaited_once_with()
    assert events == [
        "init_db",
        "local_user",
        "local_project",
        "system_projects",
        "reap",
        "system_markdowns",
        "compute_node",
        "system_assets",
        "onboarding",
    ]


@pytest.mark.asyncio
async def test_factory_reset_awaits_canonical_system_content_pass(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """A completed reset cannot leave the shipped agent table empty."""
    db_path = tmp_path / "flowpad.db"
    db_path.write_bytes(b"test-db")
    events: list[str] = []
    new_driver = object()

    async def backup() -> system_tools.BackupResult:
        events.append("backup")
        return system_tools.BackupResult(
            backup_path=str(tmp_path / "backup"),
            message="backed up",
        )

    async def clear_index() -> system_tools.ClearIndexResult:
        events.append("clear_index")
        return system_tools.ClearIndexResult(fts_cleared=0, entities_cleared=0)

    async def cancel_auto_indexes() -> None:
        events.append("cancel_auto_indexes")

    @asynccontextmanager
    async def lifecycle_guard():
        events.append("lifecycle_enter")
        yield
        events.append("lifecycle_exit")

    async def close_db() -> None:
        events.append("close_db")

    async def init_db() -> None:
        events.append("init_db")

    async def bootstrap() -> None:
        events.append("bootstrap")

    async def index_system_content() -> None:
        events.append("system_content")

    async def run_discovery() -> None:
        events.append("capability_discovery")

    monkeypatch.setattr(system_tools, "get_db_path", lambda: db_path)
    monkeypatch.setattr(system_tools, "backup_db", AsyncMock(side_effect=backup))
    monkeypatch.setattr(system_tools, "clear_index", AsyncMock(side_effect=clear_index))
    from flow_sdk.fs_store.indexer import auto_index

    monkeypatch.setattr(
        auto_index,
        "cancel_auto_indexes",
        AsyncMock(side_effect=cancel_auto_indexes),
    )
    monkeypatch.setattr(database, "close_db", AsyncMock(side_effect=close_db))
    monkeypatch.setattr(database, "init_db", AsyncMock(side_effect=init_db))
    monkeypatch.setattr(db_driver, "_driver_instances", {})
    monkeypatch.setattr(db_driver, "db_lifecycle_guard", lifecycle_guard)
    monkeypatch.setattr(db_driver, "get_db_driver", lambda: new_driver)
    monkeypatch.setattr(db_driver, "remove_db_sidecars", Mock())
    monkeypatch.setattr(DBEntity, "_db", object())
    monkeypatch.setattr(DBRelationship, "_db", object())
    monkeypatch.setattr(
        bootstrap_module,
        "invalidate_bootstrap_cache",
        lambda: events.append("invalidate_bootstrap"),
    )
    monkeypatch.setattr(
        bootstrap_module,
        "bootstrap",
        AsyncMock(side_effect=bootstrap),
    )
    discovery_mock = AsyncMock(side_effect=run_discovery)
    monkeypatch.setattr(capability_discovery, "run_discovery", discovery_mock)
    system_content_mock = AsyncMock(side_effect=index_system_content)
    monkeypatch.setattr(
        bootstrap_module,
        "index_system_content",
        system_content_mock,
    )

    # The service-row reinstall: a wipe deletes these rows, and the watcher
    # must be stopped before re-seeding and re-armed after, or FSOp triggers
    # come back stored but unwatched.
    from flow_sdk.server import builtin_triggers as builtin_triggers_module
    from flow_sdk.server import fsop_watcher as fsop_watcher_module

    async def seed_service_entities() -> None:
        events.append("seed_service_entities")

    async def watcher_stop() -> None:
        events.append("watcher_stop")

    async def watcher_rearm() -> None:
        events.append("watcher_rearm")

    monkeypatch.setattr(
        builtin_triggers_module, "seed_service_entities", seed_service_entities
    )
    monkeypatch.setattr(fsop_watcher_module.fsop_watcher, "stop", watcher_stop)
    monkeypatch.setattr(fsop_watcher_module.fsop_watcher, "rearm", watcher_rearm)

    result = await system_tools.clear_all_data()

    system_content_mock.assert_awaited_once_with()
    discovery_mock.assert_awaited_once_with()
    assert result.backup_path == str(tmp_path / "backup")
    assert events.index("cancel_auto_indexes") < events.index("clear_index")
    assert events.index("capability_discovery") > events.index("bootstrap")
    assert events.index("system_content") > events.index("bootstrap")
    # Order is load-bearing in both directions: stopping after the seed would
    # cancel the tasks just spawned, and re-arming before it would spawn tasks
    # holding pre-wipe entities.
    assert (
        events.index("watcher_stop")
        < events.index("seed_service_entities")
        < events.index("watcher_rearm")
    )


@pytest.mark.skipif(sys.platform == "win32", reason="real child regression uses /bin/sh")
@pytest.mark.asyncio
async def test_factory_reset_terminates_live_pty_children_before_db_wipe(
    initialize_test_db,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Factory reset must not leave provider-owned OS children behind."""
    PtyRegistry.reset_instance()
    manager = PtyRegistry.get_instance()
    compute_node = await ComputeNode.get_local()
    assert compute_node is not None
    provider = get_compute_provider(ComputeProviderType.LOCAL_MACHINE)
    provider_node_id = compute_node.verified_node_provider_id
    shell_id = str(uuid.uuid4())
    pty_key = (compute_node.id, provider_node_id, shell_id)

    await provider.get_or_create_pty_session(
        provider_node_id,
        shell_id,
        on_output=lambda _data: None,
        rows=24,
        cols=80,
        working_dir=str(tmp_path),
        spawn_args=["/bin/sh"],
    )
    await manager.generate_session(pty_key, compute_node.id, "test-connection")
    child_pid = provider.get_pty_shell_pid(provider_node_id, shell_id)
    assert child_pid is not None
    assert provider.is_pty_alive(provider_node_id, shell_id)

    db_path = tmp_path / "reset-target.db"
    db_path.write_bytes(b"test-db")

    async def backup() -> system_tools.BackupResult:
        return system_tools.BackupResult(
            backup_path=str(tmp_path / "backup"),
            message="backed up",
        )

    @asynccontextmanager
    async def lifecycle_guard():
        yield

    monkeypatch.setattr(system_tools, "get_db_path", lambda: db_path)
    monkeypatch.setattr(system_tools, "backup_db", backup)
    monkeypatch.setattr(
        system_tools,
        "clear_index",
        AsyncMock(
            return_value=system_tools.ClearIndexResult(
                fts_cleared=0,
                entities_cleared=0,
            )
        ),
    )
    monkeypatch.setattr(database, "close_db", AsyncMock())
    monkeypatch.setattr(database, "init_db", AsyncMock())
    monkeypatch.setattr(db_driver, "_driver_instances", {})
    monkeypatch.setattr(db_driver, "db_lifecycle_guard", lifecycle_guard)
    monkeypatch.setattr(db_driver, "get_db_driver", lambda: initialize_test_db)
    monkeypatch.setattr(db_driver, "remove_db_sidecars", Mock())
    monkeypatch.setattr(bootstrap_module, "invalidate_bootstrap_cache", lambda: None)
    monkeypatch.setattr(bootstrap_module, "bootstrap", AsyncMock())
    monkeypatch.setattr(bootstrap_module, "index_system_content", AsyncMock())
    monkeypatch.setattr(capability_discovery, "run_discovery", AsyncMock())

    try:
        await system_tools.clear_all_data()

        assert manager.states == {}
        assert provider.get_pty_shell_pid(provider_node_id, shell_id) is None
        assert not provider._is_process_alive(child_pid)
    finally:
        await provider.close_pty_session(provider_node_id, shell_id)
        PtyRegistry.reset_instance()


@pytest.mark.asyncio
async def test_rearm_watches_fsop_triggers_the_reset_left_stored() -> None:
    """After a reset, an FSOp trigger must come back WATCHING, not merely stored.

    The reset stops the watcher (it must; stale pre-wipe entities collide on
    `uname`) and re-seeds the rows. SCHEDULE triggers re-register themselves on
    save, so the heartbeat recovers — but FSOp ones do not, and would come back
    as rows with nothing watching them. Counting restored rows cannot see that,
    which is why this asserts on the watcher's task table.
    """
    from flow_sdk.builtin.trigger import Trigger, TriggerType
    from flow_sdk.server.fsop_watcher import fsop_watcher

    trigger = Trigger(
        id=str(uuid.uuid4()),
        name="watcher under test",
        trigger_type=TriggerType.FSOP,
    )

    async def _one_fsop_trigger(_type):
        return [trigger]

    # The post-wipe state: watcher stopped, so its task table is empty.
    await fsop_watcher.stop()
    assert len(fsop_watcher) == 0

    original = Trigger.list_by_type
    Trigger.list_by_type = _one_fsop_trigger  # type: ignore[assignment]
    try:
        await fsop_watcher.rearm()
        assert trigger.id in fsop_watcher._tasks, (
            "a re-seeded FSOp trigger was stored but never watched"
        )
    finally:
        Trigger.list_by_type = original  # type: ignore[assignment]
        await fsop_watcher.stop()
