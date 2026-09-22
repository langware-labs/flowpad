"""``run_wizard`` — the call loop.

A step no longer runs anything itself: it CALLS a ComputeOp or another wizard,
and reads one `ReturnedValue` back. The check / call / re-check those ops run
through is pinned in `test_compute_op_runner.py`; what is pinned here is what
only a sequence owns — order, `on_fail`, argument binding, and the trust that
must NOT compose.

The answer is a `WizardResult`: its own verdict, and each step's answer as that
step's OWN result. A step never reached is absent.

Every case drives the real runner with stub resolvers and stub I/O.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.core.compute.receipt import receipt_path
from flow_sdk.core.compute_op.runner import VALUE_KEY
from flow_sdk.core.wizard.runner import MAX_WIZARD_DEPTH, Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import (
    CliResult,
    ExitCode,
    PromptResult,
    WizardResult,
)
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)


def _op(name: str, **over) -> ComputeOpSpec:
    """A convergent cli op: `have <name>` is its check, `install <name>` its call."""
    body = {
        "name": name,
        "subkind": "cli",
        "exe_data": {"commands": {"linux": f"install {name}"}},
        "completion_check": {"commands": {"linux": f"have {name}"}},
    }
    body.update(over)
    return ComputeOpSpec.model_validate(body)


def _ops(*specs, trusted: bool = True):
    table = {s.name: s for s in specs}

    async def resolve(name: str):
        spec = table.get(name)
        return Resolved(spec, trusted) if spec is not None else None

    return resolve


def _wizards(table: dict, *, trusted: bool = True):
    async def resolve(name: str):
        spec = table.get(name)
        return Resolved(spec, trusted) if spec is not None else None

    return resolve


def _shell(code_for, *, seen=None):
    async def shell(command, **kw):
        if seen is not None:
            seen.append((command, dict(kw.get("extra_env") or {})))
        return CliResult.of_process(command, code_for(command))
    return shell


def _launch():
    async def launch(**_kw):
        return PromptResult.satisfied("The agent finished.", executor="agentic_process-proc-1")
    return launch


async def _run_wizard(spec, *, tmp_path, shell=None, **over):
    return await run_wizard(
        spec, trusted=True, platform="linux", workdir=Path(tmp_path),
        shell=shell or _shell(lambda _c: 0), launch=_launch(),
        activity_path=f"wz/{tmp_path.name}", **over,
    )


# ── dispatch ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_compute_step_takes_the_ops_answer_as_its_own(tmp_path):
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_op=_ops(_op("jq")))

    assert isinstance(result, WizardResult) and result.ok
    step = result.steps["jq"]
    assert type(step) is CliResult, "a step's answer is the op's OWN result"
    assert step.exit_code is ExitCode.OK and step.ran is False, "the check held; nothing ran"
    assert result.ran is False


@pytest.mark.asyncio
async def test_an_unknown_ref_fails_the_step_naming_it(tmp_path):
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "nope", "kind": "compute", "ref": "missing-op"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_op=_ops())

    assert result.exit_code is ExitCode.NOT_YET
    assert result.steps["nope"].exit_code is ExitCode.NOT_FOUND
    assert "missing-op" in result.steps["nope"].detail
    assert "missing-op" in result.detail


@pytest.mark.asyncio
async def test_a_step_calling_another_wizard_runs_it_and_reads_one_answer(tmp_path):
    inner = WizardSpec.model_validate({"name": "inner", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner"},
    ]})
    result = await _run_wizard(outer, tmp_path=tmp_path, resolve_op=_ops(_op("jq")),
                               resolve_wizard=_wizards({"inner": inner}))

    assert result.ok
    sub = result.steps["sub"]
    assert type(sub) is WizardResult, "a nested wizard's answer is its own WizardResult"
    # `ran=False`: the inner wizard's only step was already satisfied, so the
    # calling step did no work either — a callee being a wizard rather than an
    # op must not change the verdict.
    assert sub.ok and sub.ran is False
    assert type(sub.steps["jq"]) is CliResult


@pytest.mark.asyncio
async def test_a_nested_wizard_that_actually_works_reports_that_it_ran(tmp_path):
    """The other half of the pair above: `ran=False` must mean "nothing ran",
    not "the callee was a wizard". Here the inner op's goal does not hold until
    its call runs, so the calling step reports real work."""
    inner = WizardSpec.model_validate({"name": "inner", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner"},
    ]})
    asked: list[str] = []

    def code_for(command: str) -> int:
        if command.startswith("have "):          # the completion check
            asked.append(command)
            return 1 if len(asked) == 1 else 0   # missing, then present
        return 0                                  # the install call

    result = await _run_wizard(outer, tmp_path=tmp_path, shell=_shell(code_for),
                               resolve_op=_ops(_op("jq")), resolve_wizard=_wizards({"inner": inner}))

    assert result.ok and result.ran is True
    assert result.steps["sub"].ran is True


# ── on_fail: the sequence's policy, not the op's ─────────────────────────────

@pytest.mark.asyncio
async def test_abort_stops_the_run_and_later_steps_are_absent(tmp_path):
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "first", "kind": "compute", "ref": "broken", "on_fail": "abort"},
        {"id": "second", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, shell=_shell(lambda _c: 1),
                               resolve_op=_ops(_op("broken"), _op("jq")))

    assert result.exit_code is ExitCode.NOT_YET
    assert result.steps["first"].exit_code is ExitCode.NOT_YET
    # Never reached ⇒ absent. A fabricated failed entry would blame a step that never ran.
    assert "second" not in result.steps


@pytest.mark.asyncio
async def test_continue_lets_the_rest_of_the_run_proceed(tmp_path):
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "first", "kind": "compute", "ref": "broken", "on_fail": "continue"},
        {"id": "second", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(
        spec, tmp_path=tmp_path,
        shell=_shell(lambda c: 1 if "broken" in c else 0),
        resolve_op=_ops(_op("broken"), _op("jq")),
    )

    assert list(result.steps) == ["first", "second"]
    assert result.steps["first"].exit_code is ExitCode.NOT_YET
    assert result.steps["second"].ok and result.steps["second"].ran is False
    assert result.exit_code is ExitCode.NOT_YET, "one step failing is still a run that did not finish"


# ── arguments ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_args_bind_a_value_in_scope_to_the_callees_parameter(tmp_path):
    seen: list[tuple[str, dict]] = []
    inner = WizardSpec.model_validate({"name": "inner", "steps": [
        {"id": "use", "kind": "compute", "ref": "use-key"},
    ]})
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner", "args": {"API_KEY": "WAHA_KEY"}},
    ]})
    result = await _run_wizard(outer, tmp_path=tmp_path, inputs={"WAHA_KEY": "s3cret"},
                               shell=_shell(lambda _c: 0, seen=seen),
                               resolve_op=_ops(_op("use-key")), resolve_wizard=_wizards({"inner": inner}))

    assert result.ok
    # The callee's parameter carries the caller's VALUE, by name.
    assert any(env.get("FLOWPAD_WIZARD_INPUT_API_KEY") == "s3cret" for _c, env in seen), seen


@pytest.mark.asyncio
async def test_an_arg_that_names_nothing_in_scope_is_a_literal(tmp_path):
    seen: list[tuple[str, dict]] = []
    inner = WizardSpec.model_validate({"name": "inner", "steps": [
        {"id": "use", "kind": "compute", "ref": "use-port"},
    ]})
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner", "args": {"PORT": "3010"}},
    ]})
    result = await _run_wizard(outer, tmp_path=tmp_path, shell=_shell(lambda _c: 0, seen=seen),
                               resolve_op=_ops(_op("use-port")), resolve_wizard=_wizards({"inner": inner}))

    assert result.ok
    assert any(env.get("FLOWPAD_WIZARD_INPUT_PORT") == "3010" for _c, env in seen), seen


@pytest.mark.asyncio
async def test_a_value_reaches_a_command_as_env_and_is_never_inlined(tmp_path):
    """The injection guard, kept exactly as strict as it was before the refactor.

    Interpolating a value into a command string would make an answer of
    `; rm -rf /` executable, straight through the trust gate that decides
    whether this may run shell at all.
    """
    seen: list[tuple[str, dict]] = []
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "clone", "kind": "compute", "ref": "clone"},
    ]})
    op = _op("clone", completion_check={"commands": {"linux": "test -d repo"}},
             exe_data={"commands": {"linux": 'git clone "$FLOWPAD_WIZARD_INPUT_REPO_URL"'}})
    await _run_wizard(spec, tmp_path=tmp_path, shell=_shell(lambda _c: 0, seen=seen),
                      inputs={"REPO_URL": "; rm -rf / #"}, resolve_op=_ops(op))

    commands = [command for command, _env in seen]
    assert not any("rm -rf" in command for command in commands), commands
    assert any(env.get("FLOWPAD_WIZARD_INPUT_REPO_URL") == "; rm -rf / #" for _c, env in seen), seen


# ── trust ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_unapproved_wizard_refuses_before_it_runs_anything(tmp_path):
    seen: list = []
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    result = await run_wizard(spec, trusted=False, platform="linux", workdir=Path(tmp_path),
                              shell=_shell(lambda _c: 0, seen=seen), resolve_op=_ops(_op("jq")))

    assert type(result) is WizardResult
    assert result.exit_code is ExitCode.REFUSED and result.ran is False
    assert seen == [], "the gate refuses before any command, not after"


@pytest.mark.asyncio
async def test_being_shipped_does_not_lend_approval_to_a_callee(tmp_path):
    """The dangerous direction: system trust reaching a cloned repo.

    A shipped wizard runs unprompted. If it could pull in an op that arrived in
    someone's cloned project, "open a project" would be a code-execution
    primitive through one indirection.
    """
    seen: list = []
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq", "on_fail": "continue"},
        {"id": "after", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, shell=_shell(lambda _c: 0, seen=seen),
                               resolve_op=_ops(_op("jq"), trusted=False))

    assert result.exit_code is ExitCode.REFUSED
    assert "jq" in result.detail
    assert result.steps["jq"].exit_code is ExitCode.REFUSED
    # A refusal stops the run whatever `on_fail` says.
    assert "after" not in result.steps
    assert seen == []


@pytest.mark.asyncio
async def test_a_refusal_after_real_work_does_not_report_that_nothing_ran(tmp_path):
    """`ran=False` means SKIPPED to every reader — so a run that installed
    something before it hit an untrusted callee must not claim it."""
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
        {"id": "rg", "kind": "compute", "ref": "rg"},
    ]})
    # `have jq` fails until `install jq` has run, so the first step really works;
    # `rg` does not resolve as trusted, so the second step refuses.
    async def resolve(name: str):
        return Resolved(_op(name), name != "rg")

    installed: list[str] = []

    def code_for(command: str) -> int:
        if command == "install jq":
            installed.append(command)
            return 0
        return 0 if installed else 1

    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_op=resolve, shell=_shell(code_for))

    assert result.exit_code is ExitCode.REFUSED
    assert result.steps["jq"].ran is True, "the first step really installed something"
    assert result.ran is True, "the run did work before it was stopped"


@pytest.mark.asyncio
async def test_a_wizard_that_calls_itself_answers_instead_of_recursing(tmp_path):
    """A cycle is caught by NAME, and the answer names the loop.

    Unbounded nesting ends in a crash — the Activity tree's own depth cap raises
    before the stack gives out — and a crash is not an answer.
    """
    spec = WizardSpec.model_validate({"name": "loop", "steps": [
        {"id": "again", "kind": "wizard", "ref": "loop"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_wizard=_wizards({"loop": spec}))

    assert result.exit_code is ExitCode.NOT_YET
    assert "already running" in result.steps["again"].detail
    assert "loop -> loop" in result.steps["again"].detail


@pytest.mark.asyncio
async def test_a_chain_that_never_repeats_still_has_a_floor(tmp_path):
    """The other runaway: each wizard calls a DIFFERENT one, forever."""
    table = {
        name: WizardSpec.model_validate({"name": name, "steps": [
            {"id": "down", "kind": "wizard", "ref": nxt},
        ]})
        for name, nxt in (("w0", "w1"), ("w1", "w2"), ("w2", "w3"), ("w3", "w4"))
    }
    table["w4"] = WizardSpec.model_validate({"name": "w4", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(
        table["w0"], tmp_path=tmp_path,
        resolve_op=_ops(_op("jq")), resolve_wizard=_wizards(table),
    )

    assert result.exit_code is ExitCode.NOT_YET
    deepest = result.steps["down"].steps["down"].steps["down"]
    assert f"more than {MAX_WIZARD_DEPTH}" in deepest.detail


@pytest.mark.asyncio
async def test_a_declared_output_the_steps_do_not_satisfy_fails_the_wizard(tmp_path):
    """A wizard's `output` binds, exactly as an op's `output_spec_kind` does —
    otherwise a caller binds a value that does not hold and carries the breakage
    somewhere it cannot be explained."""
    spec = WizardSpec.model_validate({
        "name": "w",
        "output": {"port": "int"},
        "steps": [{"id": "jq", "kind": "compute", "ref": "jq", "bind": "jq"}],
    })
    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_op=_ops(_op("jq")))

    assert result.exit_code is ExitCode.NOT_YET
    assert "not the declared output" in result.detail
    assert result.steps["jq"].ok, "the step itself was fine; the wizard's promise was not"


@pytest.mark.asyncio
async def test_an_explicit_approval_does_reach_the_callees(tmp_path):
    """The safe direction, and the one that makes an approval mean anything.

    A person who approved THIS document approved what it says it calls — the
    refs are right there. Without this an approved wizard could not run its own
    ops, which is not a gate, it is a dead end.
    """
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, approved=True,
                               resolve_op=_ops(_op("jq"), trusted=False))
    assert result.ok


@pytest.mark.asyncio
async def test_a_bound_value_reaches_a_later_step_as_environment(tmp_path):
    """One namespace for every value.

    A step author should not have to know whether a value came from a human, a
    command or a model — so a bound return lands in scope and reaches a command
    the same way: as environment.
    """
    seen_env: dict = {}

    async def shell(command, **kw):
        seen_env.update(kw.get("extra_env") or {})
        return CliResult.of_process(command, 0)

    async def launch(*, workdir, **_kw):
        # The receipt IS how an agent returns a typed value.
        path = receipt_path(Path(workdir), "release")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"status": "done", "summary": "v9", "data": {VALUE_KEY: "v9"}}))
        return PromptResult.satisfied("The agent finished.", executor="agentic_process-proc-1")

    # An op with no completion check is a CALL: it always runs, and its answer
    # is its value — returned through the receipt the agent writes.
    producer = ComputeOpSpec.model_validate({
        "name": "release", "subkind": "agent", "output_spec_kind": "string",
        "exe_data": {"agent": "provisioner", "prompt": "which release"},
    })
    consumer = _op("use-it", completion_check={"commands": {"linux": "echo $FLOWPAD_WIZARD_INPUT_RELEASE"}})
    spec = WizardSpec.model_validate({"name": "chained", "steps": [
        {"id": "ask-agent", "kind": "compute", "ref": "release", "bind": "RELEASE"},
        {"id": "use-it", "kind": "compute", "ref": "use-it"},
    ]})

    result = await run_wizard(
        spec, trusted=True, platform="linux", workdir=Path(tmp_path),
        shell=shell, launch=launch,
        resolve_op=_ops(producer, consumer), activity_path=f"wz/bind-{tmp_path.name}",
    )

    assert result.ok, result.detail
    assert result.steps["ask-agent"].value == "v9"
    assert result.value == {"ask-agent": "v9"}
    assert seen_env.get("FLOWPAD_WIZARD_INPUT_RELEASE") == "v9"


@pytest.mark.asyncio
async def test_the_result_round_trips_through_its_dump(tmp_path):
    """`run.json` is the result's dump, so reading it back must give the SAME
    answers — each step as its own subclass, not a flattened base."""
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_op=_ops(_op("jq")))

    again = WizardResult.model_validate(json.loads(json.dumps(result.model_dump(mode="json"))))
    assert type(again) is WizardResult
    assert type(again.steps["jq"]) is CliResult
    assert again == result
