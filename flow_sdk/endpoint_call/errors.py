"""Why a call through a hub ``APIEndpoint`` did not produce its value, as one closed word."""

from __future__ import annotations

from typing import Any, Literal

EndpointCallFailure = Literal[
    "invalid_request",  # the request does not fit the capability, or the vendor refused its shape
    "no_endpoint",  # nothing this user may call serves the kind, or no dialect speaks its vendor
    "auth",
    "rate_limited",
    "billing",  # the vendor account is out of credit
    "unavailable",  # the hub or the vendor could not be reached
    "bad_response",  # an answer that is not the vendor's documented shape
    "failed",  # the vendor took the job and reported that it failed
    "timed_out",  # the job did not finish in the time allowed
]


class EndpointCallError(Exception):
    def __init__(
        self, reason: EndpointCallFailure, message: str, *, status: int | None = None, job_id: str = ""
    ) -> None:
        super().__init__(message)
        self.reason: EndpointCallFailure = reason
        self.message = message
        self.status = status
        #: The vendor job the call had started, when it got that far -- so it can be looked up.
        self.job_id = job_id


def reason_for(status: int, body: Any = None) -> EndpointCallFailure:
    """The hub's own refusals for an ``invoke`` and a vendor's statuses, folded into one word."""
    if isinstance(body, dict) and body.get("error") == "kind_not_served":
        return "no_endpoint"
    if status in (401, 403):
        return "auth"
    if status == 429:
        return "rate_limited"
    if status == 402:
        return "billing"
    if status == 503:
        return "no_endpoint"
    if status in (400, 404, 422):
        return "invalid_request"
    return "unavailable"


def detail_of(body: Any) -> str:
    """The sentence an error body carries, whichever key the hub or the vendor put it under."""
    if isinstance(body, dict):
        said = body.get("message") or body.get("msg") or body.get("error") or body.get("detail")
        if isinstance(said, dict):
            return detail_of(said)
        return str(said) if said else str(body)[:300]
    return str(body)[:300] if body else ""


__all__ = ["EndpointCallError", "EndpointCallFailure", "detail_of", "reason_for"]
