"""``report_type_info`` — the one shape shared by the generated-report
families (agent trace, usage report, asset-cleanup report): a flat JSON file
in its own folder, minted from the resolved path, written by a single
producer. Each family supplies only what differs."""

from typing import Callable, Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import NATIVE_JSON_IDENTITY, resolved_path_key
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


def report_type_info(
    *,
    type: EntityType,
    icon: str,
    asset_spec: type,
    index_fields: list[str],
    fts_content: tuple[str, ...] = ("name",),
    main_file: str = "report.json",
    derive_fields_fn: Optional[Callable[..., dict]] = None,
) -> TypeInfo:
    return TypeInfo(
        type_name=type,
        fts_content=fts_content,
        identity_carrier=NATIVE_JSON_IDENTITY,
        id_stable_key_fn=resolved_path_key,
        indexed_by_default=True,
        browseable_by=ViewMode.ADVANCED,
        creatable=False,
        icon=icon,
        api_visible=True,
        index_fields=index_fields,
        asset_class="repo",
        family=str(type),
        shape=Folder(main=main_file),
        # Every report family has a viewer keyed by its own type name.
        editor=str(type),
        asset_spec=asset_spec,
        manifest_layout="flat",
        name_from_path=True,
        derive_fields_fn=derive_fields_fn,
        # The producer is the file's sole author: a save WITH a payload re-renders;
        # a payload-less (metadata-only) save renders nothing and leaves the file.
        owns_main_ref=True,
    )
