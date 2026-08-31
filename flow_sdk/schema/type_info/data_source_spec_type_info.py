"""Type metadata for DATA_SOURCE_SPEC — the authored half of a data source.

A REPO folder asset, so the existing `repo_assets_fn` walker finds it with no
new discovery code: it scans `<container>/agentic-assets/<family>/` recursively
in any walked container, which includes the shipped assistant project.

``family="data_source"`` rather than the type name, because ``data_source`` is
already the CONFIGURED instance's type. The folder a human reads should be named
for the thing, not for the distinction — so the asset lives at
`agentic-assets/data_source/<name>/data_source.json`.

The metadata model is derived from the type's ``asset_spec`` (``ManifestSpec``)
∪ the ``Persist.TRUE`` ``runtime`` the extractor derives from the folder.
"""
from flow_sdk.builtin.data_source_spec import ManifestSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.data_source_spec import derive_data_source_spec
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

DATA_SOURCE_SPEC = TypeMetadata(
    type=EntityType.DATA_SOURCE_SPEC,
    icon="Antenna",
    displayName="Source definitions",
    api_visible=True,
    # Authored in a folder, not from a New button: the wizard writes the file.
    creatable=False,
    asset_class="repo",
    family="data_source",
    main_layout="folder",
    asset_spec=ManifestSpec,
    main_file="data_source.json",
    fts_content=("name", "description"),
    derive_fields_fn=derive_data_source_spec,
    # DERIVED, not a capsule: `data_source.json` deliberately carries no id, so
    # the id falls out of the path — stable for a shipped asset and identical on
    # every machine. Stamping one into the manifest would also make a shared
    # source arrive carrying the sender's id.
    identity_carrier=derived_identity(),
    index_fields=["name", "title", "runtime"],
)

# A definition's EDITOR is not declared here. It is a webapp asset nested in the
# definition's own folder (`<name>/agentic-assets/webapp/editor/`), discovered by
# the same walker that finds the definition — so the editor is an ordinary child
# asset with its own address and its own breadcrumb, and shipping one is a matter
# of adding a folder rather than of registering a capability.
