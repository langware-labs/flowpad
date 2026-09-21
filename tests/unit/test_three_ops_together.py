"""Three ops, one value from a person, one from a command, and a third that
needs both — no wizard.

    get-api-key   asks a person            -> {token}
    pick-port     runs a command           -> {port}
    start-server  requires both            -> receives $token and $port

Real subprocesses, real registry, real runner. The only stand-in is the
person, whose answer is delivered through the same call the window's POST ends
in.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from flow_sdk.core.compute.ask import _PENDING, answer, open_questions
from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

HERE = sys.platform


def _ops(tmp: Path) -> dict[str, ComputeOpSpec]:
    served = tmp / "served"
    return {
        # No completion check: a call, not a goal — it asks every time it runs.
        "get-api-key": ComputeOpSpec.model_validate({
            "name": "get-api-key", "label": "API token",
            "attempts": [{"kind": "ask", "prompt": "Service X API token"}],
            "output": {"token": "string"},
        }),
        "pick-port": ComputeOpSpec.model_validate({
            "name": "pick-port", "label": "a free port",
            "attempts": [{"kind": "command", "commands": {HERE: "echo '{\"port\": 8080}'"}}],
            "output": {"port": "int"},
        }),
        "start-server": ComputeOpSpec.model_validate({
            "name": "start-server", "label": "server",
            "requires": ["get-api-key", "pick-port"],
            "completion_check": {"commands": {HERE: f"test -f {served}"}},
            # Fails unless BOTH values arrived — the assertion is what the
            # command received, not what the test handed in.
            "attempts": [{"kind": "command", "commands": {
                HERE: f'test -n "$token" && test -n "$port" && echo "$token:$port" > {served}'}}],
        }),
    }


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    _PENDING.clear()
    yield
    _PENDING.clear()


async def _run(name: str, ops, tmp_path, *, timeout: float = 5.0):
    async def resolve(dependency):
        return ops.get(dependency)
    return await run_op(ops[name], trusted=True, workdir=tmp_path, platform=HERE,
                        resolve=resolve, ask_timeout=timeout)


async def _person_types(value) -> None:
    for _ in range(200):
        if open_questions():
            assert answer(open_questions()[0].id, value)
            return
        await asyncio.sleep(0.01)
    raise AssertionError("nobody was asked")


async def test_nobody_answers_so_the_server_never_starts(tmp_path):
    said = await _run("start-server", _ops(tmp_path), tmp_path, timeout=0.3)

    assert said.exit_code is ExitCode.NOT_YET
    assert said.detail.startswith("API token:"), "the blocker names itself"
    assert not (tmp_path / "served").exists(), "the server started with no token"


async def test_the_three_work_together(tmp_path):
    ops = _ops(tmp_path)
    run = asyncio.create_task(_run("start-server", ops, tmp_path))
    await _person_types({"token": "sk-live-1"})
    said = await run

    assert said.exit_code is ExitCode.OK, said.detail
    assert (tmp_path / "served").read_text().strip() == "sk-live-1:8080", (
        "start-server did not receive both values — one from a person, one from a command"
    )


async def test_two_dependencies_returning_the_same_field_is_refused(tmp_path):
    """`$port` from two ops would silently take whichever ran last."""
    ops = _ops(tmp_path)
    ops["pick-port-too"] = ComputeOpSpec.model_validate({
        "name": "pick-port-too", "label": "another port",
        "attempts": [{"kind": "command", "commands": {HERE: "echo '{\"port\": 9090}'"}}],
        "output": {"port": "int"},
    })
    ops["start-server"] = ops["start-server"].model_copy(update={"requires": ["pick-port", "pick-port-too"]})

    with pytest.raises(ValueError, match="both return `port`"):
        await _run("start-server", ops, tmp_path)
