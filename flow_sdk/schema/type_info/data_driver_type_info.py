"""Type metadata for DATA_DRIVER — a data source driver: its manifest and its code.

A REPO folder asset, so the existing `repo_assets_fn` walker finds it with no
new discovery code: it scans `<container>/agentic-assets/<type>/` recursively
in any walked container, which includes the shipped assistant project. The folder
is `agentic-assets/data_driver/<name>/`: `data_driver.json` (the `DataDriverSpec`)
and `source.py`. Each configured instance of a driver is a `DataSource`, a separate
asset (`data_source_type_info.py`).

The metadata model is derived from the type's ``asset_spec`` (``DataDriverSpec``)
∪ the ``Persist.TRUE`` ``runtime`` the extractor derives from the folder.
"""
from flow_sdk.assets.identity import derived_identity
from flow_sdk.assets.layout import Folder
from flow_sdk.assets.types.data_driver import data_driver_identity_key, derive_data_driver
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.data_driver_spec import (
    RETIRED_RUNTIME_FILES,
    RETIRED_RUNTIME_UPGRADE,
    DataDriverSpec,
)
from flow_sdk.schema.types import EntityType

DATA_DRIVER = TypeInfo(
    type_name=EntityType.DATA_DRIVER,
    icon="Antenna",
    display_name="Source definitions",
    api_visible=True,
    # Authored in a folder, not from a New button: the wizard writes the file.
    creatable=False,
    asset_class="repo",
    family="data_driver",
    shape=Folder(main="data_driver.json"),
    retired_files=tuple((name, RETIRED_RUNTIME_UPGRADE) for name in RETIRED_RUNTIME_FILES),
    asset_spec=DataDriverSpec,
    fts_content=("name", "description"),
    derive_fields_fn=derive_data_driver,
    # DERIVED, not a capsule: `data_driver.json` deliberately carries no id —
    # stamping one in would make a shared source arrive carrying the sender's id.
    # A derived carrier has nowhere to write an id back, so identity must be a
    # pure function of the source, and `identity_key_fn` is what supplies it. It
    # is NOT optional: without a key `TypeInfo.mint` falls through to
    # `uuid5(resolved path)`, and a spec's path is the INSTALL's
    # (`…/site-packages/flow_sdk/system_projects/…`), not the asset's — several
    # coexist on one machine and every upgrade moves it, so one shipped source
    # forked into a row per install location.
    identity_carrier=derived_identity(),
    identity_key_fn=data_driver_identity_key,
    index_fields=["name", "title", "runtime"],
)

# A definition's EDITOR is not declared here. It is a webapp asset nested in the
# definition's own folder (`<name>/agentic-assets/webapp/editor/`), discovered by
# the same walker that finds the definition — so the editor is an ordinary child
# asset with its own address and its own breadcrumb, and shipping one is a matter
# of adding a folder rather than of registering a capability.
