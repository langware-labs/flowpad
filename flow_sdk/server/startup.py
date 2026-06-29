"""Startup helpers for SDK-based servers.

Provides ``cleanup_legacy_sod_local`` and ``init_local_storage_driver`` so that
any FastAPI app built on ``flow_sdk`` can initialise drivers without duplicating
the boilerplate that was previously copy-pasted between ``server/app.py`` and
``hub/app.py``.

SOD note: there is no longer a desktop SOD *driver* to initialise. Runtime
secret access falls through ``get_current_sod_store()`` to the single
per-instance store ``get_instance_settings().sod`` (keychain/``SOD_ENC_KEY``
key over ``<inst>/sodot``). The old machine-key ``~/.flowpad/sod.local`` store
is removed; ``cleanup_legacy_sod_local`` deletes it on boot.
"""

import logging
import os
from pathlib import Path

from flow_sdk.config import default_service_config

logger = logging.getLogger(__name__)


def cleanup_legacy_sod_local() -> None:
    """Best-effort one-time removal of the legacy global SOD store.

    ``~/.flowpad/sod.local`` was encrypted with a deterministic, non-secret
    machine key and held github/MCP/env-var secrets globally (not per-instance).
    It is replaced by the per-instance ``sodot``. Clean break — no migration;
    users re-auth integrations. Never raises.
    """
    legacy = Path.home() / ".flowpad" / "sod.local"
    for path in (legacy, legacy.with_suffix(".lock")):
        try:
            if path.exists():
                path.unlink()
                logger.info("Removed legacy SOD store: %s", path)
        except OSError as e:  # noqa: PERF203
            logger.debug("Could not remove legacy SOD file %s: %s", path, e)


def init_local_storage_driver():
    """Set up a local filesystem storage driver for entity blob storage.

    Sets the storage fallback so embedded blob fields (e.g. Task.description)
    can be persisted to disk when no FlowpadService is available.
    """
    from flow_sdk.request_context.methods import set_default_test_storage_fallback
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    mount_path = default_service_config.default_storage_mount_folder
    os.makedirs(mount_path, exist_ok=True)
    storage_driver = LocalStorageDriver(mount_path=mount_path)
    set_default_test_storage_fallback(storage_driver)
