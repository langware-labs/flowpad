"""The daily-analysis flow's ``publish`` callback node.

The old monolith (``generate_usage_report`` behind the
``builtin_daily_usage_report`` trigger action) is retired: the pipeline is now
the seeded daily-analysis AgenticFlow — trigger → analyze (pysdk node, see
``flow_sdk/usage_report/flow_node.py``) → THIS callback, which posts the
already-persisted report to the Home Feed. The report id arrives in the
``report_ready`` event payload and becomes the node's ``done`` payload.
"""
from __future__ import annotations

import logging

from flow_sdk.builtin import trigger_callbacks

_log = logging.getLogger(__name__)


@trigger_callbacks.register(
    "flow_publish_usage_report",
    meaning="flow node: post an already-persisted UsageReport to the Home Feed",
)
async def flow_publish_usage_report(event) -> dict:
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    report_id = str((event.data or {}).get("report_id") or "")
    if not report_id:
        raise ValueError("publish: event carries no report_id")

    user = await get_or_create_local_user()
    feed = FeedEntry(
        feed_status=FeedStatus.NEW.value,
        data={"type_id": f"usage_report-{report_id}"},
    )
    await feed.save(user.typeid)
    _log.info("usage_report: posted feed entry for report %s", report_id)
    return {"report_id": report_id}
