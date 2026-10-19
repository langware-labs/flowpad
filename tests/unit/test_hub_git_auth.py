"""Hub credentials are fresh and limited to the configured hub repository URL."""

import subprocess

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo
from flow_sdk.utils.hub_git_auth import hub_git_environment
from tests.unit.conftest import LocalNode


@pytest.mark.asyncio
async def test_hub_credentials_scoped_and_refreshed(tmp_path, monkeypatch):
    import flow_sdk.cli.auth.hub_login as login
    import flow_sdk.cloud_client.transport.hub_http as http

    base = "https://hub.example/api/v1/graph/git_repo"
    remote = base + "/12345678-1234-4234-8234-123456789abc/git"
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "remote", "add", "origin", remote], check=True)
    monkeypatch.setattr(http, "hub_graph_url", lambda *args: base)
    monkeypatch.setattr(login, "resolve_hub_api_key", lambda **kwargs: "first-token")
    folder = GitRepo(str(tmp_path), LocalNode())._folder
    first = await hub_git_environment(folder)
    assert first["GIT_CONFIG_KEY_0"] == f"http.{remote}.extraHeader"
    assert first["GIT_CONFIG_VALUE_0"] == "Authorization: Bearer first-token"
    monkeypatch.setattr(login, "resolve_hub_api_key", lambda **kwargs: "second-token")
    second = await hub_git_environment(folder)
    assert second["GIT_CONFIG_VALUE_0"] == "Authorization: Bearer second-token"
    matched = await folder.git("config", "--get-urlmatch", "http.extraHeader", remote + "/info/refs", env=second)
    assert matched.stdout.strip() == "Authorization: Bearer second-token"
    for foreign in ("https://elsewhere.example/repo.git", base + "/other/git", remote + ".evil"):
        unmatched = await folder.git("config", "--get-urlmatch", "http.extraHeader", foreign, env=second)
        assert not unmatched.ok and not unmatched.stdout.strip()
    assert "token" not in (tmp_path / ".git/config").read_text()
    subprocess.run(["git", "-C", str(tmp_path), "remote", "set-url", "origin", remote + ".evil"], check=True)
    assert await hub_git_environment(folder) == {}


@pytest.mark.asyncio
async def test_failed_fetch_sets_status_error(tmp_path):
    subprocess.run(["git", "init", "-q", "-b", "main", str(tmp_path)], check=True)
    repo = GitRepo(str(tmp_path), LocalNode())
    await repo._git("-c", "user.name=test", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "seed")
    await repo._git("remote", "add", "origin", str(tmp_path / "missing.git"))
    await repo._git("update-ref", "refs/remotes/origin/main", "HEAD")
    await repo._git("branch", "--set-upstream-to=origin/main")
    status = await repo.fetch()
    assert status.error == "Could not fetch remote updates"
