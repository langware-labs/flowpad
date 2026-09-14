"""Adapt library repo-tree candidates into indexer traversal references."""
from pathlib import Path

from flow_sdk.assets.scanning import scan_repo_tree
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.indexer.index_log import UNCLASSIFIED_IN_FAMILY_DIR, ScanIssue, append_scan_issue
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType


def repo_assets_fn(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
    out = []
    requested = {str(value) for value in opts.types} if opts.types is not None else None
    infos = SchemaRegistry.repo_family_to_info()
    for node in nodes:
        root = Path(node.path)
        result = scan_repo_tree(root, infos, types=requested)
        parents = {root: node}
        for candidate in result.candidates:
            ref = FSRef(candidate.path, record_type=EntityType(candidate.type_name),
                        parent=parents[candidate.traversal_parent], layout=candidate.layout)
            parents[candidate.path] = ref
            if candidate.included:
                out.append(ref)
        for issue in result.issues:
            append_scan_issue(ScanIssue(path=str(issue.path), kind=UNCLASSIFIED_IN_FAMILY_DIR,
                                       detail=issue.message, type_name=issue.type_name))
    return out
