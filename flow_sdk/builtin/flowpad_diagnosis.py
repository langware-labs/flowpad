"""FlowpadDiagnosis — a recorded issue diagnosis.

One entity per diagnosed problem: what the user saw, the root cause found after
debugging, and the fix that resolved it. Metadata-only (no backing source
file) — created via the records skill (``FSRecord`` + ``sync_to_db``) and
surfaced in the account-settings "System Diagnoses" table. The FS↔disk metadata
schema lives in ``flow_sdk/schema/type_info/flowpad_diagnosis_type_info.py``
(``FlowpadDiagnosisMetadata``); this class is its DB/API entity counterpart.
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class FlowpadDiagnosis(Entity):
    type: str = APIField(default=EntityType.FLOWPAD_DIAGNOSIS.value)
    name: str = APIField("")
    title: Optional[str] = APIField(None, description="Title of the diagnosis.")
    symptoms: Optional[str] = APIField(
        None,
        description="What the user complained about / expected vs actual UI, console errors, misbehavior.",
    )
    rca: Optional[str] = APIField(None, description="Root cause found after debugging.")
    fix: Optional[str] = APIField(None, description="What was done to resolve it.")
    summary: Optional[str] = APIField(None, description="One-paragraph plain-language summary of the diagnosis.")
    user_report: Optional[str] = APIField(
        None,
        description=(
            "The user's own free-text description of the issue, typed when they ran "
            "the diagnosis (empty for a full sweep). Distinct from ``symptoms``, "
            "which is what the agent observed — this is the raw text the user wrote."
        ),
    )
    reported_by: Optional[str] = APIField(
        None,
        description=(
            "Who hit the issue — ``Name <email>`` as resolved on the machine that "
            "recorded the diagnosis. Captured at record time (not at read time) so "
            "it stays the reporter's identity after the diagnosis is forwarded to a "
            "helper on another machine."
        ),
    )
    occurred_at: Optional[str] = APIField(
        None,
        description=(
            "ISO timestamp of when the diagnosis was recorded, on the reporting "
            "machine. Distinct from the storage-level ``created_date``, which the "
            "receiver re-stamps at install time — this one travels verbatim."
        ),
    )
    os: Optional[str] = APIField(
        None,
        description=(
            "``platform.platform()`` of the machine the issue happened on, captured "
            "at record time — a receiver's own OS says nothing about the issue."
        ),
    )
    app_version: Optional[str] = APIField(
        None,
        description="Flowpad version running on the machine the issue happened on.",
    )
    origin_project_id: Optional[str] = APIField(
        None,
        description=(
            "Id of the project the user was in when the diagnosis was recorded (the "
            "project the issue happened on). On the originating machine it resolves "
            "to a local project; on another machine it is a foreign id and the "
            "receiver picks a local project instead."
        ),
    )
    origin_project_name: Optional[str] = APIField(
        None,
        description="Display name of ``origin_project_id`` — travels with the diagnosis.",
    )
