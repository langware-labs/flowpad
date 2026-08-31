"""Type metadata for DYNAMIC_WORKFLOW — an authored dynamic-workflow script asset."""
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.dynamic_workflows import (
    dynamic_workflow_default_body,
    dynamic_workflow_id_from_file,
    dynamic_workflow_identity_key,
    extract_dynamic_workflow,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class DynamicWorkflowMeta(BaseMeta):
    description: Optional[str] = None


DYNAMIC_WORKFLOW = TypeMetadata(
    type=EntityType.DYNAMIC_WORKFLOW,
    icon="Boxes",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name", "description"],
    asset_class="harness",
    harness="claude",
    family="workflows",
    main_ext=".js",
    from_disk_fn=extract_dynamic_workflow,
    identity_carrier=derived_identity(dynamic_workflow_id_from_file),
    id_stable_key_fn=dynamic_workflow_identity_key,
    default_body_fn=dynamic_workflow_default_body,
    meta_model=DynamicWorkflowMeta,
)
