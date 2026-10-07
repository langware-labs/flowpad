"""Type metadata for DIAGNOSIS_REQUEST.

A ``FlowpadDiagnosis`` someone else runs: its owner opens it here, it lives on the hub at the
same id, and another person's ``flow diagnose <id>`` writes runs into it there. Metadata-only like
its parent, so it extends ``FlowpadDiagnosisMetadata`` with the request's own fields.
"""

from typing import Optional

from pydantic import Field

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info.flowpad_diagnosis_type_info import FlowpadDiagnosisMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class DiagnosisRequestMetadata(FlowpadDiagnosisMetadata):
    """FS↔DB metadata for a diagnosis request: the diagnosis fields (the latest run) plus the request."""

    instructions: Optional[str] = Field(default=None, description="What the runner's agent is asked to do.")
    write_expires_at: Optional[str] = Field(
        default=None,
        description="ISO end of the window in which the id accepts runs (hub-clamped: 48h default, 7d max).",
    )
    max_run_bytes: Optional[int] = Field(
        default=None, description="Largest run the hub accepts (2MB default, 10MB max)."
    )
    llm_endpoint_typeid: Optional[str] = Field(
        default=None, description="The public hub budget a runner spends, when the owner funded one."
    )
    run_count: Optional[int] = Field(default=None, description="How many runs the hub has kept.")
    last_run_at: Optional[str] = Field(default=None, description="ISO time of the latest run.")


DIAGNOSIS_REQUEST = TypeInfo(
    type_name=EntityType.DIAGNOSIS_REQUEST,
    icon="Stethoscope",
    # Listed beside the other reports, and created from the Create panel: its screen is the
    # in-app ``diagnosis_request`` editor (``ui/src/components/assets/editor/diagnosis-request``).
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    api_visible=True,
    index_fields=["title", "instructions"],
    meta_model=DiagnosisRequestMetadata,
    editor="diagnosis_request",
)
