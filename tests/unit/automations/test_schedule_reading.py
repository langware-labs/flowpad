"""Schedules read back the way a person chose them, and say when they run next."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from flow_sdk.automations.schedule import next_fire_times, read_schedule, schedule_text

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.mark.parametrize("expr,kind,preset,text", [
    ("0 9 * * *", "cron", "daily", "Every day at 09:00"),
    ("30 8 * * 1-5", "cron", "weekdays", "Every weekday at 08:30"),
    ("0 9 * * 1", "cron", "weekly", "Every Monday at 09:00"),
    ("0 9 * * 0", "cron", "weekly", "Every Sunday at 09:00"),
    ("15 6 1 * *", "cron", "monthly", "On day 1 of each month at 06:15"),
    ("*/5 * * * *", "cron", "cron", "On the schedule */5 * * * *"),
    ("30m", "interval", "every", "Every 30 minutes"),
    ("1h", "interval", "every", "Every hour"),
    ("2026-10-06T09:00:00", "date", "once", "Once, at 2026-10-06 09:00:00"),
])
def test_presets_read_back(expr, kind, preset, text):
    when = read_schedule(expr, kind)
    assert when.preset == preset
    assert schedule_text(when) == text


def test_timezone_is_named():
    assert schedule_text(read_schedule("0 9 * * *", "cron", "Asia/Jerusalem")) == "Every day at 09:00 (Asia/Jerusalem)"


def test_next_weekday_runs_skip_the_weekend():
    friday_noon = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
    times = next_fire_times("0 9 * * 1-5", "cron", "UTC", 3, now=friday_noon)
    assert [t.strftime("%a %d %H:%M") for t in times] == ["Mon 12 09:00", "Tue 13 09:00", "Wed 14 09:00"]


def test_next_runs_follow_the_timezone():
    now = datetime(2026, 10, 5, 0, 0, tzinfo=timezone.utc)
    (first,) = next_fire_times("0 9 * * *", "cron", "Asia/Jerusalem", 1, now=now)
    assert first.astimezone(timezone.utc).hour == 6  # 09:00 IDT is 06:00 UTC


def test_interval_steps_forward():
    now = datetime(2026, 10, 5, 0, 0, tzinfo=timezone.utc)
    a, b = next_fire_times("30m", "interval", None, 2, now=now)
    assert (b - a).total_seconds() == 1800


def test_a_one_shot_in_the_past_has_no_next_run():
    now = datetime(2026, 10, 5, tzinfo=timezone.utc)
    assert next_fire_times("2026-01-01T09:00:00+00:00", "date", None, 3, now=now) == []


def test_a_bad_expression_raises():
    with pytest.raises(ValueError):
        next_fire_times("not a cron", "cron")


@pytest.mark.parametrize("field,names", [
    ("1-5", "mon,tue,wed,thu,fri"),
    ("0", "sun"),
    ("7", "sun"),
    ("0-3", "sun,mon,tue,wed"),
    ("5-7", "sun,fri,sat"),
    ("*/2", "sun,tue,thu,sat"),
    ("1,3,5", "mon,wed,fri"),
    ("mon-fri", "mon,tue,wed,thu,fri"),
    ("*", "*"),
])
def test_crontab_weekdays_mean_what_crontab_means(field, names):
    from flow_sdk.builtin.trigger import crontab_weekdays_as_names

    assert crontab_weekdays_as_names(field) == names


def test_the_real_scheduler_runs_weekday_schedules_on_monday_not_saturday():
    # The bug: APScheduler 3.x read crontab "1-5" with Monday = 0 → Tue..Sat.
    from flow_sdk.builtin.trigger import _parse_trigger

    trigger = _parse_trigger("cron", "0 9 * * 1-5", "UTC")
    friday_noon = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
    nxt = trigger.get_next_fire_time(None, friday_noon)
    assert nxt.strftime("%a") == "Mon"
