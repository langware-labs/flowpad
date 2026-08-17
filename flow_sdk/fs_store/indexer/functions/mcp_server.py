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

import uuid

from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.source_file_records import (
    _escape_json_pointer,
    _unescape_json_pointer,
)

# ── Source mapping: every system's MCP config files ───────────────────────────
#
# Each row is (relative path parts under the root, top-level servers key,
# format, owning agent). The key differs per agent — VS Code uses ``servers``;
# Codex uses TOML ``mcp_servers``; everyone else uses ``mcpServers``. The agent
# becomes the record's ``worker_type`` (the config owner, not necessarily an
# executor FlowPad spawns). All three Claude Desktop OS paths are listed
# unconditionally — non-matching ones simply fail ``is_file()``, so no
# ``sys.platform`` branching is needed.

# Cloud connectors managed by claude.ai are recorded under this top-level key in
# ``~/.claude.json`` — a list of display names only (no command/url/auth).
CLOUD_CONNECTORS_KEY = "claudeAiMcpEverConnected"

# Sources valid under BOTH the user home and a project root (per-scope copies
# of the same agent config — e.g. global ~/.codex/config.toml and project
# .codex/config.toml). Listed once, spread into both tables below.
_SHARED_SOURCES: list[tuple[tuple[str, ...], str, str, WorkerType]] = [
    ((".codex", "config.toml"), "mcp_servers", "toml", WorkerType.CODEX),
    ((".vscode", "mcp.json"), "servers", "json", WorkerType.VSCODE),
    ((".cursor", "mcp.json"), "mcpServers", "json", WorkerType.CURSOR),
]

_HOME_SOURCES: list[tuple[tuple[str, ...], str, str, WorkerType]] = [
    *_SHARED_SOURCES,
    ((".claude.json",), "mcpServers", "json", WorkerType.CLAUDE_CODE),
    ((".claude", "mcp.json"), "mcpServers", "json", WorkerType.CLAUDE_CODE),
    ((".claude", ".mcp.json"), "mcpServers", "json", WorkerType.CLAUDE_CODE),
    # Claude Desktop — mac / win (%APPDATA%) / linux.
    (("Library", "Application Support", "Claude", "claude_desktop_config.json"),
     "mcpServers", "json", WorkerType.CLAUDE_DESKTOP),
    (("AppData", "Roaming", "Claude", "claude_desktop_config.json"),
     "mcpServers", "json", WorkerType.CLAUDE_DESKTOP),
    ((".config", "Claude", "claude_desktop_config.json"),
     "mcpServers", "json", WorkerType.CLAUDE_DESKTOP),
    ((".copilot", "mcp-config.json"), "mcpServers", "json", WorkerType.COPILOT),
    ((".codeium", "windsurf", "mcp_config.json"), "mcpServers", "json", WorkerType.WINDSURF),
]

_PROJECT_SOURCES: list[tuple[tuple[str, ...], str, str, WorkerType]] = [
    *_SHARED_SOURCES,
    ((".mcp.json",), "mcpServers", "json", WorkerType.CLAUDE_CODE),
    (("mcp.json",), "mcpServers", "json", WorkerType.CLAUDE_CODE),
    ((".claude", "mcp.json"), "mcpServers", "json", WorkerType.CLAUDE_CODE),
    ((".claude", ".mcp.json"), "mcpServers", "json", WorkerType.CLAUDE_CODE),
]

# Path-parts suffix → (servers_key, worker_type), longest suffix wins. Built
# once from the union of both tables (duplicate shared rows collapse here).
_SOURCE_BY_SUFFIX: dict[tuple[str, ...], tuple[str, WorkerType]] = {
    rel: (key, worker) for rel, key, _fmt, worker in (*_HOME_SOURCES, *_PROJECT_SOURCES)
}


def _resolve_source(path: Path) -> tuple[str, WorkerType]:
    """Return ``(servers_key, worker_type)`` for a config file from its path.

    Pure path inspection — the single source of truth shared by stage 2 and
    ``extract_mcp_server`` (mirrors how ``claude_hook.py`` re-derives scope and
    ``transcript_streamer`` derives worker_type from path shape). Matches the
    longest path-parts suffix; falls back to the Claude Code default.
    """
    parts = path.parts
    best: tuple[int, str, WorkerType] | None = None
    for rel, (key, worker) in _SOURCE_BY_SUFFIX.items():
        if len(parts) >= len(rel) and tuple(parts[-len(rel):]) == rel:
            if best is None or len(rel) > best[0]:
                best = (len(rel), key, worker)
    if best is not None:
        return best[1], best[2]
    return "mcpServers", WorkerType.CLAUDE_CODE


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
    The candidate set is the declarative source table for the root's kind —
    ``_HOME_SOURCES`` for the user home (Claude/Codex/Copilot/Cursor/Windsurf/
    VS Code/Claude Desktop, incl. the cloud-connector-carrying ``~/.claude.json``)
    and ``_PROJECT_SOURCES`` for project roots.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        root = Path(node.path)
        table = (
            _HOME_SOURCES
            if node.record_type == RecordType.USER_HOME_FOLDER
            else _PROJECT_SOURCES
        )
        for rel, _key, _fmt, _worker in table:
            candidate = root.joinpath(*rel)
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


def _iter_servers_in_file(path: Path, data: dict) -> Iterator[tuple[str, str | None]]:
    """Yield ``(RFC-6901 pointer, scope_override)`` for every server in *path*.

    scope_override is None when the FSRef should inherit the root's ambient
    scope (user under ``~``, project under project roots) and ``"local"`` for
    the nested per-project blocks of ``~/.claude.json``.
    """
    key, _worker = _resolve_source(path)
    yield from _iter_block(data.get(key), f"/{_escape_json_pointer(key)}", None)
    # Claude *local* scope — ``~/.claude.json`` nests per-project servers under
    # projects["<abs cwd>"].mcpServers (the default `claude mcp add`). Only the
    # mcpServers-keyed Claude config carries this nested shape.
    if key == "mcpServers":
        projects = data.get("projects")
        if isinstance(projects, dict):
            for proj_path, proj_body in projects.items():
                if not isinstance(proj_body, dict):
                    continue
                prefix = f"/projects/{_escape_json_pointer(str(proj_path))}/mcpServers"
                yield from _iter_block(proj_body.get("mcpServers"), prefix, "local")


def _iter_cloud_connectors(path: Path, data: dict) -> Iterator[tuple[str, str | None]]:
    """Yield ``(pointer, scope)`` for claude.ai cloud connectors in ``.claude.json``.

    ``claudeAiMcpEverConnected`` is a flat list of connector display names (no
    command/url/auth on disk — those live in the cloud). Each becomes a
    name-only stub record at user scope under a synthetic pointer so it
    round-trips through ``extract``.
    """
    if path.name != ".claude.json":
        return
    names = data.get(CLOUD_CONNECTORS_KEY)
    if not isinstance(names, list):
        return
    for name in names:
        if isinstance(name, str) and name:
            yield f"/{CLOUD_CONNECTORS_KEY}/{_escape_json_pointer(name)}", "user"


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
        path = Path(node.path)
        data = _load_config(path)
        if data is None:
            continue
        # Parse once, feed both iterators (the file's servers + any cloud stubs).
        entries = [*_iter_servers_in_file(path, data), *_iter_cloud_connectors(path, data)]
        for json_path, scope in entries:
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
    """Resolve an arbitrary-depth pointer into ``(server_name, server_body)``.

    Cloud connectors (``/claudeAiMcpEverConnected/<name>``) are name-only — they
    have no body on disk — so they resolve to ``(name, {})`` after confirming the
    name is still present in the live list (fail-soft if removed between scan
    and parse).
    """
    parts = _pointer_parts(json_path)
    if len(parts) < 2:
        return None
    data = _load_config(path)
    if data is None:
        return None
    if parts[0] == CLOUD_CONNECTORS_KEY:
        names = data.get(CLOUD_CONNECTORS_KEY)
        if isinstance(names, list) and parts[1] in names:
            return parts[1], {}
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
    # Cloud-connector stubs are 2-segment too, but must NOT collapse to the
    # legacy ``<file>:<name>`` shape — that would collide with a real top-level
    # server of the same name in the same file. Key them on the full pointer.
    if len(parts) == 2 and parts[0] != CLOUD_CONNECTORS_KEY:
        return f"{source_file}:{parts[-1]}"
    return f"{source_file}:{json_path}"


def mcp_server_identity_key(ref: FSRef | Path) -> str:
    path = Path(getattr(ref, "path", ref))
    json_path = getattr(ref, "json_path", None) or ""
    return f"{RecordType.MCP_SERVER}:{_record_id(str(path), json_path)}"


def extract_mcp_server(ref: FSRef, resolved_id: str) -> list[FSRecord]:
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

    # Owning agent (config source) + local vs remote. worker_type is derived
    # from the file path; connector_type is "remote" for claude.ai cloud
    # connectors and for url-only (no command) servers, "local" otherwise.
    _, worker_type = _resolve_source(path)
    is_cloud = bool(parts) and parts[0] == CLOUD_CONNECTORS_KEY
    connector_type = "remote" if (is_cloud or (url and not command)) else "local"

    # FTS only indexes title/content/description — surface the launch line so
    # search matches by command / package / url. Cloud stubs have no launch
    # line; fall back to the agent + connector kind so they stay searchable.
    launch = [command, *[str(a) for a in args]] if command else [url]
    description = " ".join(x for x in launch if x).strip()
    if not description:
        description = f"{worker_type.value} {connector_type} connector"

    rec = FSRecord(
        type=RecordType.MCP_SERVER,
        id=resolved_id,
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
        worker_type=worker_type.value,
        connector_type=connector_type,
        description=description,
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True, json_path=ref.json_path))
    return [rec]
