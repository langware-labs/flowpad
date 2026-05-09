import logging
from datetime import datetime, timezone
from typing import Any, ClassVar, Optional, Union

from starlette.requests import Request

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


async def _fire_schedule_job(trigger_id: str) -> None:
    """Callback executed by APScheduler when a schedule trigger fires.

    If the trigger has an `instruction`, spawn an AgenticProcess marked with
    trigger_id so the invocation can be opened/queried later.
    """
    try:
        from flow_sdk.fs_records.trigger_log import TriggerLogRecord
        entity = await Trigger.get_by_id(trigger_id)
        if not (entity and entity.enabled):
            return
        entity.counter += 1
        entity.last_run = datetime.now(timezone.utc)
        await entity.update()

        process_id: Optional[str] = None
        if entity.instruction:
            try:
                from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
                proc = AgenticProcess(
                    instruction_content=entity.instruction,
                    workdir=entity.workdir,
                    target_vfs_path=str(entity.typeid),
                    project_id=entity.project_id,
                    visible=False,
                )
                await proc.save()
                await proc.start_pty(instruction=entity.instruction, visible=False)
                process_id = proc.id
            except Exception as e:
                logger.error(f"Schedule trigger {entity.name}: failed to spawn process: {e}")

        TriggerLogRecord.append_entry(entity.name, {
            "hook_event": "schedule_fire",
            "trigger": True,
            "reason": f"Scheduled ({entity.sched_trigger_type or 'cron'}): {entity.expr}",
            "is_test": False,
            "rule_name": entity.name,
            "actions": [],
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

    # Trigger type: 'hook' (default, filesystem-based) or 'schedule' (APScheduler)
    trigger_type: str = APIField(default="hook")

    # Hook trigger fields
    mask: dict[str, Any] = APIField(default_factory=dict, description="JSON mask for matching hook data")
    action: TriggerAction = APIField(default_factory=lambda: TriggerAction(action_type=ActionType.NOP))
    enabled: bool = APIField(default=True)
    last_triggered: Optional[datetime] = APIField(None, description="Timestamp of last trigger match")
    counter: int = APIField(default=0, description="Counter incremented when trigger action is executed")
    scope: str = APIField(default="system")
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
    project_id: Optional[str] = APIField(None, description="Owning project id (schedule triggers only)")

    _api_visible: ClassVar[bool] = True
    _unique: ClassVar[list[str]] = []

    # ── Schedule job management ───────────────────────────────────────────────

    async def _register_schedule_job(self) -> None:
        """Register this trigger with APScheduler. Updates next_run on success."""
        if not self.id or not self.expr:
            return
        try:
            scheduler = _get_scheduler()
            if scheduler:
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
            scheduler = _get_scheduler()
            if scheduler:
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
                      "instruction", "workdir", "project_id"):
            if field in body:
                setattr(self, field, body[field])
        if "mask" in body:
            self.mask = body["mask"]
        if "action" in body:
            action_data = body["action"]
            self.action = TriggerAction(**action_data) if isinstance(action_data, dict) else action_data
        if "hook_events" in body:
            self.hook_events = body["hook_events"]

        await self.update()

        if self.trigger_type == "schedule":
            await self._reschedule_job()

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

    @core_action.post(action_name="test")
    async def test_action(self, request: Request) -> ApiResponse:
        """
        POST /api/v1/graph/trigger/{id}/test — fire the trigger immediately.
        For schedule triggers: fires the schedule job.
        For hook triggers: runs the rule against a mock UserPromptSubmit event.
        """
        if self.trigger_type == "schedule":
            await _fire_schedule_job(self.id)
            # Reload to get updated counter
            updated = await Trigger.get_by_id(self.id)
            return ApiSuccessResponse(data={"status": "fired", "counter": updated.counter if updated else self.counter})

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
            from flow_sdk.fs_records.trigger_log import TriggerLogRecord
            TriggerLogRecord.append_entry(rule.name, {
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
        from flow_sdk.fs_records.trigger_log import TriggerLogRecord
        entries = TriggerLogRecord.discover(self.name, limit=limit)
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
