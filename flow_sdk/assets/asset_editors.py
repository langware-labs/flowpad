"""Asset-hosted editors — an SDK app shipped INSIDE a folder asset.

An asset may carry static apps under ``<asset root>/editors/<name>/index.html``.
They are served by the one static-app implementation (``serve_app_bytes``) at
``/api/v1/graph/<type>/<id>/editor/<name>/…`` and hosted by the UI exactly like a
``MicroApp`` — the mechanism ``flow app serve`` uses, addressed from an asset.

Two facts live here and nowhere else: the folder convention and the name rule.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

EDITORS_DIR = "editors"
#: SDK-shipped editors, declared per type through ``TypeMetadata.editors``.
BUILTIN_EDITORS_ROOT = Path(__file__).parent / EDITORS_DIR
#: Same rule ``ui/src/components/app-host/app-resolver.ts`` applies to an app uname.
EDITOR_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$")


def list_asset_editors(root: Path) -> list[str]:
    """Names of the editors an asset folder SHIPS (``editors/<name>/index.html``).
    The type's builtins are not copied onto the row — the client unions them
    from the type registry. One stat when there is no ``editors/`` dir."""
    editors = root / EDITORS_DIR
    if not editors.is_dir():
        return []
    return sorted(p.parent.name for p in editors.glob("*/index.html") if EDITOR_NAME_RE.match(p.parent.name))


def asset_editor_root(entity: Any, name: str) -> Optional[Path]:
    """The folder to serve for editor ``name`` of ``entity``: the asset's own
    ``editors/<name>`` when it ships one, else the type's builtin, else None."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    if not EDITOR_NAME_RE.match(name or ""):
        return None
    info = SchemaRegistry.get(entity.get_type())
    ref = getattr(entity, "asset_ref", None)
    if ref and info is not None:
        # The asset ROOT (the folder for a folder type) — the same resolution
        # ``Entity._storage_origin`` applies to the record's FSRef.
        shipped = Path(info.storage_root_for(Path(str(ref)))) / EDITORS_DIR / name
        if (shipped / "index.html").is_file():
            return shipped
    builtin = BUILTIN_EDITORS_ROOT / name
    if info is not None and name in info.editors and (builtin / "index.html").is_file():
        return builtin
    return None
