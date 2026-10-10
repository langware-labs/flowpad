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
            name="Log settings",
            # Dev: watches the per-instance toplog.json; re-applies the filter to
            # the tag loggers and broadcasts the state to every UI.
            description="Applies changes to Flowpad's log settings right away. "
            "It only touches Flowpad's own settings.",
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
            name="Daily usage summary",
            # Dev: when enabled, fires the daily-analysis flow (analyze function →
            # publish) every day at 07:00 local; no direct action, the flow routes it.
            description="Off unless you turn it on: a short daily summary of how you used Flowpad, "
            "on your Home page. It stays on this computer.",
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
            name="Background upkeep",
            # Dev: fires every minute; tasks register via @register_heartbeat_task and
            # the dispatch callback fans out and isolates per-task failures.
            description="Keeps Flowpad up to date in the background, using only the sources "
            "and folders you set up.",
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
    # A seed is Flowpad's own: without this the row took its scope from the path
    # it landed under, which reads as "user" and lists every seed as the person's.
    spec = {"scope": "system", **spec}
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


LLM_SETUP_WIZARD = "llm-setup"


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
    # The wizard's own Start button (`POST /wizard/<id>/start`) is a person acting and is not gated.
    if os.environ.get(SKIP_FIRST_RUN_SETUP_ENV, "").lower() == "true":
        _log.info("llm setup trigger %r: skipped (%s=true)", trigger.uname, SKIP_FIRST_RUN_SETUP_ENV)
        return

    wizard = await _wizard_for(trigger)
    if wizard is None:
        _log.warning("llm setup trigger %r names no wizard it can resolve; nothing to run", trigger.uname)
        return

    from flow_sdk.core.compute.llm_source import person_is_watching  # noqa: PLC0415
    from flow_sdk.core.wizard.start import navigate_to_wizard, start_wizard  # noqa: PLC0415

    # A popup wizard, and a person looking: put its page in front of them — steps blank, its
    # explanation readable — and stop. Racing an install question onto the screen the instant the
    # popup opens leaves no time to read what any of it is for; they press its own Start
    # (`POST /wizard/<id>/start`, the same `start_wizard`). With nobody watching there is no Start to
    # press, so it starts itself.
    #
    # Not on a box the hub launched (a sandbox, an agent's machine): its template already carries
    # every tool this wizard asks about, so there is nothing to read first and nothing to install —
    # the popup would only cover what the person opened the box for. There it runs itself.
    from flow_sdk.instance_settings.runtime import get_assigned_runtime  # noqa: PLC0415

    if wizard.popup and person_is_watching() and get_assigned_runtime() is None:
        await navigate_to_wizard(wizard)
        return

    _source, result = await start_wizard(wizard, unattended=True)
    if result.busy:
        # Replaced by a newer run (or held by one started from the wizard page):
        # that run reports for itself, so this one has nothing to tell the person.
        _log.info("llm setup trigger %r: %s", trigger.uname, result.detail)
        return
    if result.exit_code is ExitCode.REFUSED:
        _log.warning("llm setup trigger %r: %s", trigger.uname, result.detail)
        return
    _log.info("llm setup trigger %r: %s — %s", trigger.uname, "ok" if result.ok else "not done", result.detail)


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


#: Seeded rows have no asset folder of their own; the sweep below never reads them.
SERVICE_TRIGGER_UNAME_PREFIX = "builtin_"


def stale_trigger_reason(row: Trigger) -> Optional[str]:
    """Why this row should go, or None to keep it. Pure — the sweep's whole decision.

    Two kinds of stale, decided by different evidence:

    * A **foreign copy** (a shipped trigger under another install — see
      ``trigger_arming.is_foreign_copy``) whose file is gone. Location is the
      evidence, so a vanished parent does not keep it: that install was removed.
    * Any other asset-backed row whose file is gone while its parent folder is
      still there (``source_unreachable`` False). A missing parent means "can't
      tell" — an unmounted volume — and the row stays.

    Seeds (``builtin_*``) and hook rules (``discover`` owns those) are never stale here.
    A foreign copy whose file still exists stays too: it is never armed, and
    deleting it would only churn — the next walk of that folder re-adds it.
    """
    from flow_sdk.builtin.trigger_arming import is_foreign_copy  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import source_unreachable  # noqa: PLC0415

    if str(row.uname or "").startswith(SERVICE_TRIGGER_UNAME_PREFIX):
        return None
    if str(row.trigger_type) == TriggerType.HOOK.value:
        return None
    ref = str(row.asset_ref or "")
    if not ref or os.path.exists(ref):
        return None
    if is_foreign_copy(ref):
        return "foreign install copy, file gone"
    if not source_unreachable(ref):
        return "asset folder deleted"
    return None


async def reap_stale_trigger_rows() -> int:
    """Disarm and delete trigger ROWS whose asset is gone. Never touches files.

    Runs at boot beside ``reconcile_wizard_triggers`` (before ``app.ready``), so
    a wizard whose folder is gone cannot fire once more on the way out. Returns
    how many rows went.
    """
    from flow_sdk.builtin.trigger_arming import disarm_trigger  # noqa: PLC0415

    try:
        rows = await Trigger.every()
    except Exception:
        _log.exception("Could not read triggers for the stale sweep")
        return 0
    reaped = 0
    for row in rows:
        reason = stale_trigger_reason(row)
        if reason is None:
            continue
        await disarm_trigger(str(row.id))
        try:
            await row.delete()
            reaped += 1
            _log.info("reaped stale trigger %r (%s): %s", row.name, reason, row.asset_ref)
        except Exception:
            _log.exception("Could not reap stale trigger %r", row.name)
    return reaped
