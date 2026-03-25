"""
Claude hooks tests for SessionStart event.

NOTE: UserPromptSubmit lifecycle tests are in test_basic_hooks.py
"""

import json
import pytest
import subprocess
import time
import os
from pathlib import Path
from tests.utils import find_claude, run_claude


def test_hook_basic(claude_settings, temp_workdir):
    """
    Basic test for SessionStart hooks:
    1. Places a hook on SessionStart using setHook
    2. The hook echoes a string into a temp log file
    3. Executes claude code with -p and "hi"
    4. Validates that the log was written

    NOTE: This test requires Claude Code to be installed.
    """
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.claude_hooks import setHook
    from flow_sdk.cli.cli_context import ClaudeScope

    claude_path = find_claude()
    if not claude_path:
        pytest.skip("Claude command not found in PATH")

    print(f"\n✓ Claude found at: {claude_path}")

    workdir = claude_settings.home
    log_file_path = temp_workdir / "test.log"
    claude_settings_file = claude_settings.file

    # Set up the hook
    test_message = "SessionStart hook fired successfully!"
    hook_command = f'echo "{test_message}" >> {log_file_path}'

    success = setHook(
        scope=ClaudeScope.USER,
        event_name="SessionStart",
        matcher=None,
        cmd=hook_command
    )

    assert success, "Failed to set SessionStart hook"
    print(f"✓ SessionStart hook configured")

    # Verify hook was configured
    assert claude_settings_file.exists(), "Settings file not created"
    with open(claude_settings_file, 'r') as f:
        settings = json.load(f)
    assert "hooks" in settings
    assert "SessionStart" in settings["hooks"]

    # Execute claude code
    print("\n✓ Executing Claude Code with -p 'hi'")
    claude_process = run_claude(workdir, prompt="hi", debug=False)

    try:
        stdout, stderr = claude_process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        claude_process.kill()
        stdout, stderr = claude_process.communicate()

    # Validate the log was written
    print("\n✓ Validating log file")
    assert log_file_path.exists(), "Log file does not exist"

    with open(log_file_path, 'r') as f:
        log_content = f.read()

    assert test_message in log_content, f"Expected message not found in log. Got: {log_content}"
    print("\n✅ SessionStart hook test PASSED")


@pytest.mark.skip(reason="requires flowpad monorepo minihub server")
def test_hook_cli(local_server, claude_settings, monkeypatch):
    """
    Test SessionStart hook with flow CLI ping command:
    1. Starts a test server
    2. Configures a SessionStart hook that calls 'flow ping'
    3. Executes claude code with -p "hi"
    4. Validates that the server received the ping

    NOTE: This test requires Claude Code to be installed.
    """
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.claude_hooks import setHook
    from flow_sdk.cli.cli_context import ClaudeScope

    claude_path = find_claude()
    if not claude_path:
        pytest.skip("Claude command not found in PATH")

    print(f"\n✓ Claude found at: {claude_path}")

    port = local_server.port
    workdir = claude_settings.home
    claude_settings_file = claude_settings.file

    monkeypatch.setenv("LOCAL_SERVER_PORT", str(port))

    # Create wrapper script
    import random
    import string
    random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    ping_message = f"test_hook_cli_{random_suffix}"

    hook_log = workdir / "hook_execution.log"
    hook_script = workdir / "hook_wrapper.sh"
    hook_script.write_text(f'''#!/bin/bash
echo "Hook fired at $(date)" >> {hook_log}
export LOCAL_SERVER_PORT={port}
flow ping {ping_message} >> {hook_log} 2>&1
echo "Hook completed with exit code $?" >> {hook_log}
''')
    hook_script.chmod(0o755)

    success = setHook(
        scope=ClaudeScope.USER,
        event_name="SessionStart",
        matcher=None,
        cmd=str(hook_script)
    )

    assert success, "Failed to set SessionStart hook"
    print(f"✓ SessionStart hook configured")

    # Verify hook was configured
    assert claude_settings_file.exists()
    with open(claude_settings_file, 'r') as f:
        settings = json.load(f)
    assert "SessionStart" in settings.get("hooks", {})

    # Execute claude code
    print("\n✓ Executing Claude Code with -p 'hi'")
    claude_process = run_claude(workdir, prompt="hi", debug=False)

    try:
        stdout, stderr = claude_process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        claude_process.kill()
        stdout, stderr = claude_process.communicate()

    time.sleep(2)

    # Validate server received ping
    print("\n✓ Validating server received ping")
    if hook_log.exists():
        print(f"  Hook log: {hook_log.read_text()}")

    pings = local_server.get_pings()
    assert len(pings) > 0, "No pings received by server"

    last_ping = pings[-1]
    assert last_ping["ping_str"] == ping_message
    print("\n✅ SessionStart hook CLI test PASSED")

