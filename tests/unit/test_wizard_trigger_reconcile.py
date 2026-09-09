"""Wizard-declared triggers: derivation, arming, and the orphan prune.

Two things here are guarding real footguns.

``_register_post_save`` handled SCHEDULE and FSOP but not TAG. Wizard triggers
are seeded AFTER the TAG boot sweep has run (the system-content index that
discovers them is detached), so without the TAG branch the trigger sits unarmed
until the next restart — and because the bus has no durability, the event it was
waiting for is simply gone, with nothing anywhere saying why the wizard did not
run.

The orphan prune is the first of its kind in this tree: nothing else deletes a
derived entity when its asset stops declaring it. The ``wizard_`` uname prefix
is what makes it safe, so the test that a user's own trigger survives is the
important one.
"""
import json

import pytest

from flow_sdk.builtin import tag_triggers
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.builtin.wizard import Wizard
from flow_sdk.server.builtin_triggers import (
    WIZARD_TRIGGER_UNAME_PREFIX,
    _run_wizard_trigger,
    _upsert_one,
    reconcile_wizard_triggers,
    wizard_trigger_specs,
)
from tests.conftest import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

DOC = {
    "name": "Developer toolchain",
    "triggers": [{"on": "app.ready", "fire_once": True}],
    "steps": [{"id": "python3", "precondition": {"commands": {"linux": "have python3"}},
               "process": {"prompt": "install python"}}],
}


def _wizard_folder(tmp_path, doc=None, name="dev-toolchain"):
    root = tmp_path / "agentic-assets" / "wizard" / name
    root.mkdir(parents=True, exist_ok=True)
    (root / "wizard.json").write_text(json.dumps(doc or DOC), encoding="utf-8")
    return root


async def _save_wizard(tmp_path, doc=None, name="dev-toolchain") -> Wizard:
    root = _wizard_folder(tmp_path, doc, name)
    wizard = Wizard(name=name, asset_ref=str(root))
    await wizard.save()
    return wizard


async def _cleanup(*wizards):
    for wizard in wizards:
        await wizard.delete()
    for row in await Trigger.get_all({}):
        if (getattr(row, "uname", "") or "").startswith(WIZARD_TRIGGER_UNAME_PREFIX):
            tag_triggers.unregister_tag_trigger(row.id)
            await row.delete()


# ── the arming fix ───────────────────────────────────────────────────────────

@async_context
async def test_a_tag_trigger_seeded_by_upsert_is_armed_immediately(tmp_path):
    """The boot sweep already ran by the time a wizard trigger is seeded."""
    uname = f"{WIZARD_TRIGGER_UNAME_PREFIX}armtest_0"
    await _upsert_one(dict(
        uname=uname, name="arm test", trigger_type=TriggerType.TAG,
        tag_pattern="wzarm.ready",
        actions=[TriggerAction(action_type=ActionType.CALLBACK,
                               callback_name="builtin_run_wizard")],
    ))
    try:
        row = await Trigger.get_by_uname(uname)
        assert row is not None
        assert row.id in tag_triggers._subscriptions, (
            "a TAG trigger seeded after the boot sweep must be armed by "
            "_register_post_save, or it waits for the next restart"
        )
    finally:
        row = await Trigger.get_by_uname(uname)
        if row:
            tag_triggers.unregister_tag_trigger(row.id)
            await row.delete()


# ── derivation ───────────────────────────────────────────────────────────────

@async_context
async def test_a_declared_trigger_becomes_a_spec(tmp_path):
    wizard = await _save_wizard(tmp_path)
    try:
        specs = [s for s in await wizard_trigger_specs() if s["path"] == wizard.asset_ref]
        assert len(specs) == 1
        spec = specs[0]
        assert spec["uname"] == f"{WIZARD_TRIGGER_UNAME_PREFIX}dev_toolchain_0"
        assert spec["trigger_type"] == TriggerType.TAG
        assert spec["tag_pattern"] == "app.ready"
        assert spec["fire_once"] is True
        assert spec["path"] == wizard.asset_ref, "the callback finds the wizard by path"
        assert spec["actions"][0].callback_name == "builtin_run_wizard"
    finally:
        await _cleanup(wizard)


@async_context
async def test_a_disabled_wizard_declares_nothing(tmp_path):
    doc = {**DOC, "enabled": False}
    wizard = await _save_wizard(tmp_path, doc, name="off")
    try:
        assert [s for s in await wizard_trigger_specs() if s["path"] == wizard.asset_ref] == []
    finally:
        await _cleanup(wizard)


@async_context
async def test_a_malformed_pattern_is_dropped_not_raised(tmp_path):
    """A wizard may have come from a repo someone cloned; one bad document must
    not stop the others from arming."""
    doc = {**DOC, "triggers": [{"on": "*"}, {"on": "app.ready"}]}
    wizard = await _save_wizard(tmp_path, doc, name="badpattern")
    try:
        specs = [s for s in await wizard_trigger_specs() if s["path"] == wizard.asset_ref]
        assert [s["tag_pattern"] for s in specs] == ["app.ready"]
    finally:
        await _cleanup(wizard)


# ── reconcile + prune ────────────────────────────────────────────────────────

@async_context
async def test_reconcile_creates_the_row_and_arms_it(tmp_path):
    wizard = await _save_wizard(tmp_path)
    try:
        await reconcile_wizard_triggers()
        row = await Trigger.get_by_uname(f"{WIZARD_TRIGGER_UNAME_PREFIX}dev_toolchain_0")
        assert row is not None and row.fire_once is True
        assert row.id in tag_triggers._subscriptions
    finally:
        await _cleanup(wizard)


@async_context
async def test_reconcile_preserves_a_spent_counter(tmp_path):
    """Clobbering the counter of a fire-once trigger would re-arm it and re-run
    the wizard on the next boot — the exact failure fire_once exists to stop."""
    wizard = await _save_wizard(tmp_path)
    try:
        await reconcile_wizard_triggers()
        uname = f"{WIZARD_TRIGGER_UNAME_PREFIX}dev_toolchain_0"
        row = await Trigger.get_by_uname(uname)
        row.counter = 1
        await row.update()

        await reconcile_wizard_triggers()
        assert (await Trigger.get_by_uname(uname)).counter == 1
    finally:
        await _cleanup(wizard)


@async_context
async def test_reconcile_prunes_a_trigger_whose_wizard_is_gone(tmp_path):
    wizard = await _save_wizard(tmp_path)
    await reconcile_wizard_triggers()
    uname = f"{WIZARD_TRIGGER_UNAME_PREFIX}dev_toolchain_0"
    assert await Trigger.get_by_uname(uname) is not None

    await wizard.delete()
    await reconcile_wizard_triggers()
    assert await Trigger.get_by_uname(uname) is None, "an orphaned wizard trigger must go"


@async_context
async def test_the_prune_spares_a_user_authored_trigger(tmp_path):
    """The prefix is the entire safety argument — unames are minted from the
    asset slug, so a user's trigger can never land in our namespace."""
    mine = Trigger(name="my own rule", trigger_type=TriggerType.TAG,
                   tag_pattern="entity.created", subject_entity="system")
    await mine.save()
    try:
        await reconcile_wizard_triggers()
        assert await Trigger.get_by_id(mine.id) is not None
    finally:
        await mine.delete()


# ── where an unattended run REPORTS ──────────────────────────────────────────

@async_context
async def test_a_trigger_fired_run_reports_at_instance_scope_not_entity_scope(tmp_path, monkeypatch):
    """A perfect progress tree addressed to nobody is the failure this guards.

    ``activity/emit.py:_send`` routes by subject_entity: an entity-scoped activity reaches
    only that entity's WATCHERS, an unscoped one is broadcast to every
    connection. A trigger fires at boot — before anyone has opened the wizard,
    usually before a browser exists — so entity subject_entity means the footer chip
    never sees the run. Setting the machine up at startup is box-level work,
    the same shape as an index walk, and belongs in the same chip.
    """
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.core.wizard.runner import WizardRunResult

    seen: dict = {}

    async def _capture(spec, **kwargs):
        seen.update(kwargs)
        return WizardRunResult(outcomes=[], message="stubbed")

    # Patched where `execute_wizard` looks it up — the module that calls it, not
    # the package that re-exports it. Both callers reach the runner through that
    # one seam now, so this is the seam the test has to intercept.
    monkeypatch.setattr(wizard_execute, "run_wizard", _capture)

    # The REAL shipped wizard, not a tmp_path fixture: the callback refuses an
    # unattended run of anything outside a system project, so a fixture wizard
    # would never reach `run_wizard` at all — which is itself the trust gate
    # working, and is asserted separately below.
    from flow_sdk.config import system_projects_root

    shipped = (
        system_projects_root() / "flowpad_assistant"
        / "agentic-assets" / "wizard" / "dev-toolchain"
    )
    wizard = Wizard(name="dev-toolchain", asset_ref=str(shipped))
    await wizard.save()
    try:
        await reconcile_wizard_triggers()
        trigger = await Trigger.get_by_uname(f"{WIZARD_TRIGGER_UNAME_PREFIX}dev_toolchain_0")
        assert trigger is not None
        await _run_wizard_trigger(trigger, [])

        assert seen, "the shipped wizard's trigger did not reach the runner"
        assert seen.get("subject_entity") is None, (
            "an unattended run must report at instance subject_entity, or the footer chip "
            "never sees it — the run is correct and invisible"
        )
        # ONE SEGMENT: each wizard is its own activity ROOT. `monitor.drop`
        # pops from `_roots` only, so a child address could never be dropped and
        # a resumed run inherited the previous run's counters.
        assert seen.get("activity_path") == "wizard-dev-toolchain"
        assert seen.get("trusted") is True, "a shipped wizard runs unprompted"
    finally:
        await _cleanup(wizard)


@async_context
async def test_an_unattended_run_of_a_non_system_wizard_is_refused(tmp_path, monkeypatch):
    """There is no client to approve it, so the only safe answer is not to run.
    The user can still run it from the app, which is where the prompt lives."""
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.core.wizard.runner import WizardRunResult

    called: list = []

    async def _capture(spec, **kwargs):
        called.append(kwargs)
        return WizardRunResult(outcomes=[], message="stubbed")

    # Patched where `execute_wizard` looks it up — the module that calls it, not
    # the package that re-exports it. Both callers reach the runner through that
    # one seam now, so this is the seam the test has to intercept.
    monkeypatch.setattr(wizard_execute, "run_wizard", _capture)

    wizard = await _save_wizard(tmp_path)  # a user project, not system-shipped
    try:
        await reconcile_wizard_triggers()
        trigger = await Trigger.get_by_uname(f"{WIZARD_TRIGGER_UNAME_PREFIX}dev_toolchain_0")
        assert trigger is not None
        await _run_wizard_trigger(trigger, [])
        assert called == [], "a cloned repo's wizard must not run unattended"
    finally:
        await _cleanup(wizard)
