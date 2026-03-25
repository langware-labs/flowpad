"""CronEvent entity — scheduled job backed by APScheduler."""

import logging
from datetime import datetime, timezone
from typing import ClassVar, Optional

from starlette.requests import Request

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import action as core_action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _require_desktop():
    from flow_sdk.config import default_service_config
    if not default_service_config.is_desktop:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="CronEvent is only available in desktop mode")


def _parse_trigger(trigger_type: str, expr: str):
    """Parse trigger_type + expr into an APScheduler trigger object."""
    if trigger_type == "interval":
        # expr like "30s", "5m", "2h"
        from apscheduler.triggers.interval import IntervalTrigger
        seconds = _parse_interval_expr(expr)
        return IntervalTrigger(seconds=seconds)
    elif trigger_type == "date":
        from apscheduler.triggers.date import DateTrigger
        run_date = datetime.fromisoformat(expr)
        return DateTrigger(run_date=run_date)
    else:
        # Default: cron
        from apscheduler.triggers.cron import CronTrigger
        return CronTrigger.from_crontab(expr)


def _parse_interval_expr(expr: str) -> int:
    """Convert interval expression like '30s', '5m', '2h' to seconds."""
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


async def _fire_cron_job(cron_event_id: str):
    """Callback executed by APScheduler when a cron job fires."""
    try:
        entity = await CronEvent.get_by_id(cron_event_id)
        if entity and entity.enabled:
            entity.counter += 1
            entity.last_run = datetime.now(timezone.utc)
            await entity.update()
            logger.debug(f"CronEvent {entity.name} fired (counter={entity.counter})")
    except Exception as e:
        logger.error(f"CronEvent fire error for {cron_event_id}: {e}")


class CronEvent(Entity):
    """Scheduled job entity backed by APScheduler."""

    type: str = APIField(default=BuiltinEntityType.CRON_EVENT.value)
    name: str = APIField()
    description: Optional[str] = APIField(None)
    expr: str = APIField(default="* * * * *")
    trigger_type: str = APIField(default="cron")
    enabled: bool = APIField(default=True)
    counter: int = APIField(default=0)
    last_run: Optional[datetime] = APIField(None)
    next_run: Optional[datetime] = APIField(None)

    _api_visible: ClassVar[bool] = True
    _unique: ClassVar[list[str]] = []

    # ── Read (list / get-by-id) ──────────────────────────────────────────────

    @core_action.get(action_name="read")
    async def list_action(cls, request: Request) -> ApiResponse:
        """
        GET /api/v1/graph/cron_event         → sync APScheduler → DB, return all
        GET /api/v1/graph/cron_event/{id}    → get by ID (also syncs next_run)
        """
        _require_desktop()
        request_info = get_current_request_info()

        # Single entity fetch
        if request_info and request_info.target_entity_typeid and request_info.target_entity_typeid.id:
            entity = await CronEvent.get_by_id(request_info.target_entity_typeid.id)
            if entity is None:
                return ApiFailResponse(message="CronEvent not found")
            await _sync_entity_from_scheduler(entity)
            return ApiSuccessResponse(data=entity)

        # List — sync all scheduler jobs → DB first
        await _sync_all_from_scheduler()
        entities = await CronEvent.get_all()
        return ApiSuccessResponse(data=entities)

    # ── Create ───────────────────────────────────────────────────────────────

    @core_action.post(action_name="create")
    async def create_action(cls, request: Request) -> ApiResponse:
        """POST /api/v1/graph/cron_event"""
        _require_desktop()
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        if not body:
            return ApiFailResponse(message="Request body required")

        name = body.get("name")
        if not name:
            return ApiFailResponse(message="name is required")

        expr = body.get("expr", "* * * * *")
        trigger_type = body.get("trigger_type", "cron")
        description = body.get("description")
        enabled = body.get("enabled", True)

        entity = CronEvent(
            name=name,
            description=description,
            expr=expr,
            trigger_type=trigger_type,
            enabled=enabled,
        )
        await entity.save()

        # Register with APScheduler
        try:
            scheduler = _get_scheduler()
            if scheduler:
                trigger = _parse_trigger(trigger_type, expr)
                job = scheduler.add_job(
                    _fire_cron_job,
                    trigger=trigger,
                    id=entity.id,
                    name=name,
                    args=[entity.id],
                    replace_existing=True,
                )
                if not enabled:
                    job.pause()
                # Capture next_run
                if job.next_run_time:
                    entity.next_run = job.next_run_time
                    await entity.update()
        except Exception as e:
            logger.warning(f"Failed to schedule cron job: {e}")

        return ApiSuccessResponse(data=entity)

    # ── Update ───────────────────────────────────────────────────────────────

    @core_action.all(action_name="update")
    async def update_action(self, request: Request) -> ApiResponse:
        """PUT/PATCH /api/v1/graph/cron_event/{id}"""
        _require_desktop()
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        if not body:
            return ApiFailResponse(message="Request body required")

        # Apply updates to entity fields
        for field in ("name", "description", "expr", "trigger_type", "enabled"):
            if field in body:
                setattr(self, field, body[field])

        await self.update()

        # Reschedule in APScheduler
        try:
            scheduler = _get_scheduler()
            if scheduler:
                trigger = _parse_trigger(self.trigger_type, self.expr)
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
            logger.warning(f"Failed to reschedule cron job {self.id}: {e}")

        return ApiSuccessResponse(data=self)

    # ── Delete ───────────────────────────────────────────────────────────────

    @core_action.delete(action_name="delete")
    async def delete_action(self, request: Request) -> ApiResponse:
        """DELETE /api/v1/graph/cron_event/{id}"""
        _require_desktop()
        # Remove from APScheduler
        try:
            scheduler = _get_scheduler()
            if scheduler:
                scheduler.remove_job(self.id)
        except Exception as e:
            logger.debug(f"APScheduler remove_job error (may not exist): {e}")

        await self.delete()
        return ApiSuccessResponse(data={"deleted": True})

    # ── Test ─────────────────────────────────────────────────────────────────

    @core_action.post(action_name="test")
    async def test_action(self, request: Request) -> ApiResponse:
        """POST /api/v1/graph/cron_event/{id}/test — fire the job immediately."""
        _require_desktop()
        self.counter += 1
        self.last_run = datetime.now(timezone.utc)
        await self.update()
        return ApiSuccessResponse(data={"status": "fired", "counter": self.counter})


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_scheduler():
    """Get running scheduler, or None if unavailable."""
    try:
        from flow_sdk.server.scheduler import get_scheduler
        return get_scheduler()
    except Exception:
        return None


async def _sync_entity_from_scheduler(entity: CronEvent):
    """Update a single entity's next_run from APScheduler state."""
    try:
        scheduler = _get_scheduler()
        if scheduler and entity.id:
            job = scheduler.get_job(entity.id)
            if job:
                new_next = job.next_run_time
                if new_next != entity.next_run:
                    entity.next_run = new_next
                    await entity.update()
    except Exception as e:
        logger.debug(f"Scheduler sync error for {entity.id}: {e}")


async def _sync_all_from_scheduler():
    """Sync all APScheduler jobs → DB entities."""
    try:
        scheduler = _get_scheduler()
        if scheduler is None:
            return

        jobs = scheduler.get_jobs()
        job_ids = {job.id for job in jobs}

        # Update next_run for existing jobs
        for job in jobs:
            entity = await CronEvent.get_by_id(job.id)
            if entity:
                entity.next_run = job.next_run_time
                await entity.update()

        # Remove DB entities whose scheduler job no longer exists
        all_entities = await CronEvent.get_all()
        for entity in all_entities:
            if entity.id and entity.id not in job_ids:
                # Orphaned — remove from DB
                await entity.delete()
    except Exception as e:
        logger.debug(f"Full scheduler sync error: {e}")
