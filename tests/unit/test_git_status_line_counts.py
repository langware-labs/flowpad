"""``GitRepo.get_status`` line counts, against a real git repository.

Mocked-sequence tests (``test_git_repo_dispatch``) can't tell whether the git
commands we send actually produce the right numbers — and the interesting case
here, an untracked file, is precisely the one plain ``git diff --numstat``
cannot see. So this module runs real git in a tmp repo.
"""
import subprocess
import types
from pathlib import Path

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo


class LocalNode:
    """The smallest thing ``GitRepo`` accepts: it runs the shell string locally."""

    compute_provider = None

    async def run_command(self, command: str, background: bool = False):
        p = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)
        return types.SimpleNamespace(all_stdout=p.stdout, all_stderr=p.stderr, exit_code=p.returncode)

    async def exists(self, path: str) -> bool:
        return Path(path).exists()

    async def delete_files(self, path: str) -> None:
        Path(path).unlink(missing_ok=True)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main", ".")
    (tmp_path / "tracked.txt").write_text("a\nb\nc\n")
    (tmp_path / "gone.txt").write_text("x\ny\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "init")
    return tmp_path


@pytest.mark.asyncio
async def test_status_counts_lines_of_untracked_modified_and_deleted(repo: Path):
    (repo / "tracked.txt").write_text("a\nb\nc\nd\n")
    (repo / "gone.txt").unlink()
    (repo / "brand_new.txt").write_text("1\n2\n3\n4\n5\n")

    status = await GitRepo(str(repo), LocalNode()).get_status()
    counts = {f.path: (f.status, f.insertions, f.deletions) for f in status.files}

    # The untracked file is the point: it carries its own line count.
    assert counts["brand_new.txt"] == ("?", 5, 0)
    assert counts["tracked.txt"] == ("M", 1, 0)
    assert counts["gone.txt"] == ("D", 0, 2)


@pytest.mark.asyncio
async def test_status_leaves_the_real_index_and_worktree_alone(repo: Path):
    """The counts come from a throwaway index — nothing may stage, and no temp
    index file may survive the call."""
    (repo / "brand_new.txt").write_text("1\n")
    before = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True).stdout

    await GitRepo(str(repo), LocalNode()).get_status()

    after = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True).stdout
    assert after == before
    assert not list((repo / ".git").glob("flowpad-status-index-*"))


@pytest.mark.asyncio
async def test_status_counts_a_repo_with_no_commits(tmp_path: Path):
    _git(tmp_path, "init", "-q", "-b", "main", ".")
    (tmp_path / "first.txt").write_text("q\nw\n")

    status = await GitRepo(str(tmp_path), LocalNode()).get_status()

    assert [(f.path, f.insertions, f.deletions) for f in status.files] == [("first.txt", 2, 0)]
