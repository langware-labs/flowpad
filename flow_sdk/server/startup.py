"""Startup helpers for SDK-based servers.

Provides ``init_sod_driver`` and ``init_local_storage_driver`` so that any
FastAPI app built on ``flow_sdk`` can initialise drivers without duplicating
the boilerplate that was previously copy-pasted between ``server/app.py`` and
``hub/app.py``.
"""

import os
import base64
import hashlib
from pathlib import Path

from flow_sdk.config import default_service_config


def init_sod_driver():
    """Set up a file-based SOD driver for local secret storage.

    Uses a deterministic encryption key derived from the machine.
    Secrets are stored in ~/.flowpad/sod.local (encrypted).
    """
    from flow_sdk.sod.file_sod import FileSodStorage
    from flow_sdk.request_context.methods import set_default_test_sod_driver

    seed = f"flowpad-local-sod-{Path.home()}"
    raw_key = hashlib.sha256(seed.encode()).digest()
    fernet_key = base64.urlsafe_b64encode(raw_key)

    sod_dir = Path.home() / ".flowpad"
    sod_dir.mkdir(parents=True, exist_ok=True)
    default_service_config.sod_enc_key = fernet_key.decode()
    default_service_config.sod_file_name = str(sod_dir / "sod.local")

    sod_driver = FileSodStorage(default_service_config)
    set_default_test_sod_driver(sod_driver)


def init_local_storage_driver():
    """Set up a local filesystem storage driver for entity blob storage.

    Sets the storage fallback so embedded blob fields (e.g. Task.description)
    can be persisted to disk when no FlowpadService is available.
    """
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver
    from flow_sdk.request_context.methods import set_default_test_storage_fallback

    mount_path = default_service_config.default_storage_mount_folder
    os.makedirs(mount_path, exist_ok=True)
    storage_driver = LocalStorageDriver(mount_path=mount_path)
    set_default_test_storage_fallback(storage_driver)
