"""Could a STRANGER clone this project's repository?

The question the team-share dialog asks before inviting a whole team to a
project. It is not the same question as ``git_share_preflight``: preflight says
the sender may publish, this says whether the people published to will be able
to read what lands. A private repo passes every preflight gate and then refuses
to open for every recipient who is not already a collaborator on it.

The load-bearing detail, and the reason this file exists at all: the probe must
run with the CALLER's own credential helpers switched off. Run with them, the
admin's keychain (osxkeychain, `gh auth`, a cached PAT) answers, every repo they
can read looks public, and the warning never fires for exactly the people who
need it.
"""

import subprocess
from pathlib import Path

import pytest

from flow_sdk.app.actions.git_share_preflight_action import git_anonymous_access
from flow_sdk.schema.types import EntityType
from flow_sdk.utils import git as git_utils

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROJECT_ID = "3c1d5a6e-6f70-4a81-9b2c-0d1e2f3a4b5c"


def _g(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


def _repo(root: Path, remote: str | None = "https://github.com/Acme/Widgets.git") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    _g(root, "init", "-q")
    _g(root, "checkout", "-q", "-b", "main")
    _g(root, "config", "user.email", "t@t.co")
    _g(root, "config", "user.name", "t")
    if remote:
        _g(root, "remote", "add", "origin", remote)
    (root / "README.md").write_text("# widgets\n", encoding="utf-8")
    _g(root, "add", "-A")
    _g(root, "commit", "-qm", "init")
    return root


def _stub_project(monkeypatch, mount: str | None):
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    class _Fake:
        fs_storage_mount_path = mount

    async def _get_one(query):  # noqa: ARG001
        return _Fake()

    monkeypatch.setattr(Project, "get_one", staticmethod(_get_one))


async def _access(monkeypatch, mount: str | None) -> dict:
    _stub_project(monkeypatch, mount)
    return await git_anonymous_access(EntityType.PROJECT.value, PROJECT_ID)


@pytest.mark.asyncio
async def test_public_repo_is_readable_by_anyone(tmp_path, monkeypatch):
    repo = _repo(tmp_path / "repo")
    seen: dict = {}

    async def _fake_access(url, token=None, *, ignore_local_credentials=False):
        seen.update(url=url, token=token, anonymous=ignore_local_credentials)
        return True, "main"

    # The action imports the probe from ``flow_sdk.utils.git`` at call time, so
    # the module attribute is the seam.
    monkeypatch.setattr(git_utils, "git_remote_access", _fake_access)

    res = await _access(monkeypatch, str(repo))

    assert res["public"] is True
    assert res["repo"] == "Acme/Widgets"
    assert res["code"] is None
    # The probe is anonymous and carries no token — otherwise it answers for the
    # admin rather than for the team.
    assert seen["anonymous"] is True
    assert seen["token"] is None


@pytest.mark.asyncio
async def test_private_repo_is_not_public(tmp_path, monkeypatch):
    repo = _repo(tmp_path / "repo")

    async def _refused(url, token=None, *, ignore_local_credentials=False):  # noqa: ARG001
        return False, None

    monkeypatch.setattr(git_utils, "git_remote_access", _refused)

    res = await _access(monkeypatch, str(repo))

    assert res["public"] is False
    assert res["repo"] == "Acme/Widgets"


@pytest.mark.asyncio
async def test_no_repository_is_unknown_not_public(tmp_path, monkeypatch):
    """A directory outside any repo answers `None`, never `True`.

    The warning exists to fire on doubt; an undetermined probe that read as
    "public" would be the one silence that matters.
    """
    loose = tmp_path / "loose"
    loose.mkdir()

    res = await _access(monkeypatch, str(loose))

    assert res["public"] is None
    assert res["code"] == "not-in-repo"


@pytest.mark.asyncio
async def test_repo_without_a_remote_is_unknown(tmp_path, monkeypatch):
    repo = _repo(tmp_path / "repo", remote=None)

    res = await _access(monkeypatch, str(repo))

    assert res["public"] is None
    assert res["code"] == "missing-remote"


@pytest.mark.asyncio
async def test_anonymous_probe_resets_the_credential_helper(monkeypatch):
    """`ignore_local_credentials` must reach git as an emptied helper list.

    Asserted on the argv rather than on behaviour because the behaviour it
    prevents — the local keychain silently authenticating — cannot be reproduced
    in a test without a real private repo and a real credential.
    """
    captured: dict = {}

    def _fake_run(cmd, **kwargs):  # noqa: ARG001
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="ref: refs/heads/main\tHEAD\n", stderr="")

    monkeypatch.setattr(git_utils.subprocess, "run", _fake_run)

    ok, branch = await git_utils.git_remote_access("https://github.com/Acme/Widgets.git", ignore_local_credentials=True)

    assert ok is True
    assert branch == "main"
    cmd = captured["cmd"]
    # An EMPTY value is what resets the list (git-config(1)); a helper named
    # here would defeat the whole point.
    assert "credential.helper=" in cmd
    assert cmd.index("credential.helper=") < cmd.index("ls-remote")


@pytest.mark.asyncio
async def test_probe_leaves_credentials_alone_by_default(monkeypatch):
    """Every other caller keeps asking "can THIS machine read it"."""
    captured: dict = {}

    def _fake_run(cmd, **kwargs):  # noqa: ARG001
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="ref: refs/heads/main\tHEAD\n", stderr="")

    monkeypatch.setattr(git_utils.subprocess, "run", _fake_run)

    await git_utils.git_remote_access("https://github.com/Acme/Widgets.git")

    assert "credential.helper=" not in captured["cmd"]
