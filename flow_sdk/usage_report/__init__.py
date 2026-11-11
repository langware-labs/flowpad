"""Usage analysis — deterministic, date-range agentic-usage reports.

``analyze_usage(start, end)`` walks the Claude session transcripts whose start
falls in ``[start, end)`` and aggregates cost / time / tokens / skills / agents /
prompts / tools into a ``usage.summary`` value (:class:`UsageSummarySpec`). It is a *pure* function (no DB
writes, no LLM) so weekly/monthly variants reuse it by passing a wider range, and
it is cheap to unit-test.

The Daily usage summary automation runs it through the ``usage-summary`` FlowCall block
(``flowpad_assistant/agentic-assets/compute_op/usage-summary``), which keeps the
``UsageReport`` and posts the headline into the automation's conversation.
"""
from .analyze import (
    analyze_usage,
    headline,
    render_markdown,
    yesterday,
)

__all__ = [
    "analyze_usage",
    "headline",
    "render_markdown",
    "yesterday",
]
