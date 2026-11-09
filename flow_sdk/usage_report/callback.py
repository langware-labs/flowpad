"""The daily-analysis flow's ``publish`` GraphWorkflowFunction.

The pipeline is the seeded daily-analysis GraphWorkflow — trigger → analyze
(subprocess function, see ``flow_sdk/usage_report/flow_node.py``) → THIS
inline function, which posts the already-persisted report to the Home Feed.
The report id arrives in the ``report_ready`` event payload and rides through
as the node's ``done`` payload.
"""
from __future__ import annotations

import logging
from typing import Any

from flow_sdk.graph_workflow_manager import graph_workflow_functions

_log = logging.getLogger(__name__)


@graph_workflow_functions.register(
    "flow_publish_usage_report",
    meaning="post an already-persisted UsageReport to the Home Feed",
)
async def flow_publish_usage_report(event_name: str, data: dict, flow_ctx: Any) -> dict:
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    report_id = str((data or {}).get("report_id") or "")
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
