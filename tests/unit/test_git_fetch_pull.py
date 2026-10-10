"""``GitRepo.fetch`` / ``GitRepo.pull`` — the footer's "Pull (from cloud)".

Real git, two clones of one bare origin: what's under test is that a fetch is
what makes ``behind`` move, and that a pull brings the commits in without
asking the user to commit their own work first.
"""

import os
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo
from tests.unit.conftest import LocalNode

pytestmark = pytest.mark.asyncio


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
    # GitRepo commits and rebases as the repo's own user: a machine with no global identity (CI) has none.
    for repo in (mine, theirs):
        _git(repo, "config", "user.email", "t@t")
        _git(repo, "config", "user.name", "t")
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


async def test_status_names_the_remote_branch_only_when_there_is_one(clones):
    mine, _ = clones
    repo = GitRepo(str(mine), LocalNode())
    tracked = await repo.get_status()
    assert (tracked.upstream, tracked.ahead, tracked.behind) == ("origin/main", 0, 0)

    # A branch never pushed has no remote branch — not "up to date".
    _git(mine, "checkout", "-qb", "feature")
    _commit(mine, "f.md", "local only\n")
    assert (await repo.get_status()).upstream is None

    # A remote branch deleted on the server ("[gone]") is no remote branch either.
    _git(mine, "push", "-qu", "origin", "feature")
    assert (await repo.get_status()).upstream == "origin/feature"
    _git(mine, "push", "-q", "origin", "--delete", "feature")
    assert (await repo.get_status()).upstream is None


@pytest.mark.parametrize(
    ("line", "parsed"),
    [
        ("## main", ("main", None, 0, 0)),
        ("## main...origin/main", ("main", "origin/main", 0, 0)),
        ("## main...origin/main [ahead 1, behind 2]", ("main", "origin/main", 1, 2)),
        ("## main...origin/main [gone]", ("main", None, 0, 0)),
        ("## HEAD (no branch)", (None, None, 0, 0)),
        ("## No commits yet on main", ("main", None, 0, 0)),
        ("## No commits yet on main...origin/main", ("main", "origin/main", 0, 0)),
    ],
)
async def test_branch_header_parse(line, parsed):
    assert GitRepo._parse_branch_header(line) == parsed


# ---------------------------------------------------------------------------
# One conflict flow: push and pull detect the same way, report the paths, and
# refuse to start over a tree that is still stuck.
# ---------------------------------------------------------------------------


def _out(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout


async def test_a_conflicting_push_names_the_paths_and_leaves_the_rebase_open(clones):
    mine, theirs = clones
    _commit(theirs, "README.md", "theirs\n")
    _git(theirs, "push", "-q")
    (mine / "README.md").write_text("mine\n")

    repo = GitRepo(str(mine), LocalNode())
    result = await repo.push()

    assert not result.ok and result.kind == "conflict"
    assert result.conflicted == ["README.md"] and result.committed
    status = await repo.get_status()
    assert status.conflict is not None
    assert (status.conflict.paths, status.conflict.operation) == (["README.md"], "rebase")


async def test_a_second_push_over_an_open_conflict_stages_nothing(clones):
    """Staging over conflict markers would commit them — the guard refuses first."""
    mine, theirs = clones
    _commit(theirs, "README.md", "theirs\n")
    _git(theirs, "push", "-q")
    (mine / "README.md").write_text("mine\n")
    repo = GitRepo(str(mine), LocalNode())
    await repo.push()
    index_before = _out(mine, "ls-files", "--stage")

    again = await repo.push()

    assert again.kind == "conflict" and again.conflicted == ["README.md"]
    assert _out(mine, "ls-files", "--stage") == index_before
    pulled = await repo.pull()
    assert pulled.kind == "conflict" and pulled.conflicted == ["README.md"]


async def test_a_rebase_marked_resolved_but_not_continued_is_still_stuck(clones):
    mine, theirs = clones
    _commit(theirs, "README.md", "theirs\n")
    _git(theirs, "push", "-q")
    _commit(mine, "README.md", "mine\n")
    repo = GitRepo(str(mine), LocalNode())
    await repo.pull()
    (mine / "README.md").write_text("merged\n")
    _git(mine, "add", "README.md")

    status = await repo.get_status()
    assert status.conflict is not None and status.conflict.operation == "rebase"
    assert (await repo.push()).kind == "conflict"


async def test_a_pull_conflict_reports_its_paths(clones):
    mine, theirs = clones
    _commit(theirs, "README.md", "theirs\n")
    _git(theirs, "push", "-q")
    _commit(mine, "README.md", "mine\n")

    result = await GitRepo(str(mine), LocalNode()).pull()
    assert result.conflicted == ["README.md"]


async def test_a_clean_tree_has_no_conflict_in_status(clones):
    mine, _ = clones
    assert (await GitRepo(str(mine), LocalNode()).get_status()).conflict is None


async def test_pull_refuses_a_branch_other_than_the_checked_out_one(clones):
    mine, _ = clones
    result = await GitRepo(str(mine), LocalNode()).pull(branch="feature")
    assert not result.ok and result.kind == "generic" and "feature" in result.message


async def test_pull_on_the_named_branch_pulls(clones):
    mine, theirs = clones
    _commit(theirs, "notes.md", "from the cloud\n")
    _git(theirs, "push", "-q")
    result = await GitRepo(str(mine), LocalNode()).pull(branch="main")
    assert result.ok and result.kind == "pulled"


async def test_a_finished_rebase_is_not_stuck(clones):
    """``REBASE_HEAD`` outlives the rebase; a clean tree must push again."""
    mine, theirs = clones
    _commit(theirs, "README.md", "theirs\n")
    _git(theirs, "push", "-q")
    (mine / "README.md").write_text("mine\n")
    repo = GitRepo(str(mine), LocalNode())
    assert (await repo.push()).kind == "conflict"

    (mine / "README.md").write_text("merged\n")
    _git(mine, "add", "README.md")
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "rebase", "--continue"],
        cwd=mine,
        check=True,
        capture_output=True,
        env={**os.environ, "GIT_EDITOR": "true"},
    )

    assert (await repo.get_status()).conflict is None
    pushed = await repo.push()
    assert pushed.ok and pushed.kind == "pushed", pushed.message
