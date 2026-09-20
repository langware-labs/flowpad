"""``save`` and ``load`` — a shape puts itself on disk and comes back.

The folder IS the value: nothing else is needed to move it, copy it or hand it
to another machine. One rule table (``placement.py``), one naming scheme
(``names.py``), one walk each way (``writer.py`` / ``reader.py``), and identity
as a carrier beside the document rather than a field inside it
(``identity.py``).

Pure: stdlib, pydantic, and one lazy ``SchemaRegistry`` call to learn a type's
own name — the guard ``_kinds.py`` established. Everything that needs
``TypeInfo`` (where an asset's root is, which carrier it uses) stays in the
adapter above.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.io.identity import Carrier, FolderCapsule, ensure_id
from flow_sdk.schema.data_spec.io.native import Binary, Text
from flow_sdk.schema.data_spec.io.placement import Placement, placement_of, placements
from flow_sdk.schema.data_spec.io.reader import read
from flow_sdk.schema.data_spec.io.writer import write


def save(value: Any, root: "Path | str", *, carrier: Optional[Carrier] = None) -> str:
    """Write *value* into *root*; return the folder's id."""
    return write(value, Path(root), carrier=carrier)


def load(spec: type, root: "Path | str") -> Any:
    """Read a *spec* back out of *root*."""
    return read(spec, Path(root))


__all__ = [
    "Binary",
    "Carrier",
    "FolderCapsule",
    "Placement",
    "Text",
    "ensure_id",
    "load",
    "placement_of",
    "placements",
    "read",
    "save",
    "write",
]
