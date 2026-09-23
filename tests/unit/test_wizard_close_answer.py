"""A conversational wizard's close carries the same answer every wizard run gives.

``status`` stays the agent's three-way word (a cancel is not an error to the
person); ``answer`` is the ``WizardResult`` — OK with the data as its value when
done, NOT_YET otherwise. The event is captured; nothing is sent anywhere.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, WizardResult

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _close(monkeypatch, payload: dict) -> dict:
    emitted: list[tuple[str, dict]] = []

    async def capture(self, event, data):
        emitted.append((event, data))

    monkeypatch.setattr(AgenticProcess, "emit_entity_event", capture)
    result = await AgenticProcess(name="w").on_wizard_close(payload)
    assert emitted == [("wizard.closed", result)]
    return result


async def test_done_answers_ok_with_the_data_as_value(monkeypatch):
    result = await _close(monkeypatch, {"status": "done", "data": {"path": "/tmp/app"}})
    answer = WizardResult.model_validate(result["answer"])
    assert answer.exit_code is ExitCode.OK and answer.value == {"path": "/tmp/app"}
    assert result["status"] == "done"


@pytest.mark.parametrize("payload, said", [
    ({"status": "cancel"}, "cancelled"),
    ({"status": "error", "errorStr": "no git"}, "no git"),
    ({"status": "bogus"}, "Invalid wizard status"),
])
async def test_anything_else_answers_not_yet_with_the_reason(monkeypatch, payload, said):
    answer = WizardResult.model_validate((await _close(monkeypatch, payload))["answer"])
    assert answer.exit_code is ExitCode.NOT_YET and said in answer.detail
