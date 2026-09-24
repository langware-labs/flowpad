"""The CLI log (``~/.flow/logs/cli.log.jsonl``) keeps every command — never a credential's value."""
from __future__ import annotations

from flow_sdk.cli.flow_cli import _carries_secrets, _logged_argv


def test_a_credential_value_is_logged_as_its_name_only():
    argv = ["flow", "credentials", "set", "telegram", "--project", "p1", "TELEGRAM_BOT_TOKEN=123:abc", "X=a=b"]

    assert _logged_argv(argv) == ["flow", "credentials", "set", "telegram", "--project", "p1",
                                  "TELEGRAM_BOT_TOKEN=***", "X=***"]


def test_setup_keeps_its_typed_answers_out_and_other_commands_are_logged_as_run():
    assert _carries_secrets(["flow", "project", "setup"]), "its stdin carries typed keys"
    plain = ["flow", "task", "note", "t1", "a=b"]
    assert not _carries_secrets(plain) and _logged_argv(plain) == plain
