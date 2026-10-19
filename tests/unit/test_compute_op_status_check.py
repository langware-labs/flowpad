"""A compute op whose completion check is a STATUS fact (``status_check: install:<harness>``).

The setup wizard's Claude Code steps ask "is the claude CLI here". As a shell check that was
``flow status --refresh --check install:claude``: a shell, a cold ``flow`` CLI and an HTTP call
back into the backend that was asking -- on a Windows VM, more than the 30s a check gets, so
an installed Claude read as missing and the wizard offered to install it again. The backend owns
the answer; a ``status_check`` asks it in-process.
"""

from __future__ import annotations

import pytest

import flow_sdk.core.status.check as status_check
from flow_sdk.core.compute_op import check_op, run_op
from flow_sdk.core.status.check import UnknownStatusFact
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

INSTALL = {"darwin": "install-claude", "linux": "install-claude", "win32": "install-claude"}


def _spec(**over) -> ComputeOpSpec:
    base = {
        "name": "claude-code-on-path",
        "subkind": "cli",
        "exe_data": {"commands": INSTALL},
        "status_check": "install:claude",
    }
    return ComputeOpSpec.model_validate({**base, **over})


@pytest.fixture
def box(monkeypatch):
    """Whether claude is installed, and every fact the op asked."""
    state = {"installed": False, "asked": []}

    async def check_fact(fact):
        state["asked"].append(fact)
        return state["installed"], "claude is " + ("installed" if state["installed"] else "not installed")

    monkeypatch.setattr(status_check, "check_fact", check_fact)
    return state


async def test_the_fact_is_answered_in_process_never_by_a_shell(box):
    async def no_shell(*_a, **_k):
        raise AssertionError("a status check must not run a shell")

    box["installed"] = True
    said = await check_op(_spec(), shell=no_shell)

    assert said.exit_code is ExitCode.OK
    assert box["asked"] == ["install:claude"]


async def test_a_missing_harness_is_work_to_do_and_the_call_runs(box):
    ran: list[str] = []

    async def shell(command, **_k):
        ran.append(command)
        box["installed"] = True  # the installer lands the CLI
        return CliResult.of_process(command, 0)

    answer = await run_op(_spec(), trusted=True, shell=shell)

    assert ran == ["install-claude"], "only the install command runs in a shell"
    assert answer.exit_code is ExitCode.OK
    assert box["asked"] == ["install:claude", "install:claude"], "checked before, and re-checked after"


async def test_a_fact_the_layer_cannot_answer_is_a_broken_document(monkeypatch):
    async def check_fact(_fact):
        raise UnknownStatusFact("no harness named 'nope'")

    monkeypatch.setattr(status_check, "check_fact", check_fact)

    said = await check_op(_spec(status_check="install:nope"))

    assert said.exit_code is ExitCode.NOT_FOUND and "nope" in said.detail


def test_an_op_has_one_kind_of_check_not_both():
    with pytest.raises(ValueError, match="not both"):
        _spec(completion_check={"commands": {"darwin": "true"}})


def test_a_status_check_counts_as_a_check_for_the_agent_fallback():
    spec = _spec(attempts=[{"subkind": "agent", "exe_data": {"agent": "provisioner", "prompt": "install it"}}])

    assert spec.convergent
