"""How long an automation lives: how many times it may run, until when, and where it stands.

Every kind, one seam (docs/automations.md "Runs, end and status"):

- ``max_runs`` — it ends after that many real runs (``fire_once`` is ``max_runs`` 1);
- ``expires_at`` — it ends at that time, run or not;
- ``end(rule, reason)`` — the one way it ends: stamped ``ended_at`` / ``ended_reason``, disarmed, unlinked from
  the session it calls back, and its kind's last word said (a reply wait posts that it was cancelled).
  ``enabled`` is never touched: off is the person's switch, ended is the rule's own life;
- ``status(rule)`` — ``active`` · ``off`` · ``done`` · ``expired`` · ``cancelled``, for any screen to show.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal, Optional

from flow_sdk.utils.serialization import iso_to_utc

logger = logging.getLogger(__name__)

EndReason = Literal["max_runs", "expired", "cancelled"]
Status = Literal["active", "off", "done", "expired", "cancelled"]
_END_JOB = "automation-end-"
_STATUS_OF_REASON: dict[str, Status] = {"max_runs": "done", "expired": "expired", "cancelled": "cancelled"}


#: A kind's last word when one of its rules ends: ``(rule, reason)`` (a reply wait posts it was not answered).
_ON_END: list[Callable[[Any, str], Awaitable[None]]] = []


def on_end(hook: Callable[[Any, str], Awaitable[None]]) -> Callable[[Any, str], Awaitable[None]]:
    """Register a kind's on-end hook; each one decides from the rule whether it applies."""
    _ON_END.append(hook)
    return hook


def run_limit(rule: Any) -> Optional[int]:
    """How many real runs it may have: ``max_runs``, or 1 for ``fire_once``; None = no limit."""
    if getattr(rule, "max_runs", None):
        return int(rule.max_runs)
    one_shot = str(getattr(rule, "trigger_type", "")) == "schedule" and getattr(rule, "sched_trigger_type", None) == "date"
    return 1 if getattr(rule, "fire_once", False) or one_shot else None


def past_its_time(rule: Any) -> bool:
    until = iso_to_utc(getattr(rule, "expires_at", None))
    return until is not None and until <= datetime.now(timezone.utc)


def _spent(rule: Any) -> bool:
    limit = run_limit(rule)
    return limit is not None and (rule.counter or 0) >= limit


def status(rule: Any) -> Status:
    reason = getattr(rule, "ended_reason", None)
    if reason:
        return _STATUS_OF_REASON.get(reason, "done")
    if _spent(rule):
        return "done"
    if past_its_time(rule):
        return "expired"
    return "active" if getattr(rule, "enabled", True) else "off"


def runs_left(rule: Any) -> Optional[int]:
    limit = run_limit(rule)
    return None if limit is None else max(limit - (rule.counter or 0), 0)


async def may_run(rule: Any) -> bool:
    """Before a real run: a rule that ended (or should have) does not run — and ends now if it is late."""
    if getattr(rule, "ended_reason", None):
        return False
    if past_its_time(rule):
        await end(rule, "expired")
        return False
    if _spent(rule):
        await end(rule, "max_runs")
        return False
    return True


async def after_run(rule: Any) -> None:
    """After a real run was accepted (the counter moved): the last allowed run ends the rule."""
    if _spent(rule):
        await end(rule, "max_runs")


async def end(rule: Any, reason: EndReason) -> None:
    """The one way an automation ends. Idempotent: an ended rule keeps its first reason."""
    from flow_sdk.builtin.trigger_arming import disarm_trigger  # noqa: PLC0415

    if getattr(rule, "ended_reason", None) or not getattr(rule, "id", None):
        return
    rule.ended_reason = reason
    rule.ended_at = datetime.now(timezone.utc)
    await rule.update()
    await disarm_trigger(str(rule.id))
    _drop_end_job(str(rule.id))
    try:
        await rule.link_process(on=False)  # the session's chip shows only rules that still run
    except Exception:  # noqa: BLE001 — an end never fails over a chip
        logger.debug("unlink on end failed for %s", rule.id, exc_info=True)
    _emit_ended(rule, reason)
    for hook in _ON_END:
        try:
            await hook(rule, reason)
        except Exception:  # noqa: BLE001 — a last word never undoes the end
            logger.exception("on-end hook %s failed for %s", getattr(hook, "__name__", hook), rule.id)


def _emit_ended(rule: Any, reason: str) -> None:
    try:
        from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

        emit_tag("trigger.ended", target_of("trigger", str(rule.id)),
                 {"reason": reason, "runs": rule.counter or 0, "name": rule.name or ""})
    except Exception:  # noqa: BLE001
        logger.debug("trigger.ended not emitted", exc_info=True)


async def on_arm(rule: Any) -> bool:
    """While arming: False when the rule has ended (it stays disarmed); else its end time is set as a job."""
    if not await may_run(rule):
        return False
    until = iso_to_utc(getattr(rule, "expires_at", None))
    if until is not None:
        await _schedule_end_job(str(rule.id), until)
    return True


def _end_job_id(rule_id: str) -> str:
    return f"{_END_JOB}{rule_id}"


async def _schedule_end_job(rule_id: str, until: datetime) -> None:
    from flow_sdk.builtin.trigger import _get_scheduler  # noqa: PLC0415
    from flow_sdk.server.scheduler import _job_registration_lock  # noqa: PLC0415

    scheduler = _get_scheduler()
    if scheduler is None:
        return
    try:
        async with _job_registration_lock:
            scheduler.add_job(_end_job, trigger="date", run_date=until, id=_end_job_id(rule_id),
                              args=[rule_id], replace_existing=True, misfire_grace_time=None)
    except Exception:  # noqa: BLE001 — the next arm ends an overdue one
        logger.exception("could not schedule the end of %s", rule_id)


async def _end_job(rule_id: str) -> None:
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415

    rule = await Trigger.get_by_id(rule_id)
    if rule is not None:
        await end(rule, "expired")


def _drop_end_job(rule_id: str) -> None:
    from flow_sdk.builtin.trigger import _get_scheduler  # noqa: PLC0415

    scheduler = _get_scheduler()
    try:
        if scheduler is not None and scheduler.get_job(_end_job_id(rule_id)):
            scheduler.remove_job(_end_job_id(rule_id))
    except Exception:  # noqa: BLE001
        logger.debug("no end job for %s", rule_id, exc_info=True)
