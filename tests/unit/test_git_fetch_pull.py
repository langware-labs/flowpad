"""``GitRepo.fetch`` / ``GitRepo.pull`` — the footer's "Pull (from cloud)".

Real git, two clones of one bare origin: what's under test is that a fetch is
what makes ``behind`` move, and that a pull brings the commits in without
asking the user to commit their own work first.
"""

import subprocess
import types
from pathlib import Path

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo

pytestmark = pytest.mark.asyncio


class LocalNode:
    """The smallest thing ``GitRepo`` accepts: it runs the shell string locally."""

    compute_provider = None

    async def run_command(self, command: str, background: bool = False):
        p = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)
        return types.SimpleNamespace(all_stdout=p.stdout, all_stderr=p.stderr, exit_code=p.returncode)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=repo, check=True, capture_output=True
    )


def _commit(repo: Path, name: str, text: str) -> None:
    (repo / name).write_text(text)
    _git(repo, "add", name)
    _git(repo, "commit", "-qm", f"edit {name}")


@pytest.fixture
def clones(tmp_path: Path) -> tuple[Path, Path]:
    """``(mine, theirs)`` — two clones of one origin, both on ``main``."""
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    mine = tmp_path / "mine"
    _git(tmp_path, "clone", "-q", str(origin), str(mine))
    _git(mine, "checkout", "-qb", "main")
    _commit(mine, "README.md", "seed\n")
    _git(mine, "push", "-qu", "origin", "main")
    theirs = tmp_path / "theirs"
    _git(tmp_path, "clone", "-q", "-b", "main", str(origin), str(theirs))
    return mine, theirs


async def test_status_cannot_see_the_remote_but_fetch_can(clones):
    mine, theirs = clones
    _commit(theirs, "notes.md", "from the cloud\n")
    _git(theirs, "push", "-q")

    repo = GitRepo(str(mine), LocalNode())
    assert (await repo.get_status()).behind == 0
    assert (await repo.fetch()).behind == 1
    # The fetch moved the tracking ref, so a plain status now agrees.
    assert (await repo.get_status()).behind == 1


async def test_pull_brings_commits_in_and_keeps_uncommitted_work(clones):
    mine, theirs = clones
    _commit(theirs, "notes.md", "from the cloud\n")
    _git(theirs, "push", "-q")
    (mine / "draft.md").write_text("mine, unsaved\n")
    (mine / "README.md").write_text("seed\nlocal edit\n")

    repo = GitRepo(str(mine), LocalNode())
    await repo.fetch()
    result = await repo.pull()

    assert result.ok and result.kind == "pulled" and result.branch == "main"
    assert (mine / "notes.md").read_text() == "from the cloud\n"
    assert (mine / "README.md").read_text() == "seed\nlocal edit\n"
    assert (mine / "draft.md").exists()
    assert (await repo.get_status()).behind == 0


async def test_pull_with_nothing_new_says_so(clones):
    mine, _ = clones
    result = await GitRepo(str(mine), LocalNode()).pull()
    assert result.ok and result.kind == "nothing"


async def test_pull_without_an_upstream_is_no_remote(tmp_path):
    _git(tmp_path, "init", "-q", "-b", "main", ".")
    _commit(tmp_path, "a.txt", "a\n")
    result = await GitRepo(str(tmp_path), LocalNode()).pull()
    assert not result.ok and result.kind == "no_remote"


async def test_a_conflicting_pull_is_left_for_the_resolver(clones):
    mine, theirs = clones
    _commit(theirs, "README.md", "theirs\n")
    _git(theirs, "push", "-q")
    _commit(mine, "README.md", "mine\n")

    result = await GitRepo(str(mine), LocalNode()).pull()
    assert not result.ok and result.kind == "conflict"
    assert "README.md" in result.message


async def test_unsaved_edits_that_clash_with_the_pull_are_a_conflict_not_a_success(clones):
    """``pull --autostash`` exits 0 when re-applying the stash conflicts."""
    mine, theirs = clones
    _commit(theirs, "README.md", "theirs\n")
    _git(theirs, "push", "-q")
    (mine / "README.md").write_text("mine, unsaved\n")

    result = await GitRepo(str(mine), LocalNode()).pull()
    assert not result.ok and result.kind == "conflict"
    assert "README.md" in result.message
