"""``GitRepo.get_status`` reads a repository in one shell invocation, not eight.

The Git panel polls every few seconds and each command sent to the compute node
is a round trip (a process here, a network call on a remote node). The reads are
one ``sh`` script now; what they ANSWER must not have moved, so every case is
checked three ways: against plain ``git``, against the per-command path (still
what a Windows node runs), and by counting what reached the node.
"""

import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo, _split_sections
from tests.unit.conftest import LocalNode


class CountingNode(LocalNode):
    """The shared ``LocalNode`` (a POSIX compute node, run here), keeping each command it was sent."""

    def __init__(self) -> None:
        super().__init__()
        self.commands: list[str] = []
        self.envs: list[dict[str, str]] = []

    async def run_command(self, command: str, background: bool = False, env=None):
        self.commands.append(command)
        self.envs.append({pair.name: pair.value for pair in env or ()})
        return await super().run_command(command, background=background, env=env)

    async def exists(self, path: str) -> bool:
        return Path(path).exists()

    async def write_files(self, path: str, data: bytes) -> list[str]:
        Path(path).write_bytes(data)
        return [path]

    async def delete_files(self, path: str) -> None:
        Path(path).unlink(missing_ok=True)


def _git(repo: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=repo, check=True, capture_output=True, text=True
    )
    return done.stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main", ".")
    for name, text in (("unstaged.txt", "a\nb\nc\n"), ("staged.txt", "1\n2\n"), ("gone.txt", "x\ny\n"), ("old_name.txt", "k\n")):
        (tmp_path / name).write_text(text)
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "init")
    return tmp_path


def _dirty(repo: Path) -> None:
    """Staged, unstaged, staged-then-edited, deleted, renamed and untracked — one of each."""
    (repo / "unstaged.txt").write_text("a\nb\nc\nd\n")
    (repo / "staged.txt").write_text("1\n2\n3\n")
    _git(repo, "add", "staged.txt")
    (repo / "staged.txt").write_text("1\n2\n3\n4\n")
    (repo / "gone.txt").unlink()
    _git(repo, "mv", "old_name.txt", "new_name.txt")
    (repo / "added.txt").write_text("s\n")
    _git(repo, "add", "added.txt")
    (repo / "sub").mkdir()
    (repo / "sub" / "brand_new.txt").write_text("1\n2\n3\n4\n5\n")
    (repo / "*.txt").write_text("g\n")
    _git(repo, "remote", "add", "origin", "https://user:secret@github.com/org/repo.git")


def _expected_from_plain_git(repo: Path) -> dict[str, tuple[bool, int | None, int | None]]:
    """``{path: (staged, insertions, deletions)}`` worked out with git itself."""
    counts = {}
    for line in _git(repo, "diff", "--numstat", "HEAD").splitlines():
        ins, dels, path = line.split("\t", 2)
        counts[path] = (int(ins), int(dels))
    expected = {}
    for line in _git(repo, "status", "--porcelain=v1", "--untracked-files=all").splitlines():
        xy, path = line[:2], line[3:]
        if xy == "??":
            counts[path] = (len((repo / path).read_text().splitlines()), 0)
        new = path.split(" -> ", 1)[-1]
        expected[path.replace(" -> ", " → ")] = (xy[0] not in " ?", *counts.get(new, (None, None)))
    return expected


def _legacy(repo: Path, node: CountingNode) -> GitRepo:
    """The per-command path a Windows node runs — the status read as it was before."""
    git_repo = GitRepo(str(repo), node)
    git_repo._windows_shell = True
    return git_repo


async def test_a_dirty_tree_is_read_in_two_invocations_and_answers_what_git_says(repo: Path):
    _dirty(repo)
    porcelain_before = _git(repo, "status", "--porcelain=v1")
    node, old_node = CountingNode(), CountingNode()

    status = await GitRepo(str(repo), node).get_status(line_counts=True)
    before = await _legacy(repo, old_node).get_status(line_counts=True)

    assert status == before
    assert {f.path: (f.staged, f.insertions, f.deletions) for f in status.files} == _expected_from_plain_git(repo)
    assert len(status.files) == 7
    assert (status.branch, status.upstream, status.error, status.conflict) == ("main", None, None, None)
    assert (status.remote_url, status.remote_web_url) == ("https://github.com/org/repo.git", "https://github.com/org/repo")
    # One script for status + remote + tracked counts, one for the untracked files.
    # The per-command path also asks whether origin carries the branch: its 9th.
    assert (len(node.commands), len(old_node.commands)) == (2, 9)
    assert all(env.get("LC_ALL") == "C" and env.get("GIT_TERMINAL_PROMPT") == "0" for env in node.envs)
    # The real index is untouched and no throwaway file outlives the call.
    assert _git(repo, "status", "--porcelain=v1") == porcelain_before
    assert not list((repo / ".git").glob("flowpad-status-*"))


async def test_a_tree_with_nothing_untracked_is_one_invocation_with_or_without_counts(repo: Path):
    (repo / "unstaged.txt").write_text("a\nb\n")
    for line_counts, was in ((False, 2), (True, 5)):
        node, old_node = CountingNode(), CountingNode()
        status = await GitRepo(str(repo), node).get_status(line_counts=line_counts)
        assert status == await _legacy(repo, old_node).get_status(line_counts=line_counts)
        assert [(f.path, f.insertions, f.deletions) for f in status.files] == [
            ("unstaged.txt", *((0, 1) if line_counts else (None, None)))
        ]
        assert (len(node.commands), len(old_node.commands)) == (1, was)
        assert "GIT_INDEX_FILE" not in node.commands[0]


async def test_a_repo_with_no_commit_and_a_folder_that_is_no_repo(tmp_path: Path):
    plain = tmp_path / "plain"
    plain.mkdir()
    node = CountingNode()
    assert (await GitRepo(str(plain), node).get_status(line_counts=True)).error == "not a git repository"
    assert len(node.commands) == 1

    unborn = tmp_path / "unborn"
    unborn.mkdir()
    _git(unborn, "init", "-q", "-b", "main", ".")
    (unborn / "first.txt").write_text("q\nw\n")
    (unborn / "second.txt").write_text("e\n")
    _git(unborn, "add", "second.txt")
    node = CountingNode()
    status = await GitRepo(str(unborn), node).get_status(line_counts=True)
    assert status == await _legacy(unborn, CountingNode()).get_status(line_counts=True)
    assert [(f.path, f.status, f.insertions, f.deletions) for f in status.files] == [
        ("second.txt", "A", 1, 0),
        ("first.txt", "?", 2, 0),
    ]
    assert status.branch == "main" and len(node.commands) == 2
    assert not list((unborn / ".git").glob("flowpad-status-*"))


def test_sections_are_told_apart_by_marker_lines():
    out = "## main\n M a.txt\n\n@@flowpad-git:remote@@\ngit@h:o/r.git\n\n@@flowpad-git:remote-rc=0@@\n\n@@flowpad-git:unborn=1@@\n"
    sections, facts = _split_sections(out)
    assert sections[""].splitlines() == ["## main", " M a.txt"]
    assert sections["remote"].strip() == "git@h:o/r.git"
    assert facts == {"remote-rc": "0", "unborn": "1"}
    # No marker at all: the whole text is the status, nothing is known of the rest.
    assert _split_sections("## main\n?? @@x") == ({"": "## main\n?? @@x"}, {})


async def test_a_known_origin_branch_is_offered_without_another_invocation(repo: Path):
    _git(repo, "remote", "add", "origin", "https://github.com/org/repo.git")
    node, old_node = CountingNode(), CountingNode()

    assert (await GitRepo(str(repo), node).get_status()).upstream_candidate is None

    _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    node.commands.clear()
    status = await GitRepo(str(repo), node).get_status()

    assert status.upstream_candidate == "origin/main"
    assert status == await _legacy(repo, old_node).get_status()
    assert len(node.commands) == 1
