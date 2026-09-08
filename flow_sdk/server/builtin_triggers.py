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
    """Mirror the post-save registration step that the public create_action
    route runs (`flow_sdk/builtin/trigger.py:432`) — needed because the entity
    save alone doesn't tell APScheduler / the FSOp watcher about the trigger."""
    try:
        if entity.trigger_type == TriggerType.SCHEDULE:
            await entity._register_schedule_job()
        elif entity.trigger_type == TriggerType.FSOP:
            # FSOp triggers are picked up by the watcher's startup walk
            # (set_service_triggers runs BEFORE fsop_watcher.start), so we
            # don't need to spawn the awatch task here — the boot order
            # covers it. The factory-reset path has no such walk following it,
            # so it re-arms explicitly via `fsop_watcher.start(catch_up=False)`.
            from flow_sdk.server.fsop_watcher import fsop_watcher

            if len(fsop_watcher) and entity.id not in fsop_watcher._tasks:
                await fsop_watcher.on_trigger_saved(entity)
        elif entity.trigger_type == TriggerType.TAG:
            # Unlike FSOp, boot order does NOT cover this. The TAG boot sweep
            # (`start_tag_triggers`, app.py:305) runs once, and any trigger
            # seeded afterwards — every wizard trigger, because the system
            # content index is detached and lands later — would sit unarmed
            # until the next restart. The bus has no durability, so an unarmed
            # subscriber at emit time means the event is simply gone, with
            # nothing anywhere saying why the wizard never ran.
            #
            # `register_tag_trigger` unregisters-then-registers, so this is
            # correct on create and on update alike.
            from flow_sdk.builtin.tag_triggers import register_tag_trigger

            register_tag_trigger(entity)
    except Exception:
        _log.exception("Post-save registration failed for trigger %r", entity.uname)


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

    asset_ref = (trigger.path or "").strip()
    if not asset_ref:
        _log.warning("wizard trigger %r carries no path; nothing to run", trigger.uname)
        return

    wizard = await Wizard.get_one({"asset_ref": asset_ref})
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


def _wizard_slug(asset_ref: str) -> str:
    """A uname-safe slug from a wizard's folder name."""
    from pathlib import Path  # noqa: PLC0415

    raw = Path(asset_ref).name or "wizard"
    return "".join(ch if ch.isalnum() else "_" for ch in raw.lower()).strip("_") or "wizard"


async def wizard_trigger_specs() -> list[dict[str, Any]]:
    """One TAG trigger spec per subscription declared by an indexed Wizard.

    A malformed pattern is dropped with a warning rather than raising: the
    document may have come from a repo someone cloned, and one bad wizard must
    not stop the others from arming.
    """
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415
    from flow_sdk.tags.bus import validate_bus_pattern  # noqa: PLC0415

    specs: list[dict[str, Any]] = []
    try:
        wizards = await Wizard.get_all({})
    except Exception:
        _log.exception("wizard triggers: could not list wizards")
        return specs

    for wizard in wizards:
        spec = wizard.spec()
        if spec is None or not spec.enabled or not wizard.enabled:
            continue
        slug = _wizard_slug(wizard.asset_ref)
        for index, declared in enumerate(spec.triggers):
            problem = validate_bus_pattern(declared.on)
            if problem:
                _log.warning("wizard %r trigger %d: %s", wizard.name, index, problem)
                continue
            specs.append(dict(
                uname=f"{WIZARD_TRIGGER_UNAME_PREFIX}{slug}_{index}",
                name=f"{spec.name or wizard.name or slug} ({declared.on})",
                description=(
                    f"Declared by the {spec.name or slug} wizard. Runs it when "
                    f"{declared.on} fires"
                    + (", once ever." if declared.fire_once else ".")
                ),
                trigger_type=TriggerType.TAG,
                tag_pattern=declared.on,
                tag_target=declared.target or None,
                fire_once=declared.fire_once,
                path=wizard.asset_ref,
                actions=[TriggerAction(
                    action_type=ActionType.CALLBACK,
                    callback_name="builtin_run_wizard",
                )],
            ))
    return specs


async def reconcile_wizard_triggers() -> None:
    """Converge the derived wizard triggers, and prune the orphans.

    Upsert reuses `_upsert_one`, so `counter` / `last_triggered` survive — which
    matters more here than anywhere else: clobbering the counter of a
    `fire_once` trigger would re-arm it and re-run the wizard.

    The prune is a first in this tree — nothing else deletes a derived entity
    when its asset stops declaring it. It is scoped to the `wizard_` uname
    prefix, and only removes rows no live wizard still declares.
    """
    try:
        specs = await wizard_trigger_specs()
    except Exception:
        _log.exception("wizard triggers: spec derivation failed")
        return

    # ONE query serves both halves. It used to be a `get_by_uname` per spec
    # followed by an unscoped `Trigger.get_all({})` — an N+1 whose final scan
    # re-fetched every row the N lookups had just read one at a time, and an
    # unscoped read of the whole table besides (which this repo bans outright).
    # The prefix that identifies these rows is the same one the prune needs, so
    # a single `$LIKE` answers "what exists" for the upsert and "what is orphaned"
    # for the prune.
    try:
        existing_rows = await Trigger.get_all(QueryFilter(match=ExpressionNode(
            op=QueryOp.LIKE, operands=["uname", f"{WIZARD_TRIGGER_UNAME_PREFIX}%"],
        )))
    except Exception:
        _log.exception("wizard triggers: could not read the existing rows")
        return
    by_uname = {(getattr(row, "uname", "") or ""): row for row in existing_rows}

    for spec in specs:
        await _upsert_one(spec, existing=by_uname.get(spec["uname"]))

    wanted = {spec["uname"] for spec in specs}
    try:
        from flow_sdk.builtin.tag_triggers import unregister_tag_trigger  # noqa: PLC0415

        for uname, row in by_uname.items():
            if uname in wanted:
                continue
            _log.info("wizard triggers: pruning orphan %r", uname)
            unregister_tag_trigger(row.id)
            await row.delete()
    except Exception:
        _log.exception("wizard triggers: orphan prune failed")
