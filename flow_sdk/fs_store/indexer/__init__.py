"""FSIndexer — minimal unified walker under fs_store/."""

from flow_sdk.fs_store.indexer.auto_index import ScanMode
from flow_sdk.fs_store.indexer.builtin import (
    build_default_indexer,
    get_auto_scan_indexer,
    get_shared_indexer,
    indexable_types,
    reset_shared_indexer,
)
from flow_sdk.fs_store.indexer.index_function import (
    FSIndexer,
    IndexerFunc,
    IndexerOptions,
    IndexResult,
    OrphanAction,
    PerTypeIndexResult,
    ProgressCallback,
)
from flow_sdk.fs_store.indexer.progress_table import (
    PROGRESS_TEXT_COMPLETE,
    IndexProgressTable,
    TypeProgressRow,
)
from flow_sdk.fs_store.indexer.roots import default_roots

__all__ = [
    "FSIndexer",
    "IndexerFunc",
    "IndexerOptions",
    "IndexResult",
    "IndexProgressTable",
    "OrphanAction",
    "PROGRESS_TEXT_COMPLETE",
    "PerTypeIndexResult",
    "ProgressCallback",
    "TypeProgressRow",
    "indexable_types",
    "ScanMode",
    "build_default_indexer",
    "get_auto_scan_indexer",
    "get_shared_indexer",
    "reset_shared_indexer",
    "default_roots",
]


