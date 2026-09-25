"""The roots a filesystem migration walks: the ones this instance indexes.

Home, the working directory, the system project and every project mount, read from the instance's
store; without a store (a fresh install), the default roots. One helper so a migration never borrows
another migration's private function.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("migrate.roots")


def instance_roots() -> list[Path]:
    """The instance's index roots; without a store, the ones a fresh install still has."""
    try:
        from flow_sdk.migrations.migration_2026_09_identity_live_forms import _open, _roots

        conn = _open(None)
        try:
            return [Path(root._path) for root in _roots(conn)]
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 — no store yet is an install, not a failure
        logger.info("migration roots: no instance store (%s); walking the default roots", type(exc).__name__)
        from flow_sdk.fs_store.indexer.roots import default_roots

        return [Path(root._path) for root in default_roots()]


__all__ = ["instance_roots"]
