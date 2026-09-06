"""RESOLVE — one path, one asset: its type, its id, its layout.

The interactive counterpart of the index walk. A client hands over a path
(a click, ``flow show``, a watcher event) and needs the ``(type, id)`` the
walk would have assigned, without a walk: classify the path
(``SchemaRegistry.type_for`` — or the type the caller already knows),
locate the asset's root/body/ref (``TypeInfo.layout_of``), ask which row owns
that ref (``Entity.get_by_asset_ref``), and settle the id through the same
``reconcile`` the walk uses. ``index_one`` then parses the asset and syncs
the row, which is what the discover routes and the change-driven re-parse
(``reindex_paths``) need.

``write`` is decided by the caller: it says whether identity may be stamped
into the source bytes. A git-tracked or read-only root passes ``False``.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
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

    @property
    def info(self) -> TypeInfo:
        return SchemaRegistry.get(self.type_name)

    @property
    def layout(self) -> Layout:
        return self.info.layout_of(self.root)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["type"] = data.pop("type_name")
        data["root"] = str(self.root)
        data["body"] = str(self.body) if self.body else None
        return data


async def resolve_asset(
    path: str | Path,
    *,
    write: bool,
    type_name: str | None = None,
    owner_id: str | None = None,
    strict: bool = False,
) -> Resolved:
    """The ``(type, id, layout)`` of the asset at ``path``.

    ``type_name`` is the type the caller already knows (a row being re-parsed);
    without it the registry classifies the path. Either way the type must
    claim the path and the asset must exist on disk, else ``NotAnAsset``.
    ``owner_id`` is the row the caller already resolved, which skips the owner
    lookup; ``strict`` makes a failed owner lookup raise instead of reading as
    "unowned" (pass it whenever a miss leads to a write).
    """
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    p = Path(path).expanduser()
    if not p.is_absolute():
        p = Path("/") / p
    p = p.resolve()
    if type_name is None:
        type_name = SchemaRegistry.type_for(p)
    info = SchemaRegistry.get(type_name) if type_name else None
    if info is None:
        raise NotAnAsset(f"{p} is not an asset")
    if info.claims(p) is not None:
        raise NotAnAsset(f"{p} is not a {type_name}: {info.claims(p)}")
    layout = info.layout_of(p, verify=True)
    if layout.kind is LayoutKind.NONE:
        raise NotAnAsset(f"{p} is not shaped as a {type_name}")
    if owner_id is None:
        owner = await Entity.get_by_asset_ref(layout.ref, strict=strict)
        owner_id = str(owner.id) if owner is not None and getattr(owner, "id", None) else None
    entity_id = reconcile(info, layout, owner_id, None, write=write)
    return Resolved(type_name, entity_id, layout.root, layout.body, info.editor)


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
        resolved.layout.ref,
        record_type=RecordType(resolved.type_name),
        scope=scope or classify_path(resolved.root),
        project_id=project_id,
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

    driver = get_db_driver()
    entity = await driver.get_by_id(resolved.id, resolved.type_name)
    if entity is not None:
        return entity
    if await index_one(resolved) is None:
        logging.debug("[resolve] %s at %s has no parser; no row", resolved.type_name, resolved.root)
        return None
    return await driver.get_by_id(resolved.id, resolved.type_name)
