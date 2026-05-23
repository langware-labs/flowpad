"""Indexer function: USER_HOME_FOLDER -> PROJECT (Codex provenance).

Codex doesn't shard sessions per-project on disk; the project list lives in
``[projects.*]`` keys of ``<home>/.codex/config.toml`` plus the union of
``session_meta.payload.cwd`` values from rollout JSONLs.

Emits one ``RecordType.PROJECT`` node per distinct cwd. The FSRef path is
the absolute project cwd itself (not under ``.codex``); ``ProjectFsRecord.
from_fsref`` upserts by canonical cwd with ``codex_project=True``. If a
Claude indexer pass already produced a row for the same cwd, the upsert
merges the flags onto the existing row.
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_records.codex.codex_project import (
    _is_valid_cwd,
    _read_codex_projects_from_config,
)
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _scan_cwd(jsonl: Path) -> str | None:
    try:
        with open(jsonl, "rb") as fh:
            head = fh.read(8192).decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in head.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            return None
        if raw.get("type") == "session_meta":
            payload = raw.get("payload") or {}
            cwd = payload.get("cwd")
            if isinstance(cwd, str) and _is_valid_cwd(cwd):
                return cwd
            return None
    return None


def codex_projects_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen_cwds: set[str] = set()
    for node in nodes:
        codex_home = Path(node.path) / ".codex"
        if not codex_home.is_dir():
            continue

        # Source 1: config.toml [projects.*] keys.
        for cwd in _read_codex_projects_from_config(codex_home / "config.toml"):
            if cwd in seen_cwds:
                continue
            seen_cwds.add(cwd)
            out.append(
                FSRef(
                    Path(cwd),
                    record_type=RecordType.PROJECT,  # consolidated
                    parent=node,
                )
            )

        # Source 2: session_meta.payload.cwd from rollout files.
        sessions_root = codex_home / "sessions"
        if not sessions_root.is_dir():
            continue
        for jsonl in sessions_root.rglob("rollout-*.jsonl"):
            cwd = _scan_cwd(jsonl)
            if not cwd or cwd in seen_cwds:
                continue
            seen_cwds.add(cwd)
            out.append(
                FSRef(
                    Path(cwd),
                    record_type=RecordType.PROJECT,  # consolidated
                    parent=node,
                )
            )
    return out
