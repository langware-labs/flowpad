"""A completion check that runs out of time has no verdict — it is not "the goal is unmet".

On a slow machine (a Windows box where starting PowerShell alone took 12–58 s) an
install's re-check was killed at its budget and reported as "the cli call ran, but the
check still fails". The ladder read that as a failed install and escalated to the
provisioner agent, which spent ten minutes hunting a tool that was installed all along.

These run the REAL shell (no stub for ``run_shell``): the install really lands a file,
and the check really outlives its budget.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

#: The check's own budget. The check below takes longer than this once the tool exists.
CHECK_BUDGET_S = 0.3


def _install_op() -> ComputeOpSpec:
    # Missing tool → the check fails at once; installed → the check is slow and runs out of time.
    slow_when_installed = f"test -f installed && sleep {CHECK_BUDGET_S * 4}"
    return ComputeOpSpec.model_validate(
        {
            "name": "slow-check",
            "subkind": "cli",
            "exe_data": {"commands": {"darwin": "touch installed", "linux": "touch installed"}},
            "attempts": [{"subkind": "agent", "exe_data": {"agent": "provisioner", "prompt": "install it"}}],
            "completion_check": {
                "commands": {"darwin": slow_when_installed, "linux": slow_when_installed},
                "timeout_seconds": CHECK_BUDGET_S,
            },
        }
    )


def test_a_check_that_runs_out_of_time_is_reported_as_unknown_not_as_failed(tmp_path):
    launched: list[str] = []

    async def provisioner(*, prompt: str = "", **_kw) -> PromptResult:
        launched.append(prompt)
        return PromptResult.satisfied("The agent finished.", executor="agentic_process-proc-1")

    answer = asyncio.run(
        run_op(_install_op(), trusted=True, workdir=Path(tmp_path), platform=_platform(), launch=provisioner)
    )

    assert (Path(tmp_path) / "installed").exists(), "the install itself ran"
    assert answer.exit_code is ExitCode.NOT_YET
    assert answer.check is not None and answer.check.timed_out
    assert "still fails" not in answer.detail
    assert f"did not answer within {CHECK_BUDGET_S:g} s" in answer.detail
    assert launched == [], "an unknown verdict must not escalate to the provisioner agent"


def _platform() -> str:
    import sys  # noqa: PLC0415

    return "darwin" if sys.platform == "darwin" else "linux"
