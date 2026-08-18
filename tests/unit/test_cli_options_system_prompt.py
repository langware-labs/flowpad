"""Asset-backed system instructions reach each vendor through its native sink."""

import json

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import ClaudeCLIStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker import _with_language
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions

SUMMARY = "At creation time: the secret key is ABC123"
ASSETS_DIR = "/tmp/flowpad-assets"
CLAUDE_MD = f"{ASSETS_DIR}/CLAUDE.md"


def test_claude_receives_system_prompt_file_flag():
    cmd = ClaudeAgentOptions(model="sm")
    cmd.system_prompt_file = CLAUDE_MD

    argv, _env, stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--append-system-prompt-file" in argv
    assert argv[argv.index("--append-system-prompt-file") + 1] == CLAUDE_MD
    assert "--append-system-prompt" not in argv
    assert SUMMARY not in argv
    assert stdin is None  # claude takes the prompt on argv, not stdin


def test_codex_receives_developer_instructions_config():
    cmd = CodexAgentOptions()
    cmd.developer_instructions = SUMMARY

    argv, _env, stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--append-system-prompt" not in argv  # codex has no such flag
    assert "-c" in argv
    assert any(arg.startswith("developer_instructions=") and SUMMARY in arg for arg in argv)
    assert stdin == "what is the key?"


def test_copilot_receives_custom_instruction_dir_env():
    cmd = CopilotAgentOptions(
        custom_instruction_dirs=[ASSETS_DIR],
        no_custom_instructions=True,
    )

    argv, env, stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--append-system-prompt" not in argv
    assert "--no-custom-instructions" not in argv
    assert env["COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] == ASSETS_DIR
    assert stdin == "what is the key?"


def test_no_addition_is_a_no_op():
    argv, _env, stdin = ClaudeAgentOptions().to_spawn(instruction="hi")
    assert "--append-system-prompt" not in argv
    assert "--append-system-prompt-file" not in argv
    assert stdin is None
    cx_argv, _e, cx_stdin = CodexAgentOptions().to_spawn(instruction="hi")
    assert not any(arg.startswith("developer_instructions=") for arg in cx_argv)
    assert cx_stdin == "hi"


def test_claude_receives_language_via_settings_flag():
    cmd = ClaudeAgentOptions(settings_json={"language": "Hebrew"})

    argv, _env, _stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--settings" in argv
    assert json.loads(argv[argv.index("--settings") + 1]) == {"language": "Hebrew"}
    # Launch-only: to_json() is md5-hashed for restart detection, so a per-spawn
    # value must never enter it.
    assert "settings_json" not in cmd.to_json()


def test_codex_never_receives_settings_flag():
    cmd = CodexAgentOptions()
    cmd.developer_instructions = "# Language\nAlways respond in Hebrew."

    argv, _env, _stdin = cmd.to_spawn(instruction="what is the key?")

    assert "--settings" not in argv
    assert "--settings" not in cmd.to_shell_string(instruction="what is the key?")
    assert any(arg.startswith("developer_instructions=") and "Hebrew" in arg for arg in argv)


def test_no_language_emits_no_settings_flag():
    argv, _env, _stdin = ClaudeAgentOptions().to_spawn(instruction="hi")
    assert "--settings" not in argv


def test_claude_maps_context_language_to_its_own_setting():
    """Claude builds its own ``# Language`` system-prompt section, so it takes the
    language NAME via --settings — never the instruction text."""
    context = AgenticContext(workdir="/repo", language="Hebrew")

    opts = ClaudeCLIStreamWorker._options_from_context(context)
    argv, _env, _stdin = opts.to_spawn(instruction="hi")

    assert json.loads(argv[argv.index("--settings") + 1]) == {"language": "Hebrew"}
    assert "# Language" not in " ".join(argv)


def test_codex_maps_context_language_to_its_developer_message():
    """Codex has no language setting, so it needs the TEXT — prepended to the
    developer message, leaving the generated instructions intact behind it."""
    merged = _with_language("Your name is TEST_AGENT.", "Hebrew")

    assert merged.startswith("# Language\nAlways respond in Hebrew.")
    assert merged.endswith("Your name is TEST_AGENT.")

    cmd = CodexAgentOptions()
    cmd.developer_instructions = merged
    argv, _env, _stdin = cmd.to_spawn(instruction="hi")

    assert "--settings" not in argv
    assert any(arg.startswith("developer_instructions=") and "Hebrew" in arg for arg in argv)


def test_codex_language_block_stands_alone_without_instructions():
    assert _with_language(None, "Hebrew").startswith("# Language\nAlways respond in Hebrew.")


def test_no_context_language_is_a_no_op_for_every_vendor():
    """An unset/English locale must leave every vendor byte-identical to before."""
    context = AgenticContext(workdir="/repo")

    argv, _env, _stdin = ClaudeCLIStreamWorker._options_from_context(context).to_spawn(instruction="hi")
    assert "--settings" not in argv

    assert _with_language("Your name is TEST_AGENT.", None) == "Your name is TEST_AGENT."
    assert _with_language(None, None) is None
