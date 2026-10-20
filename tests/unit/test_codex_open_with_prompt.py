"""Regression for the generic PTY open path dropping Codex's launch prompt."""

from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexAgentOptions


def test_interactive_open_preserves_launch_prompt_in_spawn_args():
    options = CodexAgentOptions(json_stream=False, ephemeral=False)
    prompt = "Reply exactly RCA_PROMPT_OK. Do not use any tools or modify any files."

    # AgenticProcess._perform_open uses this two-value seam for direct PTY spawn.
    argv, _env = options.to_spawn_args(instruction=prompt)

    assert prompt in argv, "Interactive Codex launch discarded the prompt before PTY spawn"


def test_headless_launch_preserves_prompt_on_stdin():
    options = CodexAgentOptions(json_stream=True)
    prompt = "Reply exactly RCA_PROMPT_OK."

    argv, _env, stdin = options.to_spawn(instruction=prompt)

    assert prompt not in argv
    assert argv[-1] == "-"
    assert stdin == prompt
