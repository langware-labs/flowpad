"""How a turn's answer becomes the OpenAI protocol on a deployed agent's chat endpoint.

An OpenAI client raises on a non-2xx and never reads Flowpad's exit code — so
here, unlike Flowpad's own edges, a turn that was not answered is a protocol
error. What it must never be again: a 200 with empty content for a turn that
errored, or a 500 for one that ran out of time.
"""
from __future__ import annotations

import pytest

from flow_sdk.schema.data_spec.returned_value_spec import PromptResult
from flow_sdk.server.routes.agent_chat import _status_of

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.parametrize("answer,expected", [
    (PromptResult.held("another turn holds this conversation"), (409, "turn_busy")),
    (PromptResult.refused("the agent is disabled here"), (403, "agent_disabled")),
    (PromptResult.not_found("the agent is gone"), (404, "agent_not_found")),
    (PromptResult.not_yet("out of time", timed_out=True), (502, "turn_timed_out")),
    (PromptResult.not_yet("The agent ended error."), (502, "turn_not_answered")),
])
def test_a_turn_that_was_not_answered_maps_to_its_protocol_error(answer, expected):
    assert _status_of(answer) == expected


def test_only_busy_is_a_409():
    """Retrying is right for busy and nothing else — a 409 for a never-started
    turn sent a caller into a retry loop that could not succeed."""
    never_started = PromptResult.not_yet("no worker could take the turn", ran=False)
    assert _status_of(never_started)[0] != 409
