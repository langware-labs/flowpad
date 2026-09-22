"""An agent turn answers a VALUE, not just prose — when the persona declares one.

Before this, a turn's result was the assistant's last message and nothing else,
so a workflow node binding to "the agent's output" bound to a sentence. There
was one place in the whole SDK that enforced a declared shape (a ComputeOp's
``output``); ``Agent.input``/``output`` were, in their own docstring,
"declaration only".

Two halves, and the second matters as much as the first:

* a persona that DECLARES ``output`` gets its reply parsed and validated, and a
  reply that does not satisfy the shape is reported rather than silently passed on
* a persona that declares NOTHING is completely unaffected — which is every
  persona in this tree today, so this change is inert until someone opts in
"""
from __future__ import annotations

import pytest

from flow_sdk.blocks import PromptResult, _AgentRunner
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class _Persona:
    """The two attributes ``_output`` reads off an ``Agent`` row."""

    def __init__(self, output=None, name="probe"):
        self.output, self.name = output, name


EXECUTOR = "agentic_process-00000000-0000-4000-8000-000000000001"


class _Runner:
    """``_output`` with the process it answered for already named."""

    def __init__(self, output=None):
        self._inner = _AgentRunner(_Persona(output))

    def _output(self, text: str) -> PromptResult:
        return self._inner._output(text, EXECUTOR)


def _runner(output=None) -> _Runner:
    return _Runner(output)


def test_a_persona_that_declares_nothing_gets_exactly_what_it_got_before():
    out = _runner()._output("just a sentence")
    assert isinstance(out, PromptResult) and out.ok
    assert out.text == "just a sentence"
    assert out.value is None and out.executor == EXECUTOR


def test_a_declared_shape_is_parsed_out_of_the_reply():
    out = _runner({"port": "int"})._output('Picked one.\n```json\n{"port": 8080}\n```')
    # A declared shape compiles to a real DataSpec, so the value is a TYPED
    # object — that is the whole point. A dict would just be prose with braces.
    assert out.value.port == 8080
    assert out.exit_code is ExitCode.OK
    assert out.text.startswith("Picked one."), "the prose survives alongside the value"


def test_a_bare_json_reply_needs_no_fence():
    assert _runner({"port": "int"})._output('{"port": 9000}').value.port == 9000


def test_the_last_fence_wins_when_a_model_shows_its_working():
    reply = 'For example:\n```json\n{"port": 1}\n```\nThe answer:\n```json\n{"port": 2}\n```'
    assert _runner({"port": "int"})._output(reply).value.port == 2


def test_a_reply_that_does_not_match_the_shape_reports_instead_of_passing_it_on():
    out = _runner({"port": "int"})._output('```json\n{"port": "not-a-number"}\n```')
    assert out.value is None, "a value that fails its declared shape is not a value"
    assert out.exit_code is ExitCode.NOT_YET and out.ran, "the turn ran; it did not reach its shape"
    assert "declared output" in out.detail and "probe" in out.detail
    assert out.text, "the turn still happened; the prose is its only account"


def test_a_scalar_shape_takes_the_prose_itself():
    assert _runner("string")._output("  the answer  ").value == "the answer"


def test_the_value_is_read_the_same_way_on_a_replayed_turn():
    """``run`` answers a redelivered message from a record, not a fresh turn.

    That path used to build its own result; if it still did, a replay
    would return the text without the value and a binding would break on the
    second delivery only — the worst kind of bug to find.
    """
    runner = _runner({"port": "int"})
    live = runner._output('```json\n{"port": 8080}\n```')
    replayed = runner._output(live.text)
    assert replayed == live
