import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar, Optional, Union

from pydantic import model_validator
from starlette.requests import Request

from flow_sdk._compat import StrEnum
from flow_sdk.flowpad_types.enums.entity_enums import BuiltInRelationshipTypes, RelationshipDirection
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.messages import HttpMethod
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.hook_models import (
    ActionType,
    ErrorMessage,
    ExecutedAction,
    HookEventData,
    RelationshipSubAction,
    SuccessMessage,
    TriggerAction,
    get_action_handler,
)
from flow_sdk.core import action as core_action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


class TriggerType(StrEnum):
    """Discriminator for Trigger entities. New values: extend here + handle in lifecycle hooks."""

    HOOK = "hook"
    SCHEDULE = "schedule"
    FSOP = "fsop"
    # A unified-bus subscription (docs/flow-events.md phase 4): fires on
    # matching FlowEvents instead of files/cron/hooks.
    TOPIC = "topic"


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


def _parse_trigger(sched_trigger_type: str, expr: str):
    """Parse sched_trigger_type + expr into an APScheduler trigger object."""
    if sched_trigger_type == "interval":
        from apscheduler.triggers.interval import IntervalTrigger
        seconds = _parse_interval_expr(expr)
        return IntervalTrigger(seconds=seconds)
    elif sched_trigger_type == "date":
        from apscheduler.triggers.date import DateTrigger
        run_date = datetime.fromisoformat(expr)
        return DateTrigger(run_date=run_date)
    else:
        from apscheduler.triggers.cron import CronTrigger
        return CronTrigger.from_crontab(expr)


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


async def activate_flows_for_trigger(trigger_id: str, trigger_name: str,
                                     envelope=None) -> None:
    """Flow activation on any trigger fire — THE shared step for every trigger
    kind (schedule / fsop / topic): enters a run in each flow whose trigger
    node references this Trigger entity. ``envelope`` (topic fires only)
    preserves the triggering FlowEvent's id/actor onto the run entry."""
    try:
        from flow_sdk.flow_manager import get_flow_manager

        await get_flow_manager().on_trigger_fired(trigger_id, envelope=envelope)
    except Exception:
        logger.exception("Trigger %s: flow activation failed", trigger_name)


async def dispatch_trigger_actions(trigger: "Trigger", changes: list) -> None:
    """Action dispatch on any trigger fire — THE shared loop for every trigger
    kind. Per-action try/except so one bad handler can't skip the rest.
    ``changes`` is empty for schedule/topic fires; FSOp passes its batch."""
    for action in trigger.actions:
        try:
            handler = get_action_handler(action.action_type)
            if handler is None:
                logger.warning("Trigger %s: no handler for action_type=%s",
                               trigger.name, action.action_type)
                continue
            await handler.execute(trigger, action=action, changes=changes)
        except Exception:
            logger.exception("Trigger %s: action %s raised during dispatch",
                             trigger.name, action.action_type)


async def _fire_schedule_job(trigger_id: str) -> None:
    """Callback executed by APScheduler when a schedule trigger fires.

    Dispatches via the action handler registry (same path as FSOp's ``_fire``
    in ``server/fsop_watcher.py:_fire``) so any ``actions`` declared on the
    Trigger entity run — CALLBACK and RUN_SCRIPT included. Per-action try/except
    so one bad handler can't skip the rest.

    Legacy ``instruction`` path is preserved as a back-compat fallback for
    schedule triggers that pre-date the actions list (it spawns an
    AgenticProcess with the prompt).
    """
    try:
        from flow_sdk.builtin.hook_models import get_action_handler
        from flow_sdk.fs_store.operations.trigger_log import append_entry as _append_trigger_log_entry, discover as _discover_trigger_log

        entity = await Trigger.get_by_id(trigger_id)
        if not (entity and entity.enabled):
            return
        entity.counter += 1
        entity.last_run = datetime.now(timezone.utc)
        await entity.update()

        # Shared fire steps (same helpers as fsop/topic): flow activation +
        # action dispatch. ``changes`` is empty for schedule fires — RUN_SCRIPT
        # then reports CHANGES_COUNT=0 / FIRST_*="" to the script.
        await activate_flows_for_trigger(trigger_id, entity.name or trigger_id)
        await dispatch_trigger_actions(entity, changes=[])

        # Legacy back-compat: schedule triggers with ``instruction`` set spawn
        # an AgenticProcess. Pre-dates the actions list; kept so existing
        # user-created schedules keep working.
        process_id: Optional[str] = None
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

        _append_trigger_log_entry(entity.name, {
            "hook_event": "schedule_fire",
            "trigger": True,
            "reason": f"Scheduled ({entity.sched_trigger_type or 'cron'}): {entity.expr}",
            "is_test": False,
            "rule_name": entity.name,
            "actions": [{"action_type": str(a.action_type)} for a in entity.actions],
            "agentic_process_id": process_id,
        })
        logger.debug(f"Schedule trigger {entity.name} fired (counter={entity.counter}, process_id={process_id})")
    except Exception as e:
        logger.error(f"Schedule trigger fire error for {trigger_id}: {e}")


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
    last_triggered: Optional[datetime] = APIField(None, description="Timestamp of last trigger match")
    counter: int = APIField(default=0, description="Counter incremented when trigger action is executed")
    hook_events: list[str] = APIField(default_factory=list)
    log_mode: str = APIField(default="activations")
    path: Optional[str] = APIField(None)

    # Schedule trigger fields
    expr: Optional[str] = APIField(None, description="Cron/interval/date expression (schedule triggers only)")
    sched_trigger_type: Optional[str] = APIField(None, description="APScheduler type: cron, interval, date")
    next_run: Optional[datetime] = APIField(None, description="Next scheduled run (schedule triggers only)")
    last_run: Optional[datetime] = APIField(None, description="Last scheduled run (schedule triggers only)")
    instruction: Optional[str] = APIField(None, description="Prompt sent to the agentic process when this trigger fires (schedule triggers only)")
    workdir: Optional[str] = APIField(None, description="Working directory for the spawned agentic process (schedule triggers only)")

    # FSOp trigger fields
    watch_path: Optional[str] = APIField(None, description="Absolute file or folder path watched (FSOp triggers only)")
    recursive: bool = APIField(default=False, description="For folder watches: descend into subtree (FSOp only)")
    watch_glob: Optional[str] = APIField(None, description="For folder watches: glob filter, e.g. '*.json' (FSOp only)")
    last_seen_mtime: Optional[float] = APIField(None, description="File mtime at last fire (FSOp file triggers — used for restart catch-up)")
    last_seen_size: Optional[int] = APIField(None, description="File size at last fire (FSOp file triggers — used for restart catch-up)")
    step_ms: int = APIField(50, description="awatch poll interval in ms (FSOp only). Lower = snappier; higher = less CPU. Default matches watchfiles' default.")
    debounce_ms: int = APIField(1600, description="awatch debounce in ms — max wait before yielding a coalesced batch (FSOp only). Raise on noisy paths (npm install bursts).")
    respect_gitignore: bool = APIField(default=False, description="If True, walk for .gitignore files under watch_path and drop matching events (FSOp only).")
    ignore_patterns: list[str] = APIField(default_factory=list, description="Extra gitignore-style ignore patterns (FSOp only). Applied in addition to .gitignore.")

    # TOPIC trigger fields — a unified-bus subscription (topic_ prefix avoids
    # colliding with the entity's own scope field).
    topic_pattern: Optional[str] = APIField(None, description="Bus topic pattern, segment-glob (TOPIC triggers only), e.g. 'entity.created' or 'flow.*'. Bare '*' is rejected.")
    topic_target: Optional[str] = APIField(None, description="Optional target filter in colon form: 'usage_report:*' or an exact 'type:id' (TOPIC only)")
    topic_scope: list[str] = APIField(default_factory=list, description="Optional scope filter — colon-form targets the event's ctx.scope must intersect (TOPIC only)")
    max_fires_per_minute: int = APIField(default=30, description="Storm guard for TOPIC triggers: fires beyond this per-minute cap are dropped (one storm_suppressed log entry per window)")
    confirm: Optional[dict[str, Any]] = APIField(None, description="Optional confirm-against-store gate (TOPIC only): {type, filter} — the entity query must match or the fire is skipped (event != proof)")

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
        try:
            from flow_sdk.server.scheduler import _job_registration_lock

            scheduler = _get_scheduler()
            if scheduler:
                async with _job_registration_lock:
                    trigger = _parse_trigger(self.sched_trigger_type or "cron", self.expr)
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

    async def _reschedule_job(self) -> None:
        """Reschedule an existing APScheduler job after update."""
        if not self.id or not self.expr:
            return
        try:
            from flow_sdk.server.scheduler import _job_registration_lock

            scheduler = _get_scheduler()
            if scheduler:
                async with _job_registration_lock:
                    trigger = _parse_trigger(self.sched_trigger_type or "cron", self.expr)
                    job = scheduler.reschedule_job(self.id, trigger=trigger)
                    if job:
                        if self.enabled:
                            job.resume()
                        else:
                            job.pause()
                        if job.next_run_time:
                            self.next_run = job.next_run_time
                            await self.update()
        except Exception as e:
            logger.warning(f"Failed to reschedule trigger {self.id}: {e}")

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
                from flow_sdk.flow_manager import get_flow_manager

                await get_flow_manager().on_trigger_fired(self.id)
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
            return ApiFailResponse(message="Request body required")

        name = body.get("name", "")
        if not name:
            return ApiFailResponse(message="name is required")

        trigger_type = body.get("trigger_type", "hook")

        kwargs: dict[str, Any] = {
            "name": name,
            "description": body.get("description"),
            "enabled": body.get("enabled", True),
            "trigger_type": trigger_type,
            "scope": body.get("scope", "user"),
        }

        if trigger_type == "topic":
            from flow_sdk.builtin.topic_triggers import validate_topic_trigger
            problem = validate_topic_trigger(body.get("topic_pattern"))
            if problem:
                return ApiFailResponse(message=problem)
            kwargs["topic_pattern"] = body["topic_pattern"]
            for field in ("topic_target", "topic_scope", "max_fires_per_minute", "confirm"):
                if field in body:
                    kwargs[field] = body[field]
        if trigger_type == "schedule":
            kwargs["expr"] = body.get("expr", "* * * * *")
            kwargs["sched_trigger_type"] = body.get("sched_trigger_type", "cron")
            if "instruction" in body:
                kwargs["instruction"] = body["instruction"]
            if "workdir" in body:
                kwargs["workdir"] = body["workdir"]
            if "project_id" in body:
                kwargs["project_id"] = body["project_id"]
        else:
            if "mask" in body:
                kwargs["mask"] = body["mask"]
            if "action" in body:
                action_data = body["action"]
                kwargs["action"] = TriggerAction(**action_data) if isinstance(action_data, dict) else action_data
            if "hook_events" in body:
                kwargs["hook_events"] = body["hook_events"]
            if "log_mode" in body:
                kwargs["log_mode"] = body["log_mode"]

        entity = cls(**kwargs)
        await entity.save()

        if trigger_type == "schedule":
            await entity._register_schedule_job()
        elif trigger_type == "fsop":
            # Mirror the schedule pattern: hand the freshly-saved trigger to
            # the FSOp watcher so its awatch task is spawned immediately
            # (without waiting for the next server boot).
            from flow_sdk.server.fsop_watcher import fsop_watcher
            await fsop_watcher.on_trigger_saved(entity)
        elif trigger_type == "topic":
            from flow_sdk.builtin.topic_triggers import register_topic_trigger
            register_topic_trigger(entity)

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
            return ApiFailResponse(message="Request body required")

        for field in ("name", "description", "enabled", "scope", "expr",
                      "sched_trigger_type", "log_mode", "trigger_type",
                      "instruction", "workdir", "project_id",
                      "topic_pattern", "topic_target", "topic_scope",
                      "max_fires_per_minute", "confirm"):
            if field in body:
                setattr(self, field, body[field])
        if "mask" in body:
            self.mask = body["mask"]
        if "action" in body:
            action_data = body["action"]
            self.action = TriggerAction(**action_data) if isinstance(action_data, dict) else action_data
        if "hook_events" in body:
            self.hook_events = body["hook_events"]

        if self.trigger_type == "topic":
            # Mirror create: a bad pattern must FAIL the update, not silently
            # decline to arm on re-register.
            from flow_sdk.builtin.topic_triggers import validate_topic_trigger
            problem = validate_topic_trigger(self.topic_pattern)
            if problem:
                return ApiFailResponse(message=problem)

        await self.update()

        if self.trigger_type == "schedule":
            await self._reschedule_job()
        elif self.trigger_type == "fsop":
            # Re-spawn the watcher's task — config (watch_path / recursive /
            # glob / actions) may have changed; on_trigger_saved cancels the
            # existing task and starts a fresh one.
            from flow_sdk.server.fsop_watcher import fsop_watcher
            await fsop_watcher.on_trigger_saved(self)
        elif self.trigger_type == "topic":
            # Re-arm (replace) — pattern/filters/enabled may have changed.
            from flow_sdk.builtin.topic_triggers import register_topic_trigger
            register_topic_trigger(self)

        return ApiSuccessResponse(data=self)

    @core_action.delete(action_name="delete")
    async def delete_action(self, request: Request) -> ApiResponse:
        """DELETE /api/v1/graph/trigger/{id}"""
        if self.trigger_type == "schedule" and self.id:
            try:
                scheduler = _get_scheduler()
                if scheduler:
                    scheduler.remove_job(self.id)
            except Exception as e:
                logger.debug(f"APScheduler remove_job error (may not exist): {e}")
        elif self.trigger_type == "topic" and self.id:
            from flow_sdk.builtin.topic_triggers import unregister_topic_trigger
            unregister_topic_trigger(self.id)
        elif self.trigger_type == "fsop" and self.id:
            try:
                from flow_sdk.server.fsop_watcher import fsop_watcher
                await fsop_watcher.on_trigger_deleted(self.id)
            except Exception as e:
                logger.debug(f"FSOpWatcher on_trigger_deleted error (may not be running): {e}")

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
            return ApiFailResponse(message=ErrorMessage.REQUEST_INFO_NOT_AVAILABLE)

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
                return ApiFailResponse(message=ErrorMessage.REQUEST_BODY_REQUIRED)

            agent_hook_id = body.get("agent_hook_id")
            if not agent_hook_id:
                return ApiFailResponse(message=ErrorMessage.AGENT_HOOK_ID_REQUIRED)

            try:
                agent_hook_typeid = TypeId.model_validate(agent_hook_id)
            except Exception as e:
                return ApiFailResponse(message=f"{ErrorMessage.INVALID_AGENT_HOOK_ID_FORMAT}: {e}")

            if sub_action == RelationshipSubAction.ADD:
                await self.connect_to_agent_hook(agent_hook_typeid)
                return ApiSuccessResponse(message=SuccessMessage.AGENT_HOOK_CONNECTED)

            elif sub_action == RelationshipSubAction.REMOVE:
                await self.disconnect_from_agent_hook(agent_hook_typeid)
                return ApiSuccessResponse(message=SuccessMessage.AGENT_HOOK_DISCONNECTED)

            else:
                return ApiFailResponse(message=f"{ErrorMessage.UNKNOWN_SUB_ACTION}: {sub_action}")

        return ApiFailResponse(message=f"{ErrorMessage.METHOD_NOT_ALLOWED} agent_hook")

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

    @core_action.post(action_name="fire")
    async def fire_action(self, request: Request) -> ApiResponse:
        """Alias for ``/test`` — POST /api/v1/graph/trigger/{id}/fire fires
        the trigger immediately. Same body+response shape as ``test_action``.
        Kept because the natural verb for a trigger is "fire"; the original
        endpoint was named "test" before that distinction mattered.
        """
        return await self.test_action(request)

    @core_action.post(action_name="test")
    async def test_action(self, request: Request) -> ApiResponse:
        """
        POST /api/v1/graph/trigger/{id}/test — fire the trigger immediately.
        For schedule triggers: fires the schedule job.
        For hook triggers: runs the rule against a mock UserPromptSubmit event.
        Also reachable as POST /api/v1/graph/trigger/{id}/fire.
        """
        if self.trigger_type == "schedule":
            await _fire_schedule_job(self.id)
            # Reload to get updated counter
            updated = await Trigger.get_by_id(self.id)
            return ApiSuccessResponse(data={"status": "fired", "counter": updated.counter if updated else self.counter})

        if self.trigger_type == "fsop":
            # Synthetic FSOp fire: real action dispatch (callback / script runs
            # for real, marked is_test=True in the invocations log so it's
            # visually distinguishable). Matches the precedent set by schedule:
            # "Test" really runs the action. Lets the user verify wiring.
            if not self.enabled:
                return ApiFailResponse(message="Trigger is disabled — enable it before testing.")
            if not self.watch_path:
                return ApiFailResponse(message="Trigger has no watch_path configured.")
            from pathlib import Path as _Path
            from flow_sdk.builtin.change_event import ChangeEvent
            from flow_sdk.server.fsop_watcher import _fire as _fsop_fire
            test_event = ChangeEvent(path=_Path(self.watch_path), change_type="test")
            await _fsop_fire(self, [test_event], is_test=True)
            updated = await Trigger.get_by_id(self.id) if self.id else self
            return ApiSuccessResponse(data={"status": "fired", "counter": updated.counter if updated else self.counter, "is_test": True})

        # Hook trigger test
        if not self.path:
            return ApiFailResponse(message="Trigger has no filesystem path")
        from pathlib import Path
        from flow_sdk.rules.activation_rule import ActivationRule
        record_file = Path(self.path) / "record.json"
        if not record_file.exists():
            return ApiFailResponse(message=f"record.json not found at {self.path}")
        rule = ActivationRule.load_record(record_file)
        mock_data = {
            "hookEvent": "UserPromptSubmit",
            "hook_event_name": "UserPromptSubmit",
            "prompt": "",
            "cwd": "",
        }
        result = rule.run(mock_data, [])
        try:
            from flow_sdk.fs_store.operations.trigger_log import append_entry as _append_trigger_log_entry, discover as _discover_trigger_log
            _append_trigger_log_entry(rule.name, {
                "hook_event": "UserPromptSubmit",
                "trigger": result.trigger,
                "reason": result.reason or "",
                "is_test": True,
                "rule_name": rule.name,
                "actions": [a.type for a in result.actions] if result.actions else [],
            })
        except Exception:
            pass
        return ApiSuccessResponse(data=result.to_dict())

    @core_action.all(action_name="trigger-content")
    async def trigger_content_action(self, request: Request) -> ApiResponse:
        """
        Read or write the trigger.py content for this trigger's rule.

        Routes:
        - GET /api/v1/graph/trigger/{id}/trigger-content -> read trigger.py
        - PUT /api/v1/graph/trigger/{id}/trigger-content -> write trigger.py
        """
        if not self.path:
            return ApiFailResponse(message="Trigger has no filesystem path")
        from pathlib import Path
        trigger_file = Path(self.path) / "trigger.py"
        method = request.method.upper()
        if method == "GET":
            if not trigger_file.exists():
                return ApiFailResponse(message="trigger.py not found")
            content = trigger_file.read_text(encoding="utf-8")
            return ApiSuccessResponse(data={"content": content})
        elif method == "PUT":
            request_info = get_current_request_info()
            body = await request_info.get_post_data() if request_info else {}
            content = (body or {}).get("content", "")
            trigger_file.write_text(content, encoding="utf-8")
            return ApiSuccessResponse(data={"saved": True})
        return ApiFailResponse(message=f"{ErrorMessage.METHOD_NOT_ALLOWED} trigger-content")

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
        from flow_sdk.fs_store.operations.trigger_log import append_entry as _append_trigger_log_entry, discover as _discover_trigger_log
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
            return ApiFailResponse(message=f"{ErrorMessage.METHOD_NOT_ALLOWED} meta")
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        log_mode = (body or {}).get("log_mode")
        if log_mode not in ("all", "activations"):
            return ApiFailResponse(message="log_mode must be 'all' or 'activations'")
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

    @core_action.get(action_name="sync_schedule")
    async def sync_schedule_action(self, request: Request) -> ApiResponse:
        """
        GET /api/v1/graph/trigger/{id}/sync_schedule — sync next_run from APScheduler.
        """
        if self.trigger_type != "schedule":
            return ApiFailResponse(message="sync_schedule is only for schedule triggers")
        try:
            scheduler = _get_scheduler()
            if scheduler and self.id:
                job = scheduler.get_job(self.id)
                if job and job.next_run_time != self.next_run:
                    self.next_run = job.next_run_time
                    await self.update()
        except Exception as e:
            logger.debug(f"Scheduler sync error for {self.id}: {e}")
        return ApiSuccessResponse(data=self)
