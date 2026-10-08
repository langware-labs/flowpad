"""Why a decision could not be taken, as one closed word the caller branches on.

A decision is an optimisation, never a dependency: every reason here means the same thing
to the navigator -- fall back to the ordinary path. ``reason`` is what a UI or a test reads;
``message`` is the sentence a person reads.
"""

from __future__ import annotations

from typing import Any, Literal

DecisionFailure = Literal["invalid_spec", "no_endpoint", "rate_limited", "unavailable", "auth", "bad_response"]


class DecisionError(Exception):
    def __init__(self, reason: DecisionFailure, message: str, *, status: int | None = None, wire: Any = None) -> None:
        super().__init__(message)
        self.reason: DecisionFailure = reason
        self.message = message
        #: The HTTP status that produced it, when there was one.
        self.status = status
        #: The call as it happened, when one was made (``decision.wire``): what was sent, what came back.
        self.wire: Any = wire


def reason_for_status(status: int) -> DecisionFailure:
    """The hub's own answers for an ``invoke`` (``docs/api-endpoint.md``) and the vendor's, folded."""
    if status in (401, 403):
        return "auth"
    if status == 429:
        return "rate_limited"
    if status == 503:
        return "no_endpoint"  # disabled, no target or no credential: there is nothing to answer
    if status == 400 or status == 422:
        return "invalid_spec"
    return "unavailable"
