import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar, Optional, Union

from pydantic import model_validator
from starlette.requests import Request

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.api.messages import HttpMethod
from flow_sdk.builtin.hook_models import (
    ErrorMessage,
    ExecutedAction,
    HookEventData,
    RelationshipSubAction,
    SuccessMessage,
    get_action_handler,
)
from flow_sdk.core import action as core_action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.flowpad_types.enums.entity_enums import BuiltInRelationshipTypes, RelationshipDirection
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.ingest.models import STORM_CAP_PER_MINUTE
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType

logger = logging.getLogger(__name__)





def _allowlisted_roots() -> list[Path]:
    """Roots under which FSOp triggers are allowed to watch: $HOME + the OS
    tempdir (resolved so macOS /var/folders symlink expansion matches input)."""
    import tempfile as _tempfile

    roots: list[Path] = [Path.home().resolve(), Path(_tempfile.gettempdir()).resolve()]
    # Dedup while preserving order.
    seen: set[Path] = set()
    return [r for r in roots if not (r in seen or seen.add(r))]


def _validate_watch_path(path: Optional[str]) -> None:
    """Reject FSOp watch_paths outside the allowlist. None/empty is allowed.

    Raises ValueError if `path` resolves to a location outside any allowlisted
    root. Prevents "/etc/hosts"-style accidents at trigger save time.
    """
    if not path:
        return
    resolved = Path(path).resolve()
    roots = _allowlisted_roots()
    for root in roots:
        try:
            resolved.relative_to(root)
            return  # under an allowed root
        except ValueError:
            continue
    raise ValueError(
        f"watch_path {path!r} not in allowlist; allowed roots: {[str(r) for r in roots]}"
    )


# ── APScheduler helpers (shared pattern with cron_event.py) ──────────────────

def _get_scheduler():
    """Get running scheduler, or None if unavailable."""
    try:
        from flow_sdk.server.scheduler import get_scheduler
        return get_scheduler()
    except Exception:
        return None


def _parse_trigger(sched_trigger_type: str, expr: str, tz: Optional[str] = None):
    """Parse sched_trigger_type + expr into an APScheduler trigger object.

    ``tz`` is an IANA zone; None reads the clock in the machine's local zone.
    A ``date`` expr that carries its own offset keeps it — ``tz`` only applies
    to a naive wall-clock time.
    """
    tz = tz or None
    if sched_trigger_type == "interval":
        from apscheduler.triggers.interval import IntervalTrigger
        seconds = _parse_interval_expr(expr)
        return IntervalTrigger(seconds=seconds, timezone=tz)
    elif sched_trigger_type == "date":
        from apscheduler.triggers.date import DateTrigger
        run_date = datetime.fromisoformat(expr)
        return DateTrigger(run_date=run_date, timezone=tz)
    else:
        from apscheduler.triggers.cron import CronTrigger
        fields = expr.split()
        if len(fields) == 5:
            # APScheduler 3.x passes the day-of-week field through with ITS
            # numbering (0 = Monday), so the crontab "1-5" every builder writes
            # fired Tuesday to Saturday. Spell the days out by name instead.
            fields[4] = crontab_weekdays_as_names(fields[4])
            expr = " ".join(fields)
        return CronTrigger.from_crontab(expr, timezone=tz)


_CRONTAB_DAY_NAMES = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")


def crontab_weekdays_as_names(field: str) -> str:
    """A crontab day-of-week field (0 or 7 = Sunday) as an explicit list of day names.

    Expanded, never translated range for range: a crontab range that starts on
    Sunday ("0-3") would become "sun-wed", which APScheduler (Sunday last)
    rejects as backwards. ``*`` stays ``*``; a field that does not parse is
    returned unchanged so APScheduler reports the error."""
    if field == "*":
        return field
    days: set[int] = set()
    try:
        for part in field.lower().split(","):
            step = 1
            if "/" in part:
                part, step_text = part.split("/", 1)
                step = int(step_text)
            if part in ("*", ""):
                lo, hi = 0, 6
            elif "-" in part:
                a, b = part.split("-", 1)
                lo, hi = _crontab_day(a), _crontab_day(b)
                if hi == 0:
                    hi = 7  # "5-7"/"5-0": Friday through Sunday
            else:
                lo = hi = _crontab_day(part)
                if step != 1:
                    hi = 6
            days.update(d % 7 for d in range(lo, hi + 1, step))
    except ValueError:
        return field
    return ",".join(_CRONTAB_DAY_NAMES[d] for d in sorted(days))


def _crontab_day(token: str) -> int:
    if token in _CRONTAB_DAY_NAMES:
        return _CRONTAB_DAY_NAMES.index(token)
    day = int(token)
    if not 0 <= day <= 7:
        raise ValueError(token)
    return day


def _parse_interval_expr(expr: str) -> int:
    """Convert '30s', '5m', '2h', '1d' to seconds."""
    expr = expr.strip().lower()
    if expr.endswith("s"):
        return int(expr[:-1])
    elif expr.endswith("m"):
        return int(expr[:-1]) * 60
    elif expr.endswith("h"):
        return int(expr[:-1]) * 3600
    elif expr.endswith("d"):
        return int(expr[:-1]) * 86400
    return int(expr)


def _schedule_problem(expr: str, sched_trigger_type: Optional[str], tz: Optional[str]) -> Optional[str]:
    """Why a schedule can't be armed, in words — or None. Checked on save, so a bad
    expression is a 422 rather than a row that silently never runs."""
    try:
        _parse_trigger(sched_trigger_type or "cron", expr, tz)
    except Exception as exc:  # noqa: BLE001 — APScheduler raises ValueError, zoneinfo KeyError
        return f"That schedule can't be read: {exc}"
    return None


def _scheduled_next_run(trigger_id: str) -> Optional[datetime]:
    """The scheduler's next run for this trigger's job, or None when it has none."""
    try:
        scheduler = _get_scheduler()
        job = scheduler.get_job(trigger_id) if scheduler else None
        return getattr(job, "next_run_time", None) if job is not None else None
    except Exception:  # noqa: BLE001 — display state only; never fail a fire over it
        logger.debug("next_run lookup failed for %s", trigger_id, exc_info=True)
        return None


async def activate_flows_for_trigger(trigger_id: str, trigger_name: str,
                                     envelope=None, trigger: "Trigger" = None) -> Optional[str]:
    """Flow activation on any trigger fire — THE shared step for every trigger
    kind (schedule / fsop / tag): enters a run in each flow whose trigger
    node references this Trigger entity. ``envelope`` (tag fires only)
    preserves the triggering FlowEvent's id/actor onto the run entry.

    Returns the error message when activation failed, else None — so a fire's
    log row can say what broke instead of only the bus knowing."""
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_failed

    try:
        from flow_sdk.graph_workflow_manager import get_graph_workflow_manager

        await get_graph_workflow_manager().on_trigger_fired(trigger_id, envelope=envelope)
        return None
    except Exception as exc:
        logger.exception("Trigger %s: flow activation failed", trigger_name)
        # `trigger.failed` is emitted HERE, not at a call site: this except is
        # where the failure is actually caught, and it is the one outcome the
        # Automations runs exist to show that has no natural home above.
        emit_trigger_failed(
            trigger_id, str(trigger.trigger_type) if trigger else "", trigger_name,
            stage="flow_activation", error=str(exc),
            project_id=trigger.project_id if trigger else None,
        )
        return f"Workflow activation failed: {exc}"


class DispatchOutcome:
    """What one dispatch did: each handler's answer, the errors, how long it took.

    In-process only — the log row is what travels. ``process_id`` is the run a
    RUN_AGENT action started, the handle a run detail links to."""

    __slots__ = ("results", "errors", "duration_ms")

    def __init__(self, results: list[Any], errors: list[str], duration_ms: int) -> None:
        self.results = results
        self.errors = errors
        self.duration_ms = duration_ms

    @property
    def process_id(self) -> Optional[str]:
        from flow_sdk.builtin.agent_run import process_id_of  # noqa: PLC0415

        return next((pid for pid in map(process_id_of, self.results) if pid), None)

    @property
    def error(self) -> Optional[str]:
        return "; ".join(self.errors) or None


async def run_trigger_actions(trigger: "Trigger", changes: list) -> DispatchOutcome:
    """Action dispatch on any trigger fire — THE shared loop for every trigger
    kind. Per-action try/except so one bad handler can't skip the rest.
    ``changes`` is empty for schedule/tag fires; FSOp passes its batch.

    A failing action is reported three ways: logged, emitted as
    ``trigger.failed``, and returned in ``errors`` for the fire's log row."""
    import time  # noqa: PLC0415

    from flow_sdk.builtin.trigger_on_tag import emit_trigger_failed

    started = time.monotonic()
    results: list[Any] = []
    errors: list[str] = []
    for action in trigger.actions:
        try:
            handler = get_action_handler(action.action_type)
            if handler is None:
                logger.warning("Trigger %s: no handler for action_type=%s",
                               trigger.name, action.action_type)
                errors.append(f"No handler for action {action.action_type}")
                continue
            results.append(await handler.execute(trigger, action=action, changes=changes))
        except Exception as exc:
            logger.exception("Trigger %s: action %s raised during dispatch",
                             trigger.name, action.action_type)
            errors.append(f"{action.action_type}: {exc}")
            emit_trigger_failed(
                trigger.id or "", str(trigger.trigger_type), trigger.name or trigger.id or "",
                stage="action", error=str(exc), action_type=str(action.action_type),
                project_id=trigger.project_id,
            )
    return DispatchOutcome(results, errors, int((time.monotonic() - started) * 1000))


async def _fire_schedule_job(trigger_id: str) -> None:
    """Callback executed by APScheduler when a schedule trigger fires.

    The gates and the bookkeeping live here; the work is ``run_schedule_fire``,
    which *Run once now* shares without the gates.
    """
    try:
        from flow_sdk.builtin.trigger_on_tag import emit_trigger_fired

        entity = await Trigger.get_by_id(trigger_id)
        if not (entity and entity.enabled):
            return
        from flow_sdk.builtin.trigger_arming import disarm_trigger, runs_here  # noqa: PLC0415

        if not await runs_here(entity):
            # A job left in the persistent jobstore for a schedule that now
            # belongs to another place: drop it rather than run it here.
            await disarm_trigger(trigger_id)
            return
        entity.counter += 1
        entity.last_run = datetime.now(timezone.utc)
        # APScheduler has already advanced the job when it runs it: a cron's next
        # time is known, a fired one-shot's job is gone (None). Without this the
        # row kept the next_run it was armed with, stale after the first fire.
        entity.next_run = _scheduled_next_run(trigger_id)
        await entity.update()

        # Emit BEFORE the work — `fired` means the schedule came due and
        # dispatch has begun, not that it finished.
        event_id = emit_trigger_fired(
            trigger_id, str(entity.trigger_type), entity.name or trigger_id,
            counter=entity.counter,
            action_types=[str(a.action_type) for a in entity.actions],
            detail={"expr": entity.expr,
                    "sched_trigger_type": entity.sched_trigger_type or "cron"},
            project_id=entity.project_id,
        )
        await run_schedule_fire(entity, event_id, is_test=False)
    except Exception as e:
        logger.error(f"Schedule trigger fire error for {trigger_id}: {e}")


async def run_schedule_fire(entity: "Trigger", event_id: Optional[str], *, is_test: bool) -> None:
    """The work of one schedule fire, and its log row.

    Dispatches via the action handler registry (same path as FSOp's ``_fire``
    in ``server/fsop_watcher.py:_fire``) so any ``actions`` declared on the
    Trigger entity run — CALLBACK and RUN_SCRIPT included.

    Legacy ``instruction`` path is preserved as a back-compat fallback for
    schedule triggers that pre-date the actions list (it spawns an
    AgenticProcess with the prompt).
    """
    from flow_sdk.automations.fingerprint import spec_hash  # noqa: PLC0415
    from flow_sdk.fs_store.operations.trigger_log import append_entry as _append_trigger_log_entry

    trigger_id = entity.id or ""
    # Shared fire steps (same helpers as fsop/tag): flow activation +
    # action dispatch. ``changes`` is empty for schedule fires — RUN_SCRIPT
    # then reports CHANGES_COUNT=0 / FIRST_*="" to the script.
    flow_error = await activate_flows_for_trigger(trigger_id, entity.name or trigger_id, trigger=entity)
    outcome = await run_trigger_actions(entity, changes=[])
    errors = [e for e in (flow_error, outcome.error) if e]

    # A RUN_AGENT action answers with the run it started — its ``executor``
    # is the log entry's handle on the run, same field the legacy spawn below
    # fills.
    process_id: Optional[str] = outcome.process_id

    # Legacy back-compat: schedule triggers with ``instruction`` set spawn
    # an AgenticProcess. Pre-dates the actions list; kept so existing
    # user-created schedules keep working.
    if entity.instruction:
        try:
            from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
            proc = AgenticProcess(
                instruction_content=entity.instruction,
                workdir=entity.workdir,
                target_typeid_str=str(entity.typeid),
                project_id=entity.project_id,
                visible=False,
                name=f"Trigger: {entity.name}" if entity.name else "Trigger",
            )
            await proc.save()
            await proc.start_pty(instruction=entity.instruction, visible=False)
            process_id = proc.id
        except Exception as e:
            logger.error(f"Schedule trigger {entity.name}: failed to spawn process: {e}")
            errors.append(f"Could not start the agent: {e}")

    _append_trigger_log_entry(entity.name, {
        "hook_event": "schedule_fire",
        "trigger": True,
        "reason": f"Scheduled ({entity.sched_trigger_type or 'cron'}): {entity.expr}",
        "is_test": is_test,
        "rule_name": entity.name,
        "trigger_id": trigger_id,
        "trigger_type": str(entity.trigger_type),
        "event_id": event_id,
        "actor": "system",
        "actions": [{"action_type": str(a.action_type)} for a in entity.actions],
        "agentic_process_id": process_id,
        "error": "; ".join(errors) or None,
        "duration_ms": outcome.duration_ms,
        "spec_hash": spec_hash(entity),
    })
    logger.debug(f"Schedule trigger {entity.name} fired (counter={entity.counter}, process_id={process_id})")


class Trigger(Entity):
    """Entity representing a trigger that matches hook data and executes actions."""

    type: str = APIField(default=BuiltinEntityType.TRIGGER.value)
    name: str = APIField()
    description: Optional[str] = APIField(None)

    # Trigger type: 'hook' (filesystem-based), 'schedule' (APScheduler), or 'fsop' (file/folder watch).
    trigger_type: TriggerType = APIField(default=TriggerType.HOOK)

    # Hook trigger fields
    mask: dict[str, Any] = APIField(default_factory=dict, description="JSON mask for matching hook data")
    # Legacy singular action. Kept for backwards-compat with existing dispatch code
    # (trigger.py:230). New code reads `actions` instead. Always synced with
    # actions[0] when actions is non-empty (see _sync_action_and_actions).
    action: TriggerAction = APIField(default_factory=lambda: TriggerAction(action_type=ActionType.NOP))
    # Plural actions — the new canonical list. Each fired event dispatches every
    # action in order via its action handler.
    actions: list[TriggerAction] = APIField(default_factory=list, description="List of actions to dispatch on fire")
    enabled: bool = APIField(default=True)
    #: The trigger's folder on disk, when it came from one. Empty for a row the
    #: rules API or the service seed minted — those stay rowful and fileless.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    def is_file_backed(self) -> bool:
        """Only triggers adopted from a document have a filesystem asset."""
        return bool(self.asset_ref)

    @property
    def is_builtin(self) -> bool:
        """Flowpad's own: seeded (``builtin_*``), system-scoped, or shipped in the
        running install. Read-only to people — the screen lists it under "Built
        into Flowpad", and update/delete refuse it."""
        if str(self.scope or "") == "system" or str(getattr(self, "uname", "") or "").startswith("builtin_"):
            return True
        if self.asset_ref:
            from flow_sdk.config import is_running_install_path  # noqa: PLC0415

            return is_running_install_path(self.asset_ref)
        return False

    #: RUNTIME STATE. `Persist.TRUE` puts these in the SHADOW record (under flow
    #: home, never the asset folder, never git) rather than leaving them to the
    #: DB alone: a spent `fire_once` counter has to survive a full index rebuild,
    #: or rebuilding the index re-arms every one-shot trigger on the machine.
    #: They are not spec header fields, so they can never reach `trigger.json`.
    last_triggered: Optional[datetime] = APIField(None, persist=Persist.TRUE, description="Timestamp of last trigger match")
    counter: int = APIField(default=0, persist=Persist.TRUE, description="Counter incremented when trigger action is executed")
    hook_events: list[str] = APIField(default_factory=list)
    log_mode: str = APIField(default="activations")
    path: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # Schedule trigger fields
    expr: Optional[str] = APIField(None, description="Cron/interval/date expression (schedule triggers only)")
    sched_trigger_type: Optional[str] = APIField(None, description="APScheduler type: cron, interval, date")
    timezone: Optional[str] = APIField(None, description="IANA zone the schedule is read in (schedule triggers only). Empty = machine local.")
    runs_on: Optional[str] = APIField(None, description="Deployment id of the place this schedule runs on; only that place's machine arms it. Empty = every machine (legacy).")
    next_run: Optional[datetime] = APIField(None, persist=Persist.TRUE, description="Next scheduled run (schedule triggers only)")
    last_run: Optional[datetime] = APIField(None, persist=Persist.TRUE, description="Last scheduled run (schedule triggers only)")
    instruction: Optional[str] = APIField(None, description="Prompt sent to the agentic process when this trigger fires (schedule triggers only)")
    workdir: Optional[str] = APIField(None, description="Working directory for the spawned agentic process (schedule triggers only)")

    # FSOp trigger fields
    watch_path: Optional[str] = APIField(None, description="Absolute file or folder path watched (FSOp triggers only)")
    recursive: bool = APIField(default=False, description="For folder watches: descend into subtree (FSOp only)")
    watch_glob: Optional[str] = APIField(None, description="For folder watches: glob filter, e.g. '*.json' (FSOp only)")
    last_seen_mtime: Optional[float] = APIField(None, persist=Persist.TRUE, description="File mtime at last fire (FSOp file triggers — used for restart catch-up)")
    last_seen_size: Optional[int] = APIField(None, persist=Persist.TRUE, description="File size at last fire (FSOp file triggers — used for restart catch-up)")
    step_ms: int = APIField(50, description="awatch poll interval in ms (FSOp only). Lower = snappier; higher = less CPU. Default matches watchfiles' default.")
    debounce_ms: int = APIField(1600, description="awatch debounce in ms — max wait before yielding a coalesced batch (FSOp only). Raise on noisy paths (npm install bursts).")
    respect_gitignore: bool = APIField(default=False, description="If True, walk for .gitignore files under watch_path and drop matching events (FSOp only).")
    ignore_patterns: list[str] = APIField(default_factory=list, description="Extra gitignore-style ignore patterns (FSOp only). Applied in addition to .gitignore.")

    # TAG trigger fields — a unified-bus subscription (tag_ prefix avoids
    # colliding with the entity's own scope field).
    tag_pattern: Optional[str] = APIField(None, description="Bus tag pattern, segment-glob (TAG triggers only), e.g. 'entity.created' or 'graph_workflow.*'. Bare '*' is rejected.")
    tag_target: Optional[str] = APIField(None, description="Optional target filter in colon form: 'usage_report:*' or an exact 'type:id' (TAG only)")
    tag_scope: list[str] = APIField(default_factory=list, description="Optional scope filter — colon-form targets the event's ctx.scope must intersect (TAG only)")
    max_fires_per_minute: int = APIField(default=STORM_CAP_PER_MINUTE, description="Storm guard for TAG triggers: fires beyond this per-minute cap are dropped (one storm_suppressed log entry per window)")
    confirm: Optional[dict[str, Any]] = APIField(None, description="Optional confirm-against-store gate (TAG only): {type, filter} — the entity query must match or the fire is skipped (event != proof)")
    # ONCE-per-machine, expressed where the durable counter already lives.
    #
    # The alternative was a bespoke "has this fired here" file beside the
    # emitter, which would gate ONE event for ONE feature. Putting it here
    # instead means the emitter needs no gate at all — an ordinary lifecycle
    # event can fire on every boot, and any trigger that wants to answer it
    # only the first time says so itself. `counter` is the record; an
    # in-memory subscription could not hold one, which is why a wizard's
    # declared trigger is a row.
    fire_once: bool = APIField(default=False, description="Fire at most once ever (TAG only). The trigger's own counter is the durable record; a spent trigger is suppressed, not deleted, so the Triggers screen still shows that it ran.")

    _api_visible: ClassVar[bool] = True
    _unique: ClassVar[list[str]] = []

    @model_validator(mode="before")
    @classmethod
    def _sync_action_and_actions(cls, data: Any) -> Any:
        """Bidirectional sync between legacy `action` and new `actions`.

        - If `actions` is given and non-empty, it wins. `action` is back-synced to actions[0]
          so legacy dispatch code at trigger.py:230 keeps reading the same thing.
        - If only `action` is given (legacy record JSON), populate `actions = [action]`.
        - If neither is given, both stay at their defaults: action=NOP, actions=[].
        """
        if not isinstance(data, dict):
            return data
        actions_in = data.get("actions")
        action_in = data.get("action")

        def _coerce(item: Any) -> TriggerAction:
            if isinstance(item, TriggerAction):
                return item
            if isinstance(item, dict):
                return TriggerAction(**item)
            return item

        if actions_in:
            coerced = [_coerce(a) for a in actions_in]
            data["actions"] = coerced
            data["action"] = coerced[0]  # back-sync for legacy access
        elif isinstance(actions_in, list):
            # `actions` explicitly EMPTY (a cleared trigger, e.g. the daily-usage
            # cutover to flow routing): it wins — reset the legacy `action` so a
            # stale stored callback can't resurrect `actions` on the next load.
            data["action"] = TriggerAction(action_type=ActionType.NOP)
        elif action_in is not None:
            coerced = _coerce(action_in)
            data["action"] = coerced
            data["actions"] = [coerced]
        return data

    # ── Data folder (for embedded RUN_SCRIPT bodies) ──────────────────────────

    @property
    def data_dir(self) -> Path:
        """Per-trigger data folder. Holds files referenced by `script_filename`
        and any other blob attachments associated with this trigger record.

        Path: ``<records_data_root>/trigger/trigger-@<id>/``. Created on first access.
        Matches the fs-record convention at `flow_sdk/fs_store/record.py:105`.
        """
        # Import lazily so the function works in tests that monkeypatch the root.
        from flow_sdk.fs_store.record_paths import data_dir_for

        path = data_dir_for("trigger", self.id or "unsaved")
        path.mkdir(parents=True, exist_ok=True)
        return path

    def write_file(self, filename: str, content: str) -> None:
        """Write a text file into this trigger's data folder."""
        (self.data_dir / filename).write_text(content)

    def read_file(self, filename: str) -> Optional[str]:
        """Read a text file from this trigger's data folder. Returns None if missing."""
        path = self.data_dir / filename
        if not path.exists():
            return None
        return path.read_text()

    # ── Discovery ─────────────────────────────────────────────────────────────

    @classmethod
    async def every(cls) -> list["Trigger"]:
        """Every rule on this machine. The automations screen and the boot sweep of stale rows read
        them all, and the set is small; this is the one walk over it."""
        return await cls.get_all({})

    @classmethod
    async def list_by_type(cls, trigger_type: "TriggerType") -> list["Trigger"]:
        """List all Trigger entities of the given type."""
        return await cls.get_all({"trigger_type": trigger_type.value})

    # ── Schedule job management ───────────────────────────────────────────────

    async def _register_schedule_job(self) -> None:
        """Register this trigger with APScheduler. Updates next_run on success.

        Uses a lock to serialize concurrent job registrations and prevent race
        conditions where multiple coroutines add the same job multiple times.
        """
        if not self.id or not self.expr:
            return
        if self._spent_one_shot():
            # Re-arming is idempotent for a cron — the job is replaced and its
            # next run recomputed. For a `date` job it is NOT: the run time is
            # still inside the misfire grace window right after it fires, so
            # re-adding it runs it AGAIN. Any re-index does that — the first GET
            # of a just-written schedule re-syncs its record, which re-arms.
            return
        try:
            from flow_sdk.server.scheduler import _job_registration_lock

            scheduler = _get_scheduler()
            if scheduler:
                async with _job_registration_lock:
                    trigger = _parse_trigger(self.sched_trigger_type or "cron", self.expr, self.timezone)
                    job = scheduler.add_job(
                        _fire_schedule_job,
                        trigger=trigger,
                        id=self.id,
                        name=self.name,
                        args=[self.id],
                        replace_existing=True,
                    )
                    if not self.enabled:
                        job.pause()
                    if job.next_run_time:
                        self.next_run = job.next_run_time
                        await self.update()
        except Exception as e:
            logger.warning(f"Failed to schedule trigger job {self.id}: {e}")

    def _spent_one_shot(self) -> bool:
        """A `date` schedule that has already fired at (or after) its run time."""
        if (self.sched_trigger_type or "cron") != "date" or not self.last_run or not self.expr:
            return False
        try:
            run_date = datetime.fromisoformat(self.expr)
        except ValueError:
            return False
        last_run = self.last_run
        if run_date.tzinfo is None or last_run.tzinfo is None:
            run_date, last_run = run_date.replace(tzinfo=None), last_run.replace(tzinfo=None)
        return last_run >= run_date

    # ── Hook trigger logic ────────────────────────────────────────────────────

    def match(self, hook_data: HookEventData) -> bool:
        """Check if the hook data matches this trigger's mask."""
        if not self.enabled:
            return False

        hook_dict = hook_data.model_dump(exclude_none=False)

        for key, expected_value in self.mask.items():
            if key not in hook_dict:
                return False
            if hook_dict[key] != expected_value:
                return False

        return True

    async def invoke(self, hook_data: HookEventData) -> ExecutedAction | None:
        """Invoke this trigger if it matches the hook data."""
        if not self.match(hook_data):
            return None
        # Flow activation for hook fires.
        if self.id:
            try:
                from flow_sdk.graph_workflow_manager import get_graph_workflow_manager

                await get_graph_workflow_manager().on_trigger_fired(self.id)
            except Exception:
                logger.exception("Hook trigger %s: flow activation failed", self.name)
        return await self.execute_action()

    async def execute_action(self) -> ExecutedAction:
        """Execute the trigger action, update last_triggered, save."""
        self.last_triggered = datetime.now(timezone.utc)

        handler = get_action_handler(self.action.action_type)
        if handler:
            await handler.execute(self)

        await self.update()

        return ExecutedAction(
            trigger_id=self.id,
            trigger_name=self.name,
            action_type=self.action.action_type,
            counter=self.counter,
        )

    async def get_agent_hooks(self) -> list[TypeId]:
        """Get all agent hooks connected to this trigger."""
        relationships = await self.get_incoming_relationships(
            relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.ConnectedTo)
        )
        return [rel.from_typeid for rel in relationships if rel.from_typeid]

    async def connect_to_agent_hook(self, agent_hook: Union[Entity, TypeId]) -> None:
        """Connect this trigger to an agent hook."""
        if isinstance(agent_hook, Entity):
            agent_hook = agent_hook.typeid

        await self.save_relationship(
            to_e=agent_hook,
            relationship_or_str=BuiltInRelationshipTypes.ConnectedTo,
            direction=RelationshipDirection.Incoming,
        )

    async def disconnect_from_agent_hook(self, agent_hook: Union[Entity, TypeId]) -> None:
        """Disconnect this trigger from an agent hook."""
        if isinstance(agent_hook, Entity):
            agent_hook = agent_hook.typeid

        await self.delete_relationship(to_e=agent_hook, relationship=BuiltInRelationshipTypes.ConnectedTo)

    # ── API Actions ───────────────────────────────────────────────────────────

    @core_action.post(action_name="create")
    async def create_action(cls, request: Request) -> ApiResponse:
        """
        POST /api/v1/graph/trigger — create a hook or schedule trigger.
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        if not body:
            return ApiFailResponse(message="Request body required", status_code=422)

        name = body.get("name", "")
        if not name:
            return ApiFailResponse(message="name is required", status_code=422)

        trigger_type = body.get("trigger_type", "hook")

        # Every field a person sets (the builder sends them; `check_spec` reads the
        # same list), so an automation created here is complete — not a schedule
        # whose actions, timezone or watch glob were silently dropped.
        from flow_sdk.automations.check import SPEC_FIELDS  # noqa: PLC0415

        kwargs: dict[str, Any] = {k: body[k] for k in SPEC_FIELDS if k in body}
        kwargs.update(name=name, trigger_type=trigger_type, enabled=body.get("enabled", True),
                      scope=body.get("scope", "user"))

        if trigger_type == "tag":
            from flow_sdk.builtin.tag_triggers import validate_tag_trigger
            problem = validate_tag_trigger(body.get("tag_pattern"))
            if problem:
                return ApiFailResponse(message=problem, status_code=422)
        if trigger_type == "schedule":
            kwargs.setdefault("expr", "* * * * *")
            kwargs.setdefault("sched_trigger_type", "cron")
            problem = _schedule_problem(kwargs["expr"], kwargs["sched_trigger_type"], kwargs.get("timezone"))
            if problem:
                return ApiFailResponse(message=problem, status_code=422)
        if trigger_type == "fsop":
            try:
                _validate_watch_path(kwargs.get("watch_path"))
            except ValueError as exc:
                return ApiFailResponse(message=str(exc), status_code=422)
        if "action" in body and "actions" not in body:
            action_data = body["action"]
            kwargs["action"] = TriggerAction(**action_data) if isinstance(action_data, dict) else action_data

        try:
            entity = cls(**kwargs)
        except ValueError as exc:  # pydantic ValidationError is a ValueError
            return ApiFailResponse(message=f"That automation can't be saved: {exc}", status_code=422)
        await entity.save()
        # The one arming seam: it also applies the "runs here" gates (another
        # install's copy, a schedule placed on another machine) the indexer path
        # gets — a rule made here must not be armed by a different rule.
        from flow_sdk.builtin.trigger_arming import arm_trigger  # noqa: PLC0415

        await arm_trigger(entity, replace=True)

        return ApiSuccessResponse(data=entity)

    @core_action.all(action_name="update")
    async def update_action(self, request: Request) -> ApiResponse:
        """
        PUT/PATCH /api/v1/graph/trigger/{id} — update trigger fields.
        Reschedules APScheduler job when updating schedule triggers.
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        if not body:
            return ApiFailResponse(message="Request body required", status_code=422)

        from flow_sdk.automations.check import SPEC_FIELDS  # noqa: PLC0415
        from flow_sdk.automations.spec_file import SpecFileError, document_path, rewrite  # noqa: PLC0415

        if self.is_builtin and set(body) - {"log_mode"}:
            return ApiFailResponse(message="This automation is built into Flowpad and can't be changed here.",
                                   status_code=409)
        if document_path(self) is not None:
            # Defined in a trigger.json: the FILE is the truth and the row its
            # index, so a row-only write would be reverted by the next re-index.
            try:
                fresh = await rewrite(self, {k: body[k] for k in SPEC_FIELDS if k in body})
            except SpecFileError as exc:
                return ApiFailResponse(message=str(exc), status_code=exc.status_code)
            return ApiSuccessResponse(data=fresh)

        for field in SPEC_FIELDS | {"scope", "log_mode"}:
            if field in body:
                value = body[field]
                if field == "actions":
                    value = [TriggerAction(**a) if isinstance(a, dict) else a for a in value or []]
                    # The validator that keeps legacy `action` = actions[0] runs only
                    # at construction; an in-place edit has to keep them agreeing.
                    self.action = value[0] if value else TriggerAction(action_type=ActionType.NOP)
                setattr(self, field, value)
        if "action" in body and "actions" not in body:
            action_data = body["action"]
            self.action = TriggerAction(**action_data) if isinstance(action_data, dict) else action_data
        if self.trigger_type == "schedule":
            problem = _schedule_problem(self.expr or "", self.sched_trigger_type, self.timezone)
            if problem:
                return ApiFailResponse(message=problem, status_code=422)
        if self.trigger_type == "fsop" and "watch_path" in body:
            try:
                _validate_watch_path(self.watch_path)
            except ValueError as exc:
                return ApiFailResponse(message=str(exc), status_code=422)

        if self.trigger_type == "tag":
            # Mirror create: a bad pattern must FAIL the update, not silently
            # decline to arm on re-register.
            from flow_sdk.builtin.tag_triggers import validate_tag_trigger
            problem = validate_tag_trigger(self.tag_pattern)
            if problem:
                return ApiFailResponse(message=problem, status_code=422)

        await self.update()
        from flow_sdk.builtin.trigger_arming import arm_trigger  # noqa: PLC0415

        await arm_trigger(self, replace=True)  # re-arm: pattern / schedule / watch may have changed

        return ApiSuccessResponse(data=self)

    @core_action.delete(action_name="delete")
    async def delete_action(self, request: Request) -> ApiResponse:
        """DELETE /api/v1/graph/trigger/{id}

        A file-defined automation goes with its folder — disarm, folder, row, in
        that order, or the indexer resurrects a row whose folder is still on
        disk. Flowpad's own are refused."""
        from flow_sdk.automations.spec_file import document_path  # noqa: PLC0415

        if self.is_builtin:
            return ApiFailResponse(message="This automation is built into Flowpad and can't be deleted.",
                                   status_code=409)
        if self.id:
            from flow_sdk.builtin.trigger_arming import disarm_trigger

            await disarm_trigger(self.id)
        document = document_path(self)
        if document is not None:
            import asyncio  # noqa: PLC0415
            import shutil  # noqa: PLC0415

            await asyncio.to_thread(shutil.rmtree, document.parent)

        await self.delete()
        return ApiSuccessResponse(data={"deleted": True})

    @core_action.all(action_name="agent_hook")
    async def agent_hook_action(self, request: Request) -> ApiResponse:
        """
        Handle agent hook relationship management for this trigger.

        Routes:
        - GET  /api/v1/graph/trigger/{id}/agent_hook        -> list connected agent hooks
        - POST /api/v1/graph/trigger/{id}/agent_hook/add    -> add agent hook connection
        - POST /api/v1/graph/trigger/{id}/agent_hook/remove -> remove agent hook connection
        """
        from flow_sdk.builtin.agent_hook import AgentHook

        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message=ErrorMessage.REQUEST_INFO_NOT_AVAILABLE, status_code=500)

        method = request.method.upper()
        sub_action = request_info.sub_path

        if method == HttpMethod.GET.value:
            agent_hook_typeids = await self.get_agent_hooks()
            agent_hooks = []
            for typeid in agent_hook_typeids:
                agent_hook = await AgentHook.get_by_typeid(typeid)
                if agent_hook:
                    agent_hooks.append(agent_hook.model_dump())
            return ApiSuccessResponse(data=agent_hooks)

        elif method == HttpMethod.POST.value:
            body = await request_info.get_post_data()
            if not body:
                return ApiFailResponse(message=ErrorMessage.REQUEST_BODY_REQUIRED, status_code=422)

            agent_hook_id = body.get("agent_hook_id")
            if not agent_hook_id:
                return ApiFailResponse(message=ErrorMessage.AGENT_HOOK_ID_REQUIRED, status_code=422)

            try:
                agent_hook_typeid = TypeId.model_validate(agent_hook_id)
            except Exception as e:
                return ApiFailResponse(message=f"{ErrorMessage.INVALID_AGENT_HOOK_ID_FORMAT}: {e}", status_code=422)

            if sub_action == RelationshipSubAction.ADD:
                await self.connect_to_agent_hook(agent_hook_typeid)
                return ApiSuccessResponse(message=SuccessMessage.AGENT_HOOK_CONNECTED)

            elif sub_action == RelationshipSubAction.REMOVE:
                await self.disconnect_from_agent_hook(agent_hook_typeid)
                return ApiSuccessResponse(message=SuccessMessage.AGENT_HOOK_DISCONNECTED)

            else:
                return ApiFailResponse(message=f"{ErrorMessage.UNKNOWN_SUB_ACTION}: {sub_action}", status_code=404)

        return ApiFailResponse(message=f"{ErrorMessage.METHOD_NOT_ALLOWED} agent_hook", status_code=405)

    @core_action.get(action_name="fires")
    async def fires_action(cls, request: Request) -> ApiResponse:
        """
        GET /api/v1/graph/trigger/fires — raw history rows across ALL rules,
        newest first. Scripts and tests read these; the Automations screen
        reads ``runs``, which folds the same rows into runs.

        Rows are the durable half of a fire; the matching ``trigger.*`` envelope
        is the live half, joined by ``event_id``. They are read separately
        because ``trigger.*`` is not forwarded to the app (see the pin test in
        ``tests/unit/test_trigger_tags.py``) and the bus keeps no history.
        """
        request_info = get_current_request_info()
        params = request_info.request_parameters if request_info else {}
        limit = int(params.get("limit", 200))
        from flow_sdk.fs_store.operations.trigger_log import discover as _discover_trigger_log

        return ApiSuccessResponse(data=_discover_trigger_log(None, limit=limit))

    # ── Automations (docs/automations.md) ─────────────────────────────────────
    # Thin doors over ``flow_sdk/automations``; every answer is an
    # ``automation.*`` DataSpec, dumped. The UI reaches these only through the
    # TS SDK's ``Trigger`` methods.

    @core_action.get(action_name="overview")
    async def overview_action(cls, request: Request) -> ApiResponse:
        """GET /api/v1/graph/trigger/overview — every automation as a sentence with its health.

        ``?include_inactive=true`` also lists copies under other installs (never armed)."""
        from flow_sdk.automations.overview import overview  # noqa: PLC0415

        params = get_current_request_info().request_parameters or {}
        include_inactive = str(params.get("include_inactive", "false")).lower() == "true"
        rows = await overview(include_inactive=include_inactive)
        return ApiSuccessResponse(data=[r.model_dump(mode="json") for r in rows])

    @core_action.get(action_name="next_runs")
    async def next_runs_action(cls, request: Request) -> ApiResponse:
        """GET /api/v1/graph/trigger/next_runs?expr=&sched_trigger_type=&timezone=&n=5

        When a schedule — saved or still being edited — fires next, plus how it
        reads. A bad expression is a 422 that says what is wrong."""
        from flow_sdk.automations.schedule import next_fire_times, read_schedule, schedule_text  # noqa: PLC0415

        params = get_current_request_info().request_parameters or {}
        expr = str(params.get("expr") or "").strip()
        kind = str(params.get("sched_trigger_type") or "cron")
        tz = str(params.get("timezone") or "") or None
        try:
            count = max(1, min(20, int(params.get("n", 5))))
            times = next_fire_times(expr, kind, tz, count)
        except (ValueError, KeyError, TypeError) as exc:
            return ApiFailResponse(message=f"That schedule can't be read: {exc}", status_code=422)
        schedule = read_schedule(expr, kind, tz)
        return ApiSuccessResponse(data={
            "times": [t.isoformat() for t in times],
            "schedule": schedule.model_dump(mode="json"),
            "text": schedule_text(schedule),
        })

    @core_action.post(action_name="check")
    async def check_action(self, request: Request) -> ApiResponse:
        """POST /api/v1/graph/trigger/{id}/check — *Check*: would it run, and what would it do.

        No side effects. Optional body ``{"event": {tag, target?, scope?}}``
        checks an event automation against that event, field by field."""
        from flow_sdk.automations.check import check  # noqa: PLC0415

        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else None) or {}
        event = body.get("event") if isinstance(body, dict) else None
        result = await check(self, event if isinstance(event, dict) else None)
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

    @core_action.post(action_name="check_spec")
    async def check_spec_action(cls, request: Request) -> ApiResponse:
        """POST /api/v1/graph/trigger/check_spec — *Check* for an automation not saved yet.

        Body ``{"spec": {<trigger fields>}, "event"?: {...}}``. Fields the entity
        rejects are a 422 with the reason."""
        from pydantic import ValidationError  # noqa: PLC0415

        from flow_sdk.automations.check import check, trigger_from_spec  # noqa: PLC0415

        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else None) or {}
        try:
            draft = trigger_from_spec(body.get("spec") or {})
        except (ValidationError, ValueError, TypeError) as exc:
            return ApiFailResponse(message=f"That automation can't be read: {exc}", status_code=422)
        event = body.get("event")
        result = await check(draft, event if isinstance(event, dict) else None)
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

    @core_action.get(action_name="samples")
    async def samples_action(self, request: Request) -> ApiResponse:
        """GET /api/v1/graph/trigger/{id}/samples — recent real events to test this automation with."""
        from flow_sdk.automations.samples import samples_for  # noqa: PLC0415

        return ApiSuccessResponse(data=samples_for(self))

    @core_action.get(action_name="recent_events")
    async def recent_events_action(cls, request: Request) -> ApiResponse:
        """GET /api/v1/graph/trigger/recent_events?pattern=&target= — recent forwarded events a
        pattern would receive (for an automation not saved yet)."""
        from flow_sdk.automations.samples import forwarded_matching  # noqa: PLC0415

        params = get_current_request_info().request_parameters or {}
        pattern = str(params.get("pattern") or "")
        if not pattern:
            return ApiSuccessResponse(data=[])
        return ApiSuccessResponse(data=forwarded_matching(pattern, str(params.get("target") or "") or None))

    @core_action.get(action_name="bus_map")
    async def bus_map_action(cls, request: Request) -> ApiResponse:
        """GET /api/v1/graph/trigger/bus_map — every event type, how often it happened since the
        app started, which automations listen, and what they do."""
        from flow_sdk.automations.bus_map import bus_map  # noqa: PLC0415

        return ApiSuccessResponse(data=(await bus_map()).model_dump(mode="json"))

    @core_action.post(action_name="match_pattern")
    async def match_pattern_action(cls, request: Request) -> ApiResponse:
        """POST /api/v1/graph/trigger/match_pattern — the pattern sandbox.

        Body ``{"pattern", "target_filter"?, "event": {tag, target, scope?}}`` →
        ``{"matches": bool, "parts": {tag, target, scope}, "problem"}``. Nothing is saved."""
        from flow_sdk.tags.bus import explain_subscription_match  # noqa: PLC0415
        from flow_sdk.tags.grammar import tag_pattern_problem  # noqa: PLC0415

        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else None) or {}
        pattern = str(body.get("pattern") or "")
        problem = tag_pattern_problem(pattern) if pattern != "*" else None
        event = body.get("event") or {}
        parts = explain_subscription_match(pattern, str(event.get("tag") or ""), str(event.get("target") or ""),
                                           target_filter=body.get("target_filter") or None,
                                           scope_filter=body.get("scope_filter") or None,
                                           scope=list(event.get("scope") or []))
        return ApiSuccessResponse(data={"matches": problem is None and all(parts.values()),
                                        "parts": parts, "problem": problem})

    @core_action.get(action_name="runs")
    async def runs_action(cls, request: Request) -> ApiResponse:
        """GET /api/v1/graph/trigger/runs?trigger_id=&status=&include_tests=true&include_builtin=true&limit=200

        Runs newest first — one automation's when ``trigger_id`` is given, else
        every automation's. ``include_builtin=false`` leaves out Flowpad's own (a
        transcript watcher fires on every step of an agent's work and would bury
        everything else). Each launched agent run is asked how it ended."""
        from flow_sdk.automations.runs import fold, join_processes, rows_for  # noqa: PLC0415
        from flow_sdk.fs_store.operations.trigger_log import discover  # noqa: PLC0415

        params = get_current_request_info().request_parameters or {}
        limit = max(1, min(1000, int(params.get("limit", 200))))
        trigger_id = str(params.get("trigger_id") or "") or None
        if trigger_id:
            # Every file is read (a renamed rule's old rows sit under its old name),
            # but only this rule's recent rows from each.
            row = await cls.get_by_id(trigger_id)
            rows = rows_for(trigger_id, row.name if row else None,
                            discover(None, limit=10_000, per_rule=limit * 2))
        elif str(params.get("include_builtin", "true")).lower() == "false":
            builtin = {str(t.id) for t in await cls.every() if t.is_builtin}
            rows = [r for r in discover(None, limit=10_000, per_rule=limit * 2)
                    if r.get("trigger_id") not in builtin][: limit * 2]
        else:
            rows = discover(None, limit=limit * 2)
        runs = fold(rows)
        if str(params.get("include_tests", "true")).lower() == "false":
            runs = [r for r in runs if not r.is_test]
        runs = await join_processes(runs[:limit])
        status = str(params.get("status") or "")
        if status:
            runs = [r for r in runs if r.status == status]
        return ApiSuccessResponse(data=[r.model_dump(mode="json") for r in runs])

    @core_action.get(action_name="run")
    async def run_action(cls, request: Request) -> ApiResponse:
        """GET /api/v1/graph/trigger/run?id=<log row id> — one run, with its agent run's outcome."""
        from flow_sdk.automations.runs import fold, join_processes  # noqa: PLC0415
        from flow_sdk.fs_store.operations.trigger_log import discover  # noqa: PLC0415

        params = get_current_request_info().request_parameters or {}
        run_id = str(params.get("id") or "")
        for run in fold(discover(None, limit=5000)):
            if run.id == run_id:
                (joined,) = await join_processes([run])
                return ApiSuccessResponse(data=joined.model_dump(mode="json"))
        return ApiFailResponse(message="That run is no longer in the history.", status_code=404)

    @core_action.get(action_name="discover")
    async def discover_action(cls, request: Request) -> ApiResponse:
        """
        GET /api/v1/graph/trigger/discover — scan filesystem rules, sync to DB.
        All discovered triggers are hook type.
        """
        from flow_sdk.rules.engine import RuleEngine
        engine = RuleEngine()
        rules = engine.all_rules()
        triggers = []
        for rule in rules:
            existing = await cls.get_one({"name": rule.name})
            if existing is None:
                existing = cls(name=rule.name)
            existing.trigger_type = "hook"
            existing.description = getattr(rule, "description", "") or existing.description
            existing.scope = str(getattr(rule, "scope", "system") or "system")
            existing.hook_events = list(getattr(rule, "hook_events", []) or [])
            existing.log_mode = getattr(rule, "log_mode", "activations") or "activations"
            existing.path = str(rule.record_dir) if rule.record_dir else None
            if existing.id:
                await existing.update()
            else:
                await existing.save()
            triggers.append(existing)
        return ApiSuccessResponse(data=triggers)

    @core_action.post(action_name="test")
    async def test_action(self, request: Request) -> ApiResponse:
        """
        POST /api/v1/graph/trigger/{id}/test — *Run once now*.

        One rule for every kind (``automations/run_once.py``): runs even when the
        automation is off, spends nothing a real fire spends, logs ``is_test``.
        Optional body ``{"event": {tag, target?, data?}}`` picks the envelope an
        event rule runs with. Answers ``automation.run_once`` at once; the work
        continues in the background and shows up in the automation's runs.
        """
        from flow_sdk.automations.run_once import RunOnceRefused, run_once  # noqa: PLC0415

        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else None) or {}
        event = body.get("event") if isinstance(body, dict) else None
        try:
            started = await run_once(self, event if isinstance(event, dict) else None)
        except RunOnceRefused as exc:
            return ApiFailResponse(message=str(exc), status_code=422)
        return ApiSuccessResponse(data=started.model_dump(mode="json"))

    @core_action.all(action_name="trigger-content")
    async def trigger_content_action(self, request: Request) -> ApiResponse:
        """
        Read or write the trigger.py content for this trigger's rule.

        Routes:
        - GET /api/v1/graph/trigger/{id}/trigger-content -> read trigger.py
        - PUT /api/v1/graph/trigger/{id}/trigger-content -> write trigger.py
        """
        if not self.path:
            return ApiFailResponse(message="This automation has no rule code: only agent rules from a rule folder do.",
                                   status_code=404)
        from pathlib import Path

        from flow_sdk.assets.directory import AssetDir

        directory = AssetDir(Path(self.path))
        trigger_file = directory.os_path / "trigger.py"
        method = request.method.upper()
        if method == "GET":
            if not trigger_file.exists():
                return ApiFailResponse(message="trigger.py not found", status_code=404)
            content = directory.read_asset("trigger.py")
            return ApiSuccessResponse(data={"content": content})
        elif method == "PUT":
            request_info = get_current_request_info()
            body = await request_info.get_post_data() if request_info else {}
            content = (body or {}).get("content", "")
            directory.load_asset("trigger.py", content=content)
            return ApiSuccessResponse(data={"saved": True})
        return ApiFailResponse(message=f"{ErrorMessage.METHOD_NOT_ALLOWED} trigger-content", status_code=405)

    @core_action.get(action_name="log")
    async def log_action(self, request: Request) -> ApiResponse:
        """
        GET /api/v1/graph/trigger/{id}/log — fetch trigger evaluation log entries.
        Works for both hook and schedule triggers (uses trigger name as rule key).
        """
        request_info = get_current_request_info()
        params = request_info.request_parameters if request_info else {}
        limit = int(params.get("limit", 500))
        triggered_only = str(params.get("triggered_only", "false")).lower() == "true"
        from flow_sdk.fs_store.operations.trigger_log import discover as _discover_trigger_log
        entries = _discover_trigger_log(self.name, limit=limit)
        if triggered_only:
            entries = [e for e in entries if e.get("trigger")]
        return ApiSuccessResponse(data=entries)

    @core_action.all(action_name="meta")
    async def meta_action(self, request: Request) -> ApiResponse:
        """
        PATCH /api/v1/graph/trigger/{id}/meta — update log_mode.
        """
        if request.method.upper() != "PATCH":
            return ApiFailResponse(message=f"{ErrorMessage.METHOD_NOT_ALLOWED} meta", status_code=405)
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        log_mode = (body or {}).get("log_mode")
        if log_mode not in ("all", "activations"):
            return ApiFailResponse(message="log_mode must be 'all' or 'activations'", status_code=422)
        self.log_mode = log_mode
        await self.update()
        if self.path:
            from pathlib import Path

            from flow_sdk.rules.activation_rule import ActivationRule
            record_file = Path(self.path) / "record.json"
            if record_file.exists():
                try:
                    rule = ActivationRule.load_record(record_file)
                    rule.save_log_mode(log_mode)
                except Exception:
                    pass
        return ApiSuccessResponse(data={"log_mode": log_mode})
