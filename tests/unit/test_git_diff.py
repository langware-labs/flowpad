"""
Unit tests for FlowSourceControl.get_git_diff method.

Tests the GitHub-style diff limiting functionality:
- Timeout handling
- Too many files detection
- Fast path (all files small, under limit)
- Slow path (some files too large)
"""

from unittest.mock import MagicMock

from flow_sdk.core.flow.flow_source_control import ComputeSourceControl
from flow_sdk.flowpad_types.compute_types import CLICommand


def create_mock_command(stdout: str, completed: bool = True, exit_code: int = 0) -> CLICommand:
    """Create a mock CLICommand with predefined output."""
    cmd = MagicMock(spec=CLICommand)
    cmd.stdout = [stdout]
    cmd.all_stdout = stdout
    cmd.exit_code = exit_code

    async def wait(timeout=None):
        return completed

    cmd.wait = wait
    return cmd


def create_source_control_with_mock_commands(commands: dict[str, CLICommand]) -> ComputeSourceControl:
    """Create a ComputeSourceControl with mocked run_command."""
    mock_compute_node = MagicMock()
    call_count = {"count": 0}
    command_list = list(commands.values())

    async def mock_run_command(cmd: str):
        # Return commands in order they were added
        result = command_list[call_count["count"]]
        call_count["count"] += 1
        return result

    mock_compute_node.run_command = mock_run_command
    return ComputeSourceControl(compute_node=mock_compute_node)


async def test_get_git_diff_timeout_on_numstat():
    """Test that timeout on numstat returns timeout message."""
    numstat_cmd = create_mock_command("", completed=False)
    source_control = create_source_control_with_mock_commands({"numstat": numstat_cmd})

    result = await source_control.get_git_diff("abc123", timeout_seconds=1.0)

    assert "[DIFF TIMED OUT" in result
    assert "1.0s" in result


async def test_get_git_diff_too_many_files():
    """Test that too many files returns summary without diff content."""
    # Create numstat output with 51+ files (exceeds default max_files=50)
    numstat_lines = "\n".join([f"10\t5\tfile{i}.py" for i in range(51)])
    numstat_cmd = create_mock_command(numstat_lines)

    # Mock count command for total file count
    count_cmd = create_mock_command("150")

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "count": count_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123", max_files=50)

    assert "[TOO_MANY_FILES:" in result
    assert "150 files changed" in result
    assert "diff content hidden" in result


async def test_get_git_diff_too_many_files_without_count():
    """Test too many files when count command fails."""
    numstat_lines = "\n".join([f"10\t5\tfile{i}.py" for i in range(51)])
    numstat_cmd = create_mock_command(numstat_lines)

    # Count command times out
    count_cmd = create_mock_command("", completed=False)

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "count": count_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123", max_files=50)

    assert "[TOO_MANY_FILES:" in result
    assert "more than 50 files changed" in result


async def test_get_git_diff_fast_path_small_diff():
    """Test fast path when all files are small and under limit."""
    # 3 small files, all under 500 lines
    numstat_output = "10\t5\tfile1.py\n20\t10\tfile2.py\n5\t2\tfile3.py"
    numstat_cmd = create_mock_command(numstat_output)

    # Expected diff output
    diff_output = """diff --git a/file1.py b/file1.py
--- a/file1.py
+++ b/file1.py
@@ -1,3 +1,4 @@
+# New comment
 def hello():
     pass
"""
    diff_cmd = create_mock_command(diff_output)

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "diff": diff_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123")

    # Should return the actual diff
    assert "diff --git" in result
    assert "file1.py" in result
    assert "[TOO_MANY_FILES" not in result
    assert "too large" not in result


async def test_get_git_diff_slow_path_large_file():
    """Test slow path when some files are too large."""
    # 2 small files + 1 large file (600 lines > 500 default max)
    numstat_output = "10\t5\tsmall1.py\n300\t300\tlarge_file.py\n20\t10\tsmall2.py"
    numstat_cmd = create_mock_command(numstat_output)

    # Diff for small files only
    diff_output = """diff --git a/small1.py b/small1.py
--- a/small1.py
+++ b/small1.py
@@ -1 +1 @@
-old
+new
diff --git a/small2.py b/small2.py
--- a/small2.py
+++ b/small2.py
@@ -1 +1 @@
-old2
+new2
"""
    diff_cmd = create_mock_command(diff_output)

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "diff": diff_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123", max_lines_per_file=500)

    # Should include diff for small files
    assert "diff --git" in result
    assert "small1.py" in result
    assert "small2.py" in result
    # Should include skip message for large file
    assert "large_file.py" in result
    assert "600 lines changed" in result
    assert "skipped" in result
    assert "1 file(s) too large" in result


async def test_get_git_diff_binary_files_treated_as_large():
    """Test that binary files (shown as - in numstat) are treated as large."""
    # Binary file shows "-" for added/deleted
    numstat_output = "10\t5\ttext.py\n-\t-\tbinary.png"
    numstat_cmd = create_mock_command(numstat_output)

    # Diff only for text file
    diff_output = """diff --git a/text.py b/text.py
--- a/text.py
+++ b/text.py
@@ -1 +1 @@
-old
+new
"""
    diff_cmd = create_mock_command(diff_output)

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "diff": diff_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123")

    # Should include diff for text file
    assert "text.py" in result
    assert "diff --git" in result
    # Binary file should be in the "too large" summary
    assert "binary.png" in result
    assert "skipped" in result


async def test_get_git_diff_empty_numstat():
    """Test handling of empty numstat (no changes)."""
    numstat_cmd = create_mock_command("")
    diff_cmd = create_mock_command("")

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "diff": diff_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123")

    # Should return empty or minimal output
    assert "[TOO_MANY_FILES" not in result
    assert "too large" not in result


async def test_get_git_diff_all_files_large():
    """Test when all files exceed the line limit."""
    # All files are large
    numstat_output = "300\t300\tlarge1.py\n400\t200\tlarge2.py"
    numstat_cmd = create_mock_command(numstat_output)

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123", max_lines_per_file=500)

    # Should have skip messages for both
    assert "large1.py" in result
    assert "large2.py" in result
    assert "600 lines changed" in result
    assert "skipped" in result
    assert "2 file(s) too large" in result
    # No actual diff content
    assert "diff --git" not in result


async def test_get_git_diff_custom_limits():
    """Test with custom max_files and max_lines_per_file."""
    # 5 files, but we only want 3
    numstat_output = "\n".join([f"10\t5\tfile{i}.py" for i in range(5)])
    numstat_cmd = create_mock_command(numstat_output)
    count_cmd = create_mock_command("5")

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "count": count_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123", max_files=3)

    # Should indicate too many files
    assert "[TOO_MANY_FILES:" in result
    assert "5 files changed" in result


async def test_get_git_diff_diff_timeout():
    """Test timeout during diff command (not numstat)."""
    numstat_output = "10\t5\tfile1.py"
    numstat_cmd = create_mock_command(numstat_output)

    # Diff times out
    diff_cmd = create_mock_command("", completed=False)

    source_control = create_source_control_with_mock_commands(
        {
            "numstat": numstat_cmd,
            "diff": diff_cmd,
        }
    )

    result = await source_control.get_git_diff("abc123", timeout_seconds=1.0)

    assert "[DIFF TIMED OUT" in result
