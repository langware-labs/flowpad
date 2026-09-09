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
from typing import Any, Optional

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.instance_settings import get_instance_settings

_log = logging.getLogger(__name__)


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
            ToplogStateMessage(enabled=st["enabled"], filter=st["filter"]).model_dump_json()
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
            actions=[TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_toplog_filter_apply",
            )],
        ),
        dict(
            uname="builtin_daily_usage_analysis",
            name="Last day usage analysis",
            description="Every day at 7am (local): fires the daily-analysis "
                        "flow — analyze (function) → publish — which posts a usage "
                        "report to the Home Feed. Manually runnable like any trigger.",
            trigger_type=TriggerType.SCHEDULE,
            sched_trigger_type="cron",
            expr="0 7 * * *",
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
            actions=[TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_heartbeat_dispatch",
            )],
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

    # Seed the watched toplog.json so awatch attaches cleanly on boot. The master
    # switch is seeded from the instance setting (on in dev, off in prod); after
    # this the file is authority. The seed write happens BEFORE fsop_watcher.start(),
    # so no trigger fires for it — seed_file also re-derives the in-memory state so
    # the dev/prod default takes effect immediately on first boot.
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
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.functions.wizard import read_wizard  # noqa: PLC0415

    # WHICH wizard, by TypeId, off the ACTION that says so. `trigger.path` was
    # the old channel and a poor one: a generic field a HOOK trigger uses for
    # its record.json, marked Sharing.PRIVATE, so a shared trigger lost its
    # subject entirely and nothing could validate the subject was a wizard.
    # `path` is still read as a fallback so a row seeded before this keeps
    # running.
    wizard = await _wizard_for(trigger)
    asset_ref = (wizard.asset_ref if wizard else (trigger.path or "")).strip()
    if wizard is None and not asset_ref:
        _log.warning("wizard trigger %r names no wizard; nothing to run", trigger.uname)
        return

    spec = wizard.spec() if wizard is not None else read_wizard(Path(asset_ref))
    if spec is None:
        _log.warning("wizard trigger %r: no readable wizard at %s", trigger.uname, asset_ref)
        return

    trusted = wizard.is_system() if wizard is not None else False
    if not trusted:
        # No client to ask, and a trigger fire is by definition unattended.
        # Refusing is the only safe answer; the user can still run it from the
        # UI, which is where the approval prompt lives.
        _log.warning(
            "wizard trigger %r: %s is not shipped with Flowpad, so it will not run "
            "unattended. Run it from the app to approve it.",
            trigger.uname, asset_ref,
        )
        return

    from flow_sdk.core.wizard.execute import execute_wizard  # noqa: PLC0415

    try:
        result = await execute_wizard(
            str(wizard.id) if wizard else "unknown", spec, asset_ref,
            trusted=True,
            # INSTANCE scope (None), deliberately — not the wizard entity.
            #
            # `_send` routes by subject entity: one naming an entity reaches only
            # that entity's WATCHERS, while an unscoped one belongs to the box and
            # is broadcast to every connection. A trigger-fired run is unattended
            # by definition — it fires at boot, before anyone has opened the wizard
            # and usually before a browser exists at all — so entity scope
            # addressed a complete, correct progress tree to an audience of zero.
            # Verified on a clean container: the tree was right at its scoped
            # address and the footer chip's unscoped replay returned zero rows.
            #
            # Setting up the machine at startup IS box-level work, the same shape
            # as an index walk, so it belongs in the same chip. The UI path keeps
            # entity scope, because there the viewer IS watching. Which of the two
            # is used changes only WHO SEES the run — never who may start one:
            # `execute_wizard` holds the wizard's own slot for that.
            subject_entity=None,
        )
    except RuntimeError as exc:
        _log.info("wizard trigger %r: %s", trigger.uname, exc)
        return
    _log.info("wizard trigger %r: %s — %s", trigger.uname,
              "ok" if result.ok else "failed", result.message)


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
        rows = await Trigger.get_all(QueryFilter(match=ExpressionNode(
            op=QueryOp.LIKE, operands=["uname", f"{WIZARD_TRIGGER_UNAME_PREFIX}%"],
        )))
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
