"""Built-in system triggers: upserted at server boot.

`set_service_triggers()` is called from `_on_server_startup` before
`fsop_watcher.start()` so the watcher's startup walk finds them and spawns
awatch tasks. Triggers carry `scope='system'` (default for Trigger entities)
and live in the entity store keyed by `uname`.

Adding a new system trigger:
  1. Add an entry to `_service_trigger_specs()`.
  2. Register its `@trigger_callbacks.register(...)` handler below.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ReturnedValue, WizardResult

_log = logging.getLogger(__name__)

#: Set to ``true`` on a test backend to keep the first-run llm-setup trigger from running.
SKIP_FIRST_RUN_SETUP_ENV = "FLOWPAD_SKIP_FIRST_RUN_SETUP"


# ── Built-in callbacks ───────────────────────────────────────────────────────


@trigger_callbacks.register(
    "builtin_toplog_filter_apply",
    meaning="Fired when the per-instance toplog.json changes. Re-derives the "
    "in-memory tag state from the file and broadcasts the new state to "
    "all UI clients. This is the single broadcaster for toplog — every "
    "writer (backend, frontend-via-route, worker, human edit) converges "
    "through the file and this callback.",
)
async def _toplog_filter_apply(trigger: Trigger, changes: list[ChangeEvent]) -> None:
    # The file is authority: re-derive this process's in-memory state, then push
    # it to every connected client. Runs in the server's async context, so it is
    # the one place allowed to await broadcast(); the sync toplog mutators never
    # touch the event loop.
    from flow_sdk import toplog

    toplog._apply_from_file()
    try:
        from flow_sdk.api.messages import ToplogStateMessage
        from flow_sdk.server.routes.websocket import broadcast

        st = toplog.state()
        await broadcast(
            ToplogStateMessage(enabled=st["enabled"], filter=st["filter"], persist=st["persist"]).model_dump_json()
        )
    except Exception:
        _log.exception("toplog: failed to broadcast state after file change")


# ── Spec list ────────────────────────────────────────────────────────────────


def _service_trigger_specs() -> list[dict[str, Any]]:
    """Canonical system triggers. Resolved lazily so test fixtures that
    monkeypatch `get_instance_settings()` get the redirected paths.

    The imports below are intentionally lazy — they exist so each consumer's
    ``@trigger_callbacks.register`` decorator runs before set_service_triggers
    upserts the trigger, guaranteeing the callback is in the registry when
    the first fire dispatches.
    """
    from flow_sdk.ingest import flow_functions as _ingest_flow_fns  # noqa: F401  decorator side-effect
    from flow_sdk.ingest import poller as _ingest_poller  # noqa: F401  decorator side-effect
    from flow_sdk.rag import reconcile as _rag_reconcile  # noqa: F401  decorator side-effect
    from flow_sdk.server import system_heartbeat as _heartbeat  # noqa: F401  decorator side-effect
    from flow_sdk.transcript_streamer.triggers import transcript_watcher_trigger_specs
    from flow_sdk.usage_report import callback as _usage_report_cb  # noqa: F401  decorator side-effect

    settings = get_instance_settings()
    specs: list[dict[str, Any]] = [
        dict(
            uname="builtin_toplog_watcher",
            name="Toplog filter watcher",
            description="Watches the per-instance toplog.json; re-applies the "
            "filter to tag loggers and broadcasts to UI.",
            trigger_type=TriggerType.FSOP,
            watch_path=str(settings.toplog_config_path),
            recursive=False,
            actions=[
                TriggerAction(
                    action_type=ActionType.CALLBACK,
                    callback_name="builtin_toplog_filter_apply",
                )
            ],
        ),
        dict(
            uname="builtin_daily_usage_analysis",
            name="Last day usage analysis",
            description="Disabled by default. When enabled, every day at 7am "
            "(local) fires the daily-analysis flow — analyze (function) "
            "→ publish — which posts a usage report to the Home Feed.",
            trigger_type=TriggerType.SCHEDULE,
            sched_trigger_type="cron",
            expr="0 7 * * *",
            # Off by default, and FORCED off: the upsert re-applies every spec
            # key on each boot, so existing installs flip off on restart and a
            # user who enables it is reset on the next one.
            enabled=False,
            # No direct action: the daily-analysis GraphWorkflow (service_graph_workflows)
            # routes this trigger's `fired` through analyze → publish —
            # a direct action here would double-fire the report.
            actions=[],
        ),
        dict(
            uname="builtin_system_heartbeat",
            name="System heartbeat",
            description="Fires every minute. Housekeeping tasks register via "
            "@register_heartbeat_task; the dispatch callback fans "
            "out and isolates per-task failures.",
            trigger_type=TriggerType.SCHEDULE,
            sched_trigger_type="cron",
            expr="* * * * *",
            actions=[
                TriggerAction(
                    action_type=ActionType.CALLBACK,
                    callback_name="builtin_heartbeat_dispatch",
                )
            ],
        ),
    ]
    specs.extend(transcript_watcher_trigger_specs(settings))
    return specs


# ── Upsert ───────────────────────────────────────────────────────────────────


# Fields that aren't user-mutable post-save and shouldn't be re-applied on
# upsert. ``uname`` is the identity key; counter/last_triggered/last_run are
# runtime state we never want to clobber from a static spec.
_UPSERT_SKIP_KEYS = frozenset({"uname", "counter", "last_triggered", "last_run", "next_run"})


async def _upsert_one(spec: dict[str, Any], *, existing: "Optional[Trigger]" = None) -> None:
    """Find-by-uname, then update-or-create. Idempotent across server restarts.

    On create, also runs the trigger-type's post-save registration so the
    watcher / scheduler picks it up immediately (without waiting for the
    next server boot). On update, leaves the watcher/scheduler entry in
    place — the fields it cares about (cron expr, watch_path, etc.) only
    matter at registration time anyway.
    """
    uname = spec["uname"]
    if existing is None:
        # Only when the caller has not already read it. A reconcile that reads
        # the whole derived set once passes the row straight in.
        try:
            existing = await Trigger.get_by_uname(uname)
        except Exception:
            existing = None

    if existing is None:
        try:
            entity = Trigger(**spec)
            await entity.save()
            await _register_post_save(entity)
            _log.info("Created builtin trigger %r", uname)
        except Exception:
            _log.exception("Failed to create builtin trigger %r", uname)
        return

    # Update every spec field except identity/runtime — generic so any
    # trigger type (HOOK/SCHEDULE/FSOP) updates correctly across restarts.
    for key, value in spec.items():
        if key in _UPSERT_SKIP_KEYS:
            continue
        setattr(existing, key, value)
    try:
        await existing.update()
        # SCHEDULE: re-register in case the cron expression changed across
        # restarts. APScheduler's add_job(replace_existing=True) is idempotent.
        await _register_post_save(existing)
        _log.info("Updated builtin trigger %r", uname)
    except Exception:
        _log.exception("Failed to update builtin trigger %r", uname)


async def _register_post_save(entity: Trigger) -> None:
    """Mirror the post-save registration the public create route runs — the
    entity save alone does not tell APScheduler / the FSOp watcher / the bus
    about the trigger.

    Delegates to `arm_trigger`, which the INDEX path also calls: a trigger that
    arrives as an asset must end up as live as one that was seeded, and two
    copies of that logic is how one of them silently stops matching.
    """
    from flow_sdk.builtin.trigger_arming import arm_trigger  # noqa: PLC0415

    await arm_trigger(entity)


async def seed_service_entities() -> None:
    """Upsert every system-scope row a wipe destroys: the builtin triggers,
    then the service GraphWorkflows.

    The single seam for both callers — `_on_server_startup` (before
    `fsop_watcher.start()`) and `clear_all_data()`, since a factory reset
    deletes these rows like any other. Seeding them together is the point: a
    caller cannot restore half the set, which is exactly the bug that shipped
    when the reset path re-seeded triggers and left the flows behind.
    """
    await set_service_triggers()
    try:
        from flow_sdk.graph_workflow_manager.service_graph_workflows import set_service_graph_workflows

        await set_service_graph_workflows()
    except Exception:
        _log.exception("set_service_graph_workflows failed")


async def set_service_triggers() -> None:
    """Idempotently upsert system FSOp triggers, then seed any missing
    watched files so `awatch` has something to subscribe to on first boot.

    Called from `_on_server_startup` BEFORE `fsop_watcher.start()`.
    """
    for spec in _service_trigger_specs():
        await _upsert_one(spec)

    # Seed the watched toplog.json so awatch attaches cleanly on boot. Tracing does
    # not survive a restart unless the file asks to `persist`: the reset clears the
    # tags and puts the master switch back to the instance setting (on in dev, off
    # in prod). The write happens BEFORE fsop_watcher.start(); its startup catch-up
    # sees the new mtime and fires the broadcaster once, which only re-sends the
    # state just written. seed_file re-derives the in-memory state itself.
    settings = get_instance_settings()
    try:
        from flow_sdk import toplog

        toplog.seed_file(settings.toplog_enabled)
    except Exception:
        _log.exception("Failed to seed/apply initial toplog state")


# ── Wizard triggers — derived from indexed Wizard assets ─────────────────────
#
# A Wizard declares its own bus subscriptions in `wizard.json`. Those become
# real Trigger rows, reconciled here.
#
# Deliberately NOT hooked into the indexer. Nothing in this tree creates a
# control-plane entity as a side effect of indexing an asset, and this is not
# the change that should introduce it: `Trigger(...)` is constructed in exactly
# two places and both are seed paths. So this is a seed path too — structurally
# `set_service_triggers()`, only with a spec list that is computed from what is
# on disk instead of written out literally.
#
# It also answers "why a row rather than an in-memory subscription, like a
# GraphWorkflow's `subscriptions:` block?" — `fire_once` needs a counter that
# survives a restart, and an in-memory subscription has nowhere to keep one.

#: Every derived wizard trigger's uname starts with this. The prefix is what
#: makes the orphan prune below safe: unames are minted here from the asset
#: slug, so a user-authored trigger can never land in the namespace and be
#: mistaken for an orphan of ours.
WIZARD_TRIGGER_UNAME_PREFIX = "wizard_"


async def _wizard_for(trigger: Trigger) -> "Optional[Wizard]":
    """The wizard this trigger launches: its action's target, else its parent,
    else the legacy path.

    Three rungs and they are ordered by how EXPLICIT they are. The action names
    a TypeId because the author said so. `parent_type_id` is the enclosure rule
    — a trigger living inside a wizard's folder launches that wizard, which is
    what lets an author write `run_wizard: ""` and not go hunting for a uuid.
    `path` is only for rows minted before either existed.
    """
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415

    for candidate in (
        *(str(getattr(a, "target_type_id", "") or "") for a in (trigger.actions or [])),
        str(trigger.parent_type_id or ""),
    ):
        if candidate.startswith("wizard-"):
            found = await Wizard.get_by_id(candidate.split("-", 1)[1])
            if found is not None:
                return found
    asset_ref = (trigger.path or "").strip()
    return await Wizard.get_one({"asset_ref": asset_ref}) if asset_ref else None


@trigger_callbacks.register(
    "builtin_run_wizard",
    meaning="Fired by a bus tag a Wizard asset declared for itself. Resolves the "
    "Wizard from the trigger's path and runs it, reporting through the "
    "shared Activity tree. A shipped wizard runs unprompted; anything "
    "else is refused here, because running a cloned repo's shell "
    "one-liners unattended would make opening a project a code-execution "
    "primitive.",
)
async def _run_wizard_trigger(trigger: Trigger, changes: list[ChangeEvent]) -> None:
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode  # noqa: PLC0415

    # WHICH wizard, by TypeId, off the ACTION that says so. `trigger.path` was
    # the old channel and a poor one: a generic field a HOOK trigger uses for
    # its record.json, marked Sharing.PRIVATE, so a shared trigger lost its
    # subject entirely and nothing could validate the subject was a wizard.
    wizard = await _wizard_for(trigger)
    if wizard is None:
        # A row with no resolvable wizard could never run anyway: without the
        # entity there is no shipped-ness to trust, so it was always refused.
        _log.warning("wizard trigger %r names no wizard it can resolve; nothing to run", trigger.uname)
        return

    # Every gate — missing, disabled, conversational, unapproved — is decided in
    # `Wizard.run`, never re-implemented here. A trigger fire is unattended by
    # definition: there is no client to ask, so a wizard not shipped with Flowpad
    # answers REFUSED; the user can still run it from the app, where approval is.
    result = await wizard.run(unattended=True)
    if result.exit_code is ExitCode.REFUSED:
        _log.warning("wizard trigger %r: %s Run it from the app to approve it.", trigger.uname, result.detail)
        return
    _log.info("wizard trigger %r: %s — %s", trigger.uname, "ok" if result.ok else "not done", result.detail)
    if not result.ok:
        await _tell_the_person_it_did_not_finish(wizard, result)


LLM_SETUP_WIZARD = "llm-setup"


async def _resolve_llm_source() -> "CliResult":
    """`flow llm set auto`, run IN this process. Idempotent: it returns at once
    when the box is already funded, without opening anything.

    In-process, not a `flow` subprocess. The command is only this backend's own
    resolver plus a socket back to it, and a subprocess made the person pay a
    fresh shell and a cold ``flow_sdk`` import before the chooser appeared — on
    Windows ~3s (PowerShell, then ~1000 modules), a visible pause between the
    wizard page opening and the chooser. The resolver is synchronous and blocks
    on the chooser's socket, so it runs on a worker thread; its HTTP calls come
    back to this loop, which stays free to serve them.

    ``project_id=""`` is the box, which is what the subprocess answered too: it
    ran from the home directory, and the server's own working directory says
    nothing about what the person meant.
    """
    import typer  # noqa: PLC0415

    from flow_sdk.cli.commands import llm_cmd  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_op_spec import CLI_TIMEOUT  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult  # noqa: PLC0415

    try:
        row = await asyncio.wait_for(asyncio.to_thread(llm_cmd._resolve_or_choose, project_id=""), timeout=CLI_TIMEOUT)
    except asyncio.TimeoutError:
        return CliResult.not_yet("no LLM source was chosen in time")
    except typer.Exit as exc:
        # `_fail` has already said why, to this process's stderr — the log.
        return CliResult.not_yet(f"no LLM source was settled (exit {exc.exit_code})")
    except Exception as exc:  # noqa: BLE001 — the setup that follows must still run
        _log.warning("llm setup: resolving an LLM source failed", exc_info=True)
        return CliResult.not_yet(f"resolving an LLM source failed: {exc}")
    return CliResult.satisfied(f"{row.name} ({row.kind}) funds {', '.join(row.active_for)}")


async def _navigate_to_wizard(wizard: "Wizard") -> None:
    """Send whatever tab is open to this wizard's own page — the list of tools
    and their live status, not whatever screen the person happened to be on.

    Best-effort and silent either way: no live tab (headless, or nobody has
    opened the app yet) means nothing to send anywhere, same as `ask_window`'s
    own tolerance for the identical situation. This is the one case an
    unattended run is deliberately allowed to steer a tab — first-run setup
    IS the reason the person is looking at Flowpad at all, so landing them on
    a blank home screen while it works in the background is the confusing
    outcome, not this.
    """
    try:
        from flow_sdk.notifications.ui_command import send_ui_command  # noqa: PLC0415
        from flow_sdk.server.routes.websocket import get_active_connection  # noqa: PLC0415

        target = get_active_connection()
        if target is None:
            return
        _connection_id, socket = target
        await send_ui_command(
            socket,
            "navigate_dock",
            view_type="assets",
            pointer=f"editor/wizard/typeid/{wizard.typeid}",
        )
    except Exception:  # noqa: BLE001 — no socket, no server: nothing to steer
        _log.debug("llm setup: no live tab to show the wizard page on", exc_info=True)


async def run_llm_setup(wizard: "Wizard", *, unattended: bool) -> "tuple[ReturnedValue, WizardResult]":
    """First-run setup: an LLM source, then the wizard that installs the tools.

    The source is settled BEFORE the wizard and outside it (`_resolve_llm_source`).
    Whatever it answers, the wizard runs next: only its agent fallbacks need a
    source, and every plain install command works without one. The two answers
    come back side by side, so a caller can say which of them fell short.

    One function for both ways in — the trigger on the first tab after install,
    and Settings → General — so the order cannot drift between them. Both also
    steer the active tab to the wizard's own page before running it: neither
    caller is "the person is already looking at the wizard", so without this
    the whole run is invisible behind whatever screen was already open.

    Steered TWICE, not once. `_resolve_llm_source` itself navigates to the
    chooser (`/dock/llm-setup`) whenever the box is not already funded — a
    second navigation, landing well after the first, that overwrites it. A
    person who was just sent to the wizard page is then sent past it to the
    chooser, and once they press its own "Done" nothing sends them back: they
    are left on whatever the chooser's own close-target is (its caller's
    "home"), watching a wizard run they cannot see. So this steers again right
    before the wizard actually starts — a wasted no-op when the box was
    already funded and the chooser never opened, and the fix when it did.

    The previous run's answers are cleared FIRST, before the page is shown.
    `execute_wizard` clears them too, but only once the wizard itself starts —
    after the LLM source, which can mean minutes in the chooser — so the page
    opened onto the last run's leftovers and only emptied later. A run already
    in progress keeps its record (`reset_run` refuses); `wizard.run` then
    answers "already running", as it always did.
    """
    from flow_sdk.core.wizard.execute import _notify_wizard_watchers  # noqa: PLC0415
    from flow_sdk.core.wizard.state import reset_run  # noqa: PLC0415

    if reset_run(str(wizard.id)) is not None:
        await _notify_wizard_watchers(str(wizard.id))
    await _navigate_to_wizard(wizard)
    source = await _resolve_llm_source()
    _log.info("llm setup: LLM source — %s", source.detail or ("ok" if source.ok else "not done"))
    await _navigate_to_wizard(wizard)
    return source, await wizard.run(unattended=unattended)


@trigger_callbacks.register(
    "builtin_run_llm_setup",
    meaning="First-run setup, fired by the llm-setup wizard's own trigger: settles an "
    "LLM source (`flow llm set auto`), then runs the wizard. Says so when "
    "either fell short.",
)
async def _run_llm_setup_trigger(trigger: Trigger, changes: list[ChangeEvent]) -> None:
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode  # noqa: PLC0415

    # A test backend is a fresh install every run, so this would fire on the first tab of
    # every suite, steer it to the wizard page and start installing tools on the runner.
    # Settings → "Run setup again" calls `run_llm_setup` directly and is not gated.
    if os.environ.get(SKIP_FIRST_RUN_SETUP_ENV, "").lower() == "true":
        _log.info("llm setup trigger %r: skipped (%s=true)", trigger.uname, SKIP_FIRST_RUN_SETUP_ENV)
        return

    wizard = await _wizard_for(trigger)
    if wizard is None:
        _log.warning("llm setup trigger %r names no wizard it can resolve; nothing to run", trigger.uname)
        return
    source, result = await run_llm_setup(wizard, unattended=True)
    if result.exit_code is ExitCode.REFUSED:
        _log.warning("llm setup trigger %r: %s", trigger.uname, result.detail)
        return
    _log.info("llm setup trigger %r: %s — %s", trigger.uname, "ok" if result.ok else "not done", result.detail)
    if not (source.ok and result.ok):
        await _tell_the_person_it_did_not_finish(wizard, result, also_missing=[] if source.ok else ["LLM source"])


async def _tell_the_person_it_did_not_finish(
    wizard: "Wizard", result: "WizardResult", *, also_missing: "list[str] | None" = None
) -> None:
    """A run nobody started ended short of its goal: say so, and where to look.

    Unattended means nobody is watching the wizard's page, and its activity node is dropped
    when the run ends — without this, a failed first-run setup leaves nothing but a log line.
    The note names what is still missing by its step label, so "Git" is said rather than a
    step id, and a click opens the wizard, whose page shows each step's answer.
    """
    from flow_sdk.notifications.desktop import notify_desktop  # noqa: PLC0415

    spec = wizard.spec()
    labels = {step.id: step.display_label for step in (spec.steps if spec else [])}
    missing = [
        *(also_missing or []),
        *(labels.get(step_id, step_id) for step_id, answer in result.steps.items() if not answer.ok),
    ]
    body = f"Not done: {', '.join(missing)}." if missing else (result.detail or "")
    try:
        await notify_desktop(
            "wizard_not_done",
            title=f"{wizard.name or 'Setup'} did not finish",
            body=body,
            click_target={"view_type": "assets", "pointer": f"editor/wizard/typeid/{wizard.typeid}"},
            level="warning",
        )
    except Exception:  # noqa: BLE001 — a notice that could not be sent never fails the run
        _log.warning("wizard trigger: could not tell the person %r did not finish", wizard.name, exc_info=True)


async def reconcile_wizard_triggers() -> None:
    """Retire the DERIVED wizard triggers of older installs.

    A wizard's trigger is now an ordinary child asset with its own row, minted
    and armed by the indexer. The rows this used to derive — ``wizard_<slug>_<n>``,
    keyed POSITIONALLY, so reordering a wizard's array swapped two triggers'
    durable counters — are superseded, and an armed row whose declaration no
    longer exists would fire a callback for a wizard nothing points at.

    So this no longer derives anything; it deletes that namespace once. The
    prefix is what makes it safe: those unames were minted by us, so a
    user-authored trigger can never land in it. Kept as a named step rather than
    a migration script because it must run before ``app.ready`` — the same
    ordering the derivation needed, for the opposite reason.
    """
    from flow_sdk.builtin.trigger_arming import disarm_trigger  # noqa: PLC0415

    try:
        rows = await Trigger.get_all(
            QueryFilter(
                match=ExpressionNode(
                    op=QueryOp.LIKE,
                    operands=["uname", f"{WIZARD_TRIGGER_UNAME_PREFIX}%"],
                )
            )
        )
    except Exception:
        _log.exception("Could not read legacy wizard triggers")
        return

    for row in rows:
        await disarm_trigger(str(row.id))
        try:
            await row.delete()
            _log.info("retired derived wizard trigger %r (now a child asset)", row.uname)
        except Exception:
            _log.exception("Could not retire legacy wizard trigger %r", row.uname)
