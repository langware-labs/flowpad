"""Trigger callback that turns a usage analysis into a UsageReport + Feed entry.

Registered as ``builtin_daily_usage_report`` and dispatched by the
``builtin_daily_usage_analysis`` SCHEDULE trigger (cron ``0 7 * * *``, local
time) — and by a manual ``POST /trigger/{id}/test`` fire, which runs the exact
same path. ``generate_usage_report(start, end)`` is the reusable core: weekly/
monthly variants call it with a wider range.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from flow_sdk.builtin import trigger_callbacks

_log = logging.getLogger(__name__)


def _yesterday_local_range() -> tuple[datetime, datetime]:
    """[yesterday 00:00, today 00:00) in the machine's local timezone."""
    now_local = datetime.now().astimezone()
    today_midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return today_midnight - timedelta(days=1), today_midnight


async def generate_usage_report(start: datetime, end: datetime) -> Optional[str]:
    """Analyze ``[start, end)``, persist a UsageReport, and post a Feed entry.

    Returns the report entity id, or None on failure. The heavy analysis runs in
    a worker thread so the trigger dispatch never blocks the event loop.
    """
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
    from flow_sdk.builtin.usage_report import UsageReport
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from flow_sdk.usage_report import analyze_usage, render_markdown

    data = await asyncio.to_thread(analyze_usage, start, end)
    markdown = render_markdown(data)

    report = UsageReport.from_data(data, markdown=markdown)
    report = await report.save()

    try:
        user = await get_or_create_local_user()
        feed = FeedEntry(
            feed_status=FeedStatus.NEW.value,
            data={"type_id": str(report.typeid)},
        )
        await feed.save(user.typeid)
    except Exception:
        _log.exception("usage_report: failed to post Feed entry for %s", report.id)

    _log.info(
        "usage_report: generated %s (%s sessions, $%.2f) for %s..%s",
        report.id, data.session_count, data.total_cost_usd,
        data.period_start, data.period_end,
    )
    return report.id


@trigger_callbacks.register(
    "builtin_daily_usage_report",
    meaning="Fired daily at 7am (and on manual test). Analyzes the previous "
            "local day's agentic usage, saves a UsageReport entity, and posts it "
            "to the Home Feed.",
)
async def _daily_usage_report(_trigger: Any, _changes: Any) -> None:
    start, end = _yesterday_local_range()
    await generate_usage_report(start, end)
