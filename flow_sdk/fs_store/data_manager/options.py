"""Options dataclasses for DataManager phases.

No SDK imports at module level — safe from circular-import chains.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class IndexOptions:
    """Base options shared by all DataManager phases."""

    types: list[str] | None = None  # None = all default registered types
    limit: int | None = None        # max records per type


@dataclass
class ScanOptions(IndexOptions):
    """Options for DataManager.scan() — filesystem discovery only."""


@dataclass
class IndexMetaOptions(IndexOptions):
    """Options for DataManager.index_meta() — entity DB row writes."""

    skip_fresh: bool = False  # skip records whose hash sentinel already exists


@dataclass
class IndexSearchOptions(IndexOptions):
    """Options for DataManager.index_search() — FTS entry writes."""


@dataclass
class IndexAllOptions(IndexOptions):
    """Options for DataManager.index_all() — full scan → meta → search pipeline."""

    skip_fresh: bool = False
