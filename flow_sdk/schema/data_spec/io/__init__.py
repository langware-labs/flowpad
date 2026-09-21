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

**This is NOT the asset writer, and it is not a more general version of one.**
``assets/serialization.py`` writes every registered asset type; this module has
exactly one production consumer — the typed dataset slots in
``data_spec/layout.py``. Running both over all 20 registered types, this one
changes bytes for every single one. Fourteen distinct divergences, not one:

1. the main document is renamed (``trace.json``→``agent_trace.json``,
   ``SKILL.md``→``skill.json``, ``mcp.json``→``server.json``) — 14 of 20 types
2. a File-layout asset becomes a folder + json + body
3. ``SKILL.md`` / ``task.md`` / ``spec.md`` split into two files
4. ``null`` is written for every unset field (no ``exclude_none``)
5. defaults are written explicitly (no ``exclude_defaults``)
6. field aliases are dropped (``schema``→``manifest_schema``), which makes a
   ``project_manifest`` unreadable
7. non-ASCII is escaped to a ``\\u`` sequence (no ``ensure_ascii=False``)
8. sectioned headers are flattened and the free section re-keyed
9. ``type``/``id``/``version`` are dropped from entity documents
10. inline lists and dicts are exploded into directory trees — the 33 fields
    where ``Placement`` and ``FieldKind`` disagree, pinned by
    ``test_the_two_classification_tables.py``
11. the body is no longer stripped and its trailing newline is dropped
12. identity: 1 of 4 carriers implemented, always v4 — 6 live types need a
    keyed v5, and 30 of 43 get a capsule they should not have
13. writes are non-atomic and unlocked; capsule blocks are destroyed
14. the ``owns_main_ref`` guard is gone, so it always overwrites

Round trip fails BOTH directions for ``skill``, ``task`` and
``project_manifest``: each side looks for a file the other never wrote, and
both degrade silently to an empty document rather than erroring.

This module is right about exactly one thing the asset writer is not: an
unnamed list element gets an ordinal folder where ``serialization.py`` raises.
No registered asset spec declares such a field, so today that buys nothing.

If this is ever meant to become the asset writer, the list above is the
specification — and the change is a migration of every user's files, not a
refactor.
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
