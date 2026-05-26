"""Agentic process package."""

from flow_sdk.fs_records.agent_status import WorkerStatus
from flow_sdk.fs_records.agentic_process_lifecycle import ProcessStatus

from flow_sdk.builtin.agentic_process._shared import (
    AgenticContext,
    ContextData,
    CreateProcessRequest,
    ExecuteRequest,
    ProcessError,
    ProcessResultRequest,
    RunFileRequest,
    RunRequest,
    RunResult,
    StreamEvent,
)
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

# Register the TranscriptStreamer subscriber at package import. Must happen
# before _on_server_startup runs `_start_transcript_streamer()` so the catch-up
# walk has the subscriber installed for its first dispatch.
from flow_sdk.builtin.agentic_process import transcript_subscriber as _transcript_subscriber  # noqa: F401

# Register heartbeat housekeeping tasks (pending_user_to_inactive, …) at
# package import — the heartbeat trigger fires AFTER set_service_triggers
# runs at server boot, but the decorator must already be in the registry.
from flow_sdk.builtin.agentic_process import heartbeat_tasks as _heartbeat_tasks  # noqa: F401

__all__ = [
    "WorkerStatus",
    "ProcessStatus",
    "AgenticContext",
    "AgenticProcess",
    "ContextData",
    "RunFileRequest",
    "RunRequest",
    "ExecuteRequest",
    "CreateProcessRequest",
    "ProcessResultRequest",
    "RunResult",
    "StreamEvent",
    "ProcessError",
]
