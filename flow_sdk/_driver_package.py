"""How a data driver folder's package is named, and how to see through the name.

A driver folder is imported as ``flowpad_source_<folder>_<content digest>`` (``ingest.driver_registry``).
The same folder, edited, comes back under a new digest; the kind registry (``fs_store.schema_registry``)
must still see its classes as the same definitions, or the edit never takes effect in a running server.
Both sides read these three names, and nothing else, so they cannot drift. A leaf: no imports.
"""
from __future__ import annotations

import re

DRIVER_PACKAGE_PREFIX = "flowpad_source_"
DRIVER_DIGEST_LEN = 8
_PACKAGE = re.compile(rf"({re.escape(DRIVER_PACKAGE_PREFIX)}.+)_[0-9a-f]{{{DRIVER_DIGEST_LEN}}}(\..*)?")


def driver_package(folder_name: str, digest: str) -> str:
    """The package a driver folder is imported as."""
    return f"{DRIVER_PACKAGE_PREFIX}{re.sub(r'[^0-9A-Za-z_]', '_', folder_name)}_{digest[:DRIVER_DIGEST_LEN]}"


def driver_module_identity(module: str) -> str:
    """``module`` with a driver package's content digest taken out, so a reloaded driver is its own
    earlier self; any other module name as it is."""
    found = _PACKAGE.fullmatch(module or "")
    return f"{found.group(1)}{found.group(2) or ''}" if found else module
