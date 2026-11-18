"""The rig's real transcript classifiers must not accept a partial failed answer."""

import json

from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import _entry_to_replay_flow_data
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowElementType
from flow_sdk.transcript_analyzer.parsers.codex import CodexStreamParser
from tests.loginless_e2e.worker_matrix import terminal_error


def test_retained_codex_failure_is_classified_without_echoing_provider_message():
    raw = {"type": "turn.failed", "error": {"message": json.dumps({"error": {
        "message": "Unsupported parameter (private diagnostic)", "type": "invalid_request_error",
        "param": "reasoning.effort", "code": "unsupported_parameter"}})}}
    entries = CodexStreamParser().feed(raw, 0)
    frames = [frame for entry in entries for frame in _entry_to_replay_flow_data(entry)]
    assert terminal_error(frames) == {"kind": "terminal_worker_error", "type": "invalid_request_error",
                                      "param": "reasoning.effort", "code": "unsupported_parameter"}


def test_partial_answer_cannot_hide_a_terminal_result_error():
    answer = FlowData(flow_value="pong", attributes={"element-type": FlowElementType.CHAT, "role": "assistant"})
    error = FlowData(flow_value={}, attributes={"element-type": FlowElementType.RESULT, "outcome": "error"})
    assert terminal_error([answer, error]) == {"kind": "terminal_worker_error"}
    assert terminal_error([answer]) is None


def test_successful_tool_error_is_not_a_terminal_failure():
    tool = FlowData(flow_value="private tool error", attributes={"element-type": FlowElementType.TOOL_RESULT,
                                                              "is-error": "true"})
    assert terminal_error([tool]) is None
