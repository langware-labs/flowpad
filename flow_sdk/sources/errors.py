"""What a source or its provider reports. Caller mistakes stay built-in exceptions
(``TypeError``, ``ValueError``, ``RuntimeError``, pydantic ``ValidationError``); everything a
source reports derives from ``SourceError`` and ALSO from the closest built-in, so an
``except PermissionError`` written before this family keeps working.

``origin`` names the one resource affected, when there is one. There is no retry flag and no
automatic retry: the application decides. ``OutcomeUnknown`` is the only "may have happened"
signal — a caller must never read it as "nothing changed".
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.sources.values.origin import CloudOrigin


class SourceError(Exception):
    def __init__(self, message: str = "", *, origin: Optional["CloudOrigin"] = None) -> None:
        super().__init__(message)
        self.origin = origin

    def __reduce__(self):  # errors cross a process boundary intact
        return type(self), (str(self),), {"origin": self.origin}


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


class OutcomeUnknown(SourceError):
    """A write or send may have been applied; its result is unknown."""


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
    "NotFound",
    "OutcomeUnknown",
    "Rejected",
    "SourceError",
    "SourceUnavailable",
    "Unsupported",
]
