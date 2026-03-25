"""
Basic hooks end-to-end test using CLI commands.

Tests the complete hooks lifecycle:
1. Setup hooks using `flow hooks set` CLI command
2. Call Claude
3. Validate hooks were reported to server
4. Clear hooks using `flow hooks clear` CLI command
5. Call Claude again
6. Validate nothing was reported
"""

import pytest
import subprocess
import time
import stat
import os
from pathlib import Path
from tests.utils import find_claude, run_claude


@pytest.mark.skip(reason="requires flowpad monorepo minihub server")
def test_hooks_lifecycle_with_cli_commands(local_server, claude_settings, monkeypatch):
    """
    Complete hooks lifecycle test using CLI commands:
    1. Setup hooks using `flow hooks set --scope user`
    2. Call Claude
    3. Validate server received prompt via hook
    4. Clear hooks using `flow hooks clear --scope user`
    5. Call Claude again
    6. Validate server received nothing new
    """
    # Skip if Claude not available
    claude_path = find_claude()
    if not claude_path:
        pytest.skip("Claude command not found in PATH")

    port = local_server.port
    workdir = claude_settings.home
    flow_cli_path = Path(__file__).parent.parent / "flow_cli.py"

    print(f"\n{'='*60}")
    print(f"Test setup: Server on port {port}, workdir: {workdir}")
    print(f"{'='*60}")

    # Set environment
    monkeypatch.setenv("LOCAL_SERVER_PORT", str(port))
    env = os.environ.copy()
    env["LOCAL_SERVER_PORT"] = str(port)

    def run_flow(*args):
        """Run flow CLI command and return (stdout, stderr, returncode)."""
        cmd = ["python3", str(flow_cli_path)] + list(args)
        result = subprocess.run(cmd, capture_output=True, text=True, env=env)
        return result.stdout, result.stderr, result.returncode

    def get_hook_reports():
        """Get hook reports from flow_sdk.server."""
        import requests
        try:
            resp = requests.get(f"http://127.0.0.1:{port}/api/hooks/output", timeout=5)
            return resp.json().get("outputs", []) if resp.status_code == 200 else []
        except:
            return []

    # Get initial hook report count
    initial_count = len(get_hook_reports())

    # =========================================================================
    # STEP 1: Setup hooks using setHook with wrapper script
    # =========================================================================
    # Note: We use setHook with a wrapper script because Claude Code doesn't
    # pass test environment variables to hooks. The wrapper sets LOCAL_SERVER_PORT.
    print(f"\n[Step 1] Setting up hooks...")

    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.claude_hooks import setHook
    from flow_sdk.cli.cli_context import ClaudeScope

    # Create Python wrapper script that calls `flow hooks report` (our CLI command)
    hook_wrapper = workdir / "hook_wrapper.py"
    hook_wrapper.write_text(f'''#!/usr/bin/env python3
import json
import sys
import subprocess
import os

try:
    input_data = json.load(sys.stdin)

    env = os.environ.copy()
    env["LOCAL_SERVER_PORT"] = "{port}"

    # Use flow hooks report command to send to server
    proc = subprocess.Popen(
        ["flow", "hooks", "report"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env
    )
    proc.communicate(input=json.dumps(input_data))
except:
    pass
sys.exit(0)
''')
    os.chmod(hook_wrapper, os.stat(hook_wrapper).st_mode | stat.S_IEXEC)

    success = setHook(
        scope=ClaudeScope.USER,
        event_name="UserPromptSubmit",
        matcher=None,
        cmd=str(hook_wrapper)
    )
    assert success, "Failed to set hook"

    # Verify with CLI list command
    stdout, _, _ = run_flow("hooks", "list", "--scope", "user")
    assert "UserPromptSubmit" in stdout, f"Hook not in list:\n{stdout}"
    print(f"✓ Hook set and verified via 'flow hooks list'")

    # =========================================================================
    # STEP 2: Call Claude (with hooks)
    # =========================================================================
    print(f"\n[Step 2] Calling Claude with hooks enabled...")

    process = run_claude(workdir, prompt="say hello", debug=False)
    try:
        process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()

    time.sleep(2)  # Wait for hook to execute
    print(f"✓ Claude called")

    # =========================================================================
    # STEP 3: Validate server received hook report
    # =========================================================================
    print(f"\n[Step 3] Validating server received hook report...")

    reports_after_call1 = get_hook_reports()
    count_after_call1 = len(reports_after_call1)
    new_reports = count_after_call1 - initial_count

    print(f"  Reports: {initial_count} -> {count_after_call1} (+{new_reports})")

    assert new_reports > 0, f"Expected hook reports, got 0 new reports"
    print(f"✓ Hook reported to server")

    # =========================================================================
    # STEP 4: Clear hooks using HookParser (since hook is a wrapper script, not flow command)
    # =========================================================================
    # Note: removeHook only removes "flow" commands. Our wrapper script isn't recognized
    # as a flow command, so we use HookParser.clear_event() directly.
    print(f"\n[Step 4] Clearing hooks...")

    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.hook_parser import HookParser
    from flow_sdk.cli.cli_context import CLIContext

    context = CLIContext()
    hook_parser = HookParser(context=context, scope=ClaudeScope.USER)
    hook_parser.clear_event("UserPromptSubmit")
    hook_parser.save_hooks()

    # Verify cleared via CLI list command
    stdout, _, _ = run_flow("hooks", "list", "--scope", "user")
    assert "No hooks configured" in stdout or "UserPromptSubmit" not in stdout, \
        f"Hook still present:\n{stdout}"
    print(f"✓ Hooks cleared and verified via 'flow hooks list'")

    # Record count before second call
    count_before_call2 = len(get_hook_reports())

    # =========================================================================
    # STEP 5: Call Claude (without hooks)
    # =========================================================================
    print(f"\n[Step 5] Calling Claude without hooks...")

    process = run_claude(workdir, prompt="say goodbye", debug=False)
    try:
        process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()

    time.sleep(2)  # Wait to ensure no hook fires
    print(f"✓ Claude called")

    # =========================================================================
    # STEP 6: Validate nothing was reported
    # =========================================================================
    print(f"\n[Step 6] Validating no new reports...")

    reports_after_call2 = get_hook_reports()
    count_after_call2 = len(reports_after_call2)
    new_reports_after_clear = count_after_call2 - count_before_call2

    print(f"  Reports: {count_before_call2} -> {count_after_call2} (+{new_reports_after_clear})")

    assert new_reports_after_clear == 0, \
        f"Expected 0 new reports after clear, got {new_reports_after_clear}"
    print(f"✓ No reports after clear")

    print(f"\n{'='*60}")
    print(f"✅ TEST PASSED")
    print(f"{'='*60}")
