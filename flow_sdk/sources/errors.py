"""What a source or its provider reports. Caller mistakes stay built-in exceptions
(``TypeError``, ``ValueError``, ``RuntimeError``, pydantic ``ValidationError``); everything a
source reports derives from ``SourceError`` and ALSO from the closest built-in, so an
``except PermissionError`` written before this family keeps working.

``origin`` names the one resource affected, when there is one. ``provider`` names the data source
that said it, so the message a person reads starts "Data source error: <provider>". A source retries
a rate limit only when its row's ``rate_limit_retries`` is above 0 (default 0); otherwise the
application decides. ``OutcomeUnknown`` is the only "may have happened"
signal — a caller must never read it as "nothing changed".
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.sources.values.origin import CloudOrigin


class SourceError(Exception):
    def __init__(self, message: str = "", *, origin: Optional["CloudOrigin"] = None, provider: str = "") -> None:
        super().__init__(message)
        self.origin = origin
        self.provider = provider

    @property
    def message(self) -> str:
        """The source's own words, without the "Data source error" label."""
        return str(self.args[0]) if self.args else ""

    def __str__(self) -> str:
        said = self.message
        return f"Data source error: {self.provider} — {said}" if self.provider else f"Data source error: {said}"

    def __reduce__(self):  # errors cross a process boundary intact
        return type(self), (self.message,), {"origin": self.origin, "provider": self.provider}


class AccessDenied(SourceError, PermissionError):
    """The source refused access to the resource or operation."""


class SourceUnavailable(SourceError, ConnectionError):
    """Transport, storage or rate-limit failure."""


class NotFound(SourceError, LookupError):
    """A resource the operation requires does not exist. ``get`` returns ``None`` instead."""


class Unsupported(SourceError, NotImplementedError):
    """The source cannot perform this operation, query family or addressing mode."""


class InvalidCursor(SourceError, ValueError):
    """A continuation is malformed, expired or belongs to another query."""


class Rejected(SourceError):
    """The provider refused a write for its own reasons: an invariant, uniqueness, policy."""


class Conflict(Rejected):
    """A conditional write found the resource at another version than the one it was told to expect."""


class OutcomeUnknown(SourceError):
    """A write or send may have been applied; its result is unknown."""


#: The family members a person must act on: refused access, a missing resource, an unsupported operation, a rejected
#: input. Every other member (unavailable, outcome unknown, a stale cursor) is retried on the next tick.
NEEDS_A_PERSON: tuple[type[SourceError], ...] = (AccessDenied, NotFound, Unsupported, Rejected)


def is_transient(exc: BaseException) -> bool:
    """A failure that says nothing about the setup — the provider did not answer, or not yet. A ``verify`` re-raises
    one rather than reporting "not set up"."""
    return isinstance(exc, SourceError) and not isinstance(exc, NEEDS_A_PERSON)


#: Every class a boundary (RPC, REST) may re-raise by name.
FAMILY: tuple[type[BaseException], ...] = (
    AccessDenied,
    SourceUnavailable,
    NotFound,
    Unsupported,
    InvalidCursor,
    Rejected,
    OutcomeUnknown,
)

__all__ = [
    "FAMILY",
    "AccessDenied",
    "InvalidCursor",
    "NEEDS_A_PERSON",
    "NotFound",
    "OutcomeUnknown",
    "Rejected",
    "SourceError",
    "SourceUnavailable",
    "Unsupported",
    "is_transient",
]
