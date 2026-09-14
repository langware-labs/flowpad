"""Reconcile ``Entity.published`` from the project manifest after it is indexed.

The manifest FILE is the truth; the flag on each referenced row is a cache.
This is the one observer that refreshes it, run by the indexer as the
manifest's ``post_sync_fn`` — so a toggle, a ``git pull`` that brings a new
manifest, and a hand edit all converge the same way.

Two rules keep it safe to run on every scan:

* **Never delete a row from the file.** A referenced entity that has no local
  row yet (pulled via git, not indexed) or no longer exists reads as
  ``install`` / ``missing`` at read time; the file is only ever rewritten to
  fix a ``rel_path`` that the indexer proved moved — and that rewrite is
  byte-identical on the next pass, so it converges in one extra index.
* **A malformed manifest touches nothing.** Clearing every flag because a
  file failed to parse would be a silent unpublish.

Lives under ``fs_store/operations`` (not ``builtin``) so the type_info module
can import it without pulling ``Entity`` in at import time; everything heavy
is imported inside the function.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


async def reconcile_published_cache(rec) -> None:
    """``post_sync_fn`` for ``project_manifest``: set the cache on rows the
    manifest names, clear it on rows it no longer names, and repair a stale
    ``rel_path`` when the referenced asset was proven to have moved."""
    from flow_sdk.assets.project_manifest import ManifestError, publish, read_manifest, rel_path_for  # noqa: PLC0415
    from flow_sdk.builtin.project_manifest import rows_by_id  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.project_manifest_spec import PUBLISHABLE_TYPES  # noqa: PLC0415

    ar = getattr(rec, "_asset_ref", None)
    if ar is None:
        return
    # <mount>/agentic-assets/project_manifest → the mount is two levels up.
    mount = Path(ar.path).parents[1]
    project_id = getattr(rec, "project_id", None)
    try:
        spec = read_manifest(mount)
    except ManifestError:
        logger.warning("[project_manifest] %s is malformed; leaving published flags untouched", ar.path)
        return
    if spec is None:
        return

    wanted = {entry.typeid: entry for entry in spec.entries}

    # 1. Rows the manifest names: cache on, rel_path repaired if the row moved.
    by_type: dict[str, list[str]] = {}
    for entry in spec.entries:
        by_type.setdefault(entry.type, []).append(entry.id)
    found = {t: await rows_by_id(t, ids) for t, ids in by_type.items()}
    for entry in spec.entries:
        ent = found.get(entry.type, {}).get(entry.id)
        if ent is None:
            continue   # pulled via git and not indexed yet, or gone: read-time state
        current_rel = rel_path_for(mount, Path(ent.asset_ref)) if ent.asset_ref else None
        if current_rel and current_rel != entry.rel_path:
            publish(mount, entry.model_copy(update={"rel_path": current_rel}))
        if not ent.published:
            ent.published = True
            await ent.save()

    # 2. Rows that still carry the flag but the manifest no longer names.
    if not project_id:
        return
    for type_name in PUBLISHABLE_TYPES:
        info = SchemaRegistry.get(type_name)
        cls = info.entity_cls if info is not None else None
        if cls is None:
            continue
        stale = await cls.get_all(QueryFilter.parse({"published": True, "project_id": str(project_id)}, type_name))
        for ent in stale or []:
            if str(ent.typeid) in wanted:
                continue
            ent.published = False
            await ent.save()
