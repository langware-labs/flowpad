"""A checkout with a GitHub ``origin`` deploys straight from GitHub at the pushed commit.

What the client sends the hub's deploy as ``source``. "GitHub" is a local bare repository
reached through git's own ``url.<base>.insteadOf``, so the checkout keeps its canonical
``https://github.com/...`` origin URL and every git decision is real.
"""

import subprocess
from pathlib import Path

import pytest

from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError
from flow_sdk.assets.hub_repo_sync import github_deploy_source


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=a", "-c", "user.email=a@x", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture
def project(tmp_path: Path, monkeypatch) -> Path:
    subprocess.run(["git", "init", "-q", "--bare", "--initial-branch=main", str(tmp_path / "shop.git")], check=True)
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", f"url.file://{tmp_path}/.insteadOf")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "https://github.com/acme/")
    checkout = tmp_path / "project"
    checkout.mkdir()
    _git(checkout, "init", "-q", "-b", "main")
    (checkout / "README.md").write_text("hello\n")
    _git(checkout, "add", "-A")
    _git(checkout, "commit", "-qm", "first")
    _git(checkout, "remote", "add", "origin", "https://github.com/acme/shop.git")
    _git(checkout, "push", "-q", "-u", "origin", "main")
    return checkout


def test_a_pushed_github_checkout_deploys_its_head_from_github(project):
    source = github_deploy_source(project)

    assert source is not None
    assert (source["provider"], source["owner"], source["name"]) == ("github", "acme", "shop")
    assert source["head_commit"] == _git(project, "rev-parse", "HEAD")


def test_a_commit_not_on_github_refuses_with_push_then_deploy(project):
    (project / "README.md").write_text("more\n")
    _git(project, "commit", "-qam", "second")

    with pytest.raises(AssetPublishError) as raised:
        github_deploy_source(project)

    assert raised.value.code is AssetPublishCode.NOT_PUSHED
    assert "push" in str(raised.value)


def test_pushed_to_another_remote_is_not_on_github(project, tmp_path):
    subprocess.run(["git", "init", "-q", "--bare", str(tmp_path / "other.git")], check=True)
    _git(project, "remote", "add", "other", str(tmp_path / "other.git"))
    (project / "README.md").write_text("more\n")
    _git(project, "commit", "-qam", "second")
    _git(project, "push", "-q", "other", "main")

    with pytest.raises(AssetPublishError) as raised:
        github_deploy_source(project)

    assert raised.value.code is AssetPublishCode.NOT_PUSHED
    assert raised.value.data == {"count": 1}


def test_uncommitted_work_refuses_the_deploy(project):
    (project / "README.md").write_text("edited\n")

    with pytest.raises(AssetPublishError) as raised:
        github_deploy_source(project)

    assert raised.value.code is AssetPublishCode.NOT_COMMITTED


def test_a_checkout_with_no_github_origin_deploys_from_the_hub_repo(project, tmp_path):
    _git(project, "remote", "set-url", "origin", str(tmp_path / "shop.git"))
    assert github_deploy_source(project) is None
    _git(project, "remote", "remove", "origin")
    assert github_deploy_source(project) is None
    assert github_deploy_source(tmp_path) is None  # not a checkout at all


async def test_deploy_names_the_projects_github_commit(project):
    from flow_sdk.builtin.cloud_deploy import deploy_source
    from flow_sdk.builtin.project import Project

    source = await deploy_source(Project(name="shop", fs_storage_mount_path=str(project)))

    assert source["head_commit"] == _git(project, "rev-parse", "HEAD")
