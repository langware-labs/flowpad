"""Pins GitFolder against a real git binary and a real bare remote.

Everything here runs actual git. A mock would happily confirm that we build the
argv we think we build, and tell us nothing about the behaviour that matters:
whether a sparse checkout really narrows the tree, whether an optimistic-
concurrency check really catches a moved remote, whether a scoped-index commit
really leaves the user's staged work alone.

The properties this file exists to hold:

* **Containment.** ``safe_path`` refuses ``..``, ``.git``, symlinked components
  and nested repositories — the guards the hub's storage driver depends on.
* **Secret hygiene.** A failure never carries git's output, because that output
  can contain the token.
* **Scoped-index commits.** Publishing one path inside a dirty checkout must not
  commit anything else. This is the single most valuable behaviour in the class
  and the easiest to regress.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from flow_sdk.assets.git_publish import GitAuthor
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
    """The one remote rule GitFolder itself enforces — a secret in a URL ends up
    on disk in .git/config and in every error message git prints."""
    with pytest.raises(GitError) as excinfo:
        GitFolder(tmp_path, remote_url="https://user:token@example.com/x.git")
    assert excinfo.value.code is GitErrorCode.REMOTE_INVALID


# ---------------------------------------------------------------------------
# Discovery and inspection
# ---------------------------------------------------------------------------


async def test_discover_finds_the_enclosing_checkout(git_remote):
    repo = git_remote.make_checkout()
    nested = repo / "a" / "b"
    nested.mkdir(parents=True)
    (nested / "f.txt").write_text("x", encoding="utf-8")

    folder = await GitFolder.discover(nested / "f.txt")

    assert folder.root.resolve() == repo.resolve()


async def test_discover_outside_a_checkout_raises(tmp_path: Path):
    loose = tmp_path / "loose"
    loose.mkdir()
    with pytest.raises(GitError) as excinfo:
        await GitFolder.discover(loose)
    assert excinfo.value.code is GitErrorCode.NOT_A_REPO


async def test_inspection_reads_head_branch_and_remote(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo, branch="main", remote_url=git_remote.uri)

    assert await folder.is_repo() is True
    assert await folder.head() == git_cmd(repo, "rev-parse", "HEAD")
    assert await folder.current_branch() == "main"
    assert await folder.get_remote_url() == git_remote.uri


async def test_current_branch_is_none_when_detached(git_remote):
    repo = git_remote.make_checkout()
    git_cmd(repo, "checkout", "-q", "--detach", "HEAD")
    assert await GitFolder(repo).current_branch() is None


async def test_relation_classifies_divergence(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo, branch="main", remote_url=git_remote.uri)
    base = await folder.head()

    (repo / "local.txt").write_text("local\n", encoding="utf-8")
    git_cmd(repo, "add", ".")
    git_cmd(repo, "commit", "-q", "-m", "local only")
    ahead = await folder.head()

    assert await folder.relation(base, base) == "aligned"
    assert await folder.relation(ahead, base) == "ahead"
    assert await folder.relation(base, ahead) == "behind"


async def test_remote_branch_exists(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo, branch="main", remote_url=git_remote.uri)

    assert await folder.remote_branch_exists("main") is True
    assert await folder.remote_branch_exists("flow-cloud") is False


# ---------------------------------------------------------------------------
# Clone, sparse, sync
# ---------------------------------------------------------------------------


async def test_clone_creates_a_working_checkout(git_remote, tmp_path: Path):
    source = git_remote.make_checkout()
    (source / "docs").mkdir()
    (source / "docs" / "a.md").write_text("a\n", encoding="utf-8")
    git_cmd(source, "add", ".")
    git_cmd(source, "commit", "-q", "-m", "docs")
    git_cmd(source, "push", "-q", "origin", "main")

    folder = await GitFolder.clone(git_remote.uri, tmp_path / "clone", branch="main")

    assert (folder.root / "docs" / "a.md").read_text() == "a\n"


async def test_sparse_clone_narrows_the_working_tree(git_remote, tmp_path: Path):
    """The behaviour entity_git depends on: only the asset subtree lands on disk."""
    source = git_remote.make_checkout()
    for folder_name in ("wanted", "unwanted"):
        (source / folder_name).mkdir()
        (source / folder_name / "f.md").write_text(f"{folder_name}\n", encoding="utf-8")
    git_cmd(source, "add", ".")
    git_cmd(source, "commit", "-q", "-m", "two trees")
    git_cmd(source, "push", "-q", "origin", "main")

    folder = await GitFolder.clone(
        git_remote.uri, tmp_path / "sparse", branch="main", sparse_paths=["wanted"], single_branch=True
    )

    assert (folder.root / "wanted" / "f.md").exists()
    assert not (folder.root / "unwanted").exists(), "sparse checkout did not narrow the tree"
    assert "wanted" in await folder.sparse_paths()


async def test_sparse_paths_cannot_escape_the_repo(git_remote, tmp_path: Path):
    git_remote.make_checkout()  # seed main on the bare remote
    folder = await GitFolder.clone(git_remote.uri, tmp_path / "c", branch="main")
    with pytest.raises(GitError) as excinfo:
        await folder.set_sparse_paths(["../elsewhere"])
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


async def test_clone_into_a_non_empty_directory_is_refused(git_remote, tmp_path: Path):
    target = tmp_path / "occupied"
    target.mkdir()
    (target / "existing.txt").write_text("x", encoding="utf-8")

    with pytest.raises(GitError) as excinfo:
        await GitFolder.clone(git_remote.uri, target, branch="main")
    assert excinfo.value.code is GitErrorCode.NOT_A_REPO


async def test_ensure_refuses_a_checkout_pointing_at_another_repo(git_remote, tmp_path: Path):
    """Silently re-pointing is how one repo's contents get served as another's."""
    repo = git_remote.make_checkout()
    other = tmp_path / "other.git"
    other.mkdir()
    git_cmd(other, "init", "--bare", "-q", "-b", "main")

    with pytest.raises(GitError) as excinfo:
        await GitFolder(repo, remote_url=other.as_uri(), branch="main").ensure()
    assert excinfo.value.code is GitErrorCode.REMOTE_MISMATCH


async def test_clone_of_a_missing_branch_reports_branch_not_found(git_remote, tmp_path: Path):
    """The remote HAS main — only the requested branch is absent. This is the
    BRANCH_NOT_PROVISIONED case entity_git must report cleanly."""
    git_remote.make_checkout()
    with pytest.raises(GitError) as excinfo:
        await GitFolder.clone(git_remote.uri, tmp_path / "c", branch="flow-cloud")
    assert excinfo.value.code is GitErrorCode.BRANCH_NOT_FOUND


async def test_sync_aligns_to_the_remote_and_returns_the_head(git_remote, tmp_path: Path):
    source = git_remote.make_checkout("source")
    consumer = await GitFolder.clone(git_remote.uri, tmp_path / "consumer", branch="main")

    (source / "new.txt").write_text("new\n", encoding="utf-8")
    git_cmd(source, "add", ".")
    git_cmd(source, "commit", "-q", "-m", "advance")
    git_cmd(source, "push", "-q", "origin", "main")
    advanced = git_cmd(source, "rev-parse", "HEAD")

    head = await consumer.sync()

    assert head == advanced
    assert (consumer.root / "new.txt").exists()


async def test_sync_with_a_stale_expected_head_is_refused(git_remote, tmp_path: Path):
    """Optimistic concurrency: the caller's view of the remote is out of date."""
    source = git_remote.make_checkout("source")
    consumer = await GitFolder.clone(git_remote.uri, tmp_path / "consumer", branch="main")
    stale = await consumer.head()

    (source / "new.txt").write_text("new\n", encoding="utf-8")
    git_cmd(source, "add", ".")
    git_cmd(source, "commit", "-q", "-m", "advance")
    git_cmd(source, "push", "-q", "origin", "main")

    with pytest.raises(GitError) as excinfo:
        await consumer.sync(expected_head=stale)
    assert excinfo.value.code is GitErrorCode.ORIGIN_OUT_OF_DATE
    assert excinfo.value.data["head_commit"] == git_cmd(source, "rev-parse", "HEAD")


# ---------------------------------------------------------------------------
# Containment
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rel", ["../escape", "a/../../escape", ".git/config", "a/.git/config", "..\\escape"])
async def test_safe_path_refuses_escapes(git_remote, rel):
    folder = GitFolder(git_remote.make_checkout())
    with pytest.raises(GitError) as excinfo:
        await folder.safe_path(rel)
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


async def test_safe_path_accepts_a_normal_subpath(git_remote):
    repo = git_remote.make_checkout()
    resolved = await GitFolder(repo).safe_path("docs/notes.md")
    assert resolved == repo / "docs" / "notes.md"


async def test_safe_path_refuses_a_symlinked_component(git_remote, tmp_path: Path):
    repo = git_remote.make_checkout()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")
    (repo / "link").symlink_to(outside, target_is_directory=True)

    with pytest.raises(GitError) as excinfo:
        await GitFolder(repo).safe_path("link/secret.txt")
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


async def test_safe_path_refuses_a_nested_repository(git_remote):
    repo = git_remote.make_checkout()
    nested = repo / "vendored"
    nested.mkdir()
    git_cmd(nested, "init", "-q", "-b", "main")

    with pytest.raises(GitError) as excinfo:
        await GitFolder(repo).safe_path("vendored/f.txt")
    assert excinfo.value.code is GitErrorCode.PATH_ESCAPES_REPO


async def test_tree_is_confined(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo)
    (repo / "asset").mkdir()
    (repo / "asset" / "a.md").write_text("a\n", encoding="utf-8")

    assert await folder.tree_is_confined("asset") is True

    (repo / "elsewhere.txt").write_text("nope\n", encoding="utf-8")
    assert await folder.tree_is_confined("asset") is False


async def test_normalize_keep_markers_round_trip(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo)
    empty = repo / "empty"
    empty.mkdir()

    await folder.normalize_keep_markers()
    assert (empty / ".flowpad-vfs-keep").exists(), "empty dir needs a marker to survive a commit"

    (empty / "real.txt").write_text("x", encoding="utf-8")
    await folder.normalize_keep_markers()
    assert not (empty / ".flowpad-vfs-keep").exists(), "marker must go once a real sibling appears"


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


async def test_commit_and_push_advances_the_remote(git_remote, tmp_path: Path):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "f.txt").write_text("content\n", encoding="utf-8")

    head = await folder.commit(["f.txt"], "add f", author=AUTHOR)
    await folder.push()

    assert head == git_cmd(repo, "rev-parse", "HEAD")
    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/main") == head


async def test_commit_with_nothing_staged_returns_none(git_remote):
    repo = git_remote.make_checkout()
    assert await GitFolder(repo).commit(["README.md"], "no-op", author=AUTHOR) is None


async def test_commit_writes_trailers(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo)
    (repo / "f.txt").write_text("x\n", encoding="utf-8")

    await folder.commit(["f.txt"], "subject", author=AUTHOR, trailers=["FlowPad-User: user-1"])

    assert "FlowPad-User: user-1" in git_cmd(repo, "show", "-s", "--format=%B", "HEAD")


async def test_scoped_index_commit_preserves_unrelated_staged_work(git_remote):
    """The behaviour that makes publishing safe inside a dirty checkout.

    Without the temporary index, ``git add``/``commit`` would sweep the user's
    already-staged ``other.txt`` into the asset commit.
    """
    repo = git_remote.make_checkout()
    folder = GitFolder(repo, branch="main", remote_url=git_remote.uri)

    (repo / "other.txt").write_text("staged unrelated\n", encoding="utf-8")
    git_cmd(repo, "add", "other.txt")
    (repo / "asset").mkdir()
    (repo / "asset" / "a.md").write_text("asset\n", encoding="utf-8")

    await folder.commit(["asset"], "publish asset", author=AUTHOR, scoped_index=True)

    committed = git_cmd(repo, "show", "--name-only", "--format=", "HEAD").split()
    assert committed == ["asset/a.md"], f"commit swept in unrelated paths: {committed}"
    assert git_cmd(repo, "diff", "--cached", "--name-only") == "other.txt", "user's staged work was lost"


async def test_create_branch_from_a_start_point_and_push(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo, branch="main", remote_url=git_remote.uri)
    main_head = await folder.head()

    await folder.create_branch("flow-cloud", start_point="main", push=True)

    assert folder.branch == "flow-cloud"
    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/flow-cloud") == main_head


async def test_push_rejection_surfaces_a_typed_error(git_remote, tmp_path: Path):
    """No network needed — point the push URL at a repo that does not exist."""
    repo = git_remote.make_checkout()
    git_cmd(repo, "remote", "set-url", "--push", "origin", (tmp_path / "gone.git").as_uri())
    folder = GitFolder(repo, branch="main", remote_url=git_remote.uri)
    (repo / "f.txt").write_text("x\n", encoding="utf-8")
    await folder.commit(["f.txt"], "c", author=AUTHOR)

    with pytest.raises(GitError) as excinfo:
        await folder.push()
    assert excinfo.value.code in {GitErrorCode.UPSTREAM_UNAVAILABLE, GitErrorCode.AUTH_FAILED}


async def test_restore_returns_the_tree_to_a_known_head(git_remote):
    repo = git_remote.make_checkout()
    folder = GitFolder(repo)
    before = await folder.head()

    (repo / "f.txt").write_text("x\n", encoding="utf-8")
    await folder.commit(["f.txt"], "c", author=AUTHOR)
    (repo / "junk.txt").write_text("junk\n", encoding="utf-8")

    await folder.restore(before)

    assert await folder.head() == before
    assert not (repo / "f.txt").exists()
    assert not (repo / "junk.txt").exists()


# ---------------------------------------------------------------------------
# Secret hygiene and concurrency
# ---------------------------------------------------------------------------


async def test_failures_never_carry_git_output(git_remote, tmp_path: Path):
    """git stderr can contain the token, so it must not reach a caller."""
    folder = GitFolder(tmp_path / "missing", remote_url=git_remote.uri, branch="nope", token="s3cret-token")

    with pytest.raises(GitError) as excinfo:
        await folder.ensure()

    assert "s3cret-token" not in str(excinfo.value)
    assert "fatal:" not in str(excinfo.value), "raw git output leaked into the error"


async def test_token_never_appears_in_the_command_line(git_remote, tmp_path: Path):
    """It travels in the child env, referenced by name from a credential helper."""
    seen: list[list[str]] = []
    folder = GitFolder(git_remote.make_checkout(), branch="main", remote_url=git_remote.uri, token="s3cret-token")
    original_run = folder.executor.run

    async def spy(argv, **kwargs):
        seen.append(list(argv))
        assert "s3cret-token" not in " ".join(argv), "SECURITY: token was passed in argv"
        return await original_run(argv, **kwargs)

    folder.executor.run = spy  # type: ignore[method-assign]
    await folder.fetch("main")

    assert seen, "no git command ran"
    assert any("credential.helper=" in arg for argv in seen for arg in argv)


async def test_lock_serializes_work_on_one_checkout(git_remote):
    folder = GitFolder(git_remote.make_checkout())
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
