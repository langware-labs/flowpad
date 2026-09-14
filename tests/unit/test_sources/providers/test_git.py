"""The ``git`` data source, against real repositories.

Git is the source whose transport already knows what changed, and these pin that: it diffs and
never walks (an untracked file is never reported), the cursor is one commit, a later traversal
reads only what moved since it, a deletion is exact, and a ``git mv`` is a move that carries
identity — never a tombstone beside a new file.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped sources
from flow_sdk.ingest.driver import SegmentCursorView, get_driver
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.providers.git import GitSource
from flow_sdk.sources.testing import Subject, checks_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()


def _commit(repo: Path, message: str = "change") -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


def _repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.name", "Test User")
    _git(path, "config", "user.email", "test@example.com")
    for rel, body in files.items():
        (path / rel).parent.mkdir(parents=True, exist_ok=True)
        (path / rel).write_text(body)
    _commit(path, "seed")
    return path


def _row(repo: Path):
    return SimpleNamespace(id="ds-git", provider="git", account_key="", config={"repo": str(repo), "branch": "main"})


def _view(state: dict | None = None) -> SegmentCursorView:
    return SegmentCursorView(segment_key="main", state=state or {}, first_run=not state)


@pytest.fixture(scope="module")
def seeded_repo(tmp_path_factory):
    return _repo(tmp_path_factory.mktemp("conformance") / "repo", {"a.md": "a", "docs/b.md": "b", "c.md": "c"})


@pytest.mark.parametrize("check", checks_for(GitSource), ids=str)
async def test_conformance(check, seeded_repo):
    binding = SourceBinding(source_id="ds-git", config={"repo": str(seeded_repo)})
    origins = tuple(GitSource(binding).origin(rel) for rel in ("a.md", "docs/b.md", "c.md"))
    await check.run(Subject(source=lambda: GitSource(binding), seeded=origins))


async def test_the_first_pass_diffs_the_empty_tree_and_never_walks(tmp_path):
    repo = _repo(tmp_path / "repo", {"a.md": "a", "docs/b.md": "b"})
    (repo / "untracked.md").write_text("never committed")
    result = await get_driver("git").fetch(_row(repo), _view())
    assert sorted(Path(r).relative_to(repo.resolve()).as_posix() for r in result.refs) == ["a.md", "docs/b.md"]
    assert result.next_state["cursor"] == GitSource.resume_at(_git(repo, "rev-parse", "HEAD"))


async def test_a_later_pass_reads_only_what_moved_since_the_commit(tmp_path):
    repo = _repo(tmp_path / "repo", {"a.md": "a", "b.md": "b"})
    driver = get_driver("git")
    first = await driver.fetch(_row(repo), _view())
    (repo / "b.md").write_text("b, revised")
    _commit(repo)
    second = await driver.fetch(_row(repo), _view(first.next_state))
    assert [Path(r).name for r in second.refs] == ["b.md"] and not second.tombstones
    assert set(second.next_state["manifest"]) == {"a.md", "b.md"}


async def test_an_unmoved_head_is_unchanged(tmp_path):
    repo = _repo(tmp_path / "repo", {"a.md": "a"})
    driver = get_driver("git")
    first = await driver.fetch(_row(repo), _view())
    again = await driver.fetch(_row(repo), _view(first.next_state))
    assert again.unchanged is True and again.next_state["cursor"] == first.next_state["cursor"]


async def test_a_deletion_is_exact(tmp_path):
    repo = _repo(tmp_path / "repo", {"a.md": "a", "b.md": "b"})
    driver = get_driver("git")
    first = await driver.fetch(_row(repo), _view())
    _git(repo, "rm", "-q", "b.md")
    _commit(repo)
    second = await driver.fetch(_row(repo), _view(first.next_state))
    assert [Path(t).name for t in second.tombstones] == ["b.md"] and set(second.next_state["manifest"]) == {"a.md"}


async def test_a_git_mv_is_a_move_never_a_tombstone(tmp_path):
    repo = _repo(tmp_path / "repo", {"a.md": "a body long enough to be a rename", "keep.md": "k"})
    driver = get_driver("git")
    first = await driver.fetch(_row(repo), _view())
    _git(repo, "mv", "a.md", "renamed.md")
    _commit(repo)
    second = await driver.fetch(_row(repo), _view(first.next_state))
    assert {Path(new).name: Path(old).name for new, old in second.renames.items()} == {"renamed.md": "a.md"}
    assert not second.tombstones and set(second.next_state["manifest"]) == {"keep.md", "renamed.md"}


async def test_a_legacy_sha_cursor_resumes_there(tmp_path):
    repo = _repo(tmp_path / "repo", {"a.md": "a"})
    seed = _git(repo, "rev-parse", "HEAD")
    (repo / "b.md").write_text("b")
    _commit(repo)
    result = await get_driver("git").fetch(_row(repo), _view({"sha": seed}))
    assert [Path(r).name for r in result.refs] == ["b.md"]


async def test_a_directory_that_is_not_a_repository_needs_a_person(tmp_path):
    (tmp_path / "plain").mkdir()
    with pytest.raises(Exception) as caught:
        await get_driver("git").fetch(_row(tmp_path / "plain"), _view())
    assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


@pytest.mark.parametrize(
    "setup,expected",
    [
        (lambda tmp: SimpleNamespace(id="ds-git", provider="git", account_key="", config={}), "Set the repository"),
        (lambda tmp: _row((tmp / "plain").resolve()) if (tmp / "plain").mkdir() is None else None, "is not a git repository"),
    ],
)
async def test_verify_says_what_is_missing(tmp_path, setup, expected):
    verdict = await get_driver("git").verify(setup(tmp_path))
    assert verdict.ready is False and expected in verdict.detail


async def test_verify_passes_for_a_repository_with_commits(tmp_path):
    assert (await get_driver("git").verify(_row(_repo(tmp_path / "repo", {"a.md": "a"})))).ready is True


async def test_identity_is_the_documented_cross_machine_handle_when_there_is_a_remote(tmp_path):
    origin = _repo(tmp_path / "origin", {"a.md": "a"})
    _git(tmp_path, "clone", "-q", origin.as_uri(), str(tmp_path / "clone"))
    clone = tmp_path / "clone"
    result = await get_driver("git").fetch(_row(clone), _view())
    assert get_driver("git").origin_id_for(_row(clone), result.refs[0]) not in ("", result.refs[0])


async def test_the_working_tree_is_never_stamped():
    assert get_driver("git").stamps_identity is False
