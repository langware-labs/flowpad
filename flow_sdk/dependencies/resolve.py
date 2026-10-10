"""One dependency id → what it is on THIS machine: this machine first, then the hub, else ``not_found``.

An id is a TypeId (``<type>-<uuid>``) or a kind-id (``<kind>.id.<uuid>``). A kind that names an
asset type (``data_source``, or a spec's own ``spec_kind``) is the same asset as its TypeId; any
other kind names a VALUE — a dataset row — which resolves without a folder of its own.

What an asset puts in context, and where its own ``flow.json`` lives, is the type's to say
(``TypeInfo.dependency_roots_fn``): a project is its mount, a data source the folder its files
are in, any other folder asset its own folder. A single-file asset has no dependencies and puts
nothing in context beyond itself.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.schema.data_spec.flow_json_spec import AssetFlowJsonSpec, DependencySource, FlowJsonSpec
from flow_sdk.schema.types import EntityType


@dataclass(frozen=True)
class DependencyRoots:
    """What a type answers for one of its rows: the folder that goes into context (``None``:
    nothing to link), the folder whose ``flow.json`` lists what IT depends on, and whether that
    file is a project's root file (which may also name locations)."""

    context: Optional[str]
    declares: Optional[str]
    project_root: bool = False


@dataclass(frozen=True)
class Resolved:
    """One id, resolved here."""

    typeid: str
    roots: DependencyRoots
    #: Fetched from the hub during this resolve (it was not on this machine).
    fetched: bool = False

    @property
    def context(self) -> Optional[str]:
        return self.roots.context

    @property
    def declares(self) -> Optional[Path]:
        return Path(self.roots.declares) if self.roots.declares else None

    @property
    def spec(self) -> type[AssetFlowJsonSpec]:
        """The shape of the ``flow.json`` under :attr:`declares`."""
        return FlowJsonSpec if self.roots.project_root else AssetFlowJsonSpec


class NotResolved(Exception):
    """An id that did not resolve: ``state`` is a :data:`DependencyStateName`, ``reason`` the sentence."""

    def __init__(self, state: str, reason: str) -> None:
        super().__init__(reason)
        self.state = state
        self.reason = reason


def asset_type_of(source: DependencySource) -> Optional[str]:
    """The asset type an id entry names: a TypeId's own type; a kind-id's when the kind is a type or
    the kind a type's document schema is bound under (``mcp.server`` → ``mcp``). None: it names a value."""
    if source.ref_form == "typeid":
        return source.ref_type
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.fs_store.serializer.fields import asset_info  # noqa: PLC0415

    if SchemaRegistry.get(source.ref_type) is not None:
        return source.ref_type
    info = asset_info(SchemaRegistry.kind_type(source.ref_type))
    return info.type_name if info is not None else None


def typeid_of(source: DependencySource) -> str:
    """The TypeId an id entry names (a kind-id of an asset type is that type's TypeId); a value's
    kind-id stays as written."""
    asset_type = asset_type_of(source)
    return f"{asset_type}-{source.ref_id}" if asset_type else source.target


async def default_roots(row: Any) -> DependencyRoots:
    """A folder asset is its own folder — in context, and the home of its ``flow.json``. A
    single-file asset is neither."""
    ref = getattr(row, "asset_ref", None)
    folder = str(ref) if ref and Path(str(ref)).is_dir() else None
    return DependencyRoots(context=folder, declares=folder)


async def resolve_local(
    source: DependencySource, *, near: Optional[Path] = None, rows: Optional[dict] = None
) -> Optional[Resolved]:
    """The id on this machine, or None. ``near`` is the project a value is looked up in; ``rows`` a
    cache of its dataset rows one walk shares across the values it resolves."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    type_name = asset_type_of(source)
    if type_name is None:
        from flow_sdk.datasets.links import find_row  # noqa: PLC0415

        found = near is not None and find_row(source.target, near, cache=rows) is not None
        return Resolved(typeid=source.target, roots=DependencyRoots(None, None)) if found else None
    info = SchemaRegistry.get(type_name)
    if info is None:
        raise NotResolved("invalid", f"{type_name!r} is not a type")
    typeid = f"{type_name}-{source.ref_id}"
    entity_cls = SchemaRegistry.get_entity_cls(type_name)
    row = await entity_cls.get_by_id(source.ref_id) if entity_cls is not None else None
    if row is None:
        row = _scanned_only(typeid)
        if row is None:
            return None
    return Resolved(typeid=typeid, roots=await (info.dependency_roots_fn or default_roots)(row))


def _scanned_only(typeid: str) -> Any:
    """An asset the index recorded but has no row for: its record's folder stands in for the row."""
    from types import SimpleNamespace  # noqa: PLC0415

    from flow_sdk.assets.asset import Asset  # noqa: PLC0415
    from flow_sdk.fs_store.record_paths import get_default_records_root  # noqa: PLC0415

    try:
        asset = Asset.from_typeid(typeid, records_root=get_default_records_root())
    except Exception:  # noqa: BLE001 — no record, no asset path, or one that drifted: not here
        return None
    return SimpleNamespace(asset_ref=str(asset.path), typeid=typeid)


async def hub_project_for(typeid: str) -> Optional[str]:
    """The id of the hub project that holds ``typeid`` and that this user may read, or None.
    Raises ``HubError`` (its status kept) when the hub cannot answer."""
    from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    data = await hub_get_or_raise(BuiltinEntityType.PROJECT, None, action="resolve_typeid", params={"typeid": typeid})
    data = data.get("data", data) if isinstance(data, dict) else {}
    return str(data.get("project_id") or "") or None


#: Who asks the hub. A test replaces it; nothing else should.
hub_lookup: Callable[[str], Awaitable[Optional[str]]] = hub_project_for

#: Why the hub could not give a dependency, by its status — the one table (a hub project named by
#: location reads it too). 404 is the only definitive "it is not there".
HUB_REASONS = {
    0: "the hub is not reachable (log in to the cloud)",
    401: "log in to the cloud to fetch it",
    403: "you do not have access to the hub project that holds it",
    404: "nothing on this machine or on the hub has this id",
}


def hub_reason(status: int) -> str:
    return HUB_REASONS.get(status, f"the hub answered {status}")


async def resolve_ref(
    source: DependencySource,
    *,
    near: Optional[Path] = None,
    rows: Optional[dict] = None,
    fetch: bool = True,
    fetch_project: Optional[Callable[[str], Awaitable[None]]] = None,
) -> Resolved:
    """``source`` (an id) resolved: this machine, then — when fetching — the hub, whose project
    holding it ``fetch_project`` brings here; else :class:`NotResolved`."""
    local = await resolve_local(source, near=near, rows=rows)
    if local is not None:
        return local
    if not fetch:
        raise NotResolved("missing", "not on this machine — sync to look it up on the hub")
    if fetch_project is None:
        raise NotResolved("not_found", "nothing on this machine has this id")
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

    typeid = typeid_of(source)
    try:
        # A project IS the thing the hub holds; any other id is looked up for the project holding it.
        project_id = source.ref_id if asset_type_of(source) == EntityType.PROJECT.value else await hub_lookup(typeid)
    except HubError as exc:
        status = getattr(exc, "status_code", 0)
        raise NotResolved("not_found" if status == 404 else "unreachable", hub_reason(status)) from exc
    if not project_id:
        raise NotResolved("not_found", hub_reason(404))
    await fetch_project(project_id)
    fetched = await resolve_local(source, near=near, rows=rows)
    if fetched is None:
        raise NotResolved("not_found", f"the hub project {project_id} holds no {typeid} on this machine after fetching it")
    return dataclasses.replace(fetched, fetched=True)


__all__ = [
    "DependencyRoots",
    "NotResolved",
    "Resolved",
    "asset_type_of",
    "default_roots",
    "hub_reason",
    "resolve_local",
    "resolve_ref",
    "typeid_of",
]
