"""The whole chain, in one process:

    indexed wizard -> derived trigger -> armed -> app.ready -> fire -> wizard runs

Each link is separately covered elsewhere; this asserts they are actually joined.
It is the test that fails if `_register_post_save` stops arming TAG triggers, if
the reconcile stops deriving them, or if the callback stops resolving the wizard
from `trigger.path` — three wiring bugs that every per-link test would still pass.

The wizard used is the REAL shipped one, and its steps run for real. On a
developer machine python3 and git are already present, so both preconditions
report `satisfied` and no installer is spawned — which is exactly the shape the
"already provisioned" half of the container proof takes.
"""
import asyncio

import pytest

from flow_sdk.builtin import tag_triggers
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.builtin.wizard import Wizard
from flow_sdk.config import system_projects_root
from flow_sdk.server.builtin_triggers import (
    WIZARD_TRIGGER_UNAME_PREFIX,
    reconcile_wizard_triggers,
)
from flow_sdk.tags import emit_tag, target_of
from tests.conftest import async_context

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SHIPPED = (
    system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "dev-toolchain"
)
UNAME = f"{WIZARD_TRIGGER_UNAME_PREFIX}dev_toolchain_0"
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
        await wizard.delete()


@async_context
async def test_app_ready_runs_the_shipped_wizard_through_its_declared_trigger():
    # 1. INDEXED — stand in for the detached system-content walk, which is the
    #    only thing that discovers a wizard shipped inside the wheel.
    wizard = Wizard(name="dev-toolchain", asset_ref=str(SHIPPED))
    await wizard.save()
    try:
        assert wizard.is_system(), "the shipped wizard must be trusted, or it will refuse to run"

        # 2. TRIGGER DERIVED + ARMED from what the document declares.
        await reconcile_wizard_triggers()
        trigger = await Trigger.get_by_uname(UNAME)
        assert trigger is not None, "the wizard's declared trigger was not created"
        assert trigger.tag_pattern == "app.ready"
        assert trigger.fire_once is True
        assert trigger.id in tag_triggers._subscriptions, (
            "the trigger exists but is not armed — the event would be lost, and "
            "nothing anywhere would say why the wizard never ran"
        )

        # 3. THE EVENT.
        emit_tag("app.ready", target_of("compute_node", "n-1"), {"version": "test"})
        await _settle()

        # 4. IT FIRED.
        fired = await Trigger.get_by_id(trigger.id)
        assert fired.counter == 1, "app.ready did not reach the wizard's trigger"
        assert fired.last_run is not None

        # 5. AND IT IS SPENT — a second boot must not re-run it.
        emit_tag("app.ready", target_of("compute_node", "n-1"), {"version": "test"})
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1
    finally:
        await _cleanup(wizard)


@async_context
async def test_the_run_reports_through_the_activity_tree():
    """The wizard's own progress, addressed in its entity subject_entity."""
    from flow_sdk.activity import Activity
    from flow_sdk.core.wizard import run_wizard

    wizard = Wizard(name="dev-toolchain", asset_ref=str(SHIPPED))
    await wizard.save()
    try:
        spec = wizard.spec()
        assert spec is not None
        result = await run_wizard(
            spec, subject_entity=str(wizard.typeid), activity_path="wizard/chain-check",
            trusted=True, workdir=SHIPPED.parent,
        )
        assert [o.step_id for o in result.outcomes] == ["python3", "git"]
        # This machine is a developer machine, so both are already there.
        assert result.ok, f"the shipped wizard failed here: {result.message}"
        assert all(o.skipped for o in result.outcomes), (
            "python3 and git are present on this machine, so both steps must "
            f"report satisfied; got {[(o.step_id, o.status) for o in result.outcomes]}"
        )
        root = Activity.get("wizard/chain-check", subject_entity=str(wizard.typeid)).spec()
        assert root.total == 2 and root.skipped == 2 and root.errors_count == 0
    finally:
        await _cleanup(wizard)


@async_context
async def test_an_unattended_run_leaves_a_durable_record():
    """A trigger-fired run must stamp `run_state`, exactly as the UI path does.

    An unattended run has no viewer. The activity tree is LIVE-ONLY — a finished
    root is dropped — so without this stamp the entire outcome of the machine's
    first-launch setup survives as one log line: the wizard then reports "has not
    run on this machine yet", which is false, and nothing says which step failed.
    Worse for a parked run: its trigger is `fire_once` and will never fire again,
    so `set-input` is the only way back and it reads `awaiting` from this file.
    """
    from flow_sdk.core.wizard.state import read_state, reset_run
    from flow_sdk.server.builtin_triggers import _run_wizard_trigger

    wizard = Wizard(name="dev-toolchain", asset_ref=str(SHIPPED))
    await wizard.save()
    try:
        await reconcile_wizard_triggers()
        trigger = await Trigger.get_by_uname(UNAME)
        assert trigger is not None

        assert read_state(str(wizard.id)).get("status", "") == "", "precondition: no run yet"

        await _run_wizard_trigger(trigger, [])

        state = read_state(str(wizard.id))
        assert state.get("status"), (
            "the unattended run recorded nothing — `run_state` is what the viewer "
            "reads, and an empty one claims the wizard never ran"
        )
        assert state.get("outcomes"), "a run with steps must record what each step did"
    finally:
        reset_run(str(wizard.id))
        await _cleanup(wizard)
