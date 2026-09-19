"""``run_op`` — ask, act cheapest-first, prove.

Every case drives the real runner with two stub callables in place of the shell
and the agent launcher. That is what those seams are for: the machine has no
I/O of its own, so its whole behaviour is assertable in milliseconds.

The three cases that carry the design are the ones where a rung REPORTS SUCCESS
and the goal is still not met — `exit 0` is never the verdict, the re-check is.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.core.compute_op import ComputeOpNotApproved, check_op, run_op
from flow_sdk.core.compute.exec import ShellResult
from flow_sdk.core.compute.process_step import ProcessResult
from flow_sdk.schema.data_spec.compute_op_spec import CheckOutcome, ComputeOpSpec

pytestmark = pytest.mark.timeout(5)


def _spec(**over) -> ComputeOpSpec:
    body = {
        "name": "jq-on-path",
        "label": "jq",
        "completion_check": {"commands": {"linux": "have jq"}},
        "attempts": [{"kind": "command", "commands": {"linux": "install jq"}}],
    }
    body.update(over)
    return ComputeOpSpec.model_validate(body)


def _shell(code_for, *, seen=None):
    """A shell whose exit code is a function of the command."""
    async def shell(command, **_kw):
        if seen is not None:
            seen.append(command)
        code = code_for(command)
        if code == "timeout":
            return ShellResult(returncode=None, timed_out=True)
        return ShellResult(returncode=code, stdout="", stderr=f"{command}: nope" if code else "")
    return shell


def _launch(prompts=None, *, ok=True, message="", process_id="proc-1"):
    async def launch(**kw):
        if prompts is not None:
            prompts.append(kw["prompt"])
        return ProcessResult(process_id, ok, message)
    return launch


async def _run_op(spec, shell, launch=None, *, tmp_path, **over):
    return await run_op(
        spec, trusted=True, workdir=Path(tmp_path), platform="linux",
        shell=shell, launch=launch or _launch(), **over,
    )


# ── the check, on its own ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_is_cheap_and_answers_three_ways(tmp_path):
    spec = _spec(completion_check={"commands": {"linux": "have jq"}}, not_applicable_codes=[99])
    ask = lambda code: check_op(spec, workdir=tmp_path, platform="linux", shell=_shell(lambda _c: code))

    assert await ask(0) is CheckOutcome.SATISFIED
    assert await ask(1) is CheckOutcome.EXECUTE
    assert await ask(99) is CheckOutcome.NOT_APPLICABLE


@pytest.mark.asyncio
async def test_a_platform_with_no_command_is_not_applicable_never_a_failure(tmp_path):
    seen: list[str] = []
    spec = _spec(completion_check={"commands": {"darwin": "have jq"}})
    outcome = await check_op(spec, workdir=tmp_path, platform="linux",
                             shell=_shell(lambda _c: 0, seen=seen))
    assert outcome is CheckOutcome.NOT_APPLICABLE
    assert seen == [], "a check that cannot be asked here must not run anything"


@pytest.mark.asyncio
async def test_a_timed_out_check_executes_rather_than_claiming_satisfied(tmp_path):
    outcome = await check_op(_spec(), workdir=tmp_path, platform="linux",
                             shell=_shell(lambda _c: "timeout"))
    # An unanswered question is not a satisfied one: running an idempotent
    # attempt we did not need is far cheaper than skipping one we did.
    assert outcome is CheckOutcome.EXECUTE


# ── the ladder ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_satisfied_costs_one_check_and_runs_nothing(tmp_path):
    seen: list[str] = []
    verdict = await _run_op(_spec(), _shell(lambda _c: 0, seen=seen), tmp_path=tmp_path)

    assert verdict.ok and "already satisfied" in verdict.detail
    assert seen == ["have jq"], "a satisfied goal must not run an attempt"


@pytest.mark.asyncio
async def test_the_cheap_rung_fixes_it_and_the_agent_is_never_woken(tmp_path):
    installed = {"jq": False}
    prompts: list[str] = []

    async def shell(command, **_kw):
        if command == "install jq":
            installed["jq"] = True
            return ShellResult(returncode=0)
        return ShellResult(returncode=0 if installed["jq"] else 1)

    spec = _spec(attempts=[
        {"kind": "command", "commands": {"linux": "install jq"}},
        {"kind": "agent", "agent": "provisioner", "prompt": "get jq on the path"},
    ])
    verdict = await _run_op(spec, shell, _launch(prompts), tmp_path=tmp_path)

    assert verdict.ok and "the command attempt did it" in verdict.detail
    assert prompts == [], "the expensive rung must not run once the goal holds"


@pytest.mark.asyncio
async def test_a_rung_that_exits_zero_without_reaching_the_goal_escalates(tmp_path):
    """The case that breaks any design that trusts exit codes.

    `uv` installs happily into ~/.local/bin and the shell still cannot find it.
    The command rung succeeds, the CHECK does not, so the ladder keeps climbing.
    """
    state = {"on_path": False}
    prompts: list[str] = []

    async def shell(command, **_kw):
        if command == "install uv":
            return ShellResult(returncode=0, stdout="installed to ~/.local/bin")
        return ShellResult(returncode=0 if state["on_path"] else 1, stderr="uv: not found")

    async def launch(**kw):
        state["on_path"] = True
        prompts.append(kw["prompt"])
        return ProcessResult("proc-1", True, "put it on PATH")

    spec = _spec(
        name="uv-on-path", label="uv",
        completion_check={"commands": {"linux": "uv --version"}},
        attempts=[
            {"kind": "command", "commands": {"linux": "install uv"}},
            {"kind": "agent", "agent": "provisioner", "prompt": "get uv on the path"},
        ],
    )
    verdict = await _run_op(spec, shell, launch, tmp_path=tmp_path)

    assert verdict.ok and "the agent attempt did it" in verdict.detail
    assert len(prompts) == 1


@pytest.mark.asyncio
async def test_the_agent_rung_is_told_what_the_cheap_rung_tried(tmp_path):
    """Escalation without context is just a slower copy of the rung below it."""
    prompts: list[str] = []
    spec = _spec(
        description="jq parses JSON on the command line.",
        setup="Run `apt-get update` first — a fresh image ships an empty index.",
        attempts=[
            {"kind": "command", "commands": {"linux": "apt-get install -y jq"}},
            {"kind": "agent", "agent": "provisioner", "prompt": "install jq"},
        ],
    )
    await _run_op(spec, _shell(lambda c: 0 if c == "never" else 100), _launch(prompts), tmp_path=tmp_path)

    prompt = prompts[0]
    assert "apt-get install -y jq" in prompt, "the agent must know what was already tried"
    assert "exit 100" in prompt, "...and how it failed"
    assert "apt-get update" in prompt, "...and how a person does it by hand"
    assert "have jq" in prompt, "...and what proves it is done"


@pytest.mark.asyncio
async def test_exhausted_attempts_report_the_goal_as_pending(tmp_path):
    verdict = await _run_op(_spec(), _shell(lambda _c: 1), tmp_path=tmp_path)

    assert verdict.ok is False
    assert verdict.pending == ("jq-on-path",)
    assert "install jq" in verdict.detail, "the detail must name the last thing tried"


@pytest.mark.asyncio
async def test_a_goal_with_no_attempts_still_checks_and_says_pending(tmp_path):
    # A credential nobody can obtain from a script is still worth CHECKING.
    verdict = await _run_op(_spec(attempts=[]), _shell(lambda _c: 1), tmp_path=tmp_path)

    assert verdict.ok is False and verdict.pending == ("jq-on-path",)
    assert "nothing here can reach this goal" in verdict.detail


@pytest.mark.asyncio
async def test_not_applicable_is_a_pass_not_a_failure(tmp_path):
    spec = _spec(completion_check={"commands": {"linux": "locale | grep -q UTF-8"}}, not_applicable_codes=[2])
    verdict = await _run_op(spec, _shell(lambda _c: 2), tmp_path=tmp_path)

    assert verdict.ok and "not applicable here" in verdict.detail


@pytest.mark.asyncio
async def test_a_rung_silent_on_this_platform_is_skipped_not_failed(tmp_path):
    spec = _spec(attempts=[
        {"kind": "command", "commands": {"darwin": "brew install jq"}},
        {"kind": "command", "commands": {"linux": "apt-get install -y jq"}},
    ])
    seen: list[str] = []
    await _run_op(spec, _shell(lambda c: 0 if "apt-get" in c else 1, seen=seen), tmp_path=tmp_path)

    assert "brew install jq" not in seen
    assert "apt-get install -y jq" in seen


# ── requires ─────────────────────────────────────────────────────────────────

def _resolver(specs):
    async def resolve(name):
        return specs.get(name)
    return resolve


@pytest.mark.asyncio
async def test_requires_run_first_and_in_order(tmp_path):
    seen: list[str] = []
    specs = {
        "git-on-path": _spec(name="git-on-path", label="git",
                             completion_check={"commands": {"linux": "have git"}}, attempts=[]),
        "repo-cloned": _spec(name="repo-cloned", label="repo",
                             completion_check={"commands": {"linux": "have repo"}},
                             requires=["git-on-path"], attempts=[]),
    }
    verdict = await _run_op(
        specs["repo-cloned"], _shell(lambda _c: 0, seen=seen),
        tmp_path=tmp_path, resolve=_resolver(specs),
    )

    assert verdict.ok
    assert seen == ["have git", "have repo"], "a dependency is proven before the goal is asked"


@pytest.mark.asyncio
async def test_a_failed_dependency_stops_the_chain_and_keeps_its_own_detail(tmp_path):
    specs = {
        "git-on-path": _spec(name="git-on-path", label="git",
                             completion_check={"commands": {"linux": "have git"}}, attempts=[]),
        "repo-cloned": _spec(name="repo-cloned", label="repo",
                             completion_check={"commands": {"linux": "have repo"}},
                             requires=["git-on-path"], attempts=[]),
    }
    verdict = await _run_op(
        specs["repo-cloned"], _shell(lambda c: 1 if "git" in c else 0),
        tmp_path=tmp_path, resolve=_resolver(specs),
    )

    assert verdict.ok is False
    assert verdict.pending == ("git-on-path",), "the blocker is named, not the thing it blocked"


@pytest.mark.asyncio
async def test_a_missing_dependency_is_named(tmp_path):
    spec = _spec(requires=["docker-running"], attempts=[])
    verdict = await _run_op(spec, _shell(lambda _c: 0), tmp_path=tmp_path, resolve=_resolver({}))

    assert verdict.ok is False and verdict.pending == ("docker-running",)
    assert "does not exist" in verdict.detail


@pytest.mark.asyncio
async def test_a_cycle_is_a_bug_in_the_documents_not_a_runtime_condition(tmp_path):
    a = _spec(name="a", requires=["b"], attempts=[])
    b = _spec(name="b", requires=["a"], attempts=[])
    with pytest.raises(ValueError, match="cycle"):
        await _run_op(a, _shell(lambda _c: 1), tmp_path=tmp_path, resolve=_resolver({"a": a, "b": b}))


# ── trust ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_unapproved_op_refuses_before_it_asks_anything(tmp_path):
    seen: list[str] = []
    with pytest.raises(ComputeOpNotApproved):
        await run_op(_spec(), trusted=False, workdir=Path(tmp_path), platform="linux",
                     shell=_shell(lambda _c: 0, seen=seen))
    # Refuses, never blocks — and never runs a command to find out.
    assert seen == []
