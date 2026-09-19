"""``run_wizard`` — the call loop.

A step no longer runs anything itself: it CALLS a ComputeOp, another wizard, or
the person, and reads one `ReturnedValue` back. The ask/act/prove machine those
calls run through is pinned in `test_compute_op_runner.py`; what is pinned here
is what only a sequence owns — order, `on_fail`, parking and resume, argument
binding, and the trust that must NOT compose.

Every case drives the real runner with stub resolvers and stub I/O.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import json

from flow_sdk.core.compute.exec import ShellResult
from flow_sdk.core.compute.receipt import receipt_path
from flow_sdk.core.compute_op.runner import VALUE_KEY
from flow_sdk.core.compute.process_step import ProcessResult
from flow_sdk.core.wizard.runner import (
    AWAITING_INPUT,
    COMPLETED,
    FAILED,
    NOT_REACHED,
    PENDING,
    SATISFIED,
    Resolved,
    WizardNotApproved,
    run_wizard,
)
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)


def _op(name: str, **over) -> ComputeOpSpec:
    body = {"name": name, "completion_check": {"commands": {"linux": f"have {name}"}}}
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
        return ShellResult(returncode=code_for(command))
    return shell


def _launch(**_kw):
    async def launch(**kw):
        return ProcessResult("proc-1", True, "agent finished")
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

    assert result.status == COMPLETED
    assert [o.status for o in result.outcomes] == [SATISFIED]


@pytest.mark.asyncio
async def test_an_unknown_ref_fails_the_step_naming_it(tmp_path):
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "nope", "kind": "compute", "ref": "missing-op"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_op=_ops())

    assert result.status == FAILED
    assert "missing-op" in result.outcomes[0].message


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

    assert result.status == COMPLETED
    # SATISFIED, not COMPLETED: the inner wizard's only step was already
    # satisfied, so nothing ran and the calling step did no work either. The
    # direct-call case above pins the same answer for the same situation — a
    # callee being a wizard rather than an op must not change the verdict.
    assert [o.status for o in result.outcomes] == [SATISFIED]


@pytest.mark.asyncio
async def test_a_nested_wizard_that_actually_works_reports_completed(tmp_path):
    """The other half of the pair above: `satisfied` must mean "nothing ran",
    not "the callee was a wizard". Here the inner op's goal does not hold until
    its attempt runs, so the calling step reports real work."""
    inner = WizardSpec.model_validate({"name": "inner", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner"},
    ]})
    op = _op("jq", attempts=[{"kind": "command", "commands": {"linux": "install jq"}}])
    asked: list[str] = []

    def code_for(command: str) -> int:
        if command.startswith("have "):          # the completion check
            asked.append(command)
            return 1 if len(asked) == 1 else 0   # missing, then present
        return 0                                  # the install rung

    result = await _run_wizard(outer, tmp_path=tmp_path, shell=_shell(code_for),
                               resolve_op=_ops(op), resolve_wizard=_wizards({"inner": inner}))

    assert result.status == COMPLETED
    assert [o.status for o in result.outcomes] == [COMPLETED]


# ── on_fail: the sequence's policy, not the op's ─────────────────────────────

@pytest.mark.asyncio
async def test_abort_stops_the_run_and_later_steps_report_never_reached(tmp_path):
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "first", "kind": "compute", "ref": "broken", "on_fail": "abort"},
        {"id": "second", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(spec, tmp_path=tmp_path, shell=_shell(lambda _c: 1),
                        resolve_op=_ops(_op("broken", attempts=[]), _op("jq")))

    assert result.status == FAILED
    assert [o.status for o in result.outcomes] == [FAILED, NOT_REACHED]


@pytest.mark.asyncio
async def test_continue_lets_the_rest_of_the_run_proceed(tmp_path):
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "first", "kind": "compute", "ref": "broken", "on_fail": "continue"},
        {"id": "second", "kind": "compute", "ref": "jq"},
    ]})
    result = await _run_wizard(
        spec, tmp_path=tmp_path,
        shell=_shell(lambda c: 1 if "broken" in c else 0),
        resolve_op=_ops(_op("broken", attempts=[]), _op("jq")),
    )

    assert [o.status for o in result.outcomes] == [FAILED, SATISFIED]
    assert result.status == FAILED, "one step failing is still a failed run"


# ── asking, parking, resume ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_missing_value_parks_the_run_and_releases_the_caller(tmp_path):
    spec = WizardSpec.model_validate({
        "name": "w", "inputs": {"TOKEN": {"shape": "string", "label": "Token"}},
        "steps": [
            {"id": "ask", "kind": "ask", "ref": "TOKEN"},
            {"id": "jq", "kind": "compute", "ref": "jq"},
        ],
    })
    result = await _run_wizard(spec, tmp_path=tmp_path, resolve_op=_ops(_op("jq")))

    assert result.status == PENDING
    assert [o.status for o in result.outcomes] == [AWAITING_INPUT, NOT_REACHED]
    assert [a.name for a in result.awaiting] == ["TOKEN"]
    assert result.awaiting[0].label == "Token", "the form needs a label to draw"


@pytest.mark.asyncio
async def test_a_value_already_in_scope_asks_nobody(tmp_path):
    spec = WizardSpec.model_validate({
        "name": "w", "inputs": {"TOKEN": {}},
        "steps": [{"id": "ask", "kind": "ask", "ref": "TOKEN"}],
    })
    result = await _run_wizard(spec, tmp_path=tmp_path, inputs={"TOKEN": "abc"})

    # The unification: an ask is a goal whose check is "do I have this already?"
    assert result.status == COMPLETED
    assert result.outcomes[0].status == SATISFIED


@pytest.mark.asyncio
async def test_an_optional_value_skips_rather_than_parking(tmp_path):
    spec = WizardSpec.model_validate({
        "name": "w", "inputs": {"NOTE": {"optional": True}},
        "steps": [{"id": "ask", "kind": "ask", "ref": "NOTE"}],
    })
    result = await _run_wizard(spec, tmp_path=tmp_path)

    assert result.status == COMPLETED and result.outcomes[0].skipped


@pytest.mark.asyncio
async def test_a_nested_wizards_question_becomes_the_outer_runs_question(tmp_path):
    """The person answers once, at the top — not once per level of nesting."""
    inner = WizardSpec.model_validate({
        "name": "inner", "inputs": {"TOKEN": {"label": "Token"}},
        "steps": [{"id": "ask", "kind": "ask", "ref": "TOKEN"}],
    })
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner"},
    ]})
    result = await _run_wizard(outer, tmp_path=tmp_path, resolve_wizard=_wizards({"inner": inner}))

    assert result.status == PENDING
    assert [a.name for a in result.awaiting] == ["TOKEN"]


# ── arguments ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_args_bind_a_value_in_scope_to_the_callees_parameter(tmp_path):
    inner = WizardSpec.model_validate({
        "name": "inner", "inputs": {"API_KEY": {}},
        "steps": [{"id": "ask", "kind": "ask", "ref": "API_KEY"}],
    })
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner", "args": {"API_KEY": "WAHA_KEY"}},
    ]})
    result = await _run_wizard(outer, tmp_path=tmp_path, inputs={"WAHA_KEY": "s3cret"},
                        resolve_wizard=_wizards({"inner": inner}))

    # Supplied by the caller, so the inner wizard never asks.
    assert result.status == COMPLETED


@pytest.mark.asyncio
async def test_an_arg_that_names_nothing_in_scope_is_a_literal(tmp_path):
    inner = WizardSpec.model_validate({
        "name": "inner", "inputs": {"PORT": {}},
        "steps": [{"id": "ask", "kind": "ask", "ref": "PORT"}],
    })
    outer = WizardSpec.model_validate({"name": "outer", "steps": [
        {"id": "sub", "kind": "wizard", "ref": "inner", "args": {"PORT": "3010"}},
    ]})
    result = await _run_wizard(outer, tmp_path=tmp_path, resolve_wizard=_wizards({"inner": inner}))

    assert result.status == COMPLETED


@pytest.mark.asyncio
async def test_a_value_reaches_a_command_as_env_and_is_never_inlined(tmp_path):
    """The injection guard, kept exactly as strict as it was before the refactor.

    Interpolating a value into a command string would make an answer of
    `; rm -rf /` executable, straight through the trust gate that decides
    whether this may run shell at all.
    """
    seen: list[tuple[str, dict]] = []
    spec = WizardSpec.model_validate({
        "name": "w", "inputs": {"REPO_URL": {}},
        "steps": [{"id": "clone", "kind": "compute", "ref": "clone"}],
    })
    op = _op("clone", completion_check={"commands": {"linux": "test -d repo"}},
             attempts=[{"kind": "command", "commands": {"linux": 'git clone "$FLOWPAD_WIZARD_INPUT_REPO_URL"'}}])
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
    with pytest.raises(WizardNotApproved):
        await run_wizard(spec, trusted=False, platform="linux", workdir=Path(tmp_path),
                         shell=_shell(lambda _c: 0, seen=seen), resolve_op=_ops(_op("jq")))
    assert seen == [], "the gate refuses before any command, not after"


@pytest.mark.asyncio
async def test_being_shipped_does_not_lend_approval_to_a_callee(tmp_path):
    """The dangerous direction: system trust reaching a cloned repo.

    A shipped wizard runs unprompted. If it could pull in an op that arrived in
    someone's cloned project, "open a project" would be a code-execution
    primitive through one indirection.
    """
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        {"id": "jq", "kind": "compute", "ref": "jq"},
    ]})
    with pytest.raises(WizardNotApproved, match="jq"):
        await _run_wizard(spec, tmp_path=tmp_path, resolve_op=_ops(_op("jq"), trusted=False))


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
    assert result.status == COMPLETED


@pytest.mark.asyncio
async def test_a_bound_value_reaches_a_later_step_as_environment(tmp_path):
    """One namespace with the answers a person gave.

    A step author should not have to know whether a value came from a human, a
    command or a model — so a bound return lands in scope exactly where an
    answer would, and reaches a command the same way: as environment.
    """
    seen_env: dict = {}

    async def shell(command, **kw):
        seen_env.update(kw.get("extra_env") or {})
        return ShellResult(returncode=0)

    async def launch(*, workdir, **_kw):
        # The receipt IS how an agent returns a typed value.
        path = receipt_path(Path(workdir), "release")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"status": "done", "summary": "v9", "data": {VALUE_KEY: "v9"}}))
        return ProcessResult("proc-1", True, "v9")

    # An op with no completion check is a CALL: it always runs, and its answer
    # is its value — returned through the receipt the agent writes.
    producer = ComputeOpSpec.model_validate({
        "name": "release", "output": "string",
        "attempts": [{"kind": "agent", "agent": "provisioner", "prompt": "which release"}],
    })
    consumer = ComputeOpSpec.model_validate({
        "name": "use-it",
        "completion_check": {"commands": {"linux": "echo $FLOWPAD_WIZARD_INPUT_RELEASE"}},
    })
    spec = WizardSpec.model_validate({"name": "chained", "steps": [
        {"id": "ask-agent", "kind": "compute", "ref": "release", "bind": "RELEASE"},
        {"id": "use-it", "kind": "compute", "ref": "use-it"},
    ]})

    result = await run_wizard(
        spec, trusted=True, platform="linux", workdir=Path(tmp_path),
        shell=shell, launch=launch,
        resolve_op=_ops(producer, consumer), activity_path=f"wz/bind-{tmp_path.name}",
    )

    assert result.status == COMPLETED, result.message
    assert seen_env.get("FLOWPAD_WIZARD_INPUT_RELEASE") == "v9"
