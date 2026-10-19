"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

from flow_sdk.assets.identity import needs_ref
from flow_sdk.assets.types.source_file_records import _unescape_json_pointer
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


def _read_hook_fragment(path: Path, json_path: str) -> dict | None:
    """Resolve a ``/hooks/<event>/<gi>/hooks/<hi>`` pointer into the hook fields.

    Returns ``{event_type, matcher, command, hook_type, flow_metadata_name,
    flowpad_hook_id}`` or ``None`` if the pointer can't be resolved. Mirrors
    the field extraction in the deleted ``config_collector.get_hooks_from_settings``.
    """
    try:
        parts = json_path.strip("/").split("/")
        # parts == ["hooks", <escaped_event>, <group_idx>, "hooks", <hook_idx>]
        event_type = _unescape_json_pointer(parts[1])
        group_idx = int(parts[2])
        hook_idx = int(parts[4])
        data = json.loads(path.read_text(encoding="utf-8"))
        group = data["hooks"][event_type][group_idx]
        hook = group["hooks"][hook_idx]
    except (OSError, json.JSONDecodeError, KeyError, IndexError, ValueError):
        return None

    fm = hook.get("flow_metadata") if isinstance(hook.get("flow_metadata"), dict) else None
    return {
        "event_type": event_type,
        "matcher": group.get("matcher", "*"),
        "command": hook.get("command", ""),
        "hook_type": hook.get("type", "command"),
        "flow_metadata_name": (fm or {}).get("name"),
        "flowpad_hook_id": (fm or {}).get("flowpad_hook_id"),
    }


def _hook_scope(ref: FSRef) -> str:
    """settings.local.json hooks are 'local'; everything else inherits the root scope."""
    if Path(getattr(ref, "path", ref)).name == "settings.local.json":
        return "local"
    return getattr(ref, "scope", None) or "user"


def _hook_id(scope: str, frag: dict) -> str:
    """``managed:<event>:<flowpad_hook_id>`` when present, else ``<scope>:<event>:<md5>``."""
    if frag.get("flowpad_hook_id"):
        return f"managed:{frag['event_type']}:{frag['flowpad_hook_id']}"
    matcher_hash = hashlib.md5(
        f"{frag['matcher']}:{frag['command']}".encode()
    ).hexdigest()[:8]
    return f"{scope}:{frag['event_type']}:{matcher_hash}"


@needs_ref
def claude_hook_identity_key(ref: FSRef | Path) -> str:
    """Stable, filesystem-safe **UUID** id for a single hook FSRef (json_path
    fragment). The natural key carries a ``:`` (illegal in a Windows folder
    name); hashing it into a uuid5 — with the same ``f"{type}:{key}"`` formula
    ``Entity.allocate_id`` uses — yields a path-safe id identical to the DB id.
    """
    path = Path(getattr(ref, "path", ref))
    json_path = getattr(ref, "json_path", None) or ""
    frag = _read_hook_fragment(path, json_path)
    if frag is None:
        # Fallback keeps the id stable+unique even if the fragment is unreadable.
        key = f"{_hook_scope(ref)}:{json_path or path.name}"
    else:
        key = _hook_id(_hook_scope(ref), frag)
    return f"{RecordType.CLAUDE_HOOK}:{key}"


def extract_claude_hook(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse one CLAUDE_HOOK FSRef into a record matching the legacy hook item shape."""
    path = Path(ref.path)
    frag = _read_hook_fragment(path, ref.json_path or "")
    if frag is None:
        return []
    scope = _hook_scope(ref)
    source_file = str(path)
    try:
        modified_at = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        modified_at = None

    name = frag["flow_metadata_name"] or f"{frag['event_type']} ({frag['matcher']})"
    fields: dict = {
        "name": name,
        "scope": scope,
        "source_file": source_file,
        "path": source_file,
        "modified_at": modified_at,
        "event_type": frag["event_type"],
        "matcher": frag["matcher"],
        "command": frag["command"],
        "hook_type": frag["hook_type"],
    }
    if frag["flow_metadata_name"]:
        fields["flow_metadata_name"] = frag["flow_metadata_name"]
    if frag["flowpad_hook_id"]:
        fields["flowpad_hook_id"] = frag["flowpad_hook_id"]

    rec = FSRecord(type=RecordType.CLAUDE_HOOK, id=resolved_id, **fields)
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True, json_path=ref.json_path))
    return [rec]
