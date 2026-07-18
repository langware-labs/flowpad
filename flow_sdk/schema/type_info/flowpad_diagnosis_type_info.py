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
from flow_sdk.schema.view_mode import ViewMode


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
    user_report: Optional[str] = Field(
        default=None,
        description=(
            "The user's own free-text description of the issue, typed when running "
            "the diagnosis. Raw user words — distinct from the agent-observed "
            "``symptoms``. Empty when the user asked for a full sweep."
        ),
    )
    origin_project_id: Optional[str] = Field(
        default=None,
        description=(
            "Id of the project the user was in when the diagnosis was recorded — "
            "the project the issue happened on. Kept separate from the inherited "
            "``project_id`` (which is storage-derived at index time). On the "
            "originating machine this resolves to a local project; on another "
            "machine (a shared diagnosis) it is a foreign id and the receiver "
            "picks a local project instead."
        ),
    )
    origin_project_name: Optional[str] = Field(
        default=None,
        description=(
            "Display name of ``origin_project_id`` — travels with the diagnosis so "
            "a helper on another machine can see which project it happened on."
        ),
    )


FLOWPAD_DIAGNOSIS = TypeMetadata(
    type=EntityType.FLOWPAD_DIAGNOSIS,
    icon="Stethoscope",
    browseable_by=ViewMode.DEV,
    creatable=True,
    api_visible=True,
    index_fields=["title", "symptoms"],
    meta_model=FlowpadDiagnosisMetadata,
    # Metadata-only diagnosis: row-only passive payload — staged like every
    # bundle entry, then auto-installed (no review gate). The header IS the record.
    receive_policy="auto",
)
