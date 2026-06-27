from __future__ import annotations

import logging
from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)


class WorkflowRun(Entity):
    """Claude Code workflow *run* entity.

    A run's provider artifact is a single-JSON journal
    (``workflows/wf_<runId>.json``). We parse & serve it like a worker
    transcript/session (worker_type ``"workflow"``) — read-only; the spawned
    sub-agents live as ordinary Claude transcripts under
    ``subagents/workflows/<runId>/agent-<agentId>.jsonl``.

    Auto-registered via Entity.__init_subclass__ so Entity.from_record() uses
    this class when indexing workflow_run records.
    """

    type: str = APIField(default=RecordType.WORKFLOW_RUN)
    run_id: str | None = APIField(default=None)
    workflow_name: str | None = APIField(default=None)
    status: str | None = APIField(default=None)
    agent_count: int = APIField(default=0)
    total_tokens: int = APIField(default=0)
    total_tool_calls: int = APIField(default=0)
    duration_ms: int | None = APIField(default=None)
    default_model: str | None = APIField(default=None)
    asset_ref: str | None = APIField(default=None)
    # Lineage to the source workflow/skill (derived from the journal's scriptPath).
    source_path: str | None = APIField(default=None, description="Path of the source .js workflow")
    dynamic_workflow_id: str | None = APIField(default=None, description="Path-derived id of the source DynamicWorkflow")
    skill_id: str | None = APIField(default=None, description="Owning skill id when the workflow is bundled in a skill")

    _api_visible: ClassVar[bool] = False
