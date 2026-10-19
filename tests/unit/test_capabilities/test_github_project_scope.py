from __future__ import annotations

import pytest

from flow_sdk.core.capabilities.models import CapabilityKind, CapabilityScope, CapabilityResult
from flow_sdk.core.capabilities.registry import get_capability_registry


@pytest.mark.asyncio
async def test_github_project_test_is_scoped_and_does_not_use_global_state(monkeypatch):
    import flow_sdk.builtin.project as project_mod
    import flow_sdk.fs_store.origin.git_origin as git_origin_mod
    import flow_sdk.utils.git as git_mod
    import flow_sdk.core.capabilities.registry as registry_mod

    class Project:
        fs_storage_mount_path = "/workspace/project"

    class Origin:
        def clone_url(self):
            return "https://github.com/acme/project.git"

    async def get_project(cls, _id):
        return Project()

    monkeypatch.setattr(project_mod.Project, "get_by_id", classmethod(get_project))
    monkeypatch.setattr(git_origin_mod.GitOrigin, "for_asset_path", lambda _path: Origin())
    monkeypatch.setattr(registry_mod.GithubAccountRunner, "_oauth_token", lambda _self: _async_value("token"))
    monkeypatch.setattr(git_mod, "git_remote_access", lambda *_args, **_kwargs: _async_value((True, "main")))

    result = await get_capability_registry().test(
        CapabilityKind.GITHUB.value,
        scope=CapabilityScope(scope_type="project", scope_id="project-id"),
    )

    assert result.result.available is True
    assert result.result.details["scope_id"] == "project-id"
    assert "authenticated" in result.result.details


async def _async_value(value):
    return value
