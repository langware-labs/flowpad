"""RESOLVE — one path, one asset: its type, its id, its layout.

The interactive counterpart of the index walk. A client hands over a path
(a click, ``flow show``, a watcher event) and needs the ``(type, id)`` the
walk would have assigned, without a walk: classify the path
(``SchemaRegistry.type_for``), locate the asset's root/body
(``TypeInfo.layout_of``), ask which row owns that root, and settle the id
through the same ``reconcile`` the walk uses. ``index_one`` then parses the
asset and syncs the row, which is what the discover routes and the
change-driven re-parse (``reindex_paths``) need.

THE PATH IS THE CLASSIFICATION. ``type_name`` is the type of a ROW being
re-parsed (with that row's ``owner_id``), never a client's opinion about what a
file is: a bespoke-walked type is told apart by where the WALK found it, so
naming one would mint a row for a path it does not own. A type keyed on its
walk ref (``TypeInfo.keyed_by_ref``) is refused outright — from a bare path its
v5 is a different one.

``write`` is decided by the caller: it says whether identity may be stamped
into the source bytes. A git-tracked or read-only root passes ``False``.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.indexer.reconcile import reconcile
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.layout import Layout, LayoutKind


class NotAnAsset(LookupError):
    """``path`` is not an asset: no type claims it, or it does not exist."""


@dataclass(frozen=True)
class Resolved:
    type_name: str
    id: str
    root: Path
    body: Path | None
    editor: str | None
    #: The VERIFIED layout this was decided on — carried so no consumer
    #: re-derives (and re-stats) what is already settled.
    layout: Layout = field(repr=False, compare=False, default=None)  # type: ignore[assignment]
    #: The row the owner lookup fetched, if any: ``ensure_entity``'s answer
    #: whenever it IS the resolved id.
    owner: Any = field(repr=False, compare=False, default=None)

    @property
    def info(self) -> TypeInfo:
        return SchemaRegistry.get(self.type_name)

    def to_dict(self) -> dict:
        """The wire shape ``GET /api/v1/assets/resolve`` answers with."""
        return {
            "type": self.type_name,
            "id": self.id,
            "root": str(self.root),
            "body": str(self.body) if self.body else None,
            "editor": self.editor,
        }


async def _owner_row(info: TypeInfo, root: Path, *, strict: bool) -> Any:
    """The row of THIS TYPE whose ``asset_ref`` is ``root`` — one query, not
    ``Entity.get_by_asset_ref``'s ~25-type fan-out: the owner is fed to a
    per-type ``reconcile``, so another type's row would be the wrong answer."""
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import asset_ref_spellings  # noqa: PLC0415

    entity_cls = info.entity_cls
    if entity_cls is None or "asset_ref" not in getattr(entity_cls, "model_fields", {}):
        return None
    if not getattr(entity_cls, "owns_asset_ref", True):
        return None
    return await Entity.first_across_asset_owners(
        "asset_ref", asset_ref_spellings(str(root)), strict=strict, candidates=[entity_cls]
    )


async def resolve_asset(
    path: str | Path,
    *,
    write: bool,
    type_name: str | None = None,
    owner_id: str | None = None,
    strict: bool = False,
    known_unowned: bool = False,
) -> Resolved:
    """The ``(type, id, layout)`` of the asset at ``path``.

    ``type_name`` + ``owner_id`` are the type and id of the ROW being
    re-parsed; without them the registry classifies the path. Either way the
    type must claim the path and the asset must exist on disk, else
    ``NotAnAsset``. ``strict`` makes a failed owner lookup raise instead of
    reading as "unowned" (pass it whenever a miss leads to a write);
    ``known_unowned`` says the caller has ALREADY proved no row owns this
    asset, so the lookup is skipped rather than repeated.
    """
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = Path("/") / p
    p = p.resolve()
    named = type_name
    if type_name is None:
        type_name = SchemaRegistry.type_for(p)
    info = SchemaRegistry.get(type_name) if type_name else None
    if info is None:
        raise NotAnAsset(f"{p} is not an asset")
    if named is not None and owner_id is None and not info.walk:
        # And `claims` cannot refuse it: the bespoke `.json` types all
        # declare `File(".json")`.
        raise NotAnAsset(f"{p}: {named} is walked bespoke; a caller-named type is not a classification")
    if info.keyed_by_ref:
        raise NotAnAsset(f"{p}: a {type_name} is keyed on its walk ref, which a path does not carry")
    if (refusal := info.claims(p)) is not None:
        raise NotAnAsset(f"{p} is not a {type_name}: {refusal}")
    layout = info.layout_of(p, verify=True)
    if layout.kind is LayoutKind.NONE:
        raise NotAnAsset(f"{p} is not shaped as a {type_name}")
    owner = None
    if owner_id is None and not known_unowned:
        owner = await _owner_row(info, layout.root, strict=strict)
        owner_id = str(owner.id) if owner is not None and getattr(owner, "id", None) else None
    entity_id = reconcile(info, layout, owner_id, None, write=write)
    return Resolved(type_name, entity_id, layout.root, layout.body, info.editor, layout=layout, owner=owner)


async def index_one(
    resolved: Resolved,
    *,
    notify: bool = False,
    scope: str | None = None,
    project_id: str | None = None,
) -> Any:
    """Parse the asset ``resolved`` names and sync its row; the record, or
    None when the type has no parser. ``scope``/``project_id`` are the row's
    own labels when the caller has them; otherwise the path is classified and
    the deepest project mount owning it wins, as in the walk."""
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.roots import (  # noqa: PLC0415
        classify_path,
        deepest_project_id_for_path,
        load_project_mounts,
    )
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    info = resolved.info
    ref = FSRef(
        resolved.root,
        record_type=RecordType(resolved.type_name),
        scope=scope or classify_path(resolved.root),
        project_id=project_id,
        layout=resolved.layout,
    )
    record = info.record_for(ref, resolved.id)
    if record is None:
        return None
    if not project_id:
        try:
            project_id = deepest_project_id_for_path(canonical_posix_path(resolved.root), await load_project_mounts())
        except OSError:
            project_id = None
    if project_id:
        object.__setattr__(record, "project_id", project_id)
    await record.sync_to_db(notify=notify)
    return record


async def ensure_entity(resolved: Resolved) -> Any:
    """The row for ``resolved``, indexed on a miss. None only when the type
    cannot be parsed or the sync did not produce a row."""
    from flow_sdk.db import get_db_driver  # noqa: PLC0415

    owner = resolved.owner
    if owner is not None and str(getattr(owner, "id", "")) == resolved.id:
        # The owner lookup already fetched this very row.
        return owner
    driver = get_db_driver()
    entity = await driver.get_by_id(resolved.id, resolved.type_name)
    if entity is not None:
        return entity
    if await index_one(resolved) is None:
        logging.debug("[resolve] %s at %s has no parser; no row", resolved.type_name, resolved.root)
        return None
    return await driver.get_by_id(resolved.id, resolved.type_name)
