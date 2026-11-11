"""The model a headless claude turn passes: sonnet by default, the shell's own when it names one."""

from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import headless_parent_model


def test_defaults_to_sonnet():
    assert headless_parent_model({}, {}) == "sonnet"


def test_shell_model_is_kept():
    assert headless_parent_model({}, {"ANTHROPIC_MODEL": "anthropic/claude-haiku-5.5"}) is None


def test_explicit_model_wins():
    assert headless_parent_model({"model": "opus"}, {"ANTHROPIC_MODEL": "x"}) == "opus"
