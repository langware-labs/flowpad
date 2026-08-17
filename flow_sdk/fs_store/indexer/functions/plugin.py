"""Indexer function: USER_HOME_FOLDER → PLUGIN.

Single shared-JSON registry ``~/.claude/plugins/installed_plugins.json`` whose
``plugins`` map fans out to N installs. One FSRef per install, addressed by an
RFC-6901 ``json_path`` (``/plugins/<key>/<idx>``). Read-only; Claude owns the
registry. Replaces ``user_collector.get_installed_plugins``.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.source_file_records import (
    _escape_json_pointer,
    _unescape_json_pointer,
)


def _registry_path(node: FSRef) -> Path:
    return Path(node.path) / ".claude" / "plugins" / "installed_plugins.json"


def plugin_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Emit one PLUGIN FSRef per install in installed_plugins.json.

    Register on USER_HOME_FOLDER only (the registry is user-global).
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        reg = _registry_path(node)
        if not reg.is_file():
            continue
        try:
            data = json.loads(reg.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for plugin_key, installs in (data.get("plugins") or {}).items():
            if not isinstance(installs, list):
                continue
            for idx in range(len(installs)):
                json_path = f"/plugins/{_escape_json_pointer(plugin_key)}/{idx}"
                key = f"{reg}:{json_path}"
                if key in seen:
                    continue
                seen.add(key)
                out.append(
                    FSRef(
                        reg,
                        record_type=RecordType.PLUGIN,
                        parent=node,
                        json_path=json_path,
                    )
                )
    return out


def _read_install(path: Path, json_path: str) -> tuple[str, dict] | None:
    """Resolve a ``/plugins/<key>/<idx>`` pointer into (plugin_key, install_dict)."""
    try:
        parts = json_path.strip("/").split("/")
        # parts == ["plugins", <escaped_key>, <idx>]
        plugin_key = _unescape_json_pointer(parts[1])
        idx = int(parts[2])
        data = json.loads(path.read_text(encoding="utf-8"))
        install = data["plugins"][plugin_key][idx]
    except (OSError, json.JSONDecodeError, KeyError, IndexError, ValueError):
        return None
    if not isinstance(install, dict):
        return None
    return plugin_key, install


def _enabled_plugins(path: Path) -> dict:
    """Read ``enabledPlugins`` from ~/.claude/settings.json (sibling of the registry)."""
    settings = path.parent.parent / "settings.json"
    try:
        data = json.loads(settings.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    enabled = data.get("enabledPlugins")
    return enabled if isinstance(enabled, dict) else {}


def _split_plugin_key(plugin_key: str) -> tuple[str, str]:
    """``<name>@<marketplace>`` → (name, marketplace), defaulting marketplace."""
    parts = plugin_key.split("@")
    return parts[0], (parts[1] if len(parts) > 1 else "unknown")


def plugin_identity_key(ref: FSRef | Path) -> str:
    """Stable, filesystem-safe **UUID** id. The natural key
    ``<name>@<marketplace>`` is hashed into a uuid5 with the same
    ``f"{type}:{key}"`` formula ``Entity.allocate_id`` uses, so it matches the DB
    id (a conforming id is kept as-is)."""
    path = Path(getattr(ref, "path", ref))
    json_path = getattr(ref, "json_path", None) or ""
    frag = _read_install(path, json_path)
    if frag is not None:
        plugin_key = frag[0]
    else:
        segs = json_path.strip("/").split("/")
        plugin_key = _unescape_json_pointer(segs[1]) if len(segs) >= 2 else ""
    if not plugin_key:
        key = json_path or path.name
    else:
        name, marketplace = _split_plugin_key(plugin_key)
        key = f"{name}@{marketplace}"
    return key


def plugin_id_from_file(ref: FSRef | Path) -> str | None:
    key = plugin_identity_key(ref)
    return key if is_valid_entity_id(key) else None


def plugin_stable_key(ref: FSRef | Path) -> str:
    return f"{RecordType.PLUGIN}:{plugin_identity_key(ref)}"


def extract_plugin(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse one PLUGIN FSRef into a record matching the legacy item shape."""
    path = Path(ref.path)
    frag = _read_install(path, ref.json_path or "")
    if frag is None:
        return []
    plugin_key, install = frag
    parts = plugin_key.split("@")
    name = parts[0]
    marketplace = parts[1] if len(parts) > 1 else "unknown"
    installed_at = install.get("installedAt", "")
    source_file = str(path)

    rec = FSRecord(
        type=RecordType.PLUGIN,
        id=resolved_id,
        name=name,
        scope=install.get("scope", "user"),
        source_file=source_file,
        modified_at=installed_at,
        created_at=installed_at,
        path=install.get("installPath", ""),
        version=install.get("version", "unknown"),
        marketplace=marketplace,
        enabled=_enabled_plugins(path).get(plugin_key, False),
        plugin_key=plugin_key,
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True, json_path=ref.json_path))
    return [rec]
