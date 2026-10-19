"""Type metadata for DATA_SCHEMA — a schema defined by a folder instead of code.

An entity document at ``<scope>/agentic-assets/data_schema/<full.kind>/data_schema.json`` with
``description.md`` beside it. Indexing registers the schema under its kind
(``derive_data_schema``), so "defined" and "indexed" are one event; the row's ``error`` says why a
definition did not register.
"""

from flow_sdk.assets.types.data_schema import derive_data_schema
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.data_schema_spec import DataSchemaDocSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

DATA_SCHEMA = TypeInfo(
    type_name=EntityType.DATA_SCHEMA,
    icon="Braces",
    display_name="Data schemas",
    api_visible=True,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    index_fields=["name", "subkind", "error"],
    fts_content=("description",),
    asset_class="repo",
    family="data_schema",
    retired_families=("data_spec",),  # renamed 2026-10-07, no migration: a scan names the folder
    asset_spec=DataSchemaDocSpec,
    # The folder name IS the kind: a rename can never desync the two.
    name_from_path=True,
    derive_fields_fn=derive_data_schema,
    # No identity_carrier: an entity document carries its id in its own root.
)
