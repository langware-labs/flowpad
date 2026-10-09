"""Type metadata for ASSET_SETUP — a declared node of the setup tree (``agentic-assets/asset_setup/<name>/``).

An entity document like ``compute_op``: the row mirrors ``asset_setup.json`` and an edit re-renders it.
"""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.asset_setup_spec import AssetSetupSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

ASSET_SETUP = TypeInfo(
    type_name=EntityType.ASSET_SETUP,
    # A ladder of things to bring up — not Wand2 (Wizard's) nor BadgeCheck (ComputeOp's).
    icon="ListChecks",
    display_name="Setups",
    api_visible=True,
    creatable=True,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    index_fields=["name", "label"],
    asset_class="repo",
    family="asset_setup",
    asset_spec=AssetSetupSpec,
    owns_main_ref=True,
)
