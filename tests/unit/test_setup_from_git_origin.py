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
    # The sender's name survives the install: the folder leaf is only a fallback,
    # so a course shared as "Web basics" never arrives named "repo".
    assert project.name == "shared" and project.remote is True


@pytest.mark.asyncio
async def test_a_nameless_shared_project_falls_back_to_the_folder_leaf(tmp_path, monkeypatch, initialize_test_db):
    checkout = tmp_path / "acme-repo"
    checkout.mkdir()
    origin = GitOrigin(provider="github", owner="acme", name="repo", branch="main", rel_path=".")

    async def _materialize(_self, _origin, **_kwargs):
        return checkout, None

    async def _index(_path, **_kwargs):
        return None

    async def _token():
        return None

    monkeypatch.setattr(GitOriginDriver, "materialize", _materialize)
    monkeypatch.setattr(agentic_process, "_index_additional_dir", _index)
    monkeypatch.setattr("flow_sdk.app.actions.oauth_action._get_github_token_for_current_user", _token)

    project = Project(name="", origin=origin)
    await project.save()
    await project.setup_from_git_origin()

    assert project.name == "acme-repo"


@pytest.mark.asyncio
async def test_setup_from_git_origin_requires_a_git_origin(initialize_test_db):
    project = Project(name="local-only")
    with pytest.raises(RuntimeError):
        await project.setup_from_git_origin()


# ---------------------------------------------------------------------------
# Typed clone failures (R14 / KTD11): ``setup-from-git`` answers a refused
# install with ``data.code`` so the install chip can say WHY, not just "400".
# These drive the real ``GitOriginDriver.materialize``; only the git subprocess
# and the workspace lookups are replaced.
# ---------------------------------------------------------------------------

_PRIVATE_REPO_STDERR = (
    "Cloning into 'secret'...\n"
    "remote: Repository not found.\n"
    "fatal: repository 'https://github.com/acme/secret.git/' not found\n"
)
_NO_CREDENTIAL_STDERR = (
    "Cloning into 'secret'...\n"
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"
)


def _clone_fixture(tmp_path, monkeypatch, *, stderr: str | None, token: str | None):
    """Route materialize to a fresh slot and a scripted ``git clone``.

    ``stderr=None`` scripts a successful clone. Returns what the fakes saw.
    """
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult

    slot = tmp_path / "workspace" / "secret"
    seen: dict = {}

    async def _git_clone(url, target, branch=None, token=None):
        seen.update(url=url, target=target, token=token)
        if stderr is None:
            (slot / ".git").mkdir(parents=True)
            return CliResult.of_process("git clone", 0, "", "", detail="Cloned successfully.")
        return CliResult.of_process("git clone", 128, "", stderr, detail=f"Git clone failed: {stderr.strip()}")

    async def _index(path, **_kwargs):
        seen["indexed"] = path

    async def _token():
        return token

    async def _no_bootstrap(_self):
        return None

    monkeypatch.setattr("flow_sdk.utils.git.git_clone", _git_clone)
    monkeypatch.setattr(GitOrigin, "local_checkout", lambda _self: None)
    monkeypatch.setattr(GitOrigin, "next_clone_target", lambda _self: slot)
    monkeypatch.setattr(agentic_process, "_index_additional_dir", _index)
    monkeypatch.setattr("flow_sdk.app.actions.oauth_action._get_github_token_for_current_user", _token)
    monkeypatch.setattr(Project, "reconcile_bootstrap", _no_bootstrap)
    seen["slot"] = slot
    return seen


async def _shared_project() -> Project:
    origin = GitOrigin(provider="github", owner="acme", name="secret", branch="", rel_path=".")
    project = Project(name="Secret course", origin=origin)
    await project.save()
    return project


@pytest.mark.asyncio
async def test_setup_from_git_names_an_inaccessible_repo(tmp_path, monkeypatch, initialize_test_db):
    """AE6: a private repo the invitee is not a collaborator on — GitHub says
    "Repository not found" — comes back as REPO_NOT_ACCESSIBLE and nothing is bound."""
    seen = _clone_fixture(tmp_path, monkeypatch, stderr=_PRIVATE_REPO_STDERR, token="ghs_token")
    project = await _shared_project()
    mount_before = project.fs_storage_mount_path

    response = await project.setup_from_git()

    assert response.status == "FAIL"
    assert response.status_code == 400
    assert response.data == {"code": "REPO_NOT_ACCESSIBLE"}
    assert response.message  # a sentence the chip can fall back to
    # The project stays uninstalled: not bound to the slot, not indexed.
    assert project.fs_storage_mount_path == mount_before
    assert "indexed" not in seen and not project.remote


@pytest.mark.asyncio
async def test_setup_from_git_without_a_github_token_is_auth_required(tmp_path, monkeypatch, initialize_test_db):
    seen = _clone_fixture(tmp_path, monkeypatch, stderr=_NO_CREDENTIAL_STDERR, token=None)
    project = await _shared_project()

    response = await project.setup_from_git()

    assert seen["token"] is None
    assert response.status_code == 400
    assert response.data == {"code": "AUTH_REQUIRED"}


@pytest.mark.asyncio
async def test_setup_from_git_unknown_clone_failure_is_upstream_unavailable(tmp_path, monkeypatch, initialize_test_db):
    _clone_fixture(tmp_path, monkeypatch, stderr="error: RPC failed; curl 92 HTTP/2 stream 0 was not closed", token=None)
    project = await _shared_project()

    response = await project.setup_from_git()

    assert response.status_code == 400
    assert response.data == {"code": "UPSTREAM_UNAVAILABLE"}


@pytest.mark.asyncio
async def test_setup_from_git_success_is_unchanged(tmp_path, monkeypatch, initialize_test_db):
    seen = _clone_fixture(tmp_path, monkeypatch, stderr=None, token="ghs_token")
    project = await _shared_project()

    response = await project.setup_from_git()

    assert response.status == "SUCCESS"
    assert response.data is project
    assert seen["token"] == "ghs_token"
    assert seen["indexed"] == str(seen["slot"])
    assert project.fs_storage_mount_path == canonical_posix_path(str(seen["slot"]))
    assert project.remote is True and project.name == "Secret course"


@pytest.mark.asyncio
async def test_setup_from_git_non_git_failure_carries_no_code(initialize_test_db):
    """Only a classified git failure gets a code; anything else keeps the old
    message-only answer so the chip falls back to the generic sentence."""
    project = Project(name="local-only")

    response = await project.setup_from_git()

    assert response.status_code == 400
    assert not response.data
