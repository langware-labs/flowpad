"""The two rules every backend stream obeys: the terminal ``StreamEnd`` and the
errno NAME an unreadable item carries (spec §0 Completeness, §0 Values)."""

from __future__ import annotations

import errno
from typing import Iterable, Iterator, TypeVar

from flow_sdk.diskio.contract import ItemError, StreamEnd
from flow_sdk.schema.data_spec.spec import DataSpec

T = TypeVar("T", bound=DataSpec)


def with_end(items: Iterable[T]) -> Iterator[T | StreamEnd]:
    """Yield ``items``, then exactly ONE ``StreamEnd`` counting them by kind."""
    counts: dict[str, int] = {}
    for item in items:
        kind = type(item).spec_kind
        counts[kind] = counts.get(kind, 0) + 1
        yield item
    yield StreamEnd(counts=counts)


def errno_name(error: OSError) -> str:
    """``EACCES`` / ``EPERM`` / ``ENOENT`` …; the exception's class name when it carries no errno."""
    return errno.errorcode.get(error.errno or 0, type(error).__name__)


def unreadable(path: str, error: OSError) -> ItemError:
    return ItemError(path=path, kind="unreadable", detail=errno_name(error))
