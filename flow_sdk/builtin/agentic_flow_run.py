"""AgenticFlowRun — one execution of an AgenticFlow (the run journal entity).

``execution_id`` (== this entity's id) stamps every event, delivery, and
spawned process of one activation, from the trigger/injection until the run
sinks. Parent = the AgenticFlow; spawned AgenticProcesses are attached as
children — so "everything this run did" is a plain child query.

The trace itself lives on disk (WORKFLOW_RUN precedent):
``<flow folder>/runs/<run-id>.jsonl`` — appended per event/phase by
FlowManager; this row is upserted only at run START and END so run traffic
never storms the DB or the indexer.
"""
from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class RunStatus(StrEnum):
    RUNNING = "running"
    COMPLETE = "complete"    # sank: no pending deliveries, no active executions
    TRIPPED = "tripped"      # a loop budget refused further work
    FAILED = "failed"


class AgenticFlowRun(Entity):
    type: str = APIField(default=EntityType.AGENTIC_FLOW_RUN.value)
    name: str = APIField(default="")
    flow_id: str = APIField(default="", description="The AgenticFlow this run executed.")
    status: str = APIField(default=RunStatus.RUNNING.value)
    started_at: str = APIField(default="")
    ended_at: Optional[str] = APIField(None)
    # Cheap summary counters stamped at end (full trace = runs/<id>.jsonl).
    event_count: int = APIField(default=0)
    execution_count: int = APIField(default=0)
    error: Optional[str] = APIField(None, description="Budget trip / failure reason.")

    _api_visible: ClassVar[bool] = True
