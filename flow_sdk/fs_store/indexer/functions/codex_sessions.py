"""Indexer function: USER_HOME_FOLDER -> CODEX_SESSION.

Given a user HOME directory node, enumerates rollout JSONL files under
``<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`` and emits one
CODEX_SESSION node per file. Path enumeration only — no file reads.

Honors ``CODEX_HOME`` indirectly via the InstanceSettings layer when the
indexer roots resolve a non-default home; otherwise the literal
``<node.path>/.codex/sessions`` is walked.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def codex_sessions_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        sessions_root = Path(node.path) / ".codex" / "sessions"
        if not sessions_root.is_dir():
            continue
        for jsonl in sessions_root.rglob("rollout-*.jsonl"):
            out.append(
                FSRef(
                    jsonl,
                    record_type=RecordType.CODEX_SESSION,
                    parent=node,
                )
            )
    return out
