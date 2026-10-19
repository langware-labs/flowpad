"""The hook-outcome envelope and the reporter that applies it.

`flow hooks report` holds a worker's turn open. On claude and codex a non-zero
exit BLOCKS that turn, so the parsing here is deliberately paranoid: anything
absent, malformed or of the wrong type degrades to an inert outcome rather than
becoming an exit code.
"""

from __future__ import annotations

import json

import pytest
import typer

from flow_sdk.builtin.hooks.types import HOOK_OUTCOME_KEY, HookOutcome


class _Resp:
    """Minimal stand-in for the requests response the reporter receives."""

    def __init__(self, payload, text="x"):
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is _BAD_JSON:
            raise ValueError("not json")
        return self._payload


_BAD_JSON = object()


def _apply(response):
    """Run the reporter's apply step; return (exit_code, stdout, stderr)."""
    from flow_sdk.cli.flow_cli import _apply_hook_outcome

    with pytest.raises(typer.Exit) as excinfo:
        _apply_hook_outcome(response)
    return excinfo.value.exit_code


def _envelope(**kwargs) -> _Resp:
    return _Resp({"data": {HOOK_OUTCOME_KEY: HookOutcome(**kwargs).to_wire()}})


# ── the value type ──────────────────────────────────────────────────────────


def test_the_default_outcome_is_inert():
    assert HookOutcome().is_silent
    assert HookOutcome().exit_code == 0


def test_wire_round_trip_preserves_all_three_channels():
    original = HookOutcome(exit_code=2, stdout={"a": 1}, stderr="why")
    assert HookOutcome.from_wire(original.to_wire()) == original


@pytest.mark.parametrize(
    "payload",
    [None, "nonsense", 42, [], {"exit_code": "2"}, {"exit_code": True}, {"stdout": "not a dict"}],
    ids=["none", "string", "int", "list", "code-as-string", "code-as-bool", "stdout-as-string"],
)
def test_malformed_wire_degrades_to_inert_never_to_an_exit_code(payload):
    """A garbled payload must not be able to block a turn."""
    assert HookOutcome.from_wire(payload).exit_code == 0


# ── the reporter ────────────────────────────────────────────────────────────


def test_the_reporter_applies_the_exit_code(capsys):
    assert _apply(_envelope(exit_code=2, stderr="blocking reason")) == 2
    assert capsys.readouterr().err.strip() == "blocking reason"


def test_the_reporter_writes_stdout_as_json(capsys):
    assert _apply(_envelope(stdout={"decision": "block", "reason": "no"})) == 0
    assert json.loads(capsys.readouterr().out) == {"decision": "block", "reason": "no"}


@pytest.mark.parametrize(
    "response",
    [None, _Resp({}), _Resp({"data": {}}), _Resp({"data": {"received": True}}), _Resp(_BAD_JSON)],
    ids=["no-response", "empty-body", "no-outcome", "plain-ack", "unparseable"],
)
def test_the_reporter_exits_zero_and_silent_without_a_usable_envelope(response, capsys):
    assert _apply(response) == 0
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == ""


def test_the_reporter_is_vendor_blind():
    """It obeys the envelope; which code and stream mean what is the driver's job.

    A vendor branch here would put the same knowledge in two places and let the
    CLI drift from the driver that actually renders the answer.
    """
    import ast
    import inspect

    from flow_sdk.cli.flow_cli import _apply_hook_outcome

    # Compare CODE, not prose: the docstring names vendors precisely to explain
    # why a stray exit code is dangerous. ``ast.unparse`` already drops comments;
    # dropping the docstring node leaves executable code only.
    tree = ast.parse(inspect.getsource(_apply_hook_outcome).strip())
    fn = tree.body[0]
    first = fn.body[0]
    if isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant):
        fn.body = fn.body[1:]
    code = ast.unparse(tree)

    for vendor in ("claude", "codex", "copilot", "opencode"):
        assert vendor not in code.lower(), f"the reporter names {vendor}"
