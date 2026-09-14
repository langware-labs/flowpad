"""Filesystem projections and ownership receipts for process attachments.

Callers supply sources and destinations; process persistence is outside this module.
"""
from __future__ import annotations

from pathlib import Path

from pydantic import ConfigDict

from flow_sdk.assets.asset import Asset
from flow_sdk.assets.directory import AssetDir
from flow_sdk.assets.materialize import MaterializationMode
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.spec import DataSpec


class EmbeddedAsset(DataSpec):
    model_config = ConfigDict(frozen=True)
    name: str
    path: Path
    source: Path | None = None
    content: str | None = None


class ProjectionReceipt(DataSpec):
    model_config = ConfigDict(frozen=True)
    path: Path
    source: Path | None = None
    mode: MaterializationMode = MaterializationMode.COPY
    ownership: tuple[int, int]


def owns_projection(receipt: ProjectionReceipt) -> bool:
    try:
        stat = receipt.path.lstat()
    except FileNotFoundError:
        return False
    return receipt.ownership == (stat.st_dev, stat.st_ino)


def materialize_projection(projection: EmbeddedAsset, *, ref: TypeId,
                           receipts: dict[str, ProjectionReceipt],
                           mode: MaterializationMode = MaterializationMode.COPY) -> ProjectionReceipt:
    """Write a projection only into a free or still-owned destination."""
    path = projection.path.parent.resolve() / projection.path.name
    receipt = receipts.get(str(ref))
    if receipt is not None and receipt.path != path:
        raise ValueError(f"Asset {ref} is already attached at {receipt.path}; detach it before relocating")
    if any(key != str(ref) and value.path == path for key, value in receipts.items()):
        raise FileExistsError(f"Another asset is attached at {path}")
    owned = receipt is not None and owns_projection(receipt)
    if (path.exists() or path.is_symlink()) and not owned:
        raise FileExistsError(f"Refusing to replace an unowned asset at {path}")
    if projection.content is not None:
        AssetDir(path.parent).load_asset(path.name, content=projection.content)
    elif projection.source is not None:
        from flow_sdk.assets.asset import AssetIdentityMismatch
        source = Asset.from_path(projection.source)
        if source.typeid != ref:
            raise AssetIdentityMismatch(f"Projection source {source.typeid} does not match {ref}")
        source.install(path, mode=mode, overwrite=owned)
    else:
        raise FileNotFoundError(f"Asset source missing: {ref}")
    stat = path.lstat()
    return ProjectionReceipt(path=path, source=projection.source, mode=mode,
                             ownership=(stat.st_dev, stat.st_ino))


def remove_projection(receipt: ProjectionReceipt) -> None:
    if receipt.path.exists() or receipt.path.is_symlink():
        if not owns_projection(receipt):
            raise ValueError(f"Asset projection was replaced externally: {receipt.path}")
        AssetDir(receipt.path.parent).remove(receipt.path.name)


async def _skill(ref: TypeId, root: Path, skills_root: Path, source: Asset | None) -> EmbeddedAsset:
    source = source or Asset.from_typeid(ref)
    return EmbeddedAsset(name=source.path.name, path=skills_root / source.path.name, source=source.path)


def read_subagent(path: Path) -> tuple[dict, str]:
    """Parse the registered subagent specification without writing its source."""
    from flow_sdk.assets.frontmatter import _extract_body, _extract_frontmatter, _yaml_load
    from flow_sdk.capsules import strip_capsule_blocks
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.types import EntityType
    text = strip_capsule_blocks(path.read_text(encoding="utf-8"))
    fields = _yaml_load(_extract_frontmatter(text) or "") or {}
    fields.pop("id", None)
    spec = SchemaRegistry.get(EntityType.SUBAGENT).asset_spec.model_validate(fields)
    header = spec.model_dump(exclude_none=True, exclude={"prompt"})
    header["name"] = header.get("name") or path.stem
    return header, _extract_body(text)


def import_subagent(path: Path, root: Path, *, existing_id: str | None = None) -> tuple[TypeId, EmbeddedAsset]:
    """Explicitly convert a standalone document into a subagent occurrence."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
    from flow_sdk.assets.frontmatter import _render_frontmatter
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.types import EntityType
    path = path.expanduser().resolve(strict=True)
    if path.suffix.lower() != ".md" or not path.is_file():
        raise ValueError("Subagent import requires a markdown file")
    header, body = read_subagent(path)
    observed = SchemaRegistry.get(EntityType.SUBAGENT).read_id(path)
    identity = observed if observed and is_valid_entity_id(observed) else existing_id or mint_uuid()
    ref = TypeId(type=EntityType.SUBAGENT, id=identity)
    header["id"] = identity
    name = header["name"]
    if Path(name).name != name or name in (".", ".."):
        raise ValueError("Subagent name must be one filename component")
    return ref, EmbeddedAsset(name=name, path=root / ".claude" / "agents" / f"{name}.md",
                              source=path, content=_render_frontmatter(header) + "\n\n" + body + "\n")


async def _subagent(ref: TypeId, root: Path, skills_root: Path, source: Asset | None) -> EmbeddedAsset:
    source = source or Asset.from_typeid(ref)
    return EmbeddedAsset(name=source.path.stem, path=root / ".claude" / "agents" / source.path.name,
                         source=source.path)


async def _mcp(ref: TypeId, root: Path, skills_root: Path, source: Asset | None) -> EmbeddedAsset:
    source = source or Asset.from_typeid(ref)
    return EmbeddedAsset(name=source.path.name, path=root / source.info.main_subdir / source.path.name,
                         source=source.path)


async def resolve_embedding(ref: TypeId, root: Path, skills_root: Path, source: Asset | None = None) -> EmbeddedAsset | None:
    """Resolve the type-declared projection without consulting an entity or index."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(ref.type)
    project = info.process_projection if info else None
    return await project(ref, root, skills_root, source) if project else None


def materialized_agents_json(assets_dir: Path) -> dict:
    """Read embedded subagents in materialization order, without indexing."""
    from flow_sdk.assets.types.subagent_spec import KEY_TO_JSON
    agents: dict = {}
    folder = assets_dir / ".claude" / "agents"
    if not folder.is_dir():
        return agents
    for path in sorted(folder.glob("*.md"), key=lambda p: (p.stat().st_mtime_ns, p.name)):
        header, body = read_subagent(path)
        header.pop("name")
        name = path.stem
        header.pop("kind", None)
        entry = {KEY_TO_JSON.get(key, key): value for key, value in header.items()}
        if body:
            entry["prompt"] = body
        agents[name] = entry
    return agents


def embedded_assets(ref_paths) -> list[Asset]:
    """Resolve existing attached occurrences, rejecting stale identity receipts."""
    from flow_sdk.assets.asset import AssetIdentityMismatch
    found: dict[Path, Asset] = {}
    for ref, path in ref_paths:
        if path is None or not Path(path).exists():
            continue
        asset = Asset.from_path(path)
        if asset.typeid != ref:
            raise AssetIdentityMismatch(f"Attached asset {ref} was replaced by {asset.typeid} at {path}")
        found.setdefault(asset.path, asset)
    return list(found.values())
