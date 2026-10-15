"""A wizard asks for everything ONCE, before it runs — and what follows a "no".

Three things only a sequence can own, pinned here on the real runner with stub resolvers and I/O:

* the plan — every question whose goal does not hold yet, read off the wizard before any step;
* the run — one list question, each ask step then taking its answer from it instead of asking;
* the ending — a declined ``required`` question is an error, an optional one is an answer, and an
  error calls the wizard's ``exit_error`` op.
"""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.core.compute_op import ask
from flow_sdk.core.wizard.plan import plan_wizard
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode
from flow_sdk.schema.data_spec.wizard_spec import EXIT_ERROR_STEP, WizardSpec

pytestmark = pytest.mark.timeout(5)


@pytest.fixture(autouse=True)
def _asked_here(monkeypatch):
    """This process is where answers arrive, and a test is the person."""
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    ask._PENDING.clear()
    with ask.answered_here(present=True):
        yield
    ask._PENDING.clear()


def _install(name: str) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate({
        "name": f"{name}-on-path",
        "subkind": "cli",
        "exe_data": {"commands": {"linux": f"install {name}"}},
        "completion_check": {"commands": {"linux": f"have {name}"}},
    })


def _confirm(name: str, **exe) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate({
        "name": f"ask-install-{name}",
        "subkind": "ask",
        "exe_data": {"prompt": f"Install {name}?", "detail": f"{name} is missing.", **exe},
        "completion_check": {"commands": {"linux": f"have {name}"}},
        "output_spec_kind": "confirm",
    })


def _value(name: str, **exe) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate({
        "name": f"ask-{name}",
        "subkind": "ask",
        "exe_data": {"prompt": f"Your {name}", **exe},
        "output_spec_kind": "string",
    })


def _tool(name: str, **ask_step) -> WizardSpec:
    """The shipped shape: ask, then install — one wizard per tool."""
    return WizardSpec.model_validate({
        "name": f"setup-{name}",
        "steps": [
            {"id": "ask", "ref": f"ask-install-{name}", **ask_step},
            {"id": "install", "ref": f"{name}-on-path"},
        ],
    })


class _Box:
    """A machine: which tools it has, what was run on it, and every resolver a run needs."""

    def __init__(self, *, have=(), wizards=(), ops=()):
        self.have = set(have)
        self.ran: list[str] = []
        self.wizards = {w.name: w for w in wizards}
        self.ops = {o.name: o for o in ops}

    async def shell(self, command, **_kw):
        self.ran.append(command)
        verb, _, name = command.partition(" ")
        if verb == "install":
            self.have.add(name)
            return CliResult.of_process(command, 0)
        if verb == "have":
            return CliResult.of_process(command, 0 if name in self.have else 1)
        return CliResult.of_process(command, 0)

    async def resolve_op(self, name):
        return Resolved(self.ops[name], True) if name in self.ops else None

    async def resolve_wizard(self, name):
        return Resolved(self.wizards[name], True) if name in self.wizards else None

    def seams(self, tmp_path):
        return {"workdir": tmp_path, "platform": "linux", "shell": self.shell,
                "resolve_op": self.resolve_op, "resolve_wizard": self.resolve_wizard}

    def installed(self) -> list[str]:
        return [command for command in self.ran if command.startswith("install ")]


def _two_tools(**node_ask) -> tuple[WizardSpec, _Box]:
    top = WizardSpec.model_validate({
        "name": "setup",
        "label": "Finish setting up",
        "steps": [
            {"id": "git", "kind": "wizard", "ref": "setup-git", "on_fail": "continue"},
            {"id": "node", "kind": "wizard", "ref": "setup-node", "on_fail": "continue"},
        ],
    })
    box = _Box(
        wizards=[_tool("git"), _tool("node", **node_ask)],
        ops=[_confirm("git"), _install("git"), _confirm("node"), _install("node")],
    )
    return top, box


async def _person(answer_with, asked: list[dict]) -> None:
    """Answer every question as it opens with ``answer_with(payload)`` (``None`` cancels), noting
    each question's payload in *asked*, in the order they were asked."""
    while True:
        for question in ask.open_questions():
            asked.append(question.to_payload())
            said = answer_with(asked[-1])
            ask.cancel(question.id) if said is None else ask.answer(question.id, said)
        await asyncio.sleep(0.005)


async def _run(spec, box, tmp_path, answer_with, **kw):
    asked: list[dict] = []
    person = asyncio.create_task(_person(answer_with, asked))
    try:
        result = await run_wizard(spec, trusted=True, activity_path=f"wizard/{tmp_path.name}", **box.seams(tmp_path), **kw)
    finally:
        person.cancel()
    try:
        await person
    except asyncio.CancelledError:
        pass
    return result, asked


def _approve_all(payload: dict) -> dict:
    return {item["path"]: {} for item in payload["items"]}


# ── the plan ──────────────────────────────────────────────────────────────────


async def test_the_plan_lists_every_question_whose_goal_does_not_hold(tmp_path):
    top, box = _two_tools()
    plan = await plan_wizard(top, inputs={}, **box.seams(tmp_path))
    assert [need.path for need in plan.needs] == ["git/ask", "node/ask"]
    first = plan.needs[0]
    assert (first.prompt, first.detail, first.kind, first.is_approval, first.required) == (
        "Install git?", "git is missing.", "confirm", True, True)
    assert box.installed() == [], "a plan is a look, not a run"
    assert ask.open_questions() == []


async def test_a_goal_that_already_holds_is_not_asked_about(tmp_path):
    top, box = _two_tools()
    box.have.add("git")
    plan = await plan_wizard(top, inputs={}, **box.seams(tmp_path))
    assert [need.path for need in plan.needs] == ["node/ask"]


async def test_questions_that_belong_to_their_moment_stay_where_they_are(tmp_path):
    """A gate, a question showing a value an earlier step produces, and a typed answer nobody keeps."""
    wizard = WizardSpec.model_validate({
        "name": "connect",
        "steps": [
            {"id": "link", "ref": "make-link-on-path", "bind": "connect"},
            {"id": "gate", "ref": "ask-install-gate"},
            {"id": "shown", "ref": "ask-install-shown"},
            {"id": "say-hi", "ref": "ask-hi"},
            {"id": "token", "ref": "ask-token", "bind": "token"},
        ],
    })
    box = _Box(ops=[
        _install("make-link"),
        _confirm("gate", recheck=True),
        _confirm("shown", detail="Open {{connect.link}}"),
        _value("hi"),
        _value("token", secret=True),
    ])
    plan = await plan_wizard(wizard, inputs={}, **box.seams(tmp_path))
    assert [(need.path, need.secret) for need in plan.needs] == [("token", True)]


# ── the run ───────────────────────────────────────────────────────────────────


async def test_everything_is_asked_once_and_then_the_run_asks_nothing(tmp_path):
    top, box = _two_tools()
    result, asked = await _run(top, box, tmp_path, _approve_all)
    assert result.ok, result.detail
    assert len(asked) == 1, "one question for the whole run"
    assert [item["path"] for item in asked[0]["items"]] == ["git/ask", "node/ask"]
    assert box.installed() == ["install git", "install node"]
    first_install = box.ran.index("install git")
    assert all(not command.startswith("install") for command in box.ran[:first_install])


async def test_nothing_to_ask_raises_nothing(tmp_path):
    top, box = _two_tools()
    box.have.update({"git", "node"})
    result, asked = await _run(top, box, tmp_path, _approve_all)
    assert result.ok and asked == [] and box.installed() == []


async def test_an_unticked_required_item_is_the_decline_it_always_was(tmp_path):
    top, box = _two_tools()
    result, _ = await _run(top, box, tmp_path, lambda payload: {"git/ask": {}})
    assert not result.ok
    assert box.installed() == ["install git"], "declining node installs no node"
    assert result.steps["node"].steps["ask"].cancelled
    assert "install" not in result.steps["node"].steps


async def test_cancelling_the_list_declines_all_of_it(tmp_path):
    top, box = _two_tools()
    result, asked = await _run(top, box, tmp_path, lambda payload: None)
    assert not result.ok and box.installed() == []
    assert len(asked) == 1, "a declined item is not asked a second time in place"


async def test_an_optional_item_declined_is_an_answer_not_an_error(tmp_path):
    top, box = _two_tools(required=False)
    plan = await plan_wizard(top, inputs={}, **box.seams(tmp_path))
    assert [need.required for need in plan.needs] == [True, False]
    result, _ = await _run(top, box, tmp_path, lambda payload: {"git/ask": {}})
    assert result.ok, result.detail
    assert box.installed() == ["install git"]
    assert result.steps["node"].stopped_at == "ask"


async def test_a_typed_value_given_up_front_reaches_the_steps_after_it(tmp_path):
    wizard = WizardSpec.model_validate({
        "name": "keys",
        "steps": [
            {"id": "token", "ref": "ask-token", "bind": "token"},
            {"id": "use", "ref": "use-token"},
        ],
    })
    seen: dict = {}

    class Box(_Box):
        async def shell(self, command, **kw):
            seen.update(kw.get("extra_env") or {})
            return await super().shell(command, **kw)

    use = ComputeOpSpec.model_validate({"name": "use-token", "subkind": "cli", "exe_data": {"commands": {"linux": "use"}}})
    box = Box(ops=[_value("token"), use])
    result, asked = await _run(wizard, box, tmp_path, lambda payload: {"token": "s3cret"})
    assert result.ok, result.detail
    assert len(asked) == 1
    assert seen.get("FLOWPAD_WIZARD_INPUT_TOKEN") == "s3cret"


async def test_a_question_left_in_place_is_still_asked_in_place(tmp_path):
    wizard = WizardSpec.model_validate({
        "name": "mixed",
        "steps": [{"id": "git", "ref": "ask-install-git"}, {"id": "hi", "ref": "ask-hi"}],
    })
    box = _Box(ops=[_confirm("git"), _value("hi")])
    result, asked = await _run(
        wizard, box, tmp_path, lambda payload: _approve_all(payload) if payload["items"] else "ok")
    assert result.ok, result.detail
    assert [bool(payload["items"]) for payload in asked] == [True, False]


async def test_a_check_only_run_asks_nothing(tmp_path):
    top, box = _two_tools()
    result, asked = await _run(top, box, tmp_path, _approve_all, check_only=True)
    assert not result.ok and asked == [] and box.installed() == []


# ── exit_error ────────────────────────────────────────────────────────────────


def _with_exit(top: WizardSpec, box: _Box) -> WizardSpec:
    box.ops["tell"] = ComputeOpSpec.model_validate(
        {"name": "tell", "subkind": "cli", "exe_data": {"commands": {"linux": "tell"}}})
    return top.model_copy(update={"exit_error": "tell"})


async def test_exit_error_runs_when_a_required_item_was_not_approved(tmp_path):
    top, box = _two_tools()
    top = _with_exit(top, box)
    result, _ = await _run(top, box, tmp_path, lambda payload: {"git/ask": {}})
    assert not result.ok, "the op reports the error; it does not repair the verdict"
    assert box.ran[-1] == "tell"
    assert result.steps[EXIT_ERROR_STEP].ok


async def test_exit_error_is_told_what_went_wrong(tmp_path):
    seen: dict = {}

    class Box(_Box):
        async def shell(self, command, **kw):
            if command == "tell":
                seen.update(kw.get("extra_env") or {})
            if command == "install git":
                self.ran.append(command)
                return CliResult.of_process(command, 1)
            return await super().shell(command, **kw)

    wizard = WizardSpec.model_validate({"name": "one", "steps": [{"id": "git", "ref": "git-on-path"}]})
    box = Box(ops=[_install("git")])
    wizard = _with_exit(wizard, box)
    result, _ = await _run(wizard, box, tmp_path, _approve_all)
    assert result.exit_code is ExitCode.NOT_YET
    assert seen.get("FLOWPAD_WIZARD_INPUT_ERROR_STEP") == "git"
    assert seen.get("FLOWPAD_WIZARD_INPUT_ERROR_DETAIL")


async def test_exit_error_stays_out_of_a_run_that_passed_or_only_checked(tmp_path):
    top, box = _two_tools()
    top = _with_exit(top, box)
    result, _ = await _run(top, box, tmp_path, _approve_all)
    assert result.ok and "tell" not in box.ran and EXIT_ERROR_STEP not in result.steps
    top, box = _two_tools()
    top = _with_exit(top, box)
    result, _ = await _run(top, box, tmp_path, _approve_all, check_only=True)
    assert not result.ok and "tell" not in box.ran


def test_no_step_may_take_the_exit_error_id():
    with pytest.raises(ValueError, match="exit_error"):
        WizardSpec.model_validate({"name": "w", "steps": [{"id": "exit_error", "ref": "x"}]})


# ── answering the list ────────────────────────────────────────────────────────


def test_a_list_answer_is_held_item_by_item():
    from flow_sdk.core.compute.declared_value import DeclaredShapeError
    from flow_sdk.schema.data_spec.compute_op_spec import AskItemSpec

    items = [AskItemSpec(path="git/ask", prompt="Install Git?", kind="confirm"),
             AskItemSpec(path="port", prompt="Port", kind="int")]
    held = ask.held_items(items, {"git/ask": {}, "port": 8080})
    assert set(held) == {"git/ask", "port"} and held["port"] == 8080
    assert ask.held_items(items, {}) == {}, "an item left out is declined, which is an answer"
    with pytest.raises(DeclaredShapeError, match="Port"):
        ask.held_items(items, {"port": "eighty"})
    with pytest.raises(DeclaredShapeError, match="not one of the questions"):
        ask.held_items(items, {"nope": 1})
    with pytest.raises(DeclaredShapeError):
        ask.held_items(items, "yes")


async def test_yes_on_a_terminal_approves_the_confirms_of_a_list(tmp_path):
    """`flow wizard run --yes`: the confirms are approved, a value still needs a person."""
    from flow_sdk.core.wizard import local_run

    wizard = WizardSpec.model_validate({
        "name": "mixed",
        "steps": [{"id": "git", "ref": "ask-install-git"}, {"id": "token", "ref": "ask-token", "bind": "token"}],
    })
    box = _Box(ops=[_confirm("git"), _value("token")])
    said: list[str] = []
    result = await local_run._answered(
        run_wizard(wizard, trusted=True, activity_path=f"wizard/{tmp_path.name}", **box.seams(tmp_path)),
        yes=True, say=said.append,
    )
    assert result.steps["git"].ok
    assert result.steps["token"].cancelled
    assert len(said) == 2, "one line per item of the one list"


@pytest.mark.parametrize('shape', ['confirm', 'string'])
async def test_new_output_shape_keeps_early_ask_kind_and_approval(tmp_path, shape):
    plans = []
    for spelling in ('output', 'output_spec_kind'):
        op = ComputeOpSpec(name='ask-new-shape', subkind='ask', exe_data={'prompt': 'Give input'}, **{spelling: shape})
        wizard = WizardSpec(name='new-shape', output_from='ask', steps=[{'id': 'ask', 'ref': op.name}])
        box = _Box(ops=[op])
        plans.append(await plan_wizard(wizard, **box.seams(tmp_path)))
    assert plans[0].needs == plans[1].needs
    assert len(plans[0].needs) == 1
    assert plans[0].needs[0].kind == shape
    assert plans[0].needs[0].is_approval is (shape == 'confirm')


@pytest.mark.parametrize('shape', [['int'], {'number': 'int'}])
async def test_inline_ask_shapes_stay_in_place(tmp_path, shape):
    op = ComputeOpSpec(name='ask-record', subkind='ask', exe_data={'prompt': 'Give values'}, output=shape)
    wizard = WizardSpec(name='record-shape', output_from='ask', steps=[{'id': 'ask', 'ref': op.name}])
    assert not (await plan_wizard(wizard, **_Box(ops=[op]).seams(tmp_path))).needs
