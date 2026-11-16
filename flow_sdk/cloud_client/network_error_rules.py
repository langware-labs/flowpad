"""Which failed hub calls the user is told about.

One ordered table; the first matching row wins. Every failure is recorded whatever its row says
(``error_reporter``) -- a row only decides whether it raises the visible warning. A row that can
show names what the user can do about it; a failure with nothing to do is ``never``.
"""

from __future__ import annotations

from fnmatch import fnmatchcase
from typing import Literal

from pydantic import model_validator

from flow_sdk.schema.data_spec.spec import DataSpec


class NetworkErrorRule(DataSpec):
    method: str = "*"
    path: str = "*"  # glob over the request path, ids written as ``*``
    status: str = "*"  # "0" (no response), an exact code, "4xx" / "5xx", or "*"
    show: Literal["always", "never", "above_rate"]
    # above_rate: shown once MORE than ``max_events`` fail inside ``window_seconds``.
    max_events: int | None = None
    window_seconds: float | None = None
    action: str = ""  # what the user can do; empty only when the row never shows
    reason: str

    @model_validator(mode="after")
    def _a_rate_has_its_numbers(self) -> NetworkErrorRule:
        if self.show == "above_rate" and (self.max_events is None or not self.window_seconds):
            raise ValueError("an above_rate rule needs max_events and window_seconds")
        return self

    def matches(self, method: str, path: str, status: int) -> bool:
        if self.method not in ("*", method.upper()):
            return False
        if self.status not in ("*", str(status), f"{status // 100}xx"):
            return False
        return fnmatchcase(path.split("?", 1)[0], self.path)


class NetworkErrorEntry(DataSpec):
    """One failed hub call, as kept in memory and listed under Logs."""

    at: float  # seconds since the epoch
    method: str
    path: str
    status: int
    message: str
    rule: str  # the ``reason`` of the row that matched
    shown: bool


RULES: tuple[NetworkErrorRule, ...] = (
    NetworkErrorRule(
        method="POST",
        path="/api/v1/graph/compute_node/*/ops/status",
        status="0",
        show="above_rate",
        max_events=1,
        window_seconds=300,
        action="Check your connection",
        reason="background machine status poll; one miss is noise",
    ),
    NetworkErrorRule(status="401", show="always", action="Sign in", reason="credential rejected"),
    NetworkErrorRule(status="402", show="always", action="Add funds", reason="out of credit"),
    NetworkErrorRule(
        status="0",
        show="above_rate",
        max_events=5,
        window_seconds=60,
        action="Check your connection",
        reason="a run of unanswered calls means the cloud is unreachable",
    ),
    NetworkErrorRule(
        status="5xx",
        show="above_rate",
        max_events=5,
        window_seconds=60,
        action="Report it",
        reason="a single hub hiccup needs nothing from the user",
    ),
    NetworkErrorRule(show="always", action="Report it", reason="unknown failures stay visible"),
)
