"""``Project.setup_from_git_origin`` routes through the ONE checkout policy
(``GitOriginDriver.materialize``): it passes the current user's token, binds
the shared Project id to whatever root the driver returns, and indexes it."""

from __future__ import annotations

import pytest

import flow_sdk.builtin.agentic_process.agentic_process as agentic_process
from flow_sdk.builtin.drivers.git_driver import GitOriginDriver
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.origin.git_origin import GitOrigin
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all

register_all()


@pytest.mark.asyncio
async def test_setup_from_git_origin_materializes_through_the_driver(tmp_path, monkeypatch, initialize_test_db):
    checkout = tmp_path / "acme-repo"
    checkout.mkdir()
    origin = GitOrigin(provider="github", owner="acme", name="repo", branch="main", rel_path=".")
    seen: dict = {}

    async def _materialize(_self, _origin, **kwargs):
        seen.update(kwargs)
        return checkout, None

    async def _index(path, **_kwargs):
        seen["indexed"] = path

    async def _token():
        return "ghs_token"

    monkeypatch.setattr(GitOriginDriver, "materialize", _materialize)
    monkeypatch.setattr(agentic_process, "_index_additional_dir", _index)
    monkeypatch.setattr("flow_sdk.app.actions.oauth_action._get_github_token_for_current_user", _token)

    project = Project(name="shared", origin=origin)
    await project.save()
    result = await project.setup_from_git_origin()

    assert result is project
    assert seen["token"] == "ghs_token"  # the caller's credential rides into the driver
    assert seen["indexed"] == str(checkout)
    assert project.fs_storage_mount_path == canonical_posix_path(str(checkout))
    assert project.name == "acme-repo" and project.remote is True


@pytest.mark.asyncio
async def test_setup_from_git_origin_requires_a_git_origin(initialize_test_db):
    project = Project(name="local-only")
    with pytest.raises(RuntimeError):
        await project.setup_from_git_origin()
