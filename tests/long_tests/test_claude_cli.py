"""Long test: Claude Code CLI invocation (requires Claude installed + valid auth)."""

import os
import subprocess
from pathlib import Path

import pytest

from tests.test_settings import test_service_config
from tests.utils import find_claude, run_claude

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


def test_claude_cli():
    """
    Test Claude Code CLI directly without hooks.
    Validates that Claude responds correctly.

    NOTE: This test requires Claude Code to be installed with valid auth.
    """
    claude_path = find_claude()
    if not claude_path:
        pytest.skip("Claude command not found in PATH")

    workdir = Path(os.getcwd())

    claude_process = run_claude(workdir, prompt="reply with single word - hi")

    try:
        stdout, stderr = claude_process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        claude_process.kill()
        stdout, stderr = claude_process.communicate()

    if "invalid api key" in stdout.lower():
        pytest.skip("Claude authentication required")

    assert stdout, "Claude produced no output"
    assert "hi" in stdout.lower(), f"Expected 'hi' in response, got: {stdout}"
