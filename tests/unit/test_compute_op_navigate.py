"""A ``navigate`` op: the navigation is the fast lane AND the check.

While it answers ``NOT_YET`` (resolved, not usable yet) each rung of ``attempts``
gets its turn and the op navigates again after it; an agent rung's ``retries`` are
further turns in its session, told what the last navigation found. A place that
does not exist here, or a page that refuses to be framed, never wakes an agent.
Seam-injected throughout: no browser, no harness, milliseconds.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, NavigateResult, PromptResult

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

ADMIN = {"viewType": "web-app", "pointer": "url/aHR0cCUzQSUyRiUyRmxvY2FsaG9zdCUzQTMzMDAlMkY"}


def _op(*attempts: dict, target: dict | None = ADMIN) -> ComputeOpSpec:
    exe = {"target": target} if target is not None else {}
    return ComputeOpSpec.model_validate(
        {"name": "open-admin", "subkind": "navigate", "exe_data": exe, "attempts": list(attempts)}
    )


def _agent(**fields) -> dict:
    return {"subkind": "agent", "exe_data": {"agent": "spora-assistant", "prompt": "Start Spora Admin.", **fields}}


class Site:
    """A web app that is down until an agent starts it on a given turn — or answers
    with a fixed exit code (a missing place, a page that refuses framing)."""

    def __init__(self, *, up=False, starts_on_turn: "int | None" = 1, fixed: ExitCode | None = None):
        self.up = up
        self.starts_on_turn = starts_on_turn
        self.fixed = fixed
        self.navigations: list[dict] = []
        self.turns: list[dict] = []

    async def navigate(self, target, *, subject="", show=True):
        self.navigations.append({"target": target, "show": show, "subject": subject})
        if self.fixed is not None:
            return NavigateResult(exit_code=self.fixed, detail="fixed", verdict="frame_blocked", ran=False)
        if self.up:
            return NavigateResult.satisfied(verdict="ok", delivered=show)
        return NavigateResult.not_yet("Nothing is answering at localhost:3300.", verdict="not_running", delivered=show)

    async def launch(self, *, prompt="", executor=None, **_):
        self.turns.append({"prompt": prompt, "executor": executor})
        if self.starts_on_turn == len(self.turns):
            self.up = True
        return PromptResult.satisfied("the agent stopped", executor="agentic_process-repair")


def _run(spec: ComputeOpSpec, site: Site, **kw):
    return asyncio.run(
        run_op(spec, trusted=True, workdir=Path.cwd(), platform="linux",
               subject="agentic_process-session", launch=site.launch, navigate=site.navigate, **kw)
    )


def test_a_navigate_op_with_attempts_needs_no_completion_check():
    assert _op(_agent()).convergent


def test_a_navigate_op_takes_no_other_check():
    with pytest.raises(ValueError, match="its own check"):
        ComputeOpSpec.model_validate({
            "name": "x", "subkind": "navigate", "exe_data": {"target": ADMIN},
            "completion_check": {"commands": {"linux": "true"}},
        })


def test_a_place_that_works_starts_no_agent():
    site = Site(up=True)
    answer = _run(_op(_agent()), site)

    assert answer.exit_code is ExitCode.OK and isinstance(answer, NavigateResult)
    assert len(site.navigations) == 1 and site.turns == []
    assert site.navigations[0]["subject"] == "agentic_process-session"


def test_a_dead_server_is_repaired_then_opened_again():
    site = Site(starts_on_turn=1)
    answer = _run(_op(_agent()), site)

    assert answer.exit_code is ExitCode.OK
    assert [n["show"] for n in site.navigations] == [True, True], "navigate, repair, navigate again"
    assert answer.executor == "agentic_process-repair"
    told = site.turns[0]["prompt"]
    assert "http://localhost:3300/" in told and "Nothing is answering" in told
    assert "Start Spora Admin." in told and "Earlier attempts" in told


def test_retries_are_further_turns_told_what_the_navigation_found():
    site = Site(starts_on_turn=2)
    answer = _run(_op(_agent(retries=1)), site)

    assert answer.exit_code is ExitCode.OK
    assert len(site.turns) == 2 and site.turns[1]["executor"] == "agentic_process-repair"
    assert "still not usable" in site.turns[1]["prompt"] and "not_running" in site.turns[1]["prompt"]
    assert len(site.navigations) == 3


def test_a_repair_that_never_works_ends_not_yet_with_why():
    site = Site(starts_on_turn=None)
    answer = _run(_op(_agent()), site)

    assert answer.exit_code is ExitCode.NOT_YET and answer.verdict == "not_running"
    assert "after the agent attempt" in answer.detail


@pytest.mark.parametrize("code", [ExitCode.NOT_FOUND, ExitCode.REFUSED])
def test_what_an_agent_cannot_fix_never_starts_one(code):
    site = Site(fixed=code)
    answer = _run(_op(_agent()), site)

    assert answer.exit_code is code and site.turns == []


def test_check_only_asks_without_showing_or_repairing():
    site = Site()
    answer = _run(_op(_agent()), site, check_only=True)

    assert answer.exit_code is ExitCode.NOT_YET
    assert [n["show"] for n in site.navigations] == [False] and site.turns == []


def test_a_target_less_op_opens_the_pointer_a_wizard_step_bound():
    site = Site(up=True)
    env = {"FLOWPAD_WIZARD_INPUT_POINTER": json.dumps(ADMIN)}
    answer = _run(_op(target=None), site, env=env)

    assert answer.exit_code is ExitCode.OK
    assert site.navigations[0]["target"].pointer == ADMIN["pointer"]


def test_a_target_less_op_with_no_input_is_not_found():
    answer = _run(_op(target=None), Site(up=True))

    assert answer.exit_code is ExitCode.NOT_FOUND
