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
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.builtin.wizard import Wizard
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from flow_sdk.server.builtin_triggers import (
    _run_wizard_trigger,
    _upsert_one,
    reconcile_wizard_triggers,
)
from tests.fixtures.identity import index_path
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

DOC = {
    "name": "Developer toolchain",
    "steps": [
        {
            "id": "python3",
            "precondition": {"commands": {"linux": "have python3"}},
            "process": {"prompt": "install python"},
        }
    ],
}


def _wizard_folder(tmp_path, doc=None, name="dev-toolchain"):
    root = tmp_path / "agentic-assets" / "wizard" / name
    root.mkdir(parents=True, exist_ok=True)
    (root / "wizard.json").write_text(json.dumps(doc or DOC), encoding="utf-8")
    return root


async def _save_wizard(tmp_path, doc=None, name="dev-toolchain") -> Wizard:
    root = _wizard_folder(tmp_path, doc, name)
    record = await index_path("wizard", root)
    return await Wizard.get_by_id(record.id)


async def _trigger_for(wizard: Wizard, *, uname: str = "wizard_test_0") -> Trigger:
    """A tag trigger that launches `wizard`, built the way the asset path builds
    one: the ACTION names the wizard, by TypeId."""
    trigger = Trigger(
        uname=uname,
        name=f"{wizard.name} (app.ready)",
        trigger_type=TriggerType.TAG,
        tag_pattern="app.ready",
        fire_once=True,
        actions=[
            TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_run_wizard",
                target_type_id=str(wizard.typeid),
            )
        ],
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
        uname="wizard_armed_0",
        name="armed",
        trigger_type=TriggerType.TAG,
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
        uname="wizard_dev_toolchain_0",
        name="derived",
        trigger_type=TriggerType.TAG,
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
        uname="user_app_ready",
        name="mine",
        trigger_type=TriggerType.TAG,
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
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

    seen: dict = {}

    async def _capture(spec, **kwargs):
        seen.update(kwargs)
        return WizardResult.satisfied("stubbed")

    monkeypatch.setattr(wizard_execute, "run_wizard", _capture)

    # The REAL shipped wizard: the callback refuses an unattended run of anything
    # outside a system project, so a fixture wizard would never reach the runner.
    shipped = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "llm-setup"
    record = await index_path("wizard", shipped, write=False)
    wizard = await Wizard.get_by_id(record.id)
    trigger = await _trigger_for(wizard)
    try:
        await _run_wizard_trigger(trigger, [])

        assert seen, "the shipped wizard's trigger did not reach the runner"
        assert seen.get("subject_entity") is None, (
            "an unattended run must report at instance scope, or the footer chip "
            "never sees it — the run is correct and invisible"
        )
        # ONE SEGMENT: each wizard is its own activity ROOT — the address the
        # entity advertises, which is also its run slot (unique per wizard).
        assert seen.get("activity_path") == wizard.activity_path
        assert "/" not in wizard.activity_path and "llm-setup" in wizard.activity_path
        assert seen.get("trusted") is True, "a shipped wizard runs unprompted"
    finally:
        await _cleanup(wizard, trigger)


@pytest.mark.parametrize("finished", [True, False])
@async_context
async def test_a_run_that_did_not_finish_tells_the_person_what_is_missing(monkeypatch, finished):
    """Nobody watches an unattended run and its activity node is dropped when it ends, so a
    short run says so — a warning (kept in the footer list, not only toasted) naming each
    missing step by its label, with a click to the wizard. A run that finished says nothing."""
    from flow_sdk.config import system_projects_root
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.notifications import desktop
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, WizardResult

    async def _ends(spec, **kwargs):
        if finished:
            return WizardResult.satisfied("stubbed")
        return WizardResult.not_yet(
            "git: the cli call ran, but the check still fails.",
            steps={"llm": CliResult.satisfied("funded"), "git": CliResult.not_yet("still missing")},
        )

    told: list[dict] = []

    async def _notify(notify_type, **kwargs):
        told.append({"notify_type": notify_type, **kwargs})

    monkeypatch.setattr(wizard_execute, "run_wizard", _ends)
    monkeypatch.setattr(desktop, "notify_desktop", _notify)

    shipped = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "llm-setup"
    record = await index_path("wizard", shipped, write=False)
    wizard = await Wizard.get_by_id(record.id)
    trigger = await _trigger_for(wizard)
    try:
        await _run_wizard_trigger(trigger, [])

        if finished:
            assert told == []
            return
        (note,) = told
        assert note["level"] == "warning"
        assert note["body"] == "Not done: Git."
        assert note["click_target"] == {"view_type": "assets", "pointer": f"editor/wizard/typeid/{wizard.typeid}"}
    finally:
        await _cleanup(wizard, trigger)


def _row(**over):
    from flow_sdk.cli.commands.llm_cmd import Row

    fields = dict(
        n=1,
        typeid="llm_endpoint-x",
        name="Claude",
        kind="device",
        provider="anthropic",
        harnesses=["claude"],
        scope="default",
        active_for=["claude"],
    )
    return Row(**{**fields, **over})


def test_the_llm_source_is_settled_in_process_for_the_box(monkeypatch):
    """No `flow` subprocess: that paid a fresh shell and a cold import (~3s on
    Windows) before the chooser appeared. It needs no indexed entity either —
    that race is what once made `run_llm_setup` answer "not installed" on a
    fresh first boot. The scope is the box, as the old subprocess (run from
    home) answered: the server's own working directory means nothing here."""
    import asyncio

    from flow_sdk.cli.commands import llm_cmd
    from flow_sdk.core.compute import exec as compute_exec
    from flow_sdk.server.builtin_triggers import _resolve_llm_source

    seen: dict = {}

    def _resolve(**kwargs):
        seen.update(kwargs)
        return _row()

    async def _no_shell(*_a, **_k):
        raise AssertionError("settling the source must not spawn a process")

    monkeypatch.setattr(llm_cmd, "_resolve_or_choose", _resolve)
    monkeypatch.setattr(compute_exec, "run_shell", _no_shell)

    result = asyncio.run(_resolve_llm_source())

    assert result.ok, result.detail
    assert seen == {"project_id": ""}
    assert "Claude" in result.detail


def test_nothing_chosen_is_not_ok_and_does_not_raise(monkeypatch):
    """`_fail` exits the CLI; in-process that is a `typer.Exit` to catch, not a crash."""
    import asyncio

    import typer

    from flow_sdk.cli.commands import llm_cmd
    from flow_sdk.server.builtin_triggers import _resolve_llm_source

    def _skipped(**_kwargs):
        raise typer.Exit(4)

    monkeypatch.setattr(llm_cmd, "_resolve_or_choose", _skipped)

    result = asyncio.run(_resolve_llm_source())

    assert not result.ok


@async_context
async def test_run_setup_clears_the_last_run_before_the_llm_source(monkeypatch):
    """A person who clicks "Run setup again" sees empty steps at once, not the
    last run's answers sitting there while the chooser is open."""
    from flow_sdk.config import system_projects_root
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.core.wizard.state import read_result, record_result
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, WizardResult
    from flow_sdk.server import builtin_triggers

    shipped = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "llm-setup"
    record = await index_path("wizard", shipped, write=False)
    wizard = await Wizard.get_by_id(record.id)
    record_result(str(wizard.id), WizardResult.not_yet("the last run"))
    seen_at_source: list = []

    async def _resolve_source():
        seen_at_source.append(read_result(str(wizard.id)))
        return CliResult.satisfied("funded")

    async def _wizard(spec, **kwargs):
        return WizardResult.satisfied("stubbed")

    monkeypatch.setattr(builtin_triggers, "_resolve_llm_source", _resolve_source)
    monkeypatch.setattr(wizard_execute, "run_wizard", _wizard)
    try:
        await builtin_triggers.run_llm_setup(wizard, unattended=False)
        assert seen_at_source == [None], "the last run's answer was still there while the source was settled"
    finally:
        await _cleanup(wizard)


@pytest.mark.parametrize("funded", [True, False])
@async_context
async def test_first_run_setup_settles_the_llm_source_then_runs_the_wizard(monkeypatch, funded):
    """The source comes BEFORE the wizard and outside it; without one the wizard
    still runs (its plain commands need none), and the notice names the source."""
    from flow_sdk.config import system_projects_root
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.notifications import desktop
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, WizardResult
    from flow_sdk.server import builtin_triggers
    from flow_sdk.server.builtin_triggers import _run_llm_setup_trigger

    order: list[str] = []

    async def _resolve_source():
        order.append("llm source")
        return CliResult.satisfied("funded") if funded else CliResult.not_yet("skipped")

    async def _wizard(spec, **kwargs):
        order.append("wizard")
        return WizardResult.satisfied("stubbed")

    told: list[dict] = []

    async def _notify(notify_type, **kwargs):
        told.append(kwargs)

    monkeypatch.setattr(builtin_triggers, "_resolve_llm_source", _resolve_source)
    monkeypatch.setattr(wizard_execute, "run_wizard", _wizard)
    monkeypatch.setattr(desktop, "notify_desktop", _notify)

    shipped = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "llm-setup"
    record = await index_path("wizard", shipped, write=False)
    wizard = await Wizard.get_by_id(record.id)
    trigger = await _trigger_for(wizard)
    try:
        await _run_llm_setup_trigger(trigger, [])

        assert order == ["llm source", "wizard"], "the source is settled first, and the wizard runs either way"
        if funded:
            assert told == []
        else:
            (note,) = told
            assert note["body"] == "Not done: LLM source."
    finally:
        await _cleanup(wizard, trigger)


@async_context
async def test_an_unattended_run_of_a_non_system_wizard_is_refused(tmp_path, monkeypatch):
    """There is no client to approve it, so the only safe answer is not to run.
    The user can still run it from the app, which is where the prompt lives."""
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

    called: list = []

    async def _capture(spec, **kwargs):
        called.append(kwargs)
        return WizardResult.satisfied("stubbed")

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
