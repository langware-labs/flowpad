"""Durable FlowCall admission/state; only result is a completed work answer."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import ClassVar

from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue, TaggedValue
from flow_sdk.schema.data_spec.spec import DataSpec, Tagged


class CallState(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    FAILED = "failed"


class CallRecord(DataSpec):
    spec_kind: ClassVar[str] = "compute.call_record"
    call_id: str
    invocation_id: str
    #: The call that started this one, when a caller passed its trace; None for a run's root.
    parent_call_id: str | None = None
    block: str
    project_id: str | None = None
    input_present: bool = False
    input: TaggedValue = None
    state: CallState = CallState.RUNNING
    created_at: datetime
    completed_at: datetime | None = None
    executor: str | None = None
    executor_pid: int
    executor_started: float
    result: Tagged[ReturnedValue] | None = None
    error: str | None = None
