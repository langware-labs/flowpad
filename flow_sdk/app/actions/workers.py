"""Workers action — authoritative snapshot of agentic workers on this machine.

``GET /api/.../workers`` → ``WorkerSnapshot { workers, external, scanner_enabled }``.

Source split (see the footer worker-list chip plan):
  * ``workers`` mirrors the managed ``AgenticProcess`` entities, classified into
    an ``ExecutionMode`` from cheap STORED fields only (``visible`` / ``status``)
    — it deliberately does NOT read ``worker_status`` (that derivation
    transcript-parses per process and would starve the event loop on a list
    query). The live interactive/background/error counts the chip shows are
    derived client-side from the WS-op stream; this snapshot is additive.
  * ``external`` is the OS-cmdline scan of workers running outside the app. The
    scanner is DEFERRED — gated behind ``InstanceSettings.external_worker_scan_enabled``
    (default off), so v1 always returns ``[]``.
"""

import logging

from pydantic import BaseModel

from flow_sdk.builtin.worker_status import ExecutionMode, classify_execution_mode
from flow_sdk.core import action
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


class WorkerInfo(BaseModel):
    process_id: str
    project_id: str | None = None
    visible: bool = False
    status: str | None = None
    worker_status: str | None = None
    mode: str
    pid_alive: bool | None = None


class ExternalWorker(BaseModel):
    pid: int
    cmdline: str
    mode: str = ExecutionMode.EXTERNAL.value
    detected_at: float | None = None


class WorkerSnapshot(BaseModel):
    workers: list[WorkerInfo]
    external: list[ExternalWorker]
    scanner_enabled: bool


async def _managed_workers() -> list[WorkerInfo]:
    """Snapshot the managed AgenticProcesses using cheap stored fields only.

    Classifies via the transport ``pty_mode`` + ``status`` (``worker_status``
    intentionally omitted — see module docstring). Non-live processes are dropped.
    ``visible`` is still surfaced on ``WorkerInfo`` as display metadata.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess

    out: list[WorkerInfo] = []
    for proc in await AgenticProcess.get_all():
        status = getattr(proc, "status", None)
        status_str = str(status) if status is not None else None
        visible = bool(getattr(proc, "visible", False))
        pty_mode = bool(getattr(proc, "pty_mode", True))
        mode = classify_execution_mode(
            status=status_str,
            worker_status=None,  # cheap snapshot — never parse the transcript here
            pty_mode=pty_mode,
        )
        if mode is None:
            continue  # not live → not listed
        out.append(
            WorkerInfo(
                process_id=str(getattr(proc, "id", "")),
                project_id=getattr(proc, "project_id", None),
                visible=visible,
                status=status_str,
                mode=mode.value,
            )
        )
    return out


@action.all(action_name="workers", methods=["get"], types="all")
async def workers() -> ApiSuccessResponse | ApiFailResponse:
    """Return the authoritative worker snapshot for this instance."""
    request_info = get_current_request_info()
    if request_info is None:
        return ApiFailResponse(message="Request info not available")

    scanner_enabled = get_instance_settings().external_worker_scan_enabled

    try:
        managed = await _managed_workers()
    except Exception as e:  # noqa: BLE001
        logger.warning("workers action: managed snapshot failed: %s", e)
        managed = []

    # External scanner is deferred — empty while the opt-in flag is off (always,
    # in v1). The real psutil cmdline scan lands here later.
    external: list[ExternalWorker] = []

    snapshot = WorkerSnapshot(
        workers=managed,
        external=external,
        scanner_enabled=scanner_enabled,
    )
    return ApiSuccessResponse(data=snapshot.model_dump())
