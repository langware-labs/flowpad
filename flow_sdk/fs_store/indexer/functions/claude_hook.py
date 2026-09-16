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

import json
from pathlib import Path

from flow_sdk.assets.types.source_file_records import (  # RFC-6901 (shared)
    _escape_json_pointer,
)
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

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

















# ── Backward-compat aliases — older registrations may still import these ────


# Legacy names kept for any caller (test or otherwise) that imports them
# directly. Both alias the file-enumeration walkers; existing parser dispatch
# still handles file-level FSRefs (without json_path) via the 1:N fallback
# in ``ClaudeHookRecord._from_fsref_sync`` (now in operations/claude_hook.py).
claude_hook_fn = claude_hook_files_fn
claude_hook_extras_fn = claude_hook_files_extras_fn
