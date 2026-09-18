"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import json
from pathlib import Path


def read_copilot_session_meta(path: Path) -> dict:
    """Best-effort metadata from Copilot workspace.yaml + first JSONL line."""
    session_dir = path.parent
    meta: dict = {"id": session_dir.name, "_path": str(path)}
    cwd = _read_workspace_cwd(session_dir / "workspace.yaml")
    if cwd:
        meta["cwd"] = cwd
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                raw = json.loads(line)
                timestamp = raw.get("timestamp")
                if timestamp:
                    meta["_timestamp"] = timestamp
                result = raw.get("result")
                if isinstance(result, dict) and result.get("sessionId"):
                    meta["id"] = result["sessionId"]
                data = raw.get("data")
                if isinstance(data, dict):
                    if data.get("sessionId"):
                        meta["id"] = data["sessionId"]
                    if data.get("cwd") and "cwd" not in meta:
                        meta["cwd"] = data["cwd"]
                break
    except (OSError, json.JSONDecodeError):
        pass
    return meta


def _read_workspace_cwd(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("cwd:"):
            continue
        value = stripped.split(":", 1)[1].strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        return value or None
    return None
