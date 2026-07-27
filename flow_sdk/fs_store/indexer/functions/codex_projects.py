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
import uuid
from pathlib import Path

try:
    import tomllib as _tomllib  # type: ignore[import-not-found]
except ImportError:
    import tomli as _tomllib  # type: ignore[import-not-found,no-redef]

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.path_utils import is_valid_project_cwd
from flow_sdk.fs_store.record_types import RecordType

# ── Codex project path helpers (inlined from former fs_records/codex/codex_project.py) ──


def _codex_project_id(cwd: str) -> str:
    """Deterministic uuid5 id for a codex project keyed on canonical cwd."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"codex_project:{cwd}"))


def _read_codex_projects_from_config(
    config_path: Path,
    *,
    include_temp: bool = False,
) -> dict[str, dict]:
    """Return ``{absolute_path: {trust_level}}`` from ``config.toml``."""
    if not config_path.is_file():
        return {}
    try:
        with open(config_path, "rb") as fh:
            data = _tomllib.load(fh)
    except (OSError, ValueError):
        return {}
    projects = data.get("projects")
    if not isinstance(projects, dict):
        return {}
    out: dict[str, dict] = {}
    for path, entry in projects.items():
        if not isinstance(path, str) or not is_valid_project_cwd(
            path,
            include_temp=include_temp,
        ):
            continue
        if isinstance(entry, dict):
            out[path] = {"trust_level": entry.get("trust_level")}
        else:
            out[path] = {"trust_level": None}
    return out


def _scan_cwd(jsonl: Path, *, include_temp: bool = False) -> str | None:
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
            if isinstance(cwd, str) and is_valid_project_cwd(
                cwd,
                include_temp=include_temp,
            ):
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
        for cwd in _read_codex_projects_from_config(
            codex_home / "config.toml",
            include_temp=opts.include_temp,
        ):
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
            cwd = _scan_cwd(jsonl, include_temp=opts.include_temp)
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
