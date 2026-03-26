"""Result dataclasses for DataManager phases.

No SDK imports at module level — safe from circular-import chains.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class DiscoveryResult:
    """Result of DataManager.scan() — filesystem discovery."""

    records: list        # list[Record] — typed as list to avoid circular import
    by_type: dict[str, list]
    total: int
    duration_ms: float


@dataclass
class IndexMetaResult:
    """Result of DataManager.index_meta() — entity DB row writes."""

    indexed: int
    skipped: int
    errors: int
    duration_ms: float


@dataclass
class IndexSearchResult:
    """Result of DataManager.index_search() — FTS entry writes."""

    indexed: int
    errors: int
    duration_ms: float


@dataclass
class IndexAllResult:
    """Result of DataManager.index_all() — full pipeline."""

    discovery: DiscoveryResult
    meta: IndexMetaResult
    search: IndexSearchResult
    duration_ms: float
