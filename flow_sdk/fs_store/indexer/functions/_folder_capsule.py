"""The retired ``.flow/id`` folder id file — read-only.

A folder asset once stored its id in ``<folder>/.flow/id`` (one line, the
v4/v5 UUID). The live forms are the json capsule (``Sidecar``) and the main
document's frontmatter (``Frontmatter``); this reader exists so the identity
migration can carry an old id across, and it is never written.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _asset_path(ref: Any) -> Path:
    return Path(getattr(ref, "_path", ref))


def _capsule_path(folder: Any) -> Path:
    return _asset_path(folder) / ".flow" / "id"


def read_folder_capsule_id(folder: Any) -> str | None:
    """Adopt the folder's ``.flow/id`` capsule id (validated v4/v5), else ``None``.

    Routes through ``adopt_entity_id`` so a foreign/garbage capsule id (a v7, a
    hand-typed token) is rejected → ``None`` and the caller mints a fresh v4.
    """
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

    try:
        raw = _capsule_path(folder).read_text(encoding="utf-8")
    except OSError:
        return None
    return adopt_entity_id(raw)
