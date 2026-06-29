"""Source-file CRUD: thin extractors that turn known JSON config files
(settings.json, .mcp.json, etc.) into a flat list of typed records keyed
by their RFC-6901 JSON Pointer within the file.

Replaces the dissolved ``JsonFileRecordStore`` Record-subclass hierarchy.
Each extractor is a pure function: ``(data: dict) -> list[dict]`` where each
returned dict carries at minimum ``type`` (RecordType value) and
``json_path`` (RFC-6901 pointer; empty string for the root record).

The path-based API handler in ``fs_records_actions._handle_path_based_source_file``
delegates here. The TS SDK's ``SourceFileRecordList`` subclasses read these
records back and reconstruct typed views.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .record_types import RecordType


# ── JSON Pointer helpers (RFC 6901) ───────────────────────────────────────────


def _escape_json_pointer(segment: str) -> str:
    return segment.replace("~", "~0").replace("/", "~1")


def _unescape_json_pointer(segment: str) -> str:
    return segment.replace("~1", "/").replace("~0", "~")


def _set_pointer(data: dict, pointer: str, value: Any) -> None:
    if not pointer or pointer == "/":
        raise ValueError("Cannot set root pointer; replace data directly")
    parts = pointer.strip("/").split("/")
    current = data
    for part in parts[:-1]:
        key = _unescape_json_pointer(part)
        if key not in current or not isinstance(current[key], dict):
            current[key] = {}
        current = current[key]
    current[_unescape_json_pointer(parts[-1])] = value


def _delete_pointer(data: dict, pointer: str) -> bool:
    if not pointer or pointer == "/":
        return False
    parts = pointer.strip("/").split("/")
    current = data
    for part in parts[:-1]:
        key = _unescape_json_pointer(part)
        if not isinstance(current, dict) or key not in current:
            return False
        current = current[key]
    key = _unescape_json_pointer(parts[-1])
    if isinstance(current, dict) and key in current:
        del current[key]
        return True
    return False


# ── Per-file extractors ───────────────────────────────────────────────────────


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case (light-weight, ASCII)."""
    out = []
    for i, c in enumerate(name):
        if c.isupper() and i > 0:
            out.append("_")
        out.append(c.lower())
    return "".join(out)


def _snake_keys(d: dict) -> dict:
    """Shallow snake_case rename of a dict's keys (non-recursive)."""
    return {_camel_to_snake(k): v for k, v in d.items()}


def _extract_settings_json(data: dict, source_file: str) -> list[dict]:
    """Extract typed records from ``settings.json`` / ``settings.local.json``.

    Mirrors the legacy ``ClaudeSettingsJsonRecordList._extract``: emit a root
    record plus typed sub-records for ``permissions``, ``sandbox``, and
    ``attribution`` blocks when present.
    """
    out: list[dict] = []

    # Root record — all top-level scalars/dicts go in; sub-blocks remain
    # under their own keys so the TS side can still navigate the raw shape.
    root: dict[str, Any] = dict(data)
    root.update({
        "type": RecordType.CLAUDE_SETTINGS_JSON.value,
        "json_path": "",
        "source_file": source_file,
    })
    out.append(root)

    if isinstance(data.get("permissions"), dict):
        perms = _snake_keys(data["permissions"])
        perms.update({
            "type": RecordType.CLAUDE_SETTINGS_JSON_PERMISSIONS.value,
            "json_path": "/permissions",
            "source_file": source_file,
        })
        out.append(perms)

    if isinstance(data.get("sandbox"), dict):
        sandbox_src = dict(data["sandbox"])
        network = sandbox_src.pop("network", {}) or {}
        sandbox = _snake_keys(sandbox_src)
        for k, v in _snake_keys(network).items():
            sandbox[f"network_{k}"] = v
        sandbox.update({
            "type": RecordType.CLAUDE_SETTINGS_JSON_SANDBOX.value,
            "json_path": "/sandbox",
            "source_file": source_file,
        })
        out.append(sandbox)

    if isinstance(data.get("attribution"), dict):
        attr = _snake_keys(data["attribution"])
        attr.update({
            "type": RecordType.CLAUDE_SETTINGS_JSON_ATTRIBUTION.value,
            "json_path": "/attribution",
            "source_file": source_file,
        })
        out.append(attr)

    return out


def _extract_managed_settings(data: dict, source_file: str) -> list[dict]:
    """Extract the single root record for ``managed-settings.json``."""
    root = dict(data)
    root.update({
        "type": RecordType.CLAUDE_MANAGED_SETTINGS.value,
        "json_path": "",
        "source_file": source_file,
    })
    return [root]


def _extract_mcp_json(data: dict, source_file: str) -> list[dict]:
    """Extract the root + per-server records for ``.mcp.json``."""
    out: list[dict] = []
    root = {
        "type": RecordType.CLAUDE_MCP_JSON.value,
        "json_path": "",
        "source_file": source_file,
    }
    out.append(root)
    servers = data.get("mcpServers") or {}
    if isinstance(servers, dict):
        for name, body in servers.items():
            if not isinstance(body, dict):
                continue
            srv = _snake_keys(body)
            srv.update({
                "type": RecordType.CLAUDE_MCP_JSON_ENTRY.value,
                "json_path": f"/mcpServers/{_escape_json_pointer(name)}",
                "source_file": source_file,
                "name": name,
            })
            out.append(srv)
    return out


_EXTRACTORS: dict[str, Callable[[dict, str], list[dict]]] = {
    "settings.json": _extract_settings_json,
    "settings.local.json": _extract_settings_json,
    "managed-settings.json": _extract_managed_settings,
    "mcp.json": _extract_mcp_json,
    ".mcp.json": _extract_mcp_json,
}


# ── Security ──────────────────────────────────────────────────────────────────

# Derived from _EXTRACTORS so the allow-list can't drift from what we can
# actually extract (an allowed-but-unextractable filename would pass the
# security check yet silently yield zero records).
_ALLOWED_FILENAMES = frozenset(_EXTRACTORS.keys())

_ALLOWED_PATH_FRAGMENTS = (".claude/", "/.mcp.json")


def is_allowed_source_path(path: str) -> bool:
    """Only allow known Claude config file paths."""
    expanded = str(Path(path).expanduser())
    if Path(expanded).name not in _ALLOWED_FILENAMES:
        return False
    return any(frag in expanded for frag in _ALLOWED_PATH_FRAGMENTS)


# ── Public surface ────────────────────────────────────────────────────────────


def known_filename(path: str | Path) -> bool:
    """True when *path* has a filename we know how to extract."""
    return Path(path).name in _EXTRACTORS


def extract_from_data(data: dict, path: str | Path) -> list[dict]:
    """Emit the typed records for an already-parsed JSON *data* dict.

    Lets callers that already hold the parsed content (e.g. a PUT that just
    wrote the file) re-derive records without a second disk read + parse.
    """
    extractor = _EXTRACTORS.get(Path(path).name)
    if extractor is None or not isinstance(data, dict):
        return []
    return extractor(data, str(path))


def extract_records(path: str | Path) -> list[dict]:
    """Read *path* as JSON and emit the typed records for that filename.

    Returns an empty list when the file is missing or the filename is not
    registered.
    """
    p = Path(path)
    if p.name not in _EXTRACTORS:
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return extract_from_data(data, p)


def load_raw(path: str | Path) -> dict:
    """Read a JSON file and return its content. Returns ``{}`` on error."""
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def write_raw(path: str | Path, data: dict) -> None:
    """Write *data* as JSON to *path*, creating parents as needed."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
