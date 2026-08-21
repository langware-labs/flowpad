"""Removing the row behind an orphaned asset — one definition, two callers.

Both the indexer sweep (``indexer/index_function.py``) and the push path
(``reindex.py``) reap a record whose source file is gone, and they must agree on
exactly how much they take with it. They used not to: the push path went through
``Entity.delete_by_id`` — the TYPED path, whose relationship cascade can unbind
bootstrap-required rows (deleting a "project" orphan that way ripples through
membership and unbinds the ``@local`` compute node) — while the sweep used the
type-scoped driver delete and said so in a comment. Two copies of a rationale
drift on the next edit, so the rationale lives here now and neither caller
carries it.

Deliberately a leaf: it imports nothing from ``fs_store.indexer`` or
``fs_store.reindex``, so both may import it without a cycle.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def remove_orphan_row(entity_id: str, type_name: str) -> bool:
    """Drop the DB row, its FTS entry and its wiki edges. Returns whether a row went.

    Type-scoped driver delete ONLY — never ``Entity.delete()``. An orphan sweep
    wants minimal row removal; anything beyond that belongs in the regular API
    delete path, which knows what a user meant.

    The source file is never touched by any caller of this.
    """
    from flow_sdk.db import get_db_driver  # noqa: PLC0415

    driver = get_db_driver()

    # Best-effort, and first: stale edges pointing at a deleted id outlive the
    # row otherwise. Idempotent, so it is safe when there is no row to delete.
    try:
        from flow_sdk import wiki  # noqa: PLC0415

        await wiki.delete_for_id(type_name, entity_id)
    except Exception:  # noqa: BLE001 — edges are derived; never block the row delete
        logger.debug("wiki edge cleanup failed for %s:%s", type_name, entity_id, exc_info=True)

    if hasattr(driver, "fts_delete"):
        try:
            await driver.fts_delete(entity_id)
        except Exception:  # noqa: BLE001 — FTS is derived, same reasoning
            logger.debug("fts cleanup failed for %s:%s", type_name, entity_id, exc_info=True)

    return bool(await driver.delete_by_id(entity_id, type_name))
