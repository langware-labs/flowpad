"""Path-based file-pattern registry for JsonFileRecordStore subclasses.

Maps filenames (e.g. "settings.json") to JsonFileRecordStore subclasses
so the path-based API (``/fs-records/file?path=...``) can resolve which
store class to use for any source file path.

Usage::

    from flow_sdk.fs_store.source_file_registry import register_file_pattern, resolve_list_class

    # Register (typically at module import time)
    register_file_pattern("settings.json", ClaudeSettingsJsonRecordList)

    # Lookup (in the path-based API handler)
    list_class = resolve_list_class("/home/user/.claude/settings.json")
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .json_file_record_store import JsonFileRecordStore


# Maps filename (e.g. "settings.json") to a JsonFileRecordStore subclass.
_FILE_PATTERNS: dict[str, type[JsonFileRecordStore]] = {}


def register_file_pattern(filename: str, list_class: type[JsonFileRecordStore]) -> None:
    """Register a filename -> JsonFileRecordStore class mapping."""
    _FILE_PATTERNS[filename] = list_class


def resolve_list_class(source_path: str | Path) -> type[JsonFileRecordStore] | None:
    """Look up the JsonFileRecordStore class for a file by its filename."""
    return _FILE_PATTERNS.get(Path(source_path).name)


# Allowed filename patterns for the path-based API.
_ALLOWED_FILENAMES = frozenset({
    "settings.json",
    "settings.local.json",
    "mcp.json",
    ".mcp.json",
    "managed-settings.json",
    ".claude.json",
})

_ALLOWED_PATH_RE = re.compile(
    r"(?:^|/)"
    r"(?:"
    r"\.claude/"
    r"|\.mcp\.json$"
    r"|\.claude\.json$"
    r")"
)


def is_allowed_source_path(path: str) -> bool:
    """Security check: only allow known Claude config file paths."""
    expanded = str(Path(path).expanduser())
    filename = Path(expanded).name
    if filename not in _ALLOWED_FILENAMES:
        return False
    return bool(_ALLOWED_PATH_RE.search(expanded))
