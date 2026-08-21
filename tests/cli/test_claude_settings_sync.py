from flow_sdk.builtin.claude_settings_sync import generate_hook_command


def test_generate_hook_command():
    command = generate_hook_command("hook-abc")
    # Uses wrapper script, not bare flow
    assert "hooks report --hook-entry-id=hook-abc" in command
    assert "flowpad_runner" in command
    assert not command.startswith("flow ")


def test_generate_hook_command_with_name():
    command = generate_hook_command("hook-abc", name="flowpad_sniffer")
    assert "--hook-entry-id=hook-abc" in command
    assert "--name=flowpad_sniffer" in command
    assert "flowpad_runner" in command


def test_generate_hook_command_never_waits_for_response():
    """Global hooks are fire-and-forget for EVERY event.

    ``--wait-for-response`` used to be added for ``PermissionRequest`` so the
    ExitPlanMode auto-approve could answer synchronously. That feature is gone,
    and nothing on the global tier produces a ``hookSpecificOutput`` decision —
    so blocking Claude on a round-trip that returns ``{}`` would be pure latency.
    """
    for event in ("PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "PermissionRequest"):
        command = generate_hook_command("hook-abc", name=event)
        assert "--wait-for-response" not in command, f"Unexpected --wait-for-response for event {event}"
