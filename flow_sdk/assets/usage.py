"""Resolve transcript evidence to filesystem occurrences without a catalog/index."""
from __future__ import annotations

from collections import defaultdict
from enum import Enum
from pathlib import Path

from pydantic import Field

from flow_sdk.assets.asset import Asset
from flow_sdk.assets.catalog import AssetEvidence, AssetUsageKind
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.transcript_analyzer.entry import EntryKind


class UsageResolution(str, Enum):
    RESOLVED = 'resolved'
    MISSING = 'missing'
    AMBIGUOUS = 'ambiguous'
    UNBOUND = 'unbound'
    IDENTITY_CHANGED = 'identity_changed'


class InvocationBinding(DataSpec):
    name: str
    path: Path


class AssetUsage(DataSpec):
    asset: Asset | None = None
    reference: str
    resolution: UsageResolution
    evidence: list[AssetEvidence] = Field(default_factory=list)


def resolve_usage(entries, *, workdir: str | Path | None = None,
                  assets: list[Asset] = (), bindings: list[InvocationBinding] = ()) -> list[AssetUsage]:
    """Paths are evidence; a bare invocation name needs an explicit binding.

    Never derive invocation precedence from folder names or current inventory.
    Missing and ambiguous historical references survive as unresolved records.
    """
    from flow_sdk.assets.transcript_evidence import (
        injected_skill_paths,
        recognizable_asset_reference,
        skill_result_paths,
    )
    result_paths = skill_result_paths(entries)
    injected_paths = injected_skill_paths(entries)
    grouped = {}
    evidence_by_occurrence = defaultdict(list)
    seen = set()
    for entry in entries:
        if entry.kind not in (EntryKind.FILE_READ, EntryKind.SKILL_CALL) and id(entry) not in injected_paths:
            continue
        entry_id = getattr(entry, 'tool_use_id', None) or getattr(entry, 'entry_id', None) or getattr(entry, 'id', None) or None
        timestamp = getattr(entry, 'timestamp', None)
        kind = AssetUsageKind.TRANSCRIPT_FILE_READ if entry.kind == EntryKind.FILE_READ else AssetUsageKind.SKILL_INVOKED
        raw_path = getattr(entry, 'path', None) or injected_paths.get(id(entry))
        if not raw_path and entry.kind == EntryKind.SKILL_CALL:
            raw_path = (getattr(entry, 'tool_input', None) or {}).get('file_path') or result_paths.get(getattr(entry, 'tool_use_id', None))
        reference = getattr(entry, 'skill_name', '') or raw_path
        if not reference:
            continue
        tool_id = getattr(entry, 'tool_use_id', None)
        event_key = ('tool', tool_id) if tool_id else (entry_id, str(reference)) if entry_id else (id(entry), str(reference))
        if event_key in seen:
            continue
        seen.add(event_key)
        asset = None
        resolution = UsageResolution.UNBOUND
        path = None
        if raw_path:
            path = Path(raw_path).expanduser()
            if not path.is_absolute():
                path = Path(workdir) / path if workdir else None
            if path is not None:
                # Preserve the entry spelling for alias occurrence attribution.
                path = path.absolute()
                matching = [a for a in assets if path == a.path or a.path in path.parents]
                if matching:
                    previous = max(matching, key=lambda a: len(a.path.parts))
                    try:
                        current = Asset.from_path(previous.path, project_id=previous.project_id)
                        asset = current if current.typeid == previous.typeid else None
                        if asset is None:
                            resolution = UsageResolution.IDENTITY_CHANGED
                    except (OSError, ValueError, LookupError):
                        asset = None
                if asset is None and not matching:
                    try:
                        asset = Asset.containing(path)
                    except (OSError, ValueError, LookupError):
                        asset = None
                if asset is None and not matching and not recognizable_asset_reference(path):
                    continue
                if resolution != UsageResolution.IDENTITY_CHANGED:
                    resolution = UsageResolution.RESOLVED if asset else UsageResolution.MISSING
        else:
            paths = {binding.path for binding in bindings if binding.name == reference}
            if len(paths) > 1:
                resolution = UsageResolution.AMBIGUOUS
            elif paths:
                try:
                    asset = Asset.from_path(paths.pop())
                except (OSError, ValueError, LookupError):
                    resolution = UsageResolution.MISSING
                else:
                    resolution = UsageResolution.RESOLVED
        evidence = AssetEvidence(kind=kind, path=str(path) if path else None,
                                 entry_id=entry_id, timestamp=str(timestamp) if timestamp else None,
                                 label='Read in transcript' if kind == AssetUsageKind.TRANSCRIPT_FILE_READ else f'Invoked via /{reference}')
        key = ('asset', str(asset.path)) if asset else (resolution, str(path or reference))
        if key not in grouped:
            grouped[key] = AssetUsage(asset=asset, reference=str(reference), resolution=resolution)
        evidence_by_occurrence[key].append(evidence)
    return [usage.model_copy(update={'evidence': evidence_by_occurrence[key]}) for key, usage in grouped.items()]


def apply_usage(descriptors, usages, *, sources=()):
    """Join resolved evidence while preserving descriptor occurrence identity."""
    from flow_sdk.assets.catalog import descriptor_from_asset
    result = {d.posix_path: d for d in descriptors}
    for usage in usages:
        if usage.asset is None:
            continue
        path = str(usage.asset.path)
        descriptor = result.get(path) or descriptor_from_asset(usage.asset, sources)
        result[path] = descriptor.model_copy(update={'usage': list(usage.evidence)})
    return list(result.values())


def usage_project_context(usages, folders):
    """Supply occurrence project context from explicit caller-owned folders."""
    result = []
    for usage in usages:
        if usage.asset is None:
            result.append(usage)
            continue
        path = usage.asset.path
        matches = [folder for folder in folders if folder.project_id and (path == folder.path or folder.path in path.parents)]
        if matches:
            folder = max(matches, key=lambda value: len(value.path.parts))
            usage = usage.model_copy(update={'asset': usage.asset.model_copy(update={'project_id': folder.project_id})})
        result.append(usage)
    return result
