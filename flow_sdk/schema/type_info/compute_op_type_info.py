"""Type metadata for COMPUTE_OP — a folder-backed GOAL.

An entity document at ``<scope>/agentic-assets/compute_op/<name>/compute_op.json``,
with ``setup.md`` beside it holding the same instructions a person would follow
by hand — which is also what the agent rung is handed when the cheap rung fails.

The distinction from WIZARD, which is also a folder of ordered things:

    A Wizard SEQUENCES steps.
    A ComputeOp is one step's worth of "make this true, and prove it" — and,
    unlike a step, it is addressable and reusable on its own.

``requires`` composes ops, so a shared prerequisite (docker is running) is one
document many ops name rather than a clause each of them restates.
"""
from flow_sdk.assets.layout import Folder
from flow_sdk.fs_store.schema_registry import ENTITY_LAYOUT, TypeInfo
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

COMPUTE_OP = TypeInfo(
    type_name=EntityType.COMPUTE_OP,
    # A goal WITH ITS PROOF — the block is a check as much as it is work.
    # Not Wand2: that is the Wizard's, and the two must not read alike in a list.
    icon="BadgeCheck",
    display_name="Compute ops",
    api_visible=True,
    creatable=True,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    index_fields=["name", "description"],
    asset_class="repo",
    family="compute_op",
    shape=Folder.entity_json(EntityType.COMPUTE_OP.value),
    manifest_layout=ENTITY_LAYOUT,
    asset_spec=ComputeOpSpec,
    # The entity is the authoring surface: an edit re-renders the document.
    owns_main_ref=True,
    # No identity_carrier: an entity document carries its id in its own root,
    # the way data_source.json does. A shipped op therefore ships with one.
)
