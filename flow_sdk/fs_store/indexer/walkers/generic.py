"""Index adapters for the filesystem library's declared candidate scanner."""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.assets.scanning import first_seen, scan_declared
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerFunc, IndexerOptions
from flow_sdk.fs_store.indexer.index_log import UNCLASSIFIED_IN_FAMILY_DIR, ScanIssue, append_scan_issue
from flow_sdk.fs_store.record_types import RecordType

if TYPE_CHECKING:
    from flow_sdk.fs_store.schema_registry import TypeInfo


def walk_roots(info: TypeInfo) -> tuple[RecordType, ...]:
    return tuple(dict.fromkeys(RecordType(root) for walk in info.walk for root in walk.roots))


def layout_walker(info: TypeInfo) -> IndexerFunc:
    if not info.walk:
        raise ValueError(f"{info.type_name}: no walk declared")

    def walker(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
        out: list[FSRef] = []
        seen: set[str] = set()
        for node in nodes:
            result = scan_declared(info, Path(node.path), str(node.record_type))
            for candidate in result.candidates:
                if first_seen(seen, candidate.path):
                    out.append(FSRef(candidate.path, record_type=RecordType(candidate.type_name),
                                     parent=node, layout=candidate.layout))
            for issue in result.issues:
                append_scan_issue(ScanIssue(path=str(issue.path), kind=UNCLASSIFIED_IN_FAMILY_DIR,
                                           detail=issue.message, type_name=issue.type_name))
        return out
    walker.__name__ = walker.__qualname__ = f"layout_walker[{info.type_name}]"
    return walker


def walker_for(type_name: str) -> IndexerFunc:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    info = SchemaRegistry.get(type_name)
    if info is None:
        raise KeyError(f"unknown type {type_name!r}")
    return layout_walker(info)
