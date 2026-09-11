"""Application context and cloud decoration for filesystem asset catalogs."""
import logging

from flow_sdk.assets.catalog import AssetDescriptor, AssetSource, add_source_dir
from flow_sdk.fs_store.type_id import TypeId

logger = logging.getLogger(__name__)

async def hydrate_asset_descriptor_remote(descriptors: list[AssetDescriptor]) -> list[AssetDescriptor]:
    """Return cloud-decorated values without changing filesystem identity."""
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    groups: dict[str, set[str]] = {}
    for descriptor in descriptors:
        if descriptor.remote is not None:
            continue
        try:
            ref = TypeId(descriptor.typeid)
        except (TypeError, ValueError):
            continue
        groups.setdefault(ref.type, set()).add(ref.id)
    remote: dict[str, bool] = {}
    for kind, ids in groups.items():
        cls = SchemaRegistry.get_entity_cls(kind)
        if cls is None:
            continue
        try:
            rows = await cls.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["id", sorted(ids)])))
            remote.update({str(TypeId(type=kind, id=str(row.id))): bool(getattr(row, "remote", False)) for row in rows})
        except Exception:
            logger.debug("asset cloud decoration unavailable for %s", kind, exc_info=True)
    return [descriptor if descriptor.remote is not None else descriptor.model_copy(update={"remote": remote.get(descriptor.typeid, False)})
            for descriptor in descriptors]


def collect_base_source_dirs(project) -> tuple[list[tuple[str, AssetSource]], set[str]]:
    """The user/project/context portion of the scan-dir policy, shared by
    ``AgenticProcess._collect_source_dirs`` and ``Project.get_assets_action``
    so the staging view cannot drift from what a new process would see.
    ``project`` may be None (user-home only)."""
    from flow_sdk.instance_settings import get_instance_settings

    pairs: list[tuple[str, AssetSource]] = []
    seen: set[str] = set()
    add_source_dir(pairs, seen, get_instance_settings().user_home, AssetSource.USER_DIR)
    if project is not None:
        add_source_dir(
            pairs,
            seen,
            getattr(project, "fs_storage_mount_path", None),
            AssetSource.PROJECT_DIR,
        )
        # CONTEXT_DIR — the project's context folders (include_dirs). Deduped on
        # canonical path, so a folder that is also the project/user root won't
        # double-count.
        for context_dir in getattr(project, "include_dirs", None) or []:
            add_source_dir(pairs, seen, context_dir, AssetSource.CONTEXT_DIR)
    return pairs, seen
