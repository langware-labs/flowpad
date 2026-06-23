"""Unit tests for GitRepo.dispatch().

Uses a mocked ComputeNode (no real git process) following the pattern from
tests/unit/test_git_diff.py.
"""
from unittest.mock import MagicMock

from flow_sdk.builtin.faas.git_repo import GitRepo
from flow_sdk.flowpad_types.compute_types import CLICommand


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_cmd(stdout: str, exit_code: int = 0, stderr: str = "") -> CLICommand:
    """Create a mock CLICommand with predefined stdout/stderr and exit code."""
    cmd = MagicMock(spec=CLICommand)
    cmd.all_stdout = stdout
    cmd.all_stderr = stderr
    cmd.exit_code = exit_code

    async def wait(timeout=None):
        return True

    cmd.wait = wait
    return cmd


def make_repo(responses: list) -> GitRepo:
    """Create a GitRepo backed by a mock node that returns responses in order."""
    mock_node = MagicMock()
    idx = {"i": 0}

    async def run_command(cmd, **kwargs):
        r = responses[idx["i"]]
        idx["i"] += 1
        return r

    mock_node.run_command = run_command
    return GitRepo("/repo", mock_node)


# ---------------------------------------------------------------------------
# dispatch("status")
# ---------------------------------------------------------------------------

async def test_dispatch_status_clean_repo():
    """Clean repo returns branch info and empty files list."""
    # combined status --porcelain=v1 --branch → numstat unstaged → numstat staged
    responses = [
        make_cmd("## main...origin/main [ahead 1, behind 0]"),  # status --branch header, no files
        make_cmd(""),        # diff --numstat (unstaged)
        make_cmd(""),        # diff --numstat --staged
    ]
    result = await make_repo(responses).dispatch("status")
    assert result.status == "SUCCESS"
    assert result.data["branch"] == "main"
    assert result.data["ahead"] == 1
    assert result.data["files"] == []


async def test_dispatch_status_not_a_repo():
    """Non-git directory returns an error field."""
    responses = [make_cmd("", exit_code=128)]  # rev-parse fails → is_init=False
    result = await make_repo(responses).dispatch("status")
    assert result.status == "SUCCESS"
    assert result.data["error"] == "not a git repository"


# ---------------------------------------------------------------------------
# dispatch("branch")
# ---------------------------------------------------------------------------

async def test_dispatch_branch():
    result = await make_repo([make_cmd("feat/my-feature")]).dispatch("branch")
    assert result.status == "SUCCESS"
    assert result.data["branch"] == "feat/my-feature"


async def test_dispatch_branch_detached():
    result = await make_repo([make_cmd("", exit_code=0)]).dispatch("branch")
    assert result.status == "SUCCESS"
    assert result.data["branch"] is None


# ---------------------------------------------------------------------------
# dispatch("is-init") — camelCase key
# ---------------------------------------------------------------------------

async def test_dispatch_is_init_true():
    result = await make_repo([make_cmd("true", exit_code=0)]).dispatch("is-init")
    assert result.status == "SUCCESS"
    assert result.data["isInit"] is True  # camelCase via alias_generator


async def test_dispatch_is_init_false():
    result = await make_repo([make_cmd("", exit_code=128)]).dispatch("is-init")
    assert result.status == "SUCCESS"
    assert result.data["isInit"] is False


# ---------------------------------------------------------------------------
# dispatch("is-linked-worktree") — camelCase key
# ---------------------------------------------------------------------------

async def test_dispatch_is_linked_worktree_true():
    result = await make_repo([make_cmd(".git/worktrees/feat-branch")]).dispatch("is-linked-worktree")
    assert result.status == "SUCCESS"
    assert result.data["isLinkedWorktree"] is True  # camelCase via alias_generator


async def test_dispatch_is_linked_worktree_false():
    result = await make_repo([make_cmd(".git", exit_code=0)]).dispatch("is-linked-worktree")
    assert result.status == "SUCCESS"
    assert result.data["isLinkedWorktree"] is False


# ---------------------------------------------------------------------------
# dispatch("has-commit") — camelCase key
# ---------------------------------------------------------------------------

async def test_dispatch_has_commit_true():
    result = await make_repo([make_cmd("abc1234", exit_code=0)]).dispatch("has-commit")
    assert result.status == "SUCCESS"
    assert result.data["hasCommit"] is True  # camelCase via alias_generator


async def test_dispatch_has_commit_false_empty_repo():
    result = await make_repo([make_cmd("", exit_code=128)]).dispatch("has-commit")
    assert result.status == "SUCCESS"
    assert result.data["hasCommit"] is False


async def test_dispatch_has_commit_false_non_repo():
    result = await make_repo([make_cmd("", exit_code=128)]).dispatch("has-commit")
    assert result.status == "SUCCESS"
    assert result.data["hasCommit"] is False


# ---------------------------------------------------------------------------
# dispatch("discard-file") / "stage-file" / "unstage-file" — per-file ops (POST)
# ---------------------------------------------------------------------------

async def test_dispatch_discard_modified():
    """Modified file → git restore --staged --worktree, ok=True."""
    result = await make_repo([make_cmd("")]).dispatch(
        "discard-file", {"file": "a.txt", "status": "M"}, method="POST"
    )
    assert result.status == "SUCCESS"
    assert result.data["ok"] is True


async def test_dispatch_discard_untracked_deletes():
    """Untracked file (status ?) → git clean, ok=True."""
    result = await make_repo([make_cmd("")]).dispatch(
        "discard-file", {"file": "new.txt", "status": "?"}, method="POST"
    )
    assert result.status == "SUCCESS"
    assert result.data["ok"] is True


async def test_dispatch_discard_failure_surfaces_stderr():
    """Non-zero rc → ok=False with the git stderr in the message."""
    result = await make_repo([make_cmd("", exit_code=1, stderr="fatal: bad path")]).dispatch(
        "discard-file", {"file": "a.txt", "status": "M"}, method="POST"
    )
    assert result.status == "SUCCESS"
    assert result.data["ok"] is False
    assert "fatal: bad path" in result.data["message"]


async def test_dispatch_discard_requires_post():
    result = await make_repo([]).dispatch(
        "discard-file", {"file": "a.txt", "status": "M"}, method="GET"
    )
    assert result.status == "FAIL"
    assert result.status_code == 405


async def test_dispatch_discard_missing_file():
    result = await make_repo([]).dispatch("discard-file", {"status": "M"}, method="POST")
    assert result.status == "FAIL"
    assert result.status_code == 400


async def test_dispatch_stage_file():
    result = await make_repo([make_cmd("")]).dispatch(
        "stage-file", {"file": "a.txt"}, method="POST"
    )
    assert result.status == "SUCCESS"
    assert result.data["ok"] is True


async def test_dispatch_unstage_file():
    result = await make_repo([make_cmd("")]).dispatch(
        "unstage-file", {"file": "a.txt"}, method="POST"
    )
    assert result.status == "SUCCESS"
    assert result.data["ok"] is True


async def test_dispatch_stage_requires_post():
    result = await make_repo([]).dispatch("stage-file", {"file": "a.txt"}, method="GET")
    assert result.status == "FAIL"
    assert result.status_code == 405


# ---------------------------------------------------------------------------
# dispatch(unknown)
# ---------------------------------------------------------------------------

async def test_dispatch_unknown_sub():
    result = await make_repo([]).dispatch("nonexistent")
    assert result.status == "FAIL"
    assert "nonexistent" in result.message
