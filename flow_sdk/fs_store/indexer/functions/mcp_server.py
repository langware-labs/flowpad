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

from pathlib import Path
from typing import Iterator

from flow_sdk.assets.types.mcp_server import (
    _HOME_SOURCES,
    _PROJECT_SOURCES,
    CLOUD_CONNECTORS_KEY,
    _load_config,
    _resolve_source,
)
from flow_sdk.assets.types.source_file_records import (
    _escape_json_pointer,
)
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

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


# Sources valid under BOTH the user home and a project root (per-scope copies
# of the same agent config — e.g. global ~/.codex/config.toml and project
# .codex/config.toml). Listed once, spread into both tables below.






# Path-parts suffix → (servers_key, worker_type), longest suffix wins. Built
# once from the union of both tables (duplicate shared rows collapse here).






# ── Format-aware config loading ───────────────────────────────────────────────





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
