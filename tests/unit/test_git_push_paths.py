"""`GitRepo.push(paths=...)` — the scoped commit behind `flow record share`.

Real git repos in ``tmp_path``, no mocks: the whole value of a scoped push is
what it does to an index and a working tree, which a mock cannot tell you.

The properties under test are the ones a caller bets on when it hands a
reviewer a URL: that ONLY the named paths are committed, and that a failure to
commit is never reported as a successful push.
"""

import subprocess

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo
from tests.unit.conftest import LocalNode, git_cmd

pytestmark = pytest.mark.asyncio


async def git_add_commit_push(repo, paths, message):
    return await GitRepo(str(repo), LocalNode()).push(paths=paths, message=message)


def _git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=False)


def _write(repo, rel, text="x\n"):
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


@pytest.fixture()
def repo(git_remote):
    """A seeded checkout with an `origin` it can actually push to."""
    return git_remote.make_checkout("work")


def _upstream_moves(git_remote, rel, text):
    """Someone else pushes ``rel`` first, from a second checkout of the same origin."""
    other = git_remote.make_checkout("other", seed=False)
    git_cmd(other, "pull", "-q", "origin", "main")
    _write(other, rel, text)
    git_cmd(other, "add", "-A")
    git_cmd(other, "commit", "-q", "-m", "upstream")
    git_cmd(other, "push", "-q", "origin", "main")


def _committed_files(repo, ref="HEAD"):
    out = _git(repo, "show", "--name-only", "--pretty=format:", ref).stdout
    return sorted(f for f in out.splitlines() if f.strip())


async def test_commits_and_pushes_only_the_named_paths(repo):
    _write(repo, "docs/breadcrumbs/x.md", "rules\n")
    _write(repo, "tests/test_x.py", "# capsule\n")
    _write(repo, "unrelated.txt", "someone else's work\n")

    result = await git_add_commit_push(str(repo), ["docs/breadcrumbs/x.md", "tests/test_x.py"], "docs(breadcrumb): x")

    assert result.ok and result.committed and result.kind == "pushed"
    assert result.sha and result.branch == "main"
    assert _committed_files(repo) == ["docs/breadcrumbs/x.md", "tests/test_x.py"]
    # The bystander is untouched and still dirty — that is the point.
    assert "unrelated.txt" in _git(repo, "status", "--porcelain").stdout
    # And it really left the machine.
    assert result.sha in _git(repo, "ls-remote", "origin", "main").stdout


async def test_an_unrelated_staged_file_is_neither_committed_nor_mistaken_for_ours(repo):
    """The bug the pathspec-scoped staged check fixes.

    Our path exists and is already committed, so the honest answer is "nothing
    to commit". A repo-wide `git diff --cached --quiet` instead sees someone
    else's staged file, concludes OUR path changed, and commits — sweeping
    their work into a commit they did not make.
    """
    _write(repo, "docs/a.md")
    await git_add_commit_push(str(repo), ["docs/a.md"], "ours")
    head_before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    _write(repo, "theirs.txt", "staged by someone else\n")
    _git(repo, "add", "theirs.txt")

    result = await git_add_commit_push(str(repo), ["docs/a.md"], "should be a no-op")

    assert result.ok is True and result.committed is False
    assert result.kind == "nothing"
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == head_before
    # Their file is still staged and uncommitted — we never touched it.
    assert "A  theirs.txt" in _git(repo, "status", "--porcelain").stdout


async def test_clean_paths_are_a_successful_no_op(repo):
    _write(repo, "docs/a.md")
    await git_add_commit_push(str(repo), ["docs/a.md"], "first")

    again = await git_add_commit_push(str(repo), ["docs/a.md"], "second")

    assert again.ok is True and again.committed is False
    assert again.kind == "nothing"
    assert len(_git(repo, "log", "--oneline").stdout.splitlines()) == 2  # seed + first


async def test_a_missing_path_is_reported_not_swallowed(repo):
    _write(repo, "docs/a.md")

    result = await git_add_commit_push(str(repo), ["docs/a.md", "docs/gone.md"], "partial")

    assert result.ok and result.committed
    assert _committed_files(repo) == ["docs/a.md"]
    assert "docs/gone.md" in (result.warning or "")


async def test_every_path_missing_fails_before_touching_git(repo):
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    result = await git_add_commit_push(str(repo), ["nope.md"], "nothing")

    assert result.ok is False and result.committed is False
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == before


async def test_a_failed_push_still_reports_the_commit(repo):
    """`ok=False` must not imply "nothing happened" — the commit is local now."""
    _git(repo, "remote", "set-url", "origin", str(repo.parent / "does-not-exist.git"))
    _write(repo, "docs/a.md")

    result = await git_add_commit_push(str(repo), ["docs/a.md"], "will fail to push")

    assert result.ok is False
    assert result.committed is True and result.kind != "pushed"
    assert result.sha == _git(repo, "rev-parse", "HEAD").stdout.strip()


async def test_rebases_when_the_upstream_moved(repo, git_remote):
    """A second clone pushes first; our push must still land."""
    _upstream_moves(git_remote, "theirs.md", "upstream moved\n")

    _git(repo, "fetch", "origin")
    _write(repo, "docs/a.md")
    result = await git_add_commit_push(str(repo), ["docs/a.md"], "ours")

    assert result.ok and result.kind == "pushed", result.message
    assert _committed_files(repo) == ["docs/a.md"]
    assert (repo / "theirs.md").exists()  # the rebase brought their commit in


async def test_a_scoped_push_that_conflicts_is_left_for_the_resolver(repo, git_remote):
    """The same conflict answer as the one-click Publish — not a swallowed rebase."""
    _upstream_moves(git_remote, "docs/a.md", "theirs\n")
    _git(repo, "fetch", "origin")
    _write(repo, "unrelated.txt", "someone else's work\n")

    _write(repo, "docs/a.md", "ours\n")
    result = await git_add_commit_push(str(repo), ["docs/a.md"], "ours")

    assert result.kind == "conflict" and result.conflicted == ["docs/a.md"]
    assert result.committed
