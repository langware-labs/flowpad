"""Pins GitFolder against a real git binary and a real bare remote.

Everything here runs actual git. A mock would happily confirm that we build the
argv we think we build, and tell us nothing about the behaviour that matters:
whether a scoped-index commit really leaves the user's staged work alone,
whether an alignment check really catches a moved remote.

The class exposes ONE application operation — ``publish()`` — plus ``discover``,
``lock`` and the raw ``git()`` escape hatch. Everything else is a private step of
that operation. So the flow tests below drive ``publish()``; only the guards
(containment, secret hygiene) reach for the private methods they belong to.

The properties this file exists to hold:

* **Scoped-index commits.** Publishing one path inside a dirty checkout must not
  commit anything else. The single most valuable behaviour here, and the easiest
  to regress.
* **Alignment.** A branch ahead of or diverged from its remote must refuse to
  publish — except for our own half-finished publish, which must recover.
* **Containment.** ``_safe_path`` refuses ``..``, ``.git``, symlinked components
  and nested repositories.
* **Secret hygiene.** The token never reaches argv, and a failure never carries
  git's output.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from flow_sdk.assets.git_publish import GitAuthor
from flow_sdk.utils.command_executor import _LocalCommandExecutor
from flow_sdk.utils.git_folder import (
    GitError,
    GitErrorCode,
    GitFolder,
    validate_branch_name,
    validate_github_remote,
)
from tests.unit.conftest import git_cmd

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

AUTHOR = GitAuthor(name="Test User", email="test@example.com", typeid="user-1")
MARKER = "FlowPad-Asset: markdown-1"

# Nothing here tests executor SELECTION, so threading it through every
# construction is noise.
EXECUTOR = _LocalCommandExecutor()


def git_folder(root, **kwargs) -> GitFolder:
    return GitFolder(root, executor=EXECUTOR, **kwargs)


async def publish(folder: GitFolder, rel: str, **kwargs):
    return await folder.publish(rel, message="publish", author=AUTHOR, **kwargs)


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "branch",
    ["-x", ".hidden", "/leading", "trailing/", "trailing.", "a..b", "a@{b", "with space", "ctrl\x01", "x~1", "a:b"],
)
async def test_invalid_branch_names_are_refused(branch):
    with pytest.raises(GitError) as excinfo:
        validate_branch_name(branch)
    assert excinfo.value.code is GitErrorCode.BRANCH_INVALID


@pytest.mark.parametrize("branch", ["main", "flow-cloud", "feature/x", "v1.2.3"])
async def test_valid_branch_names_pass(branch):
    assert validate_branch_name(branch) == branch


@pytest.mark.parametrize(
    "url",
    [
        "https://user:pw@github.com/o/n.git",  # embedded credentials
        "http://github.com/o/n.git",  # not https
        "https://evil.com/o/n.git",  # not github
        "https://github.com/only-one-part",
        "https://github.com/o/n.git?x=1",
    ],
)
async def test_non_canonical_github_remotes_are_refused(url):
    with pytest.raises(GitError) as excinfo:
        validate_github_remote(url)
    assert excinfo.value.code is GitErrorCode.REMOTE_INVALID


async def test_canonical_github_remote_parses():
    assert validate_github_remote("https://github.com/flowpad/assets.git") == ("flowpad", "assets")


async def test_constructor_refuses_a_remote_with_embedded_credentials(tmp_path: Path):
    """A secret in a URL ends up on disk in .git/config and in every error
    message git prints."""
    with pytest.raises(GitError) as excinfo:
        git_folder(tmp_path, remote_url="https://user:token@example.com/x.git")
    assert excinfo.value.code is GitErrorCode.REMOTE_INVALID


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


async def test_discover_finds_the_enclosing_checkout(git_remote):
    repo = git_remote.make_checkout()
    nested = repo / "a" / "b"
    nested.mkdir(parents=True)
    (nested / "f.txt").write_text("x", encoding="utf-8")

    folder = await GitFolder.discover(executor=EXECUTOR, path=nested / "f.txt")

    assert folder.root.resolve() == repo.resolve()


async def test_discover_outside_a_checkout_raises(tmp_path: Path):
    loose = tmp_path / "loose"
    loose.mkdir()
    with pytest.raises(GitError) as excinfo:
        await GitFolder.discover(executor=EXECUTOR, path=loose)
    assert excinfo.value.code is GitErrorCode.NOT_A_REPO


# ---------------------------------------------------------------------------
# publish() — the application operation
# ---------------------------------------------------------------------------


async def test_publish_commits_the_path_and_pushes(git_remote):
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "note.md").write_text("hello\n", encoding="utf-8")

    receipt = await publish(folder, "note.md")

    assert receipt.changed is True
    assert receipt.branch == "main"
    assert receipt.head_commit == git_cmd(repo, "rev-parse", "HEAD")
    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/main") == receipt.head_commit


async def test_publish_commits_ONLY_the_named_path(git_remote):
    """The behaviour that makes publishing safe inside a dirty checkout: the
    user's unrelated STAGED work must survive untouched."""
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)

    (repo / "other.txt").write_text("staged unrelated\n", encoding="utf-8")
    git_cmd(repo, "add", "other.txt")
    (repo / "asset").mkdir()
    (repo / "asset" / "a.md").write_text("asset\n", encoding="utf-8")

    await publish(folder, "asset")

    assert git_cmd(repo, "show", "--name-only", "--format=", "HEAD").split() == ["asset/a.md"]
    assert git_cmd(repo, "diff", "--cached", "--name-only") == "other.txt", "user's staged work was lost"


async def test_publish_is_a_noop_when_nothing_changed(git_remote):
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    before = git_cmd(repo, "rev-parse", "HEAD")

    receipt = await publish(folder, "README.md")

    assert receipt.changed is False
    assert receipt.head_commit == before


async def test_publish_advances_a_second_branch_in_the_same_push(git_remote):
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "note.md").write_text("hello\n", encoding="utf-8")

    receipt = await publish(folder, "note.md", also_advance="flow-cloud")

    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/flow-cloud") == receipt.head_commit
    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/main") == receipt.head_commit


async def test_the_second_branch_advances_even_when_nothing_changed(git_remote):
    """It may not exist yet, so a clean re-publish still has to create it."""
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)

    receipt = await publish(folder, "README.md", also_advance="flow-cloud")

    assert receipt.changed is False
    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/flow-cloud") == receipt.head_commit


async def test_unrelated_local_commit_blocks_publishing(git_remote):
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "other.txt").write_text("local\n", encoding="utf-8")
    git_cmd(repo, "add", ".")
    git_cmd(repo, "commit", "-q", "-m", "unrelated")

    with pytest.raises(GitError) as excinfo:
        await publish(folder, "README.md")
    assert excinfo.value.code is GitErrorCode.BRANCH_AHEAD


async def test_publishing_from_a_detached_head_is_refused(git_remote):
    repo = git_remote.make_checkout()
    git_cmd(repo, "checkout", "-q", "--detach", "HEAD")
    folder = git_folder(repo, remote_url=git_remote.uri)

    with pytest.raises(GitError) as excinfo:
        await publish(folder, "README.md")
    assert excinfo.value.code is GitErrorCode.DETACHED_HEAD


async def test_a_diverged_branch_is_refused(git_remote, tmp_path: Path):
    """Both sides moved: someone else pushed, and we have a local commit.

    ``other`` is CLONED rather than seeded independently — two fresh ``git
    init``s produce two unrelated root commits whose push order then depends on
    whether they hashed in the same second."""
    repo = git_remote.make_checkout()
    git_cmd(tmp_path, "clone", "-q", git_remote.uri, "other")
    other = tmp_path / "other"
    git_cmd(other, "config", "user.name", "Other User")
    git_cmd(other, "config", "user.email", "other@example.com")
    (other / "theirs.txt").write_text("theirs\n", encoding="utf-8")
    git_cmd(other, "add", ".")
    git_cmd(other, "commit", "-q", "-m", "theirs")
    git_cmd(other, "push", "-q", "origin", "main")

    (repo / "mine.txt").write_text("mine\n", encoding="utf-8")
    git_cmd(repo, "add", ".")
    git_cmd(repo, "commit", "-q", "-m", "mine")

    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    with pytest.raises(GitError) as excinfo:
        await publish(folder, "README.md")
    assert excinfo.value.code is GitErrorCode.BRANCH_DIVERGED


async def test_a_failed_push_is_retried_without_a_second_commit(git_remote, tmp_path: Path):
    """Without retry_marker, a publish that committed then failed to push is
    stuck behind the BRANCH_AHEAD guard forever."""
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "note.md").write_text("pending\n", encoding="utf-8")
    git_cmd(repo, "remote", "set-url", "--push", "origin", (tmp_path / "gone.git").as_uri())

    with pytest.raises(GitError) as first:
        await publish(folder, "note.md", trailers=[MARKER], retry_marker=MARKER)
    assert first.value.code is GitErrorCode.PUSH_REJECTED
    assert first.value.data["head_commit"], "a retry needs the head it left behind"
    pending = git_cmd(repo, "rev-parse", "HEAD")

    git_cmd(repo, "remote", "set-url", "--push", "origin", git_remote.uri)
    receipt = await publish(folder, "note.md", trailers=[MARKER], retry_marker=MARKER)

    assert receipt.changed is True
    assert receipt.head_commit == pending, "the retry must reuse the pending commit"
    assert git_cmd(repo, "rev-list", "--count", "HEAD") == "2", "a second commit was created"


async def test_without_a_retry_marker_a_pending_commit_still_blocks(git_remote, tmp_path: Path):
    """The recovery is opt-in: an unrecognised ahead-branch stays refused."""
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "note.md").write_text("pending\n", encoding="utf-8")
    git_cmd(repo, "remote", "set-url", "--push", "origin", (tmp_path / "gone.git").as_uri())
    with pytest.raises(GitError):
        await publish(folder, "note.md")

    git_cmd(repo, "remote", "set-url", "--push", "origin", git_remote.uri)
    with pytest.raises(GitError) as excinfo:
        await publish(folder, "note.md")
    assert excinfo.value.code is GitErrorCode.BRANCH_AHEAD


async def test_publish_writes_trailers(git_remote):
    repo = git_remote.make_checkout()
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "note.md").write_text("x\n", encoding="utf-8")

    await publish(folder, "note.md", trailers=["FlowPad-User: user-1"])

    assert "FlowPad-User: user-1" in git_cmd(repo, "show", "-s", "--format=%B", "HEAD")


async def test_publish_deletion_is_committed_path_only(git_remote):
    repo = git_remote.make_checkout()
    (repo / "asset").mkdir()
    (repo / "asset" / "a.md").write_text("a\n", encoding="utf-8")
    git_cmd(repo, "add", ".")
    git_cmd(repo, "commit", "-q", "-m", "seed")
    git_cmd(repo, "push", "-q", "origin", "main")
    folder = git_folder(repo, branch="main", remote_url=git_remote.uri)

    (repo / "asset" / "a.md").unlink()
    receipt = await publish(folder, "asset")

    assert receipt.changed is True
    assert git_cmd(repo, "show", "--name-status", "--format=", "HEAD") == "D\tasset/a.md"


# ---------------------------------------------------------------------------
# checkout() — the read counterpart
# ---------------------------------------------------------------------------


async def _publish_subtree(git_remote, branch: str = "flow-cloud") -> str:
    """A remote carrying ``docs/`` and ``other/`` on ``branch``. Returns the head."""
    repo = git_remote.make_checkout("publisher")
    for folder_name in ("docs", "other"):
        (repo / folder_name).mkdir()
        (repo / folder_name / "f.md").write_text(f"{folder_name}\n", encoding="utf-8")
    git_cmd(repo, "add", ".")
    git_cmd(repo, "commit", "-q", "-m", "content")
    git_cmd(repo, "push", "-q", "origin", f"HEAD:refs/heads/{branch}")
    return git_cmd(repo, "rev-parse", "HEAD")


async def test_checkout_materializes_the_subtree_and_reports_the_head(git_remote, tmp_path: Path):
    head = await _publish_subtree(git_remote)
    folder = git_folder(tmp_path / "cache", remote_url=git_remote.uri, branch="flow-cloud")

    receipt = await folder.checkout("docs")

    assert receipt.head_commit == head
    assert (receipt.path / "f.md").read_text(encoding="utf-8") == "docs\n"


async def test_checkout_is_sparse_to_the_named_path(git_remote, tmp_path: Path):
    """A shared asset is a subtree; the rest of the repo must not be fetched."""
    await _publish_subtree(git_remote)
    folder = git_folder(tmp_path / "cache", remote_url=git_remote.uri, branch="flow-cloud")

    receipt = await folder.checkout("docs")

    assert receipt.path.is_dir()
    assert not (folder.root / "other").exists(), "sparse checkout pulled an unrelated subtree"


async def test_checkout_reuses_the_cache_and_follows_the_branch(git_remote, tmp_path: Path):
    await _publish_subtree(git_remote)
    folder = git_folder(tmp_path / "cache", remote_url=git_remote.uri, branch="flow-cloud")
    first = await folder.checkout("docs")

    publisher = tmp_path / "publisher"
    (publisher / "docs" / "f.md").write_text("moved on\n", encoding="utf-8")
    git_cmd(publisher, "add", ".")
    git_cmd(publisher, "commit", "-q", "-m", "second")
    git_cmd(publisher, "push", "-q", "origin", "HEAD:refs/heads/flow-cloud")

    second = await folder.checkout("docs")

    assert second.head_commit != first.head_commit
    assert (second.path / "f.md").read_text(encoding="utf-8") == "moved on\n"


async def test_checkout_refuses_a_cache_holding_a_different_repository(git_remote, tmp_path: Path):
    """Silently re-pointing is how one repo's content gets served as another's."""
    await _publish_subtree(git_remote)
    root = tmp_path / "cache"
    await git_folder(root, remote_url=git_remote.uri, branch="flow-cloud").checkout("docs")

    other_remote = tmp_path / "other.git"
    other_remote.mkdir()
    git_cmd(other_remote, "init", "--bare", "-q", "-b", "main")
    impostor = git_folder(root, remote_url=other_remote.as_uri(), branch="flow-cloud")

    with pytest.raises(GitError) as excinfo:
        await impostor.checkout("docs")
    assert excinfo.value.code is GitErrorCode.REMOTE_MISMATCH


async def test_checkout_of_an_unprovisioned_branch_reports_branch_not_found(git_remote, tmp_path: Path):
    """Never a silent branch-and-push: provisioning belongs to whoever publishes."""
    git_remote.make_checkout("publisher")
    folder = git_folder(tmp_path / "cache", remote_url=git_remote.uri, branch="flow-cloud")

    with pytest.raises(GitError) as excinfo:
        await folder.checkout("docs")
    assert excinfo.value.code is GitErrorCode.BRANCH_NOT_FOUND


@pytest.mark.parametrize("rel", ["../escape", ".git/config", "a/../../escape"])
async def test_checkout_refuses_a_path_that_escapes(git_remote, tmp_path: Path, rel):
    folder = git_folder(tmp_path / "cache", remote_url=git_remote.uri, branch="flow-cloud")
    with pytest.raises(GitError) as excinfo:
        await folder.checkout(rel)
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


# ---------------------------------------------------------------------------
# Containment — the guards the storage layer depends on
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rel", ["../escape", "a/../../escape", ".git/config", "a/.git/config", "..\\escape"])
async def test_safe_path_refuses_escapes(git_remote, rel):
    folder = git_folder(git_remote.make_checkout())
    with pytest.raises(GitError) as excinfo:
        await folder._safe_path(rel)
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


async def test_safe_path_accepts_a_normal_subpath(git_remote):
    repo = git_remote.make_checkout()
    assert await git_folder(repo)._safe_path("docs/notes.md") == repo / "docs" / "notes.md"


async def test_safe_path_refuses_a_symlinked_component(git_remote, tmp_path: Path):
    repo = git_remote.make_checkout()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")
    (repo / "link").symlink_to(outside, target_is_directory=True)

    with pytest.raises(GitError) as excinfo:
        await git_folder(repo)._safe_path("link/secret.txt")
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


async def test_safe_path_refuses_a_nested_repository(git_remote):
    repo = git_remote.make_checkout()
    nested = repo / "vendored"
    nested.mkdir()
    git_cmd(nested, "init", "-q", "-b", "main")

    with pytest.raises(GitError) as excinfo:
        await git_folder(repo)._safe_path("vendored/f.txt")
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


# ---------------------------------------------------------------------------
# Secret hygiene and concurrency
# ---------------------------------------------------------------------------


async def test_failures_never_carry_git_output(git_remote, tmp_path: Path):
    """git stderr can contain the token, so it must not reach a caller."""
    folder = git_folder(tmp_path / "missing", remote_url=git_remote.uri, branch="nope", token="s3cret-token")

    with pytest.raises(GitError) as excinfo:
        await folder._ensure()

    assert "s3cret-token" not in str(excinfo.value)
    assert "fatal:" not in str(excinfo.value), "raw git output leaked into the error"


async def test_token_never_appears_in_the_command_line(git_remote):
    """It travels in the child env, referenced by name from a credential helper."""
    seen: list[list[str]] = []
    folder = git_folder(git_remote.make_checkout(), branch="main", remote_url=git_remote.uri, token="s3cret-token")
    original = folder.executor.run

    async def spy(argv, **kwargs):
        seen.append(list(argv))
        assert "s3cret-token" not in " ".join(argv), "SECURITY: token was passed in argv"
        return await original(argv, **kwargs)

    folder.executor.run = spy  # type: ignore[method-assign]
    await folder._fetch("main")

    assert seen, "no git command ran"
    assert any("credential.helper=" in arg for argv in seen for arg in argv)


async def test_the_raw_git_seam_still_works(git_remote):
    """``git()`` stays public on purpose: the FaaS git panel issues ~17
    subcommands and needs the raw (stdout, stderr, rc)."""
    repo = git_remote.make_checkout()
    result = await git_folder(repo).git("rev-parse", "--abbrev-ref", "HEAD")

    assert result.ok is True
    assert result.stdout.strip() == "main"


async def test_lock_serializes_work_on_one_checkout(git_remote):
    folder = git_folder(git_remote.make_checkout())
    order: list[str] = []

    async def worker(name: str) -> None:
        async with folder.lock():
            order.append(f"{name}-start")
            await asyncio.sleep(0.01)
            order.append(f"{name}-end")

    await asyncio.gather(worker("a"), worker("b"))

    assert order in (
        ["a-start", "a-end", "b-start", "b-end"],
        ["b-start", "b-end", "a-start", "a-end"],
    ), f"work interleaved: {order}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
