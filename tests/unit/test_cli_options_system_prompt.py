"""ContextProcess delivery: system_prompt_append reaches every vendor's worker.

The unified base routes a system-prompt addition via each vendor's declared sink:
claude → ``--append-system-prompt`` (argv); codex/copilot → prepended into the
stdin prompt. This is the fix for the bug that started the whole consolidation —
proven here for all three vendors, deterministically, with no live worker.
"""
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotCliOptions

SUMMARY = "At creation time: the secret key is ABC123"


def test_claude_appends_system_prompt_as_an_argv_flag():
    argv, _env, stdin = ClaudeCliOptions(model="sm").to_spawn(
        instruction="what is the key?", system_prompt_append=SUMMARY
    )
    assert "--append-system-prompt" in argv
    assert SUMMARY in argv
    assert argv[argv.index("--append-system-prompt") + 1] == SUMMARY
    assert stdin is None  # claude takes the prompt on argv, not stdin


def test_codex_prepends_system_prompt_into_stdin():
    argv, _env, stdin = CodexCliOptions().to_spawn(
        instruction="what is the key?", system_prompt_append=SUMMARY
    )
    assert "--append-system-prompt" not in argv  # codex has no such flag
    assert stdin is not None and stdin.startswith(SUMMARY)
    assert "what is the key?" in stdin


def test_copilot_prepends_system_prompt_into_stdin():
    argv, _env, stdin = CopilotCliOptions().to_spawn(
        instruction="what is the key?", system_prompt_append=SUMMARY
    )
    assert "--append-system-prompt" not in argv
    assert stdin is not None and stdin.startswith(SUMMARY)
    assert "what is the key?" in stdin


def test_no_addition_is_a_no_op():
    # Unset ⇒ no flag, no stdin pollution (the Phase B equivalence case).
    argv, _env, stdin = ClaudeCliOptions().to_spawn(instruction="hi")
    assert "--append-system-prompt" not in argv
    cx_argv, _e, cx_stdin = CodexCliOptions().to_spawn(instruction="hi")
    assert cx_stdin == "hi"
