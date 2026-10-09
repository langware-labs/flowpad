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

    async def write_files(self, path: str, data: bytes) -> list[str]:
        Path(path).write_bytes(data)
        return [path]

    async def delete_files(self, path: str) -> None:
        Path(path).unlink(missing_ok=True)


class RecordingNode(LocalNode):
    """Runs real git like ``LocalNode`` and keeps every command it was sent."""

    def __init__(self) -> None:
        self.commands: list[str] = []

    async def run_command(self, command: str, background: bool = False):
        self.commands.append(command)
        return await super().run_command(command, background)


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

    status = await GitRepo(str(repo), LocalNode()).get_status(line_counts=True)
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

    await GitRepo(str(repo), LocalNode()).get_status(line_counts=True)

    after = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True).stdout
    assert after == before
    assert not list((repo / ".git").glob("flowpad-status-*"))


@pytest.mark.asyncio
async def test_status_skips_line_counts_unless_asked(repo: Path):
    """Counts are opt-in: the default call lists the same files with no counts,
    and never builds the throwaway index."""
    (repo / "tracked.txt").write_text("a\nb\nc\nd\n")
    (repo / "brand_new.txt").write_text("1\n2\n")
    git_dir = repo / ".git"
    before = set(git_dir.iterdir())

    status = await GitRepo(str(repo), LocalNode()).get_status()

    assert {f.path: (f.status, f.insertions, f.deletions) for f in status.files} == {
        "tracked.txt": ("M", None, None),
        "brand_new.txt": ("?", None, None),
    }
    assert not list(git_dir.glob("flowpad-status-*"))
    assert set(git_dir.iterdir()) == before


@pytest.mark.asyncio
async def test_status_counts_a_repo_with_no_commits(tmp_path: Path):
    _git(tmp_path, "init", "-q", "-b", "main", ".")
    (tmp_path / "first.txt").write_text("q\nw\n")

    status = await GitRepo(str(tmp_path), LocalNode()).get_status(line_counts=True)

    assert [(f.path, f.insertions, f.deletions) for f in status.files] == [("first.txt", 2, 0)]


@pytest.mark.asyncio
async def test_status_reports_remote_and_its_browser_url(repo: Path):
    status = await GitRepo(str(repo), LocalNode()).get_status()
    assert (status.remote_url, status.remote_web_url) == (None, None)

    _git(repo, "remote", "add", "origin", "https://x-access-token:secret@github.com/org/repo.git")
    status = await GitRepo(str(repo), LocalNode()).get_status()
    # Credentials never reach the UI; the browser form drops .git.
    assert status.remote_url == "https://github.com/org/repo.git"
    assert status.remote_web_url == "https://github.com/org/repo"

    _git(repo, "remote", "set-url", "origin", "git@github.com:org/repo.git")
    status = await GitRepo(str(repo), LocalNode()).get_status()
    assert status.remote_url == "git@github.com:org/repo.git"
    assert status.remote_web_url == "https://github.com/org/repo"



@pytest.mark.asyncio
async def test_status_counts_staged_and_oddly_named_files(repo: Path):
    """Staged and unstaged edits of one file add up against HEAD; a staged new
    file is tracked, an untracked one named like a glob names only itself."""
    (repo / "tracked.txt").write_text("a\nb\nc\nd\n")
    _git(repo, "add", "tracked.txt")
    (repo / "tracked.txt").write_text("a\nb\nc\nd\ne\n")
    (repo / "staged_new.txt").write_text("s\n")
    _git(repo, "add", "staged_new.txt")
    (repo / "*.txt").write_text("1\n2\n")

    status = await GitRepo(str(repo), LocalNode()).get_status(line_counts=True)
    counts = {f.path: (f.insertions, f.deletions) for f in status.files}

    assert counts["tracked.txt"] == (2, 0)
    assert counts["staged_new.txt"] == (1, 0)
    assert counts["*.txt"] == (2, 0)
    assert not list((repo / ".git").glob("flowpad-status-*"))


@pytest.mark.asyncio
async def test_tracked_files_count_through_the_real_index(repo: Path):
    """An index rebuilt from HEAD has no stat cache, so diffing through it
    re-hashes every tracked file — seconds per call on a large repo, every few
    seconds while the Git panel is open. Tracked paths must diff through the
    real index, and the throwaway index exists only when there are untracked
    files to count."""
    (repo / "tracked.txt").write_text("a\nb\nc\nd\n")

    node = RecordingNode()
    await GitRepo(str(repo), node).get_status(line_counts=True)
    assert not [c for c in node.commands if "read-tree" in c or "GIT_INDEX_FILE" in c]

    (repo / "brand_new.txt").write_text("1\n")
    node = RecordingNode()
    status = await GitRepo(str(repo), node).get_status(line_counts=True)
    assert not [c for c in node.commands if "read-tree" in c]
    assert {f.path: (f.insertions, f.deletions) for f in status.files}["brand_new.txt"] == (1, 0)
