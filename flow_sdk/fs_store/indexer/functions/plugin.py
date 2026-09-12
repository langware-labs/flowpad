"""Indexer function: USER_HOME_FOLDER → PLUGIN.

Single shared-JSON registry ``~/.claude/plugins/installed_plugins.json`` whose
``plugins`` map fans out to N installs. One FSRef per install, addressed by an
RFC-6901 ``json_path`` (``/plugins/<key>/<idx>``). Read-only; Claude owns the
registry. Replaces ``user_collector.get_installed_plugins``.
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.assets.types.source_file_records import (
    _escape_json_pointer,
)
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


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
