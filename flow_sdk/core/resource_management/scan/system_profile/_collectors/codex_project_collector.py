"""Codex project collector — enumerates projects Codex CLI knows about.

Two sources are merged:
  1. ``$CODEX_HOME/config.toml`` ``[projects."<path>"]`` keys (authoritative,
     carries ``trust_level``).
  2. ``session_meta.payload.cwd`` aggregated from rollout JSONL files (covers
     projects Codex used but never trusted).

Returns plain dicts with the same keys ``project_collector.get_projects()``
produces, plus a ``worker_type: "codex"`` discriminator and Codex-specific
fields (``trust_level``, ``originators``).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from flow_sdk.fs_records.codex.codex_project import (
    _is_valid_cwd,
    _read_codex_projects_from_config,
    _codex_project_id,
)

from ..utils import _codex_home, _codex_sessions_dir, shorten_path


def _scan_rollout_meta(jsonl_path: Path) -> dict | None:
    """Return ``{cwd, originator, modified_at}`` from a rollout's session_meta line."""
    try:
        with open(jsonl_path, "rb") as fh:
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
            if not isinstance(cwd, str) or not _is_valid_cwd(cwd):
                return None
            try:
                mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime).isoformat()
            except OSError:
                mtime = None
            return {
                "cwd": cwd,
                "originator": payload.get("originator") or "",
                "modified_at": mtime,
            }
    return None


def get_codex_projects() -> list[dict]:
    """Return all Codex projects as collector-shape dicts."""
    config_path = _codex_home() / "config.toml"
    sessions_root = _codex_sessions_dir()

    from_config = _read_codex_projects_from_config(config_path)

    cwd_to_meta: dict[str, dict] = {}
    if sessions_root.is_dir():
        for p in sessions_root.rglob("rollout-*.jsonl"):
            meta = _scan_rollout_meta(p)
            if not meta:
                continue
            cwd = meta["cwd"]
            bucket = cwd_to_meta.setdefault(
                cwd,
                {"originators": set(), "latest_activity": None, "session_count": 0},
            )
            bucket["session_count"] += 1
            if meta.get("originator"):
                bucket["originators"].add(meta["originator"])
            ts = meta.get("modified_at")
            if ts and (
                not bucket["latest_activity"] or ts > bucket["latest_activity"]
            ):
                bucket["latest_activity"] = ts

    out: list[dict] = []
    for cwd in set(from_config) | set(cwd_to_meta):
        if not _is_valid_cwd(cwd):
            continue
        cfg = from_config.get(cwd) or {}
        meta = cwd_to_meta.get(cwd) or {}
        out.append(
            {
                "id": f"codex_project:{_codex_project_id(cwd)}",
                "type": "codex_project",
                "worker_type": "codex",
                "name": shorten_path(cwd),
                "scope": "user",
                "source_file": cwd,
                "path": cwd,
                "cwd": cwd,
                "modified_at": meta.get("latest_activity"),
                "trust_level": cfg.get("trust_level"),
                "originators": sorted(meta.get("originators") or []),
                "session_count": int(meta.get("session_count") or 0),
                "total_messages": 0,
            }
        )
    out.sort(key=lambda x: x.get("modified_at") or "", reverse=True)
    return out
