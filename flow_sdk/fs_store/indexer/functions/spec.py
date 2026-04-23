"""Indexer function: REAL_PROJECT_CWD -> SPEC.

Reproduces flow_sdk/fs_records/spec_record.py:_external_source_iter.
Specs live only at <project>/specs/<name>/spec.md — no user-level equivalent.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def spec_project_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        specs_root = Path(node.path) / "specs"
        if not specs_root.is_dir():
            continue
        for spec_dir in sorted(specs_root.iterdir()):
            md = spec_dir / "spec.md"
            if not md.is_file():
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.SPEC, parent=node)
            )
    return out
