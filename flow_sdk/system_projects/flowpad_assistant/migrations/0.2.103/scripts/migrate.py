"""Rename record folders off the retired ``<type>-@<id>`` uname-sigil stem.

The record shadow/data store now names a record's folder by its BARE id under a
``<type>/`` parent — ``records/<type>/<id>/`` and ``records_data/<type>/<id>/`` —
instead of the old ``<type>-@<id>`` (which branded every UUID record as a
malformed uname). Flat / portable namespaces (bundle staging arcs) keep a
self-describing token but drop the ``@``: ``<type>-<id>``.

Folder names are derived (identity lives inside ``metadata.json``), so file-backed
shadows would regenerate on the next index walk — but METADATA-ONLY records
(``app_secret``, ``cli_log_settings``, ``project``, ``run``, ``flow_message`` data,
staged attachments) hold their canonical data in the shadow/data dir and do NOT
regenerate. This one-shot renames every legacy folder so nothing is stranded:

  * ``records/<type>/<type>-@<id>/``        → ``records/<type>/<id>/``
  * ``records_data/<type>/<type>-@<id>/``   → ``records_data/<type>/<id>/``
  * nested staging arcs
    ``…/unpacked/{attachment,metadata}/<type>-@<id>/`` → ``…/<type>-<id>/``
  * ``MessageAttachment`` rows' ``unpacked_path`` / ``entry_key`` (``-@`` → ``-``)

Contract:
* Idempotent — a folder already at its bare/canonical name is skipped (rename only
  fires when ``-@`` is present and the target does not already exist).
* Crash-safe — the sqlite db is backed up before the row rewrite.
* ``run(*, dry_run=False)`` — the runner calls ``run()`` (no args).

NOTE: the directory name (``0.2.103``) must equal the release ``__version__`` this
change ships in, or the runner won't fire it (it resolves the recipe for the
current version only).

Entry point: ``run()``.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

_LEGACY = "-@"


def _rename_top_level_to_bare(root: Path, counts: dict, *, dry_run: bool) -> None:
    """``<root>/<type>/<type>-@<id>/`` → ``<root>/<type>/<id>/`` (bare id)."""
    if not root.is_dir():
        return
    for type_dir in root.iterdir():
        if not type_dir.is_dir():
            continue
        for entry in list(type_dir.iterdir()):
            if not entry.is_dir() or _LEGACY not in entry.name:
                continue
            # ``<type>-@<id>`` → keep everything after the ``-@`` as the bare id.
            _, _, bare = entry.name.partition(_LEGACY)
            if not bare:
                continue
            target = entry.parent / bare
            if target.exists():
                continue
            counts["shadow_dirs"] += 1
            if not dry_run:
                entry.rename(target)


def _rename_staging_arcs_to_canonical(records_data_root: Path, counts: dict, *, dry_run: bool) -> None:
    """Nested bundle staging arcs keep a self-describing token: ``<type>-<id>``.

    Walks ``records_data/flow_message/<id>/unpacked/{attachment,metadata}/`` and
    rewrites any legacy ``<type>-@<id>`` arc to ``<type>-<id>``.
    """
    fm_root = records_data_root / "flow_message"
    if not fm_root.is_dir():
        return
    for fm_dir in fm_root.iterdir():
        unpacked = fm_dir / "unpacked"
        if not unpacked.is_dir():
            continue
        for sub in ("attachment", "metadata"):
            d = unpacked / sub
            if not d.is_dir():
                continue
            for entry in list(d.iterdir()):
                if not entry.is_dir() or _LEGACY not in entry.name:
                    continue
                canonical = entry.name.replace(_LEGACY, "-")
                target = entry.parent / canonical
                if target.exists():
                    continue
                counts["staging_arcs"] += 1
                if not dry_run:
                    entry.rename(target)


def _rewrite_message_attachment_rows(conn, counts: dict, *, dry_run: bool) -> None:
    """``unpacked_path`` / ``entry_key`` on MessageAttachment rows: ``-@`` → ``-``.

    Both fields hold a ``<type>-@<id>`` token (an arc dir name / a staging rel
    path whose last segment is the arc). A UUID never contains ``-@``, so a plain
    replace is safe.
    """
    rows = conn.execute(
        "SELECT id, type, data FROM entities WHERE type = 'message_attachment'"
    ).fetchall()
    for eid, etype, blob in rows:
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except (ValueError, TypeError):
            continue
        changed = False
        for field in ("unpacked_path", "entry_key"):
            val = data.get(field)
            if isinstance(val, str) and _LEGACY in val:
                data[field] = val.replace(_LEGACY, "-")
                changed = True
        if changed:
            counts["ma_rows"] += 1
            if not dry_run:
                conn.execute(
                    "UPDATE entities SET data = ? WHERE id = ? AND type = ?",
                    (json.dumps(data), eid, etype),
                )


def run(*, dry_run: bool = False) -> None:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.fs_store import (
        get_default_records_data_root,
        get_default_records_root,
    )
    from flow_sdk.instance_settings import get_instance_settings

    records_root = get_default_records_root()
    records_data_root = get_default_records_data_root()
    counts = {"shadow_dirs": 0, "staging_arcs": 0, "ma_rows": 0}

    # 1 + 2. Filesystem renames (idempotent; no db needed).
    _rename_top_level_to_bare(records_root, counts, dry_run=dry_run)
    _rename_top_level_to_bare(records_data_root, counts, dry_run=dry_run)
    _rename_staging_arcs_to_canonical(records_data_root, counts, dry_run=dry_run)

    # 3. Rewrite persisted MessageAttachment path/key fields.
    db_path = Path(get_instance_settings().db_path)
    if db_path.exists():
        conn = open_sqlite(db_path)
        try:
            if not dry_run:
                bak = db_path.with_suffix(db_path.suffix + ".pre-stem-rename.bak")
                if not bak.exists():
                    shutil.copy2(db_path, bak)
                    logger.info("[stem-rename] backed up db → %s", bak)
            _rewrite_message_attachment_rows(conn, counts, dry_run=dry_run)
            if not dry_run:
                conn.commit()
        finally:
            conn.close()

    logger.info(
        "[stem-rename] %s: shadow_dirs=%d staging_arcs=%d ma_rows=%d",
        "PLAN" if dry_run else "DONE",
        counts["shadow_dirs"], counts["staging_arcs"], counts["ma_rows"],
    )


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    run(dry_run="--dry-run" in sys.argv)
