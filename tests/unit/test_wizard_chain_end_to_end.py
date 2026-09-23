"""The whole chain, in one process:

    trigger.json -> indexed row -> armed -> app.tab.ready -> fire -> wizard runs

Each link is separately covered elsewhere; this asserts they are actually joined.
It is the test that fails if the extractor stops flattening the document, if
arming stops happening for a trigger that arrives by INDEXING rather than by
seeding, or if the callback stops resolving the wizard from the action that
names it — three wiring bugs that every per-link test would still pass.

The wizard used is the REAL shipped one (`llm-setup`). Its shell is a double on
which every check holds — the "already provisioned" shape — so nothing is asked,
nothing runs, and the result does not depend on which of python, git, node and
npm this machine happens to have (a Mac without node is a normal developer
machine). What a check prints and how a missing tool is asked about is
`test_llm_setup_wizard.py`'s job.
"""

import asyncio

import pytest

from flow_sdk.builtin import tag_triggers
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.builtin.wizard import Wizard
from flow_sdk.config import system_projects_root
from flow_sdk.server.builtin_triggers import WIZARD_TRIGGER_UNAME_PREFIX
from flow_sdk.tags import emit_tag, target_of
from tests.fixtures.identity import index_path
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ASSETS = system_projects_root() / "flowpad_assistant" / "agentic-assets"
SHIPPED = ASSETS / "wizard" / "llm-setup"
#: The wizards its steps call, and the ops THOSE call. A step names one; the row
#: has to be indexed for the resolver to find it, exactly as it is on a real
#: machine.
SUB_WIZARDS = [ASSETS / "wizard" / name for name in ("llm-setup-python", "llm-setup-git", "llm-setup-node")]
OPS = [
    ASSETS / "compute_op" / name
    for name in (
        "python-on-path",
        "git-on-path",
        "node-on-path",
        "npm-on-path",
        "ask-install-python",
        "ask-install-git",
        "ask-install-node",
        "ask-install-npm",
    )
]
#: The shipped wizard's trigger, as a child asset — the standard shape.
SHIPPED_TRIGGER = SHIPPED / "agentic-assets" / "trigger" / "on-tab-ready"
UNAME = f"{WIZARD_TRIGGER_UNAME_PREFIX}llm_setup_0"


@pytest.fixture(autouse=True)
def _never_wait_for_a_person(monkeypatch):
    """On a machine missing one of the four tools the wizard would ask, and a
    test process has no tab. The runner then gives up after its presence grace;
    shrinking that grace keeps the run from sitting in it. It shortens a wait —
    the caps stay as they are."""
    from flow_sdk.core.compute_op import runner

    monkeypatch.setattr(runner, "PRESENCE_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(runner, "PRESENCE_POLL_SECONDS", 0.01)


async def _everything_is_installed(command: str, **_):
    """Every check passes, printing the empty confirm an ask op's check echoes."""
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult

    return CliResult.of_process(command, 0, "{}\n")


async def _index_trigger(wizard) -> Trigger:
    """Stand in for the indexer: document -> row -> armed.

    Goes through the REAL extractor and the REAL arming seam, so what is proved
    is the path a trigger actually takes off disk, not a hand-built row.
    """
    from flow_sdk.assets.types.trigger import read_trigger, row_fields
    from flow_sdk.builtin.trigger_arming import arm_trigger
    from flow_sdk.schema.data_spec.trigger_action import TriggerAction

    spec = read_trigger(SHIPPED_TRIGGER)
    assert spec is not None, f"the shipped trigger asset did not parse at {SHIPPED_TRIGGER}"
    record = await index_path("trigger", SHIPPED_TRIGGER, write=False)
    trigger = await Trigger.get_by_id(record.id)
    trigger.uname = UNAME
    trigger.parent_type_id = str(wizard.typeid)
    fields = row_fields(spec, parent_type_id=str(wizard.typeid))
    trigger.actions = [TriggerAction.model_validate(item) for item in fields.pop("actions", [])]
    for field, value in fields.items():
        setattr(trigger, field, value)
    await trigger.save()
    await arm_trigger(trigger)
    return trigger


_MAX_DRAIN_ROUNDS = 50


async def _settle():
    current = asyncio.current_task()
    for _ in range(_MAX_DRAIN_ROUNDS):
        pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)
    raise AssertionError("handlers never went quiet")


async def _cleanup(wizard):
    for row in await Trigger.get_all({}):
        if (getattr(row, "uname", "") or "").startswith(WIZARD_TRIGGER_UNAME_PREFIX):
            tag_triggers.unregister_tag_trigger(row.id)
            await row.delete()
    if wizard is not None:
        from flow_sdk.core.wizard.state import reset_run

        reset_run(str(wizard.id))
        await wizard.delete()


@async_context
async def test_a_ready_tab_runs_the_shipped_wizard_through_its_declared_trigger():
    # 1. INDEXED — stand in for the detached system-content walk, which is the
    #    only thing that discovers a wizard shipped inside the wheel.
    record = await index_path("wizard", SHIPPED, write=False)
    wizard = await Wizard.get_by_id(record.id)
    try:
        assert wizard.is_system(), "the shipped wizard must be trusted, or it will refuse to run"

        # 2. THE TRIGGER ASSET, indexed and armed — no derivation, no restart.
        trigger = await _index_trigger(wizard)
        assert trigger is not None, "the wizard's trigger asset produced no row"
        assert trigger.tag_pattern == "app.tab.ready"
        assert trigger.fire_once is False
        assert trigger.id in tag_triggers._subscriptions, (
            "the trigger exists but is not armed — the event would be lost, and "
            "nothing anywhere would say why the wizard never ran"
        )

        # 3. THE EVENT.
        emit_tag("app.tab.ready", target_of("compute_node", "n-1"), {"connection_id": "c-1"})
        await _settle()

        # 4. IT FIRED.
        fired = await Trigger.get_by_id(trigger.id)
        assert fired.counter == 1, "app.tab.ready did not reach the wizard's trigger"
        assert fired.last_run is not None

        # 5. AND IT IS NOT SPENT — a reload, a new window or a restart is another
        #    tab, and a tool removed since must be asked about again.
        emit_tag("app.tab.ready", target_of("compute_node", "n-1"), {"connection_id": "c-2"})
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 2

        # 6. AND IT DOES NOT LISTEN TO THE OLD TAG. `app.ready` fires before any
        #    tab exists, which is the whole reason this moved.
        emit_tag("app.ready", target_of("compute_node", "n-1"), {"version": "test"})
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 2
    finally:
        await _cleanup(wizard)


@async_context
async def test_the_run_reports_through_the_activity_tree():
    """The wizard's own progress, addressed in its entity subject_entity."""
    from flow_sdk.activity import Activity
    from flow_sdk.core.wizard import run_wizard

    record = await index_path("wizard", SHIPPED, write=False)
    wizard = await Wizard.get_by_id(record.id)
    try:
        spec = wizard.spec()
        assert spec is not None
        # A step names an op; only the entity layer knows what is indexed and
        # whether a callee is trusted here, so it supplies the resolvers.
        from flow_sdk.core.wizard.execute import _resolve_op, _resolve_wizard

        for folder in SUB_WIZARDS:
            await index_path("wizard", folder, write=False)
        for folder in OPS:
            await index_path("compute_op", folder, write=False)

        result = await run_wizard(
            spec,
            subject_entity=str(wizard.typeid),
            activity_path="wizard/chain-check",
            trusted=True,
            workdir=SHIPPED.parent,
            shell=_everything_is_installed,
            resolve_op=_resolve_op,
            resolve_wizard=_resolve_wizard,
        )
        assert list(result.steps) == ["python", "git", "node"]
        assert result.ok, f"the shipped wizard failed here: {result.detail}"
        assert not any(step.ran for step in result.steps.values()), (
            "every check holds on this shell, so nothing may run; got {[(k, v.exit_code, v.ran) for k, v in result.steps.items()]}"
        )
        root = Activity.get("wizard/chain-check", subject_entity=str(wizard.typeid)).spec()
        assert root.total == 3 and root.skipped == 3 and root.errors_count == 0
    finally:
        await _cleanup(wizard)


@async_context
async def test_an_unattended_run_leaves_a_durable_record():
    """A trigger-fired run must stamp `run_state`, exactly as the UI path does.

    An unattended run has no viewer. The activity tree is LIVE-ONLY — a finished
    root is dropped — so without this stamp the entire outcome of the machine's
    first-launch setup survives as one log line: the wizard then reports "has not
    run on this machine yet", which is false, and nothing says which step failed.
    """
    from flow_sdk.core.wizard.state import read_result, reset_run
    from flow_sdk.server.builtin_triggers import _run_wizard_trigger

    record = await index_path("wizard", SHIPPED, write=False)
    wizard = await Wizard.get_by_id(record.id)
    try:
        trigger = await _index_trigger(wizard)

        assert read_result(str(wizard.id)) is None, "precondition: no run yet"

        await _run_wizard_trigger(trigger, [])

        recorded = read_result(str(wizard.id))
        assert recorded is not None, (
            "the unattended run recorded nothing — `run_state` is what the viewer "
            "reads, and an empty one claims the wizard never ran"
        )
        assert recorded.steps, "a run with steps must record what each step answered"
    finally:
        reset_run(str(wizard.id))
        await _cleanup(wizard)
