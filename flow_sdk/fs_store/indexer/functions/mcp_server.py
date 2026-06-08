"""Indexer functions: MCP server discovery (recursive — walks into files).

MCP servers are a *standard* asset across agents: the server entity is the
agent-neutral ``MCP_SERVER`` record, while the source files are per-agent
config formats. Two-stage recursive walk, mirroring ``claude_hook.py``:

  Stage 1: roots → MCP_SERVER_SOURCE
    ``mcp_source_files_fn`` enumerates the known config files — one FSRef per
    source file, no reads:
      ``.mcp.json`` / ``mcp.json`` / ``.claude/mcp.json`` / ``.claude/.mcp.json``
      ``.claude.json``        (Claude: user-scope + nested local-scope servers)
      ``.codex/config.toml``  (Codex: ``[mcp_servers.<name>]`` tables)

  Stage 2: MCP_SERVER_SOURCE → MCP_SERVER
    ``mcp_servers_in_file_fn`` opens each source file and emits one MCP_SERVER
    FSRef per server, carrying ``json_path`` (RFC 6901 pointer). All scopes:
      user    — top-level ``mcpServers`` under the home root
                (``~/.claude.json``, ``~/.claude/mcp.json``); also Codex
                ``[mcp_servers.*]`` (pointer ``/mcp_servers/<name>``)
      project — top-level ``mcpServers`` in ``<proj>/.mcp.json`` etc.
                (scope inherited from the project root)
      local   — nested ``projects["<cwd>"].mcpServers`` in ``~/.claude.json``
                (pointer ``/projects/<cwd>/mcpServers/<name>``, explicit
                ``scope="local"`` — Claude's default ``claude mcp add`` scope)

Each extracted record persists its full *definition site* — ``source_file``,
``json_path``, ``format``, ``scope`` (+ ``project_path`` for local scope) — so
a later control phase can update/remove the exact entry. This phase is
read-only; Claude/Codex own the files.

Replaces ``config_collector.get_mcp_servers``.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Iterator

try:
    import tomllib as _tomllib  # type: ignore[import-not-found]
except ImportError:
    import tomli as _tomllib  # type: ignore[import-not-found,no-redef]

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.source_file_records import (
    _escape_json_pointer,
    _unescape_json_pointer,
)


# ── Format-aware config loading ───────────────────────────────────────────────


def _load_config(path: Path) -> dict | None:
    """Parse a config file: TOML for ``.toml``, JSON otherwise.

    Returns None when the file is missing, unparseable, or not a dict —
    callers treat that as "no servers here".
    """
    try:
        if path.suffix == ".toml":
            with open(path, "rb") as fh:
                data = _tomllib.load(fh)
        else:
            data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # json.JSONDecodeError and tomllib.TOMLDecodeError are ValueError subclasses.
        return None
    return data if isinstance(data, dict) else None


# ── Stage 1: source-file enumeration ─────────────────────────────────────────


def mcp_source_files_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Enumerate MCP config files under each root.

    Register on USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT → MCP_SERVER_SOURCE.
    The legacy ``~/.claude.json`` (which may carry a top-level ``mcpServers``
    block *and* nested per-project local-scope blocks) is included so
    user-level servers survive; ``.codex/config.toml`` covers Codex.
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
            root / ".codex" / "config.toml",
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


def _iter_block(servers, prefix: str, scope: str | None) -> Iterator[tuple[str, str | None]]:
    """Yield ``(pointer, scope)`` for every dict entry of one server block."""
    if not isinstance(servers, dict):
        return
    for name, body in servers.items():
        if isinstance(body, dict):
            yield f"{prefix}/{_escape_json_pointer(name)}", scope


def _iter_servers_in_file(path: Path) -> Iterator[tuple[str, str | None]]:
    """Yield ``(RFC-6901 pointer, scope_override)`` for every server in *path*.

    scope_override is None when the FSRef should inherit the root's ambient
    scope (user under ``~``, project under project roots) and ``"local"`` for
    the nested per-project blocks of ``~/.claude.json``.
    """
    data = _load_config(path)
    if data is None:
        return
    # Claude shape (camelCase) — user/project scope, inherited from the root.
    yield from _iter_block(data.get("mcpServers"), "/mcpServers", None)
    # Codex shape (snake_case TOML tables) — global config under ~/.codex.
    yield from _iter_block(data.get("mcp_servers"), "/mcp_servers", None)
    # Claude *local* scope — ``~/.claude.json`` nests per-project servers
    # under projects["<abs cwd>"].mcpServers (the default `claude mcp add`).
    projects = data.get("projects")
    if isinstance(projects, dict):
        for proj_path, proj_body in projects.items():
            if not isinstance(proj_body, dict):
                continue
            prefix = f"/projects/{_escape_json_pointer(str(proj_path))}/mcpServers"
            yield from _iter_block(proj_body.get("mcpServers"), prefix, "local")


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
        for json_path, scope in _iter_servers_in_file(Path(node.path)):
            out.append(
                FSRef(
                    node.path,
                    record_type=RecordType.MCP_SERVER,
                    parent=node,
                    json_path=json_path,
                    scope=scope,
                )
            )
    return out


# ── Parse one MCP_SERVER FSRef (json_path fragment) into a record ────────────


def _pointer_parts(json_path: str) -> list[str]:
    """Split a pointer into unescaped segments. ``""`` → ``[]``."""
    stripped = json_path.strip("/")
    if not stripped:
        return []
    return [_unescape_json_pointer(p) for p in stripped.split("/")]


def _read_server_fragment(path: Path, json_path: str) -> tuple[str, dict] | None:
    """Resolve an arbitrary-depth pointer into ``(server_name, server_body)``."""
    parts = _pointer_parts(json_path)
    if len(parts) < 2:
        return None
    data = _load_config(path)
    if data is None:
        return None
    body: object = data
    for key in parts:
        if not isinstance(body, dict):
            return None
        body = body.get(key)
    if not isinstance(body, dict):
        return None
    return parts[-1], body


def _record_id(source_file: str, json_path: str) -> str:
    """Stable id for one server definition.

    Top-level entries (``/mcpServers/<n>``, ``/mcp_servers/<n>`` — exactly two
    segments by construction) keep the legacy ``<source_file>:<name>`` shape so
    existing records don't re-key. Deeper pointers (nested local scope) use the
    raw pointer — unique within the file even when two projects define
    same-named servers. Pointer depth (not scope) drives the choice: depth is
    intrinsic to the pointer, so ids stay stable regardless of which root
    walked the file.
    """
    parts = _pointer_parts(json_path)
    if len(parts) == 2:
        return f"{source_file}:{parts[-1]}"
    return f"{source_file}:{json_path}"


def mcp_server_id(ref: FSRef) -> str:
    """Stable id — pure string work over the FSRef's pointer (no file read)."""
    return _record_id(str(ref.path), ref.json_path or "")


def extract_mcp_server(ref: FSRef) -> list[FSRecord]:
    """Parse one MCP_SERVER FSRef into the agent-neutral server record.

    Persists the full definition site (``source_file`` + ``json_path`` +
    ``format`` + ``scope`` [+ ``project_path``]) — the addressing handle a
    later control phase needs to update/remove the exact entry — plus the
    launch payload (stdio ``command/args/env`` or remote ``url``).
    """
    path = Path(ref.path)
    json_path = ref.json_path or ""
    frag = _read_server_fragment(path, json_path)
    if frag is None:
        return []
    name, body = frag
    source_file = str(path)
    try:
        modified_at = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        modified_at = None

    command = body.get("command", "") or ""
    args = body.get("args", []) or []
    url = body.get("url", "") or ""
    transport = body.get("type") or ("http" if url and not command else "stdio")

    # Local-scope pointers are /projects/<cwd>/mcpServers/<name> by
    # construction (see _iter_servers_in_file) — the owning project is parts[1].
    parts = _pointer_parts(json_path)
    project_path = parts[1] if ref.scope == "local" and len(parts) == 4 else ""

    # FTS only indexes title/content/description — surface the launch line so
    # search matches by command / package / url.
    launch = [command, *[str(a) for a in args]] if command else [url]
    description = " ".join(x for x in launch if x).strip()

    rec = FSRecord(
        type=RecordType.MCP_SERVER,
        id=_record_id(source_file, json_path),
        name=name,
        scope=ref.scope or "user",
        source_file=source_file,
        path=source_file,
        json_path=json_path,
        format="toml" if path.suffix == ".toml" else "json",
        project_path=project_path,
        modified_at=modified_at,
        command=command,
        args=args,
        env=body.get("env", {}) or {},
        url=url,
        transport=transport,
        description=description,
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True, json_path=ref.json_path))
    return [rec]
