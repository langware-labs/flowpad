"""Private durable admission and answers for ComputeOp's existing executor.

Records are instance-local operation data, not shared graph entities. Reading a
record never launches work: an executor lost on restart is reported interrupted.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

import psutil

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.instances.atomic import write_json_atomic
from flow_sdk.request_context.detached import add_detached_done_callback, create_detached_task
from flow_sdk.schema.data_spec.compute_call_spec import CallRecord, CallState
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue

_tasks: set[asyncio.Task] = set()


def save(path: Path, record: CallRecord) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_json_atomic(path, record.model_dump(mode="json"))
    path.chmod(0o600)


def read(folder: Path, call_id: str) -> CallRecord | None:
    if not is_valid_entity_id(call_id):
        raise ValueError("call_id must be an entity UUID")
    path = folder / f"{call_id}.json"
    if not path.exists():
        return None
    record = CallRecord.model_validate_json(path.read_text())
    if record.state is CallState.RUNNING:
        try:
            owner = psutil.Process(record.executor_pid)
            alive = owner.create_time() == record.executor_started and owner.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            alive = False
        if not alive:
            record = record.model_copy(update={
                "state": CallState.INTERRUPTED, "completed_at": datetime.now(timezone.utc),
                "error": "Executor stopped before recording an answer; work was not replayed.",
            })
            save(path, record)
    return record


def start(folder: Path, *, block: str, project_id: str | None, input: Any,
          input_present: bool, execute: Callable[[str, Callable[[str], None]], Awaitable[ReturnedValue]],
          invocation_id: str | None = None, parent_call_id: str | None = None) -> CallRecord:
    """Admit one call; a caller's ``invocation_id`` joins its run, none starts a new one."""
    identity = str(mint_uuid())
    record = CallRecord(call_id=identity, invocation_id=invocation_id or identity,
                        parent_call_id=parent_call_id, block=block,
                        project_id=project_id, input=input, input_present=input_present,
                        created_at=datetime.now(timezone.utc), executor_pid=os.getpid(), executor_started=psutil.Process().create_time())
    path = folder / f"{identity}.json"
    save(path, record)  # Admission cannot escape before its durable identity exists.

    def attach_executor(executor: str) -> None:
        nonlocal record
        record = record.model_copy(update={"executor": executor})
        save(path, record)

    async def run() -> None:
        nonlocal record
        try:
            answer = await execute(identity, attach_executor)
            record = record.model_copy(update={"result": answer, "executor": answer.executor or record.executor,
                                               "state": CallState.COMPLETED})
        except asyncio.CancelledError:
            record = record.model_copy(update={"state": CallState.INTERRUPTED,
                                               "error": "Executor cancelled; work was not replayed."})
            raise
        except Exception as exc:
            record = record.model_copy(update={"state": CallState.FAILED, "error": str(exc)})
        finally:
            record = record.model_copy(update={"completed_at": datetime.now(timezone.utc)})
            save(path, record)

    task = create_detached_task(run(), name=f"compute-call-{identity}")
    _tasks.add(task)
    add_detached_done_callback(task, _tasks.discard)
    return record.model_copy(deep=True)
