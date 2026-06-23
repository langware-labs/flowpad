"""Usage analysis — deterministic, date-range agentic-usage reports.

``analyze_usage(start, end)`` walks the Claude session transcripts whose start
falls in ``[start, end)`` and aggregates cost / time / tokens / skills / agents /
prompts / tools into a :class:`UsageReportData`. It is a *pure* function (no DB
writes, no LLM) so weekly/monthly variants reuse it by passing a wider range, and
it is cheap to unit-test.

The daily trigger (``flow_sdk/usage_report/callback.py``) is the one consumer that
persists the result as a ``UsageReport`` entity + Home-Feed entry.
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
