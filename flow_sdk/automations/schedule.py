"""Schedules in plain words, and when they run next.

``read_schedule`` is the inverse of the builder's presets — a schedule made as
"Every weekday at 09:00" reads back that way, and anything the presets cannot
express falls back to the raw cron. ``next_fire_times`` answers "when will this
run" for a schedule that may not be saved yet: it asks the same APScheduler
trigger the real job uses, without registering a job.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from flow_sdk.schema.data_spec.automation_spec import ScheduleWhen

WEEKDAY_NAMES = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")


def _hhmm(minute: str, hour: str) -> Optional[str]:
    if minute.isdigit() and hour.isdigit():
        return f"{int(hour):02d}:{int(minute):02d}"
    return None


def read_schedule(expr: str, sched_type: Optional[str] = None, tz: Optional[str] = None) -> ScheduleWhen:
    """The preset a schedule matches, with its parameters."""
    expr = (expr or "").strip()
    kind = sched_type or "cron"
    base = {"expr": expr, "sched_type": kind, "timezone": tz or None}
    if kind == "interval":
        from flow_sdk.builtin.trigger import _parse_interval_expr  # noqa: PLC0415

        try:
            seconds = _parse_interval_expr(expr)
        except ValueError:
            return ScheduleWhen(preset="cron", **base)
        return ScheduleWhen(preset="every", interval_seconds=seconds, **base)
    if kind == "date":
        return ScheduleWhen(preset="once", **base)

    parts = expr.split()
    if len(parts) != 5:
        return ScheduleWhen(preset="cron", **base)
    minute, hour, dom, month, dow = parts
    time = _hhmm(minute, hour)
    if time is None or month != "*":
        return ScheduleWhen(preset="cron", **base)
    if dom == "*" and dow == "*":
        return ScheduleWhen(preset="daily", time=time, **base)
    if dom == "*" and dow in ("1-5", "MON-FRI", "mon-fri"):
        return ScheduleWhen(preset="weekdays", time=time, **base)
    if dom == "*" and dow.isdigit():
        return ScheduleWhen(preset="weekly", time=time, weekday=int(dow) % 7, **base)
    if dom.isdigit() and dow == "*":
        return ScheduleWhen(preset="monthly", time=time, month_day=int(dom), **base)
    return ScheduleWhen(preset="cron", **base)


def _every(seconds: int) -> str:
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if seconds % size == 0:
            n = seconds // size
            return f"{n} {unit}s" if n != 1 else unit
    return f"{seconds} seconds"


def schedule_text(when: ScheduleWhen) -> str:
    """English for the CLI and agents. The UI renders ``when`` in its own language."""
    zone = f" ({when.timezone})" if when.timezone else ""
    preset = when.preset
    if preset == "daily":
        text = f"Every day at {when.time}"
    elif preset == "weekdays":
        text = f"Every weekday at {when.time}"
    elif preset == "weekly":
        text = f"Every {WEEKDAY_NAMES[when.weekday or 0]} at {when.time}"
    elif preset == "monthly":
        text = f"On day {when.month_day} of each month at {when.time}"
    elif preset == "every":
        text = f"Every {_every(when.interval_seconds or 0)}"
    elif preset == "once":
        text = f"Once, at {when.expr.replace('T', ' ')}"
    else:
        text = f"On the schedule {when.expr}"
    return text + zone


def next_fire_times(expr: str, sched_type: Optional[str] = None, tz: Optional[str] = None,
                    n: int = 5, now: Optional[datetime] = None) -> list[datetime]:
    """The next ``n`` times this schedule fires. Raises ``ValueError`` on a bad expression.

    Walks the APScheduler trigger's ``get_next_fire_time`` forward — the same
    object the real job is armed with, so this can never disagree with it."""
    from flow_sdk.builtin.trigger import _parse_trigger  # noqa: PLC0415

    trigger = _parse_trigger(sched_type or "cron", expr, tz)
    start = current = now or datetime.now(timezone.utc)
    out: list[datetime] = []
    previous: Optional[datetime] = None
    for _ in range(max(0, n)):
        nxt = trigger.get_next_fire_time(previous, current)
        # A one-shot whose time has passed still answers its run date (that is
        # how a misfire is caught up); it is not a NEXT run.
        if nxt is None or nxt < start:
            break
        out.append(nxt)
        previous = nxt
        # Step past the fire just found, or a cron returns the same instant again.
        from datetime import timedelta  # noqa: PLC0415

        current = nxt + timedelta(microseconds=1)
    return out
