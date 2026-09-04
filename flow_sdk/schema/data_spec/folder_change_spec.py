"""``FolderChange`` — what one poll of a folder source observed, as a value."""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class FolderChange(DataSpec):
    """One page of changes under a watched folder. Frozen; a value is a value.

    Paths are canonical absolute local paths — the coordinate a search index stores. Intent is
    kept (``renamed`` is not ``removed`` + ``added``); the consumer decides what a move means.
    """

    spec_kind: ClassVar[str] = "ingest.folder_change"

    source_id: str
    root: str = ""
    added: list[str] = []
    changed: list[str] = []
    removed: list[str] = []
    renamed: dict[str, str] = {}

    @property
    def paths(self) -> list[str]:
        """Every path this page touched, in one list — for a consumer that treats them alike."""
        return [*self.added, *self.changed, *self.removed, *self.renamed, *self.renamed.values()]


__all__ = ["FolderChange"]
