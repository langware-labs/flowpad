"""``WorkerUnavailableEntry`` — a worker cannot serve the current request."""

from __future__ import annotations

from typing import Any, Literal

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry

WorkerUnavailableReason = Literal["quota_exhausted", "rate_limited"]

# The vendor-blind vocabulary every parser classifies a provider limit with.
# One owner, so ``reason`` means the same thing whichever CLI reported it.
_QUOTA_EXHAUSTED_MARKERS = (
    "weekly limit",
    "usage limit",
    "credit limit",
    "credits limit",
    "out of credits",
    "credits exhausted",
)
_RATE_LIMIT_MARKERS = ("rate limit", "too many requests", "429")


def classify_limit_reason(message: str) -> WorkerUnavailableReason | None:
    """The limit ``reason`` a provider message states, or None if it states none."""
    folded = message.casefold()
    if any(marker in folded for marker in _QUOTA_EXHAUSTED_MARKERS):
        return "quota_exhausted"
    if any(marker in folded for marker in _RATE_LIMIT_MARKERS):
        return "rate_limited"
    return None


class WorkerUnavailableEntry(TranscriptEntry):
    """Normalized provider failure that another configured worker can recover."""

    kind = EntryKind.WORKER_UNAVAILABLE

    def __init__(
        self,
        *,
        reason: WorkerUnavailableReason,
        worker_type: str,
        provider_error: str,
        status_code: int | None,
        message: str,
        recoverable_with_alternative: bool = True,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.reason = reason
        self.worker_type = worker_type
        self.provider_error = provider_error
        self.status_code = status_code
        self.message = message
        self.recoverable_with_alternative = recoverable_with_alternative

    def to_flow_data(self) -> list[FlowData]:
        payload = {
            "reason": self.reason,
            "worker": self.worker,
            "worker_type": self.worker_type,
            "provider_error": self.provider_error,
            "status_code": self.status_code,
            "message": self.message,
            "recoverable_with_alternative": self.recoverable_with_alternative,
        }
        attributes = {
            "element-type": FlowElementType.WORKER_UNAVAILABLE,
            "data-type": FlowDataType.OBJECT,
            "subtype": self.kind.value,
            "reason": self.reason,
            "worker": self.worker,
            "worker-type": self.worker_type,
            "provider-error": self.provider_error,
            "recoverable-with-alternative": (
                "true" if self.recoverable_with_alternative else "false"
            ),
        }
        if self.status_code is not None:
            attributes["status-code"] = str(self.status_code)
        return [
            FlowData(
                flow_value=payload,
                created_time=self.timestamp,
                attributes=attributes,
            )
        ]

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "reason": self.reason,
            "worker_type": self.worker_type,
            "provider_error": self.provider_error,
            "status_code": self.status_code,
            "message": self.message,
            "recoverable_with_alternative": self.recoverable_with_alternative,
        }

    def _body_lines(self) -> list[str]:
        out = [
            f"reason: {self.reason}",
            f"worker_type: {self.worker_type}",
            f"provider_error: {self.provider_error}",
        ]
        if self.status_code is not None:
            out.append(f"status_code: {self.status_code}")
        out.append(
            "recoverable_with_alternative: "
            f"{str(self.recoverable_with_alternative).lower()}"
        )
        out.extend(render_block("message", self.message))
        return out
