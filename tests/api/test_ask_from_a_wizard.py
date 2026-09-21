"""A wizard step that asks a person, answered over HTTP the way the UI does.

The other half of the matrix. `tests/unit/test_compute_op_ask.py` drives an ask
op from Python; this drives one through a WIZARD, because that is how a person
meets most ops — and because the wizard is what an ask op is meant to stop
being mandatory for.

The answer arrives through the same route the window posts to, against the real
app. No mocks: a real wizard run, a real op, a real HTTP answer.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from flow_sdk.core.compute.ask import open_questions
from flow_sdk.core.wizard.runner import COMPLETED, Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(60)  # do not increase timeout without approval

ASK_OP = ComputeOpSpec.model_validate({
    "name": "get-api-key",
    "label": "API token",
    "attempts": [{"kind": "ask", "prompt": "Service X API token"}],
    "output": {"token": "string"},
})

WIZARD = WizardSpec.model_validate({
    "name": "connect-service-x",
    "description": "Connect Service X",
    "steps": [{"id": "key", "kind": "compute", "ref": "get-api-key", "bind": "key"}],
})


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")


async def _resolve_op(name: str):
    # Trust travels with the callee, not with the run — hence Resolved, not
    # the bare spec.
    return Resolved(ASK_OP, True) if name == "get-api-key" else None


async def _answer_over_http(client, value, *, timeout: float = 20.0) -> str:
    """Act as the window: find the question, POST the answer to the real route."""
    for _ in range(int(timeout / 0.05)):
        waiting = open_questions()
        if waiting:
            sent = await client.post(f"/api/v1/ask/{waiting[0].id}/answer", json={"value": value})
            assert sent.status_code == 200, sent.text
            return waiting[0].id
        await asyncio.sleep(0.05)
    raise AssertionError("the wizard step never raised a question")


async def test_a_wizard_step_asks_and_binds_what_the_person_typed(client, tmp_path):
    run = asyncio.create_task(run_wizard(
        WIZARD, trusted=True, approved=True, workdir=Path(tmp_path),
        platform=sys.platform, resolve_op=_resolve_op,
    ))
    await _answer_over_http(client, {"token": "typed-into-the-window"})
    result = await run

    assert result.status == COMPLETED, result.message
    assert result.ok is True
    # `bind` is what makes an answer reusable by a LATER step — the whole reason
    # a wizard was the only way to move a value between two units of work.
    assert result.outputs["key"].token == "typed-into-the-window"


async def test_a_cancelled_step_stops_the_wizard_without_a_value(client, tmp_path):
    from flow_sdk.core.compute.ask import cancel

    run = asyncio.create_task(run_wizard(
        WIZARD, trusted=True, approved=True, workdir=Path(tmp_path),
        platform=sys.platform, resolve_op=_resolve_op,
    ))
    for _ in range(400):
        waiting = open_questions()
        if waiting:
            assert cancel(waiting[0].id) is True
            break
        await asyncio.sleep(0.05)
    else:
        raise AssertionError("the wizard step never raised a question")
    result = await run

    assert result.ok is False, "a declined question must not read as a completed wizard"
    assert "key" not in (result.outputs or {})
