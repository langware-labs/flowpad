"""Type metadata for BROWSER_DRIVER — one way a session drives a browser.

A REPO folder asset, ``agentic-assets/browser_driver/<name>/``: ``browser_driver.json`` (the
``BrowserDriverSpec``) and ``instructions.md``. The row is the index; a session's choice is
resolved by ``browser_choice`` against the SHIPPED folders (``flow_sdk/core/browser_drivers.py``).

Identity is derived from the manifest's ``name`` (a shipped folder's path is the install's).
"""
from flow_sdk.assets.identity import derived_identity
from flow_sdk.assets.types.named_manifest import name_identity_key
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.browser_driver_spec import BrowserDriverSpec
from flow_sdk.schema.types import EntityType

BROWSER_DRIVER = TypeInfo(
    type_name=EntityType.BROWSER_DRIVER,
    icon="Globe",
    display_name="Browsers",
    api_visible=True,
    creatable=False,
    asset_class="repo",
    family="browser_driver",
    asset_spec=BrowserDriverSpec,
    fts_content=("name", "description"),
    identity_carrier=derived_identity(),
    identity_key_fn=name_identity_key(BrowserDriverSpec.main_file),
    index_fields=["name", "title"],
)
