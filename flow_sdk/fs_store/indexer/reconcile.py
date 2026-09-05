"""RECONCILE — the carrier against the store, for one walked asset.

A full-content rewrite can wipe an asset's carrier, so a carrier-less source
is not a new asset when a row already owns the path: it is that row, and its
id is stamped back. The axis is CARRIER LIVENESS:

    1. the carrier   IF no row owns this path
                     OR the carrier IS that row
                     OR the carrier is a live id of this type
    2. else the owning row (never for a derived type: its id is a pure
       function of the source, so a stale row on a rotated session path must
       not swallow a different asset)
    3. else MINT (``TypeInfo.mint``)

``live_ids=None`` means "cannot prove dead", so a valid carrier still wins —
only the index walk, holding the complete per-type id set, may conclude a
carrier is a fossil. A ``Foreign`` carrier (a v7, a slug) is recorded as a
``foreign_id`` scan issue and answered with the keyed/path v5 so the asset
still indexes; a legacy markdown capsule is converted into the header here,
id unchanged.
"""
from __future__ import annotations

import logging
from collections.abc import Container
from pathlib import Path
from typing import Any

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.identity_carrier import LEGACY_CONVERTIBLE, Foreign, Found, Unstamped
from flow_sdk.fs_store.indexer.index_log import FOREIGN_ID, ScanIssue, append_scan_issue
from flow_sdk.schema.layout import Layout


def reconcile(
    info: Any,
    layout: Layout,
    owner_row: str | None,
    live_ids: "Container[str] | None",
    *,
    write: bool,
    ref: Any = None,
) -> str:
    """The id for the asset at ``layout`` given what the store knows: the row
    owning its path (``owner_row``) and the live ids of its type. ``write``
    gates every byte touched. ``ref`` reaches the stable-key function when it
    carries more than the path. Sync; never touches the DB."""
    carrier = info.carrier
    where = carrier.locate(layout)
    found = carrier.read(where)

    def _fallback() -> str:
        key = info.stable_key_for(ref if ref is not None else layout.ref)
        return mint_uuid(key or str(Path(layout.ref or where).resolve()), namespace=info.id_namespace)

    if isinstance(found, Found):
        live = owner_row is None or found.id == owner_row or live_ids is None or found.id in live_ids
        if live:
            if write and found.source in LEGACY_CONVERTIBLE and hasattr(carrier, "convert") and carrier.accepts(where):
                try:
                    carrier.convert(where, found.id)
                except OSError:
                    logging.debug("[asset-id] legacy→frontmatter conversion skipped for %s", where, exc_info=True)
            return found.id
        if owner_row and carrier.writable:
            # A fossil: syntactically valid, names no entity. The bytes stay —
            # a present carrier is never rewritten — and the row answers.
            logging.warning(
                "[asset-id] %s carrier %r names no live entity; path is owned by %s (%s)",
                info.type_name, found.id, owner_row, where,
            )
            return owner_row
    elif isinstance(found, Foreign):
        append_scan_issue(
            ScanIssue(path=str(where), kind=FOREIGN_ID, detail=f"{found.source}: {found.raw!r}", type_name=info.type_name)
        )
        if owner_row and carrier.writable:
            return owner_row
        return _fallback()
    elif owner_row and carrier.writable:
        # Absent carrier under an owning row: heal it in place when allowed.
        if write and carrier.accepts(where):
            try:
                carrier.stamp(where, owner_row)
            except OSError:
                logging.debug("[asset-id] re-stamp skipped for %s", where, exc_info=True)
        return owner_row

    try:
        return info.mint(layout, write=write, ref=ref, found=found)
    except Unstamped:
        # Not written and keyless: the stable path-derived v5 is the one
        # deterministic answer (a read-only portable asset, a failed write).
        return _fallback()
