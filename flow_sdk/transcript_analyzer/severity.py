"""Severity classifier — Python mirror of ``ts_sdk/src/models/severity.ts``.

Single source of truth for collapsing analyzer-emitted severity vocabularies
(``error/warn/info``, ``high/medium/low``, ``blocker/derived/info``) into
three canonical tiers. Used by future analyzer skill builds and any
backend cost/quality dashboards.

Keep the token sets in sync with the TypeScript file.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional


class SeverityTier(str, Enum):
    """Three-tier severity model — see ``severity.ts`` for UI rules."""

    ATTENTION = "attention"
    NOTABLE = "notable"
    INFO = "info"


_ATTENTION_TOKENS = frozenset(
    {
        "attention",
        "error",
        "blocker",
        "critical",
        "fatal",
        "high",
        "sut_regression",
        "regression",
        "sla_violation",
        "status_mismatch",
    }
)

_NOTABLE_TOKENS = frozenset(
    {
        "notable",
        "warn",
        "warning",
        "medium",
        "retry",
        "wrong_tool",
        "mid_run_toolsearch",
        "incomplete",
        "protocol_violation",
        "visibility_check",
        "visibility_heuristic_override",
    }
)

_INFO_TOKENS = frozenset(
    {
        "info",
        "low",
        "derived",
        "observation",
        "behavior",
        "latency",
    }
)


def classify_severity(
    raw_severity: Optional[str] = None,
    raw_kind: Optional[str] = None,
    raw_category: Optional[str] = None,
) -> SeverityTier:
    """Collapse analyzer-emitted severity strings to a canonical tier.

    Precedence: ``severity → kind → category``. Unknown tokens default to
    NOTABLE so the user still sees them (better to over-show than lose a
    real issue).

    Mirrors ``classifySeverity`` in ``ts_sdk/src/models/severity.ts``.
    """
    for raw in (raw_severity, raw_kind, raw_category):
        if not raw:
            continue
        token = str(raw).strip().lower()
        if not token:
            continue
        if token in _ATTENTION_TOKENS:
            return SeverityTier.ATTENTION
        if token in _NOTABLE_TOKENS:
            return SeverityTier.NOTABLE
        if token in _INFO_TOKENS:
            return SeverityTier.INFO
    return SeverityTier.NOTABLE


SEVERITY_RANK: dict[SeverityTier, int] = {
    SeverityTier.ATTENTION: 2,
    SeverityTier.NOTABLE: 1,
    SeverityTier.INFO: 0,
}


def is_visible_in_simple_mode(tier: SeverityTier) -> bool:
    return tier is not SeverityTier.INFO
