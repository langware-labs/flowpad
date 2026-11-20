"""What the vendor dialects share: reading a local image for a request, and waiting for a vendor job."""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from flow_sdk.endpoint_call.errors import EndpointCallError

#: The first checks of a job come sooner than its vendor's interval.
EARLY_POLLS = 4
EARLY_POLL_SECONDS = 3.0


def read_image(path: str, what: str = "image") -> tuple[Path, str, str]:
    """``(file, mime, base64)`` of local image ``path``; ``invalid_request`` when it is not there."""
    file = Path(path).expanduser()
    if not file.is_file():
        raise EndpointCallError("invalid_request", f"{what} not found: {path}")
    mime = mimetypes.guess_type(file.name)[0] or "image/png"
    return file, mime, base64.b64encode(file.read_bytes()).decode()


async def poll_job(
    job_id: str, check: Callable[[], Awaitable[Any]], *, every: float, timeout: float, vendor: str
) -> Any:
    """Ask ``check`` until it answers something other than ``None``, and return that: soon at first
    (a short job should not wait a full interval), then every ``every`` seconds. ``timed_out`` after
    ``timeout`` seconds; every failure carries ``job_id``, so a job cut short can be looked up rather
    than started again."""
    deadline = time.monotonic() + timeout
    asked = 0
    while True:
        await asyncio.sleep(min(every, EARLY_POLL_SECONDS) if asked < EARLY_POLLS else every)
        asked += 1
        try:
            finished = await check()
        except EndpointCallError as exc:
            exc.job_id = job_id
            raise
        if finished is not None:
            return finished
        if time.monotonic() > deadline:
            raise EndpointCallError("timed_out", f"{vendor} job {job_id} did not finish in time", job_id=job_id)


__all__ = ["poll_job", "read_image"]
