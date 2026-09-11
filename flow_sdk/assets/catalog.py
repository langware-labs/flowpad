"""Filesystem asset catalog and transport values; callers supply scope context."""
from __future__ import annotations

import asyncio
from enum import Enum
from pathlib import Path

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType


class AssetSource(str, Enum):
    EMBEDDED = 'embedded'
    INLINE = 'inline'
    PROJECT_DIR = 'project_dir'
    USER_DIR = 'user_dir'
    WORKDIR = 'workdir'
    ADDITIONAL_DIR = 'additional_dir'
    CONTEXT_DIR = 'context_dir'
    SYSTEM = 'system'
    EXTERNAL = 'external'


class AssetUsageKind(str, Enum):
    TRANSCRIPT_FILE_READ = 'transcript_file_read'
    SKILL_INVOKED = 'skill_invoked'


class AssetEvidence(DataSpec):
    kind: AssetUsageKind
    path: str | None = None
    entry_id: str | None = None
    timestamp: str | None = None
    label: str | None = None


class AssetDescriptor(DataSpec):
    typeid: str
    source: AssetSource
    posix_path: str | None
    source_dir: str | None = None
    project_id: str | None = None
    usage: list[AssetEvidence] = Field(default_factory=list)
    remote: bool | None = None
    name: str | None = None
    invocation_name: str | None = None
    attached: bool = False
    available: bool = False
    present: bool = True

    def to_row(self) -> dict:
        return self.model_dump(mode='json')


EXECUTABLE_ASSET_TYPES = (EntityType.SKILL, EntityType.SUBAGENT, EntityType.MCP)
READONLY_ASSET_SOURCES = frozenset(set(AssetSource) - {AssetSource.EMBEDDED, AssetSource.INLINE})


def is_readonly_source(source: AssetSource) -> bool:
    return source in READONLY_ASSET_SOURCES


def add_source_dir(pairs, seen, path, source):
    if path:
        key = str(Path(path).expanduser().resolve())
        if key not in seen:
            pairs.append((key, source))
            seen.add(key)


def source_match_for_asset(asset_path, ranked_sources):
    from fnmatch import fnmatchcase

    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    path = Path(asset_path)
    for root, source in sorted(ranked_sources, key=lambda pair: -len(pair[0])):
        directory = Path(root)
        if path != directory and directory not in path.parents:
            continue
        if source == AssetSource.USER_DIR:
            # A home prefix alone does not make arbitrary checkouts user assets.
            relative = path.relative_to(directory).parts
            mounts = [Path(mount).parts for name in SchemaRegistry.get_all_types()
                      for mount in SchemaRegistry.get(name).scan_mounts]
            if not any(len(relative) >= len(parts) and all(fnmatchcase(value, pattern)
                       for value, pattern in zip(relative, parts)) for parts in mounts):
                continue
        return root, source
    return None


def descriptor_from_asset(asset, sources=(), *, attached=False):
    match = source_match_for_asset(asset.path, sources)
    root, source = match if match else (None, AssetSource.EXTERNAL)
    return AssetDescriptor(typeid=str(asset.typeid), source=AssetSource.EMBEDDED if attached else source,
                           posix_path=str(asset.path), source_dir=root, project_id=asset.project_id,
                           name=asset.name, attached=attached)


def folders_for_sources(sources, project_id=None):
    from flow_sdk.assets.folder import AssetFolder
    return [AssetFolder(path=Path(path), project_id=project_id if source == AssetSource.PROJECT_DIR else None,
                        recursive=source in (AssetSource.PROJECT_DIR, AssetSource.CONTEXT_DIR))
            for path, source in sorted(sources, key=lambda pair: -len(pair[0])) if source != AssetSource.SYSTEM]


def descriptors_from_folders(folders, sources, types):
    from flow_sdk.assets.folder import collect_assets
    return [descriptor_from_asset(asset, sources) for asset in collect_assets(folders) if asset.typeid.type in types]


async def scan_path_asset_descriptors(sources, own_project_id, types, limit=10000, offset=0):
    values = await asyncio.to_thread(descriptors_from_folders, folders_for_sources(sources, own_project_id), sources, types)
    return values[offset:offset + limit] if limit else values[offset:]
