"""A ``cli`` op that names a ``source_step`` runs that setup step IN the backend -- what ``flow source step
<source> <step> [--check] --value`` does, with no process, no shell and no HTTP call back into this same
backend. Each of those cost 12-50 s on a slow Windows box, and the WhatsApp Connect was three of them (check,
call, re-check), so its first attempt timed out. Same exit codes, same value as the CLI printed."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode
from flow_sdk.sources.setup_steps import ReturnedValue, SetupShown, SourceUpdateSpec

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval

SOURCE = "0b1e8c3a-1d6f-4a52-9a77-5d1b2f3e4c5d"
SHOWN = SetupShown(name="Flow", code="AB2CD3", link="https://wa.me/1?text=link%20AB2CD3")


def _spec(command: str = "flow source step $FLOWPAD_WIZARD_INPUT_SOURCE connect --value") -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(
        {
            "name": "connect",
            "label": "Connect WhatsApp",
            "subkind": "cli",
            "output_spec_kind": "source.setup_shown",
            "exe_data": {"commands": {"linux": command}, "source_step": "connect"},
            "completion_check": {"commands": {"linux": command.replace(" connect", " connect --check")}, "source_step": "connect"},
        }
    )


@pytest.fixture
def source(monkeypatch):
    state = {"live": False, "calls": []}

    async def step(self, name, *, check=False, values=None):
        state["calls"].append((name, check, dict(values or {})))
        if check and not state["live"]:
            return ReturnedValue.not_yet("no Connect code yet")
        state["live"] = True
        return ReturnedValue.satisfied("a Connect code is ready", value=SourceUpdateSpec(shown=SHOWN))

    async def get_by_id(cls, ident):
        return DataSource(id=ident, provider="flow_whatsapp", name="flow") if ident == SOURCE else None

    monkeypatch.setattr(DataSource, "step", step)
    monkeypatch.setattr(DataSource, "get_by_id", classmethod(get_by_id))
    return state


async def _never(*_a, **_kw):
    raise AssertionError("no shell: the step runs in this process")


async def test_check_call_recheck_run_in_process_and_bind_what_the_step_shows(source, tmp_path):
    env = {"FLOWPAD_WIZARD_INPUT_SOURCE": f"data_source-{SOURCE}", "FLOWPAD_WIZARD_INPUT_NAME": "flow"}

    answer = await run_op(_spec(), trusted=True, workdir=Path(tmp_path), platform="linux", shell=_never, env=env)

    assert answer.exit_code is ExitCode.OK
    assert [(name, check) for name, check, _ in source["calls"]] == [("connect", True), ("connect", False), ("connect", True)]
    assert source["calls"][0][2] == {"source": f"data_source-{SOURCE}", "name": "flow"}, "the wizard's values ride along"
    assert answer.value.code == "AB2CD3", "the value the CLI's --value printed: what the step shows"


async def test_without_value_the_check_prints_what_the_cli_printed(source):
    from flow_sdk.core.compute_op.runner import _source_step

    source["live"] = True
    env = {"FLOWPAD_WIZARD_INPUT_SOURCE": SOURCE}
    plain = ComputeOpSpec.model_validate(
        {"name": "x", "subkind": "cli", "exe_data": {"commands": {"linux": "flow source step s connect"}, "source_step": "connect"}}
    )

    said = await _source_step(plain.exe_data, env, check=True, platform="linux")

    printed = json.loads(said.stdout)
    assert printed["ok"] is True and printed["step"] == "connect" and printed["answer"]["exit_code"] == 0


async def test_a_run_with_no_source_falls_back_to_the_command(source, tmp_path):
    seen: list = []

    async def shell(command, **_kw):
        seen.append(command)
        return CliResult.of_process(command, 0, json.dumps(SHOWN.model_dump(mode="json")), "")

    await run_op(_spec(), trusted=True, workdir=Path(tmp_path), platform="linux", shell=shell, env={})

    assert seen and source["calls"] == []
