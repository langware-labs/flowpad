"""Indexer functions: CLAUDE_HOOK discovery (recursive — walks into files).

Two-stage recursive walk:

  Stage 1: roots → CLAUDE_HOOK_SOURCE
    ``claude_hook_files_fn`` + ``claude_hook_files_extras_fn`` enumerate
    settings.json-like files (the *source files* that contain hook
    definitions). One FSRef emitted per file, no file reads.

  Stage 2: CLAUDE_HOOK_SOURCE → CLAUDE_HOOK
    ``hooks_in_settings_fn`` opens each source file, walks its hooks tree,
    and emits one CLAUDE_HOOK FSRef per individual hook entry. Each emitted
    FSRef carries ``json_path`` (RFC 6901 pointer to that hook's position in
    the source file). The 1:N parsing that used to live in
    ``ClaudeHookRecord._from_fsref_sync`` now happens here at the walker
    layer — the parser becomes a clean 1:1 dispatch.

Source-file shapes handled:
  * ``settings.json`` / ``settings.local.json`` — standard hook tree.
  * ``.claude.json`` — legacy user-level shape (same tree).
  * Plugin-cache ``hooks.json`` — same tree; plugin metadata applied later.
  * ``installed_plugins.json`` — registry only; no hooks emitted.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.source_file_records import (  # RFC-6901 (shared)
    _escape_json_pointer,
    _unescape_json_pointer,
)

# ── Stage 1: source-file enumeration (was: claude_hook_fn / claude_hook_extras_fn)


def claude_hook_files_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/.claude/settings.json + settings.local.json.

    Register on USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT → CLAUDE_HOOK_SOURCE.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        claude_dir = Path(node.path) / ".claude"
        for name in ("settings.json", "settings.local.json"):
            candidate = claude_dir / name
            if not candidate.is_file():
                continue
            key = str(candidate.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(
                    candidate,
                    record_type=RecordType.CLAUDE_HOOK_SOURCE,
                    parent=node,
                )
            )
    return out


def claude_hook_files_extras_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Legacy ~/.claude.json + plugin-cache hooks.json files.

    Register on USER_HOME_FOLDER only → CLAUDE_HOOK_SOURCE.

    Plugin-cache hooks live at
        ~/.claude/plugins/cache/<vendor>/<plugin>/<ver>/hooks/hooks.json
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        candidates = [
            Path(node.path) / ".claude.json",
            Path(node.path) / ".claude" / "plugins" / "installed_plugins.json",
        ]
        cache_dir = Path(node.path) / ".claude" / "plugins" / "cache"
        if cache_dir.is_dir():
            candidates.extend(sorted(cache_dir.rglob("hooks.json")))

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
                    record_type=RecordType.CLAUDE_HOOK_SOURCE,
                    parent=node,
                )
            )
    return out


# ── Stage 2: descend into each source file, emit per-hook FSRefs ─────────────


def _iter_hooks_in_file(path: Path):
    """Yield (event_type, group_idx, hook_idx, json_path) tuples for every
    hook entry in a settings.json-shaped file. Skips registry files."""
    if path.name == "installed_plugins.json":
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    hooks_section = data.get("hooks")
    if not isinstance(hooks_section, dict):
        return
    for event_type, group_list in hooks_section.items():
        if not isinstance(group_list, list):
            continue
        escaped_event = _escape_json_pointer(event_type)
        for group_idx, group in enumerate(group_list):
            if not isinstance(group, dict):
                continue
            hook_entries = group.get("hooks", [])
            if not isinstance(hook_entries, list):
                continue
            for hook_idx, hook in enumerate(hook_entries):
                if not isinstance(hook, dict):
                    continue
                json_path = (
                    f"/hooks/{escaped_event}/{group_idx}/hooks/{hook_idx}"
                )
                yield event_type, group_idx, hook_idx, json_path


def hooks_in_settings_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """For each CLAUDE_HOOK_SOURCE FSRef, emit one CLAUDE_HOOK FSRef per hook
    entry inside the file. Each emitted FSRef has ``json_path`` set to the
    RFC 6901 pointer for its hook fragment.

    Register on CLAUDE_HOOK_SOURCE → CLAUDE_HOOK.
    """
    out: list[FSRef] = []
    for node in nodes:
        if node.record_type != RecordType.CLAUDE_HOOK_SOURCE:
            continue
        for _event, _gidx, _hidx, json_path in _iter_hooks_in_file(Path(node.path)):
            out.append(
                FSRef(
                    node.path,
                    record_type=RecordType.CLAUDE_HOOK,
                    parent=node,
                    json_path=json_path,
                )
            )
    return out


# ── Stage 3: parse one CLAUDE_HOOK FSRef (json_path fragment) into a record ──


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


# ── Backward-compat aliases — older registrations may still import these ────


# Legacy names kept for any caller (test or otherwise) that imports them
# directly. Both alias the file-enumeration walkers; existing parser dispatch
# still handles file-level FSRefs (without json_path) via the 1:N fallback
# in ``ClaudeHookRecord._from_fsref_sync`` (now in operations/claude_hook.py).
claude_hook_fn = claude_hook_files_fn
claude_hook_extras_fn = claude_hook_files_extras_fn
