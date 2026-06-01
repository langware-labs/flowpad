"""Analytics for ComputeNode — cost / usage / context.

Non-filesystem derived data: cost aggregation over indexed sessions, the
Anthropic usage API probe, and the ``claude -p /context`` subprocess. Replaces
the cost/usage/context branches of the deleted ``system_profile`` scanner.
"""

from flow_sdk.builtin.faas.analytics.actions import AnalyticsActionsMixin

__all__ = ["AnalyticsActionsMixin"]
