"""Type metadata for SPEC."""
from flow_sdk.builtin.spec import SpecDocSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    frontmatter_identity,
    resolved_path_key,
)
from flow_sdk.fs_store.indexer.functions.spec import derive_spec
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

SPEC = TypeInfo(
    type_name=EntityType.SPEC,
    fts_content=("content",),
    identity_carrier=frontmatter_identity(),
    id_stable_key_fn=resolved_path_key,
    indexed_by_default=True,
    browseable_by=ViewMode.STANDARD,
    icon="FileText",
    api_visible=True,
    index_fields=["name", "spec_type"],
    asset_class="repo",
    family="spec",
    shape=Folder(main="spec.md"),
    asset_spec=SpecDocSpec,
    derive_fields_fn=derive_spec,
    # WRITE-ONCE (owns_main_ref stays False): a DB-only spec materializes its
    # ``specs/<name>/spec.md`` body file the first time it's saved without one,
    # so the file exists to carry into a bundle and to index from. Thereafter
    # the file is USER DATA — preserved verbatim, never re-rendered on save
    # (re-rendering would mutate the user's file). Original filenames from a
    # received bundle are kept as-is via the record's existing asset_ref.
)
