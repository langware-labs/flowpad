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

def make_cmd(stdout: str, exit_code: int = 0) -> CLICommand:
    """Create a mock CLICommand with predefined stdout and exit code."""
    cmd = MagicMock(spec=CLICommand)
    cmd.all_stdout = stdout
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
    # is_init → branch → ahead/behind → numstat unstaged → numstat staged → porcelain
    responses = [
        make_cmd("true"),    # rev-parse --is-inside-work-tree
        make_cmd("main"),    # branch --show-current
        make_cmd("1\t0"),    # rev-list left-right count
        make_cmd(""),        # diff --numstat (unstaged)
        make_cmd(""),        # diff --numstat --staged
        make_cmd(""),        # status --porcelain=v1
    ]
    result = await make_repo(responses).dispatch("status")
    assert result.worker_status == "SUCCESS"
    assert result.data["branch"] == "main"
    assert result.data["ahead"] == 1
    assert result.data["files"] == []


async def test_dispatch_status_not_a_repo():
    """Non-git directory returns an error field."""
    responses = [make_cmd("", exit_code=128)]  # rev-parse fails → is_init=False
    result = await make_repo(responses).dispatch("status")
    assert result.worker_status == "SUCCESS"
    assert result.data["error"] == "not a git repository"


# ---------------------------------------------------------------------------
# dispatch("branch")
# ---------------------------------------------------------------------------

async def test_dispatch_branch():
    result = await make_repo([make_cmd("feat/my-feature")]).dispatch("branch")
    assert result.worker_status == "SUCCESS"
    assert result.data["branch"] == "feat/my-feature"


async def test_dispatch_branch_detached():
    result = await make_repo([make_cmd("", exit_code=0)]).dispatch("branch")
    assert result.worker_status == "SUCCESS"
    assert result.data["branch"] is None


# ---------------------------------------------------------------------------
# dispatch("is-init") — camelCase key
# ---------------------------------------------------------------------------

async def test_dispatch_is_init_true():
    result = await make_repo([make_cmd("true", exit_code=0)]).dispatch("is-init")
    assert result.worker_status == "SUCCESS"
    assert result.data["isInit"] is True  # camelCase via alias_generator


async def test_dispatch_is_init_false():
    result = await make_repo([make_cmd("", exit_code=128)]).dispatch("is-init")
    assert result.worker_status == "SUCCESS"
    assert result.data["isInit"] is False


# ---------------------------------------------------------------------------
# dispatch("is-linked-worktree") — camelCase key
# ---------------------------------------------------------------------------

async def test_dispatch_is_linked_worktree_true():
    result = await make_repo([make_cmd(".git/worktrees/feat-branch")]).dispatch("is-linked-worktree")
    assert result.worker_status == "SUCCESS"
    assert result.data["isLinkedWorktree"] is True  # camelCase via alias_generator


async def test_dispatch_is_linked_worktree_false():
    result = await make_repo([make_cmd(".git", exit_code=0)]).dispatch("is-linked-worktree")
    assert result.worker_status == "SUCCESS"
    assert result.data["isLinkedWorktree"] is False


# ---------------------------------------------------------------------------
# dispatch("has-commit") — camelCase key
# ---------------------------------------------------------------------------

async def test_dispatch_has_commit_true():
    result = await make_repo([make_cmd("abc1234", exit_code=0)]).dispatch("has-commit")
    assert result.worker_status == "SUCCESS"
    assert result.data["hasCommit"] is True  # camelCase via alias_generator


async def test_dispatch_has_commit_false_empty_repo():
    result = await make_repo([make_cmd("", exit_code=128)]).dispatch("has-commit")
    assert result.worker_status == "SUCCESS"
    assert result.data["hasCommit"] is False


async def test_dispatch_has_commit_false_non_repo():
    result = await make_repo([make_cmd("", exit_code=128)]).dispatch("has-commit")
    assert result.worker_status == "SUCCESS"
    assert result.data["hasCommit"] is False


# ---------------------------------------------------------------------------
# dispatch(unknown)
# ---------------------------------------------------------------------------

async def test_dispatch_unknown_sub():
    result = await make_repo([]).dispatch("nonexistent")
    assert result.worker_status == "FAIL"
    assert "nonexistent" in result.message
