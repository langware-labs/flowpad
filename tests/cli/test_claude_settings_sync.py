from flow_sdk.builtin.claude_settings_sync import generate_hook_command


def test_generate_hook_command():
    command = generate_hook_command("hook-abc", "PreToolUse")
    assert command == "flow hooks report --hook-entry-id=hook-abc"


def test_generate_hook_command_with_name():
    command = generate_hook_command("hook-abc", "PostToolUse", name="flowpad_sniffer")
    assert command == "flow hooks report --hook-entry-id=hook-abc --name=flowpad_sniffer"


def test_generate_hook_command_permission_request_adds_wait_flag():
    command = generate_hook_command("hook-abc", "PermissionRequest", name="flowpad_sniffer")
    assert "--wait-for-response" in command
    assert command == "flow hooks report --hook-entry-id=hook-abc --wait-for-response --name=flowpad_sniffer"


def test_generate_hook_command_non_permission_request_no_wait_flag():
    for event in ("PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"):
        command = generate_hook_command("hook-abc", event)
        assert "--wait-for-response" not in command, f"Unexpected --wait-for-response for event {event}"
