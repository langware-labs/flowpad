"""Filesystem path evidence carried by normalized worker transcript entries."""
from flow_sdk.transcript_analyzer.entry import EntryKind


def skill_result_paths(entries):
    """A native Skill result can explicitly identify its loaded directory.

    Correlate by the tool call ID, never adjacency or a folder-name guess.
    """
    result = {}
    for entry in entries:
        if entry.kind != EntryKind.TOOL_RESULT or getattr(entry, 'is_error', False):
            continue
        path = getattr(entry, 'file_path', None)
        first = (getattr(entry, 'tool_output', '') or '').strip().splitlines()
        prefix = 'Base directory for this skill:'
        if first and first[0].startswith(prefix):
            path = first[0][len(prefix):].strip()
        if path and getattr(entry, 'tool_use_id', None):
            result[entry.tool_use_id] = path
    return result


def recognizable_asset_reference(path):
    """Recognize a disappeared carrier through registered layouts/mounts.

    An arbitrary missing source file is not evidence of a deleted asset.
    """
    from fnmatch import fnmatchcase
    from pathlib import Path

    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.layout import Folder

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


def injected_skill_paths(entries):
    """Native loaded-skill messages carry an explicit directory independently
    of whether the preceding invocation included a resolvable name.
    """
    result = {}
    prefix = 'Base directory for this skill:'
    for entry in entries:
        if entry.kind != EntryKind.USER_MESSAGE:
            continue
        first = (getattr(entry, 'text', '') or '').lstrip().splitlines()
        if first and first[0].startswith(prefix):
            path = first[0][len(prefix):].strip()
            if path:
                result[id(entry)] = path
    return result
