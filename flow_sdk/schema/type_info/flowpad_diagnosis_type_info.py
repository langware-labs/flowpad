"""Type metadata for FLOWPAD_DIAGNOSIS.

One record per user-raised issue: what the user complained about, the root
cause found after debugging, and the fix that resolved it. App-created (not
walked from arbitrary user files), so no ``from_disk_fn`` — it is persisted
via ``FSRecord.save``/``sync_to_db`` into ``metadata.json`` + the DB.
"""
from typing import Optional

from pydantic import Field

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class FlowpadDiagnosisMetadata(BaseMeta):
    """FS↔DB metadata schema for a Flowpad diagnosis record.

    Inherits name/scope/project_id/created_date/... from BaseMeta and adds the
    diagnosis-specific persisted fields. ``name`` (BaseMeta) mirrors ``title``
    so generic listing surfaces have a label.
    """

    title: Optional[str] = Field(
        default=None,
        description="Title of the diagnosis — a short label for the issue.",
    )
    symptoms: Optional[str] = Field(
        default=None,
        description=(
            "What the user complained about or expected to see: the UI behavior, "
            "console/log errors, or misfunctionality that was observed."
        ),
    )
    rca: Optional[str] = Field(
        default=None,
        description="Root cause of the issue, established after debugging.",
    )
    fix: Optional[str] = Field(
        default=None,
        description="What was done to resolve the issue.",
    )
    summary: Optional[str] = Field(
        default=None,
        description="One-paragraph plain-language summary of the diagnosis, shown to the user.",
    )


FLOWPAD_DIAGNOSIS = TypeMetadata(
    type=EntityType.FLOWPAD_DIAGNOSIS,
    icon="Stethoscope",
    browseable=True,
    creatable=True,
    api_visible=True,
    index_fields=["title", "symptoms"],
    meta_model=FlowpadDiagnosisMetadata,
)
