"""Display-target resolution — the one policy for "what does this address show".

Shared by the two agent-facing display verbs so they agree by construction:

* ``flow navigate`` (``server/routes/navigate.py``) — steers the browser tab.
* ``flow show`` (``AgenticProcess._http_show``) — sets the process's display
  focus via the ``on_show`` entity event.

Resolution policy (the ``flow navigate file`` behaviour):
  * typeid → the entity, or ``EntityNotFound`` (unknown type collapses too);
  * path   → the indexed asset's entity when one owns it via ``asset_ref``
             (stable editor view), else a raw vfs pointer — this is what makes
             "agent writes hello.md, then shows it" work without indexing;
  * port   → a webapp preview.
"""

from __future__ import annotations

import os

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.path_utils import canonical_posix_path


class DisplayTargetKind(StrEnum):
    """Discriminator carried in resolved payloads (and asserted by the TS side)."""

    ENTITY = "entity"
    VFS = "vfs"
    WEBAPP = "webapp"


class InvalidDisplayTarget(ValueError):
    """The address itself is malformed (bad typeid / port / nothing given)."""


class DisplayTargetNotFound(LookupError):
    """A well-formed typeid that resolves to no entity."""


async def resolve_display_target(
    typeid: str | None = None,
    path: str | None = None,
    port: object = None,
) -> dict:
    """Resolve one display address to its payload dict.

    Exactly one of ``typeid`` / ``path`` / ``port`` should be given (checked in
    that priority order). Returns ``{"kind": DisplayTargetKind, ...}``; raises
    ``InvalidDisplayTarget`` / ``DisplayTargetNotFound`` for the caller to map
    onto its own response shape (HTTP error body, exit code, ...).
    """
    if typeid:
        try:
            tid = TypeId(typeid)
        except (ValueError, IndexError) as e:
            raise InvalidDisplayTarget(f"Invalid typeid '{typeid}': {e}") from e
        try:
            entity = await Entity.get_by_typeid(tid)
        except ValueError:
            entity = None  # unknown type collapses to "not found"
        if entity is None:
            raise DisplayTargetNotFound(f"Entity not found: {typeid}")
        return _entity_payload(entity)

    if path:
        resolved = canonical_posix_path(os.path.abspath(os.path.expanduser(path)))
        entity = await Entity.get_by_asset_ref(resolved)
        if entity is not None and getattr(entity, "id", None):
            return {**_entity_payload(entity), "path": resolved}
        return {"kind": DisplayTargetKind.VFS, "path": resolved}

    if port is not None:
        try:
            return {"kind": DisplayTargetKind.WEBAPP, "port": int(port)}  # type: ignore[arg-type]
        except (TypeError, ValueError) as e:
            raise InvalidDisplayTarget(f"Invalid port: {port!r}") from e

    raise InvalidDisplayTarget("Must include one of: typeid, path, port")


def _entity_payload(entity: Entity) -> dict:
    return {
        "kind": DisplayTargetKind.ENTITY,
        "typeid": f"{entity.get_type()}-{entity.id}",
        "type": entity.get_type(),
        "id": entity.id,
    }
