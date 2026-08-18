"""Extractor for DATA_SOURCE_SPEC — `agentic-assets/data_source/<name>/data_source.json`.

Thin by design: every rule about what a manifest may say lives in
``flow_sdk/ingest/manifest.py`` as a pure function, so it is testable without a
filesystem. This module only does the I/O and the mapping onto a record.

A manifest that fails validation yields NO record rather than a half-parsed one.
A source that silently loaded with a dropped field is worse than one that is
visibly absent — the author gets a log line naming the rule they broke.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.ingest.manifest import MANIFEST_FILE, ManifestError, parse_manifest

logger = logging.getLogger(__name__)


def extract_data_source_spec(ref: FSRef, resolved_id: str) -> list:
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415 — circular-safe

    folder = ref._path
    if not folder.is_dir():
        return []
    manifest_path = folder / MANIFEST_FILE
    if not manifest_path.is_file():
        return []

    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("[data_source] %s is not readable JSON: %s", manifest_path, exc)
        return []

    try:
        manifest = parse_manifest(raw, files={p.name for p in folder.iterdir()})
    except ManifestError as exc:
        logger.warning("[data_source] %s rejected: %s", manifest_path, exc)
        return []

    rec = FSRecord(
        type=RecordType.DATA_SOURCE_SPEC,
        id=resolved_id,
        name=manifest.name,
        title=manifest.title,
        description=manifest.description,
        icon_name=manifest.icon_name,
        setup_wiki=manifest.setup_wiki,
        manifest_schema=manifest.schema,
        requires=dict(manifest.requires),
        runtime=manifest.runtime.value,
        reflect=list(manifest.reflect),
        config_schema={k: vars(v) for k, v in manifest.config.items()},
        auth=vars(manifest.auth) if manifest.auth else None,
        traits=vars(manifest.traits) if manifest.traits else None,
    )
    rec.asset_ref = FSRef(folder.resolve())
    if ref.scope:
        rec.scope = ref.scope
    return [rec]
