"""Indexer functions: MCP server discovery (recursive — walks into files).

Two-stage recursive walk, mirroring ``claude_hook.py``:

  Stage 1: roots → MCP_SERVER_SOURCE
    ``mcp_source_files_fn`` enumerates ``.mcp.json`` / ``mcp.json`` /
    ``.claude/mcp.json`` (and the legacy ``~/.claude.json`` ``mcpServers``
    block) — one FSRef per source file, no reads.

  Stage 2: MCP_SERVER_SOURCE → MCP_SERVER
    ``mcp_servers_in_file_fn`` opens each source file and emits one
    MCP_SERVER FSRef per server, carrying ``json_path`` (RFC 6901 pointer
    ``/mcpServers/<name>``).

Replaces ``config_collector.get_mcp_servers`` — read-only; Claude owns the files.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.source_file_records import (
    _escape_json_pointer,
    _unescape_json_pointer,
)


# ── Stage 1: source-file enumeration ─────────────────────────────────────────


def mcp_source_files_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Enumerate MCP config files under each root.

    Register on USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT → MCP_SERVER_SOURCE.
    The legacy ``~/.claude.json`` (which may carry a top-level ``mcpServers``
    block) is included so user-level servers survive.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        root = Path(node.path)
        candidates = [
            root / ".mcp.json",
            root / "mcp.json",
            root / ".claude" / "mcp.json",
            root / ".claude" / ".mcp.json",
            root / ".claude.json",
        ]
        for candidate in candidates:
            if not candidate.is_file():
                continue
            key = str(candidate.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(
                    candidate,
                    record_type=RecordType.MCP_SERVER_SOURCE,
                    parent=node,
                )
            )
    return out


# ── Stage 2: descend into each source file, emit per-server FSRefs ────────────


def _iter_servers_in_file(path: Path):
    """Yield the RFC-6901 ``/mcpServers/<name>`` pointer for every server."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        return
    for name, body in servers.items():
        if not isinstance(body, dict):
            continue
        yield f"/mcpServers/{_escape_json_pointer(name)}"


def mcp_servers_in_file_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """For each MCP_SERVER_SOURCE, emit one MCP_SERVER FSRef per server.

    Register on MCP_SERVER_SOURCE → MCP_SERVER.
    """
    out: list[FSRef] = []
    for node in nodes:
        if node.record_type != RecordType.MCP_SERVER_SOURCE:
            continue
        for json_path in _iter_servers_in_file(Path(node.path)):
            out.append(
                FSRef(
                    node.path,
                    record_type=RecordType.MCP_SERVER,
                    parent=node,
                    json_path=json_path,
                )
            )
    return out


# ── Parse one MCP_SERVER FSRef (json_path fragment) into a record ────────────


def _read_server_fragment(path: Path, json_path: str) -> tuple[str, dict] | None:
    """Resolve a ``/mcpServers/<name>`` pointer into (name, server_body)."""
    try:
        parts = json_path.strip("/").split("/")
        # parts == ["mcpServers", <escaped_name>]
        name = _unescape_json_pointer(parts[1])
        data = json.loads(path.read_text(encoding="utf-8"))
        body = data["mcpServers"][name]
    except (OSError, json.JSONDecodeError, KeyError, IndexError):
        return None
    if not isinstance(body, dict):
        return None
    return name, body


def mcp_server_id(ref: FSRef) -> str:
    """Stable id: ``<source_file>:<server_name>`` (matches legacy collector)."""
    frag = _read_server_fragment(Path(ref.path), ref.json_path or "")
    name = frag[0] if frag else (ref.json_path or "").rsplit("/", 1)[-1]
    return f"{ref.path}:{name}"


def extract_mcp_server(ref: FSRef) -> list[FSRecord]:
    """Parse one MCP_SERVER FSRef into a record matching the legacy item shape."""
    path = Path(ref.path)
    frag = _read_server_fragment(path, ref.json_path or "")
    if frag is None:
        return []
    name, body = frag
    source_file = str(path)
    try:
        modified_at = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        modified_at = None

    rec = FSRecord(
        type=RecordType.MCP_SERVER,
        id=f"{source_file}:{name}",
        name=name,
        scope=ref.scope or "user",
        source_file=source_file,
        path=source_file,
        modified_at=modified_at,
        command=body.get("command", ""),
        args=body.get("args", []),
        env=body.get("env", {}),
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True, json_path=ref.json_path))
    return [rec]
