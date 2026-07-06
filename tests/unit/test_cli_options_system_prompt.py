"""Asset-backed system instructions reach each vendor through its native sink."""

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotCliOptions

SUMMARY = "At creation time: the secret key is ABC123"
ASSETS_DIR = "/tmp/flowpad-assets"
CLAUDE_MD = f"{ASSETS_DIR}/CLAUDE.md"


def test_claude_receives_system_prompt_file_flag():
    cmd = ClaudeCliOptions(model="sm")
    cmd.system_prompt_file = CLAUDE_MD

    argv, _env, stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--append-system-prompt-file" in argv
    assert argv[argv.index("--append-system-prompt-file") + 1] == CLAUDE_MD
    assert "--append-system-prompt" not in argv
    assert SUMMARY not in argv
    assert stdin is None  # claude takes the prompt on argv, not stdin


def test_codex_receives_developer_instructions_config():
    cmd = CodexCliOptions()
    cmd.developer_instructions = SUMMARY

    argv, _env, stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--append-system-prompt" not in argv  # codex has no such flag
    assert "-c" in argv
    assert any(arg.startswith("developer_instructions=") and SUMMARY in arg for arg in argv)
    assert stdin == "what is the key?"


def test_copilot_receives_custom_instruction_dir_env():
    cmd = CopilotCliOptions(
        custom_instruction_dirs=[ASSETS_DIR],
        no_custom_instructions=True,
    )

    argv, env, stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--append-system-prompt" not in argv
    assert "--no-custom-instructions" not in argv
    assert env["COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] == ASSETS_DIR
    assert stdin == "what is the key?"


def test_no_addition_is_a_no_op():
    argv, _env, stdin = ClaudeCliOptions().to_spawn(instruction="hi")
    assert "--append-system-prompt" not in argv
    assert "--append-system-prompt-file" not in argv
    assert stdin is None
    cx_argv, _e, cx_stdin = CodexCliOptions().to_spawn(instruction="hi")
    assert not any(arg.startswith("developer_instructions=") for arg in cx_argv)
    assert cx_stdin == "hi"
