"""Identity for a driver-style folder asset: its manifest's ``name``, never its path."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from flow_sdk.fs_store.fs_ref import FSRef


def name_identity_key(main_file: str) -> Callable[["FSRef | Path"], str]:
    """An ``identity_key_fn`` answering the manifest's ``name`` (the folder's name when it has none).

    A shipped asset's path names the INSTALL, which moves on every upgrade; its name is the key
    its own registry already uses. Same rule as ``data_driver.data_driver_identity_key``.
    """

    def key(ref: "FSRef | Path") -> str:
        path = Path(getattr(ref, "_path", ref))
        root = path.parent if path.is_file() else path
        try:
            name = str(json.loads((root / main_file).read_text(encoding="utf-8")).get("name") or "").strip()
        except (OSError, TypeError, AttributeError, json.JSONDecodeError):
            name = ""
        return name or root.name

    return key
