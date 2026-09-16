"""One page of a traversal. ``next_cursor=None`` is the only end signal; a page may be empty
and still continue. A cursor belongs to the query that produced it and is not a durable
checkpoint — except where a source declares ``durable_cursor`` and hands back a
``resume_cursor`` on a ``ChangePage``, which the application may persist."""

from __future__ import annotations

from typing import Annotated, ClassVar, Optional

from pydantic import StringConstraints

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values.items import FileItem, SourceItemSpec
from flow_sdk.sources.values.origin import CloudOrigin

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 1000


class DataPage(DataSpec):
    spec_kind: ClassVar[str] = "source.page"

    items: tuple[SourceItemSpec, ...]
    next_cursor: Optional[Annotated[str, StringConstraints(min_length=1)]] = None


class FileDataPage(DataPage):
    items: tuple[FileItem, ...]


class Move(DataSpec):
    """A resource the source observed moving: it now lives at ``origin``, it was ``previous``."""

    spec_kind: ClassVar[str] = "source.move"

    origin: CloudOrigin
    previous: CloudOrigin


class ChangePage(DataPage):
    """A page from a source that can also report what left or moved since the cursor —
    only a source that genuinely observes absence or moves may fill ``removed``/``moved``.
    ``resume_cursor`` is where the NEXT traversal starts; it is distinct from ``next_cursor``,
    which continues THIS one."""

    spec_kind: ClassVar[str] = "source.page.changes"

    removed: tuple[CloudOrigin, ...] = ()
    moved: tuple[Move, ...] = ()
    resume_cursor: Optional[str] = None


__all__ = ["DEFAULT_PAGE_SIZE", "MAX_PAGE_SIZE", "ChangePage", "DataPage", "FileDataPage", "Move"]
