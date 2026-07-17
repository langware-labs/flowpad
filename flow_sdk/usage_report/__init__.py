"""Usage analysis — deterministic, date-range agentic-usage reports.

``analyze_usage(start, end)`` walks the Claude session transcripts whose start
falls in ``[start, end)`` and aggregates cost / time / tokens / skills / agents /
prompts / tools into a :class:`UsageReportData`. It is a *pure* function (no DB
writes, no LLM) so weekly/monthly variants reuse it by passing a wider range, and
it is cheap to unit-test.

The daily-analysis AgenticFlow consumes it in stages: the pysdk ``analyze``
node (``flow_node.py``) runs it and persists the ``UsageReport`` via REST, and
the ``flow_publish_usage_report`` callback (``callback.py``) posts the
Home-Feed entry.
"""
from .analyze import (
    SessionRow,
    UsageReportData,
    analyze_usage,
    render_markdown,
)

__all__ = [
    "SessionRow",
    "UsageReportData",
    "analyze_usage",
    "render_markdown",
]
