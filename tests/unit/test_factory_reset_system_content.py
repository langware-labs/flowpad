from unittest.mock import AsyncMock

import pytest

from flow_sdk.server.routes import bootstrap as bootstrap_module


@pytest.mark.asyncio
async def test_system_content_pass_indexes_all_shipped_assets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pass reused by factory reset must include agents, not only docs."""
    user = object()
    project = object()
    system_project = object()
    compute_node = type(
        "ComputeNodeStub",
        (),
        {"_index_system_assets": AsyncMock()},
    )()

    monkeypatch.setattr(bootstrap_module, "init_db", AsyncMock())
    monkeypatch.setattr(
        bootstrap_module,
        "get_or_create_local_user",
        AsyncMock(return_value=user),
    )
    monkeypatch.setattr(
        bootstrap_module,
        "get_or_create_local_project",
        AsyncMock(return_value=project),
    )
    ensure_projects = AsyncMock(return_value=[system_project])
    monkeypatch.setattr(bootstrap_module, "_ensure_system_projects", ensure_projects)
    monkeypatch.setattr(
        bootstrap_module,
        "_reap_protected_path_projects",
        AsyncMock(),
    )
    index_markdowns = AsyncMock()
    monkeypatch.setattr(
        bootstrap_module,
        "_index_system_project_markdowns",
        index_markdowns,
    )
    get_compute_node = AsyncMock(return_value=compute_node)
    monkeypatch.setattr(
        bootstrap_module,
        "get_or_create_local_compute_node",
        get_compute_node,
    )
    monkeypatch.setattr(bootstrap_module, "create_onboarding_assets", AsyncMock())

    await bootstrap_module.index_system_content()

    ensure_projects.assert_awaited_once_with(desktop_user=user)
    index_markdowns.assert_awaited_once_with([system_project])
    get_compute_node.assert_awaited_once_with(
        local_project=project,
        desktop_user=user,
    )
    compute_node._index_system_assets.assert_awaited_once_with()
