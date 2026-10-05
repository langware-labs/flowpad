"""Type metadata for DATA_SPEC — a DataSpec kind defined by a folder.

An entity document at ``<scope>/agentic-assets/data_spec/<full.kind>/data_spec.json`` with
``description.md`` beside it. Indexing registers the kind it defines (``derive_data_spec``), so
"defined" and "indexed" are one event; the row's ``error`` says why a definition did not register.
"""

from flow_sdk.assets.types.data_spec import derive_data_spec
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.data_spec_spec import DataSpecDocSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

DATA_SPEC = TypeInfo(
    type_name=EntityType.DATA_SPEC,
    icon="Braces",
    display_name="Data specs",
    api_visible=True,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    index_fields=["name", "subkind", "error"],
    fts_content=("description",),
    asset_class="repo",
    family="data_spec",
    asset_spec=DataSpecDocSpec,
    # The folder name IS the kind: a rename can never desync the two.
    name_from_path=True,
    derive_fields_fn=derive_data_spec,
    # No identity_carrier: an entity document carries its id in its own root.
)
