"""DataManager — split-phase indexing pipeline for fs records.

Usage::

    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions, IndexAllOptions

    dm = DataManager()
    result = await dm.scan(ScanOptions(types=["claude_session"], limit=100))
    await dm.index_meta(result.records)
    await dm.index_search(result.records)
"""
from .manager import DataManager
from .options import IndexAllOptions, IndexMetaOptions, IndexOptions, IndexSearchOptions, ScanOptions
from .results import DiscoveryResult, IndexAllResult, IndexMetaResult, IndexSearchResult

__all__ = [
    "DataManager",
    # options
    "IndexOptions",
    "ScanOptions",
    "IndexMetaOptions",
    "IndexSearchOptions",
    "IndexAllOptions",
    # results
    "DiscoveryResult",
    "IndexMetaResult",
    "IndexSearchResult",
    "IndexAllResult",
]
