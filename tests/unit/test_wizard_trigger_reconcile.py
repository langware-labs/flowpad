"""A wizard's trigger: armed on arrival, and refused when it must not run.

The derivation these tests used to cover is gone — a wizard's trigger is an
ordinary child asset now, minted and armed by the indexer, so there is nothing
left to derive from `wizard.json`. What survives is everything that was never
about derivation:

* **arming.** The TAG boot sweep runs once and the bus has no durability, so a
  trigger created afterwards must be armed by whoever created it or the event it
  waits for is simply gone, with nothing saying why the wizard did not run.
* **the trust gate.** An unattended run of a wizard from a cloned repo would make
  opening a project a code-execution primitive.
* **instance scope.** A trigger fires before anyone has opened the wizard, so a
  perfectly correct entity-scoped progress tree would reach an audience of zero.

Plus one new thing: the legacy prune, which retires the positional
`wizard_<slug>_<n>` rows older installs derived.
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
)
from tests.conftest import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

DOC = {
    "name": "Developer toolchain",
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


async def _trigger_for(wizard: Wizard, *, uname: str = "wizard_test_0") -> Trigger:
    """A tag trigger that launches `wizard`, built the way the asset path builds
    one: the ACTION names the wizard, by TypeId."""
    trigger = Trigger(
        uname=uname,
        name=f"{wizard.name} (app.ready)",
        trigger_type=TriggerType.TAG,
        tag_pattern="app.ready",
        fire_once=True,
        actions=[TriggerAction(
            action_type=ActionType.CALLBACK,
            callback_name="builtin_run_wizard",
            target_type_id=str(wizard.typeid),
        )],
    )
    await trigger.save()
    return trigger


async def _cleanup(*entities):
    for entity in entities:
        await entity.delete()
    for row in await Trigger.get_all({}):
        if (getattr(row, "uname", "") or "").startswith(("wizard_", "user_")):
            tag_triggers.unregister_tag_trigger(row.id)
            await row.delete()


# ── arming ───────────────────────────────────────────────────────────────────

@async_context
async def test_a_tag_trigger_created_after_the_boot_sweep_is_armed_immediately(tmp_path):
    """`start_tag_triggers` runs once at boot. Anything created afterwards — an
    indexed asset, a seeded row — has to arm itself, or it waits for an event
    that has already gone past."""
    spec = dict(
        uname="wizard_armed_0", name="armed", trigger_type=TriggerType.TAG,
        tag_pattern="app.ready",
        actions=[TriggerAction(action_type=ActionType.CALLBACK, callback_name="builtin_run_wizard")],
    )
    await _upsert_one(spec)
    row = await Trigger.get_by_uname("wizard_armed_0")
    try:
        assert row is not None
        assert row.id in tag_triggers._subscriptions, "created but never armed"
    finally:
        await _cleanup(row)


# ── the legacy prune ─────────────────────────────────────────────────────────

@async_context
async def test_the_derived_namespace_is_retired(tmp_path):
    """Older installs hold `wizard_<slug>_<n>` rows this used to derive. They are
    superseded by child assets, and an armed row whose declaration no longer
    exists would fire for a wizard nothing points at."""
    stale = Trigger(
        uname="wizard_dev_toolchain_0", name="derived", trigger_type=TriggerType.TAG,
        tag_pattern="app.ready",
    )
    await stale.save()
    tag_triggers.register_tag_trigger(stale)
    stale_id = stale.id

    await reconcile_wizard_triggers()

    assert await Trigger.get_by_uname("wizard_dev_toolchain_0") is None
    assert stale_id not in tag_triggers._subscriptions, "retired but left armed"


@async_context
async def test_the_prune_spares_a_user_authored_trigger(tmp_path):
    """The `wizard_` prefix is what makes deleting rows safe: those unames were
    minted by us, so nothing a person wrote can land in the namespace."""
    mine = Trigger(
        uname="user_app_ready", name="mine", trigger_type=TriggerType.TAG,
        tag_pattern="app.ready",
    )
    await mine.save()
    try:
        await reconcile_wizard_triggers()
        assert await Trigger.get_by_uname("user_app_ready") is not None
    finally:
        await _cleanup(mine)


# ── what a fired trigger does ────────────────────────────────────────────────

@async_context
async def test_a_trigger_fired_run_reports_at_instance_scope_not_entity_scope(tmp_path, monkeypatch):
    """A perfect progress tree addressed to nobody is the failure this guards.

    ``activity/emit.py:_send`` routes by subject_entity: an entity-scoped
    activity reaches only that entity's WATCHERS, an unscoped one is broadcast
    to every connection. A trigger fires at boot — before anyone has opened the
    wizard, usually before a browser exists — so entity scope means the footer
    chip never sees the run.
    """
    from flow_sdk.config import system_projects_root
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.core.wizard.runner import WizardRunResult

    seen: dict = {}

    async def _capture(spec, **kwargs):
        seen.update(kwargs)
        return WizardRunResult(outcomes=[], message="stubbed")

    monkeypatch.setattr(wizard_execute, "run_wizard", _capture)

    # The REAL shipped wizard: the callback refuses an unattended run of anything
    # outside a system project, so a fixture wizard would never reach the runner.
    shipped = (
        system_projects_root() / "flowpad_assistant"
        / "agentic-assets" / "wizard" / "dev-toolchain"
    )
    wizard = Wizard(name="dev-toolchain", asset_ref=str(shipped))
    await wizard.save()
    trigger = await _trigger_for(wizard)
    try:
        await _run_wizard_trigger(trigger, [])

        assert seen, "the shipped wizard's trigger did not reach the runner"
        assert seen.get("subject_entity") is None, (
            "an unattended run must report at instance scope, or the footer chip "
            "never sees it — the run is correct and invisible"
        )
        # ONE SEGMENT: each wizard is its own activity ROOT.
        assert seen.get("activity_path") == "wizard-dev-toolchain"
        assert seen.get("trusted") is True, "a shipped wizard runs unprompted"
    finally:
        await _cleanup(wizard, trigger)


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

    monkeypatch.setattr(wizard_execute, "run_wizard", _capture)

    wizard = await _save_wizard(tmp_path)  # a user project, not system-shipped
    trigger = await _trigger_for(wizard)
    try:
        await _run_wizard_trigger(trigger, [])
        assert called == [], "a cloned repo's wizard must not run unattended"
    finally:
        await _cleanup(wizard, trigger)


@async_context
async def test_the_action_is_what_names_the_wizard(tmp_path):
    """`trigger.path` was the old channel — a generic HOOK field, PRIVATE, so a
    shared trigger lost its subject. The action carries the TypeId now."""
    from flow_sdk.server.builtin_triggers import _wizard_for

    wizard = await _save_wizard(tmp_path, name="named-by-action")
    trigger = await _trigger_for(wizard)
    try:
        found = await _wizard_for(trigger)
        assert found is not None and str(found.id) == str(wizard.id)
    finally:
        await _cleanup(wizard, trigger)
