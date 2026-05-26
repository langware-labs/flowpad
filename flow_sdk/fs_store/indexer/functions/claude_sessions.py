"""Indexer function: PROJECT -> CLAUDE_SESSION.

Given a PROJECT node (an encoded project dir under ~/.claude/projects/),
enumerates *.jsonl session files and emits one CLAUDE_SESSION node per file.
Path enumeration only — no file reads.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def claude_sessions_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        for jsonl in sorted(Path(node.path).glob("*.jsonl")):
            out.append(
                FSRef(
                    jsonl,
                    record_type=RecordType.CLAUDE_SESSION,
                    parent=node,
                )
            )
    return out
