"""Indexer functions: CLAUDE_HOOK source file discovery.

Scan stage emits one FSRef per settings.json-like source file. Index stage
reads each file and expands it into N hook records via the existing
`_parse_hooks_from_file` / `_parse_hooks_from_plugins` helpers in
`flow_sdk/fs_records/claude/claude_hook_record.py`.

Two functions, split by *location convention* (not by scope):

  claude_hook_fn
      <root>/.claude/settings.json, <root>/.claude/settings.local.json
      Register on USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT.

  claude_hook_extras_fn
      Legacy <home>/.claude.json, plugins installed_plugins.json
      Register on USER_HOME_FOLDER only.

Mirrors `_default_search_paths` + the plugins/legacy branch in
`ClaudeHookRecordList._discover`.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_hook_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/.claude/settings.json + settings.local.json."""
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
                    record_type=RecordType.CLAUDE_HOOK,
                    parent=node,
                )
            )
    return out


async def claude_hook_extras_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Legacy ~/.claude.json + installed_plugins.json + plugin-cache hook files.

    Plugin-cache hooks live at
        ~/.claude/plugins/cache/<vendor>/<plugin>/<ver>/hooks/hooks.json
    Legacy reaches them via installed_plugins.json indirection; we discover
    them directly by rglob. USER_HOME_FOLDER only.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        candidates = [
            Path(node.path) / ".claude.json",
            Path(node.path) / ".claude" / "plugins" / "installed_plugins.json",
        ]
        # Walk plugins cache for hooks.json files
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
                    record_type=RecordType.CLAUDE_HOOK,
                    parent=node,
                )
            )
    return out
