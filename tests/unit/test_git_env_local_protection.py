"""Real Git regressions for the init/first-clone paths traced during RCA."""

import pytest

from tests.unit.conftest import git_cmd
from flow_sdk.assets.hub_repo_sync import HubRepoCheckout
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.faas.git_repo import DEFAULT_GITIGNORE, GitRepo
from flow_sdk.config import ComputeProviderType


@pytest.fixture
def local_compute_node():
    return ComputeNode(node_provider_type=ComputeProviderType.LOCAL_MACHINE, node_provider_id="unit-git-ignore")


@pytest.mark.parametrize("existing_ignore", [None, ".env\n", ".env.local\n!.env.local"])
async def test_git_repo_init_excludes_env_local(tmp_path, local_compute_node, existing_ignore):
    if existing_ignore is not None:
        (tmp_path / ".gitignore").write_text(existing_ignore)
    repo = GitRepo(str(tmp_path), local_compute_node)
    assert (await repo.dispatch("init", method="POST")).data["ok"]
    if existing_ignore is None:
        assert (tmp_path / ".gitignore").read_text() == DEFAULT_GITIGNORE
    (tmp_path / ".env.local").write_text("PUBLIC_TEST_VALUE=1\n")
    status = await repo.dispatch("status")
    assert status.status == "SUCCESS"
    assert ".env.local" not in [f["path"] for f in status.data["files"]], status.data["files"]


async def test_reinit_validates_existing_repo_and_is_idempotent(tmp_path, local_compute_node):
    git_cmd(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / ".gitignore").write_text("# Keep custom rules\ncustom/\n.env\n")
    repo = GitRepo(str(tmp_path), local_compute_node)
    assert (await repo.dispatch("init", method="POST")).data["ok"]
    protected = (tmp_path / ".gitignore").read_bytes()
    assert protected.startswith(b"# Keep custom rules\ncustom/\n.env\n")
    assert git_cmd(tmp_path, "check-ignore", ".env.local") == ".env.local"
    assert (await repo.init()).ok
    assert (tmp_path / ".gitignore").read_bytes() == protected


async def test_validation_refuses_tracked_env_local(tmp_path, local_compute_node):
    git_cmd(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / ".env.local").write_text("PUBLIC_TEST_VALUE=1\n")
    git_cmd(tmp_path, "add", ".env.local")
    (tmp_path / ".gitignore").write_text(".env.local\n")
    with pytest.raises(RuntimeError, match="already tracked"):
        await GitRepo(str(tmp_path), local_compute_node).ensure_gitignore()


async def test_first_hub_clone_excludes_env_local(tmp_path, git_remote, local_compute_node):
    source = git_remote.make_checkout()
    (source / ".gitignore").write_text(".env\n")
    git_cmd(source, "add", ".gitignore")
    git_cmd(source, "commit", "-qm", "Ignore dotenv")
    git_cmd(source, "push", "-q")
    target = tmp_path / "received"
    await HubRepoCheckout(root=target, clone_url=git_remote.uri, branch="main", token="").checkout()
    (target / ".env.local").write_text("PUBLIC_TEST_VALUE=1\n")
    status = await GitRepo(str(target), local_compute_node).dispatch("status")
    assert status.status == "SUCCESS"
    assert ".env.local" not in [f["path"] for f in status.data["files"]], status.data["files"]


async def test_first_git_origin_clone_excludes_env_local(tmp_path, git_remote, local_compute_node):
    from flow_sdk.builtin.drivers.git_driver import GitOriginDriver
    from flow_sdk.fs_store.origin.git_origin import GitOrigin

    git_remote.make_checkout()
    target = tmp_path / "received"
    origin = GitOrigin.from_url(git_remote.uri, branch="main")
    await GitOriginDriver().materialize(origin, preferred_root=target)
    (target / ".env.local").write_text("PUBLIC_TEST_VALUE=1\n")
    status = await GitRepo(str(target), local_compute_node).dispatch("status")
    assert ".env.local" not in [f["path"] for f in status.data["files"]], status.data["files"]
