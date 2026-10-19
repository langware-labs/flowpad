"""A ladder of `attempts`, any kind but `ask`, one check the whole way down.

Reaching the SAME goal by other, more expensive means when the op's own call did
not — cli, then an agent; two cli rungs; several agents — is `attempts`: rungs
of any subkind but `ask`, tried in order against the one completion check, until
it holds. An agent rung can also take `retries` further turns in its own
session. Seam-injected throughout: no process, no harness, milliseconds.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, PromptResult

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

CHECK = "rg --version"
INSTALL = "apt-get install -y ripgrep"
#: A SECOND, different cli command — proves a rung need not be an agent, and that
#: kind/position are the author's, not the runner's.
SNAP_INSTALL = "snap install ripgrep"


def _op(*attempts: dict) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(
        {
            "name": "ripgrep-on-path",
            "subkind": "cli",
            "exe_data": {"commands": {"linux": INSTALL}},
            "attempts": list(attempts),
            "completion_check": {"commands": {"linux": CHECK}},
        }
    )


def _agent(**fields) -> dict:
    return {"subkind": "agent", "exe_data": {"agent": "provisioner", "prompt": "Install ripgrep.", **fields}}


def _cli(command: str) -> dict:
    return {"subkind": "cli", "exe_data": {"commands": {"linux": command}}}


class Box:
    """A machine where ripgrep is present or not, where some cli commands actually
    install it and others do not, and where an agent installs it on a given turn
    (or never)."""

    def __init__(
        self,
        *,
        installed=False,
        working_commands: frozenset = frozenset(),
        agent_installs_on_turn: "int | None" = 1,
        agent_times_out=False,
    ):
        self.installed = installed
        self.working_commands = working_commands
        self.agent_installs_on_turn = agent_installs_on_turn
        self.agent_times_out = agent_times_out
        self.commands: list[str] = []
        self.turns: list[dict] = []

    async def shell(self, command, **_):
        self.commands.append(command)
        if command == CHECK:
            return CliResult.of_process(
                command, 0 if self.installed else 1, stderr="" if self.installed else "rg: not found"
            )
        works = command in self.working_commands
        self.installed = self.installed or works
        return CliResult.of_process(command, 0 if works else 100, stderr="" if works else "E: Unable to locate package")

    async def launch(self, *, prompt="", executor=None, **_):
        self.turns.append({"prompt": prompt, "executor": executor})
        if self.agent_times_out:
            return PromptResult.not_yet("the agent ran out of time", timed_out=True, executor="agentic_process-p1")
        if self.agent_installs_on_turn == len(self.turns):
            self.installed = True
        return PromptResult.satisfied("the agent stopped", executor="agentic_process-p1")


def _run(spec: ComputeOpSpec, box: Box):
    return asyncio.run(
        run_op(spec, trusted=True, workdir=Path.cwd(), platform="linux", shell=box.shell, launch=box.launch)
    )


def test_already_installed_runs_nothing():
    box = Box(installed=True)
    answer = _run(_op(_agent()), box)

    assert answer.ok and answer.ran is False
    assert box.commands == [CHECK] and box.turns == []


def test_a_command_that_works_never_starts_the_next_rung():
    box = Box(working_commands=frozenset({INSTALL}))
    answer = _run(_op(_agent()), box)

    assert answer.exit_code is ExitCode.OK
    assert box.commands == [CHECK, INSTALL, CHECK]
    assert box.turns == []


def test_a_command_that_misses_hands_the_same_goal_to_the_agent():
    box = Box()
    answer = _run(_op(_agent()), box)

    assert answer.exit_code is ExitCode.OK, answer.detail
    assert isinstance(answer, PromptResult), "the answer is the last rung's"
    assert len(box.turns) == 1 and box.turns[0]["executor"] is None, "a fresh process, not a continued one"
    assert "Install ripgrep." in box.turns[0]["prompt"]
    assert "after the cli attempt" in answer.detail, "what the attempt before it said is kept"
    assert box.commands[-1] == CHECK, "the agent is judged by the same check"


def test_a_rung_need_not_be_an_agent():
    """A second cli command is exactly as valid a rung as an agent — the runner
    does not special-case which kind comes next."""
    box = Box(working_commands=frozenset({SNAP_INSTALL}))
    answer = _run(_op(_cli(SNAP_INSTALL)), box)

    assert answer.exit_code is ExitCode.OK, answer.detail
    assert isinstance(answer, CliResult)
    assert box.commands == [CHECK, INSTALL, CHECK, SNAP_INSTALL, CHECK]
    assert box.turns == [], "no agent was ever named"


def test_several_rungs_run_in_order_until_one_holds():
    """A miss anywhere in the chain moves to the NEXT rung, whatever kind it is —
    the ladder does not stop at the first non-agent rung, or the first agent."""
    box = Box(agent_installs_on_turn=None)  # the agent never gets there either
    answer = _run(_op(_cli(SNAP_INSTALL), _agent()), box)

    assert answer.exit_code is ExitCode.NOT_YET
    assert box.commands == [CHECK, INSTALL, CHECK, SNAP_INSTALL, CHECK, CHECK]
    assert len(box.turns) == 1, "the ladder still reached the agent rung after the cli one missed"
    assert "after the cli attempt" in answer.detail


def test_a_fresh_rung_is_told_every_earlier_attempt():
    """The op's own cli call misses, its first agent rung ALSO misses, and a
    second agent rung succeeds. The second rung's prompt names both — the
    cli's AND the first agent's — so it does not waste a turn rediscovering
    what they already found out."""
    box = Box(agent_installs_on_turn=2)  # the first agent turn fails; the second (rung 2) succeeds
    answer = _run(_op(_agent(), _agent()), box)

    assert answer.exit_code is ExitCode.OK, answer.detail
    first_prompt, second_prompt = (t["prompt"] for t in box.turns)
    assert "Earlier attempts at this same goal" in first_prompt, "the cli's own miss came before it"
    assert "cli:" in first_prompt and "E: Unable to locate package" in first_prompt
    assert "Earlier attempts at this same goal" in second_prompt
    assert "cli:" in second_prompt and "E: Unable to locate package" in second_prompt
    assert "agent:" in second_prompt, "the first agent rung's own miss is named too, not only the cli's"


def test_a_retry_is_the_same_session_told_what_the_check_said():
    box = Box(agent_installs_on_turn=2)
    answer = _run(_op(_agent(retries=1)), box)

    assert answer.exit_code is ExitCode.OK, answer.detail
    first, second = box.turns
    assert second["executor"] == "agentic_process-p1", "the retry continues the same process"
    assert CHECK in second["prompt"] and "rg: not found" in second["prompt"]
    assert "Install ripgrep." not in second["prompt"], "the task is already in its session"


def test_retries_are_a_cap_not_a_loop():
    box = Box(agent_installs_on_turn=None)
    answer = _run(_op(_agent(retries=1)), box)

    assert answer.exit_code is ExitCode.NOT_YET
    assert len(box.turns) == 2


def test_an_agent_that_ran_out_of_time_is_not_prompted_again():
    """That process is busy, not finished — a second turn would stack on a turn it
    never ended. The next `attempts` entry, if any, is what runs instead."""
    box = Box(agent_times_out=True)
    answer = _run(_op(_agent(retries=1)), box)

    assert answer.exit_code is ExitCode.NOT_YET
    assert len(box.turns) == 1


def test_attempts_run_regardless_of_the_ops_own_subkind():
    """The root call can be prompt or agent too, not only cli — nothing about
    `attempts` is tied to what the op's own subkind is."""
    spec = ComputeOpSpec.model_validate(
        {
            "name": "summary-then-agent",
            "subkind": "prompt",
            "exe_data": {"prompt": "Summarize the log."},
            "attempts": [_agent()],
            "completion_check": {"commands": {"linux": CHECK}},
        }
    )
    box = Box()

    async def _prompt(*, say, **_):
        say("prompt ran")
        return PromptResult.satisfied("a bad summary")

    answer = asyncio.run(
        run_op(spec, trusted=True, workdir=Path.cwd(), platform="linux", shell=box.shell, launch=box.launch)
    )
    assert answer.exit_code is ExitCode.OK, answer.detail
    assert len(box.turns) == 1, "the prompt call does not satisfy the check, so the agent rung ran"


def test_a_rung_cannot_be_ask():
    """A person belongs at the wizard level, where declining stops only the one
    step asking — nothing inside an op can express that, so `ask` is refused
    at the type level."""
    with pytest.raises(ValueError):
        _op({"subkind": "ask", "exe_data": {"prompt": "Install?"}})


def test_attempts_need_a_completion_check():
    body = _op(_agent()).model_dump(mode="json", exclude_none=True)
    body["completion_check"] = None
    with pytest.raises(ValueError, match="attempts need a completion_check"):
        ComputeOpSpec.model_validate(body)
