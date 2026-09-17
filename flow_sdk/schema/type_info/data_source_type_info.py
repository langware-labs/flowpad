"""Type metadata for DATA_SOURCE and the rows keyed to it.

**DataSource is an asset** — an entity document at
``<scope>/agentic-assets/data_source/<name>/data_source.json``: which data driver, with which config,
owned by whom. The file holds only what a person authors (``DataSourceSpec``); what the engine
learns while it runs (status, health, the next poll, identities) is row-only, so a poll never
rewrites the file. The file is the truth: a row with no file is removed, with everything it
ingested (``orphan_cascade_fn``).
"""
from flow_sdk.assets.layout import Folder
from flow_sdk.fs_store.schema_registry import ENTITY_LAYOUT, TypeInfo
from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec
from flow_sdk.schema.types import EntityType


async def _cascade_data_source(entity_id: str) -> None:
    """What a data source ingested goes with it: records, positions, changes, projections."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415 — the type info loads before the class

    await DataSource.delete_children_of(entity_id)


DATA_SOURCE = TypeInfo(
    type_name=EntityType.DATA_SOURCE,
    icon="Antenna",
    display_name="Data sources",
    api_visible=True,
    creatable=True,
    # Deliberately NOT browseable: the dedicated `/dock/data-sources` screen is
    # the one surface — operating a source needs verbs (poll, replay, enable,
    # delete) a generic type browser has nowhere to put. `creatable` stays: it
    # is the "offer a New button" hint, not an authorization flag (see
    # `_uncreatable_reason`).
    index_fields=["name", "provider", "kind", "status", "health"],
    asset_class="repo",
    family="data_source",
    shape=Folder.entity_json(EntityType.DATA_SOURCE.value),
    manifest_layout=ENTITY_LAYOUT,
    asset_spec=DataSourceSpec,
    # The entity is the authoring surface: an edit re-renders the document. Identical bytes are not
    # rewritten, and runtime fields are not spec fields, so a poll never touches the file.
    owns_main_ref=True,
    orphan_cascade_fn=_cascade_data_source,
)

# The consumer-side cursor. Tier C (``db_only``): written on every drain, so a disk mirror would be a
# filesystem write per poll forever, for state no human reads and no search should return.
CONSUMER_POSITION = TypeInfo(
    type_name=EntityType.CONSUMER_POSITION,
    icon="Bookmark",
    api_visible=True,
    db_only=True,
)

# The change log an object-shaped source leaves behind each reflected page.
SOURCE_CHANGE = TypeInfo(
    type_name=EntityType.SOURCE_CHANGE,
    icon="FileDiff",
    api_visible=True,
    db_only=True,
)
