"""Filesystem path evidence carried by normalized worker transcript entries."""
from flow_sdk.transcript_analyzer.entry import EntryKind

_SKILL_DIR = 'Base directory for this skill:'


def _skill_dir(text):
    """The directory a loaded skill body names on its first line, else None."""
    head = (text or '').lstrip()
    if not head.startswith(_SKILL_DIR):
        return None
    return head.partition('\n')[0][len(_SKILL_DIR):].strip() or None


def linked_skill_dirs(entries):
    """Skill call id → the directory its injected body names (None: a harness built-in).

    Claude Code links the body to its call with ``source_tool_use_id``; that id
    is the only correlation — never adjacency or a folder-name guess.
    """
    calls = {e.tool_use_id for e in entries if e.kind == EntryKind.SKILL_CALL and getattr(e, 'tool_use_id', None)}
    result = {}
    for entry in entries:
        source = getattr(entry, 'source_tool_use_id', None)
        if entry.kind == EntryKind.USER_MESSAGE and source in calls:
            result[source] = result.get(source) or _skill_dir(entry.text)
    return result


def skill_result_paths(entries):
    """A native Skill result can explicitly identify its loaded directory."""
    result = {}
    for entry in entries:
        if entry.kind != EntryKind.TOOL_RESULT or getattr(entry, 'is_error', False):
            continue
        path = _skill_dir(getattr(entry, 'tool_output', '')) or getattr(entry, 'file_path', None)
        if path and getattr(entry, 'tool_use_id', None):
            result[entry.tool_use_id] = path
    return result


def recognizable_asset_reference(path):
    """Recognize a disappeared carrier through registered layouts/mounts.

    An arbitrary missing source file is not evidence of a deleted asset.
    """
    from fnmatch import fnmatchcase
    from pathlib import Path

    from flow_sdk.assets.layout import Folder
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    path = Path(path)
    for name in SchemaRegistry.get_all_types():
        info = SchemaRegistry.get(name)
        if info is None or info.shape is None or info.keyed_by_ref:
            continue
        if isinstance(info.shape, Folder) and info.shape.main and path.name == info.shape.main:
            return True
        for mount in info.scan_mounts:
            parts = Path(mount).parts
            # A registered family beneath a provider/root, plus an asset entry.
            for index in range(len(path.parts) - len(parts)):
                if all(fnmatchcase(value, pattern) for value, pattern in zip(path.parts[index:index + len(parts)], parts)):
                    return True
    return False


def injected_skill_paths(entries, linked=()):
    """Native loaded-skill messages carry an explicit directory independently
    of whether the preceding invocation included a resolvable name.

    A body linked to its Skill call (``linked``) is that call's evidence, not a second usage.
    """
    result = {}
    for entry in entries:
        if entry.kind != EntryKind.USER_MESSAGE or getattr(entry, 'source_tool_use_id', None) in linked:
            continue
        path = _skill_dir(entry.text)
        if path:
            result[id(entry)] = path
    return result
