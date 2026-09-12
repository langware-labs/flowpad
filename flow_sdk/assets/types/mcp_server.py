"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import json

try:
    import tomllib as _tomllib
except ImportError:
    import tomli as _tomllib
from datetime import datetime
from pathlib import Path

from flow_sdk.assets.identity import needs_ref
from flow_sdk.assets.types.source_file_records import _unescape_json_pointer
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

CLOUD_CONNECTORS_KEY = "claudeAiMcpEverConnected"


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


@needs_ref
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
