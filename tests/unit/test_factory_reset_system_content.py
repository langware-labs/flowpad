from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, Mock

import pytest

from flow_sdk import system_tools
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

    monkeypatch.setattr(system_tools, "get_db_path", lambda: db_path)
    monkeypatch.setattr(system_tools, "backup_db", AsyncMock(side_effect=backup))
    monkeypatch.setattr(system_tools, "clear_index", AsyncMock(side_effect=clear_index))
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
    system_content_mock = AsyncMock(side_effect=index_system_content)
    monkeypatch.setattr(
        bootstrap_module,
        "index_system_content",
        system_content_mock,
    )

    result = await system_tools.clear_all_data()

    system_content_mock.assert_awaited_once_with()
    assert result.backup_path == str(tmp_path / "backup")
    assert events.index("system_content") > events.index("bootstrap")
