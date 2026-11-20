"""Google Vertex dialect for video: our ``VideoRequest`` to a Veo job, its finished clip to a file.

Veo runs as a long operation on a regional endpoint: ``POST publishers/google/models/<model>
:predictLongRunning {instances, parameters}`` answers the operation's ``name``;
``POST …:fetchPredictOperation {operationName}`` reports ``done`` and then carries the clip inline
as base64. Key frames go in the request the same way, as bytes, so nothing is hosted anywhere.
The endpoint's target already names the project and location, so the path starts at
``publishers``. Vertex's words (``instances``, ``lastFrame``, ``bytesBase64Encoded``) stop at this file.
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any

from flow_sdk.endpoint_call.dialect import poll_job, read_image
from flow_sdk.endpoint_call.errors import EndpointCallError
from flow_sdk.schema.data_spec.media_spec import VIDEO_GENERATE, VideoRequest, VideoResult

KIND = VIDEO_GENERATE
#: Veo is served per region; the global host (where the image models live) does not have it.
HOSTS = ("us-central1-aiplatform.googleapis.com",)
DEFAULT_MODEL = "veo-3.1-fast-generate-001"
DEFAULT_RESOLUTION = "720p"
#: The only clip lengths Veo makes.
DURATIONS = (4, 6, 8)
POLL_SECONDS = 10.0
#: How long a job may take. A 6-second clip from two key frames measured about a minute.
JOB_TIMEOUT_SECONDS = 900.0
_FRAME_TYPES = ("image/png", "image/jpeg")


def path_for(model: str, action: str) -> str:
    return f"publishers/google/models/{model}:{action}"


def duration_for(seconds: int) -> int:
    """The shortest clip Veo makes that is at least ``seconds`` long (its longest, when none is)."""
    return next((allowed for allowed in DURATIONS if allowed >= seconds), DURATIONS[-1])


def _frame(path: str, url: str, which: str) -> dict[str, str] | None:
    if not path:
        if url:
            raise EndpointCallError("invalid_request", f"Veo takes the {which} frame as a local file, not a URL")
        return None
    _file, mime, data = read_image(path, "frame")
    if mime not in _FRAME_TYPES:
        raise EndpointCallError("invalid_request", f"the {which} frame must be a PNG or a JPEG, got {mime}")
    return {"bytesBase64Encoded": data, "mimeType": mime}


def to_wire(request: VideoRequest) -> dict[str, Any]:
    instance: dict[str, Any] = {"prompt": request.prompt}
    if first := _frame(request.first_frame, request.first_frame_url, "first"):
        instance["image"] = first
    if last := _frame(request.last_frame, request.last_frame_url, "last"):
        instance["lastFrame"] = last
    parameters: dict[str, Any] = {
        "durationSeconds": duration_for(request.duration_s),
        "sampleCount": 1,
        "aspectRatio": request.aspect_ratio or "16:9",
        "resolution": (request.resolution or DEFAULT_RESOLUTION).lower(),
        "generateAudio": request.audio,
    }
    return {"instances": [instance], "parameters": parameters}


def clip_of(operation: dict[str, Any]) -> bytes:
    """The clip of a finished operation, or why there is none."""
    error = operation.get("error")
    if isinstance(error, dict):
        raise EndpointCallError("failed", f"Veo job failed: {error.get('message') or error}")
    response = operation.get("response") if isinstance(operation.get("response"), dict) else {}
    for video in response.get("videos") or []:
        if isinstance(video, dict) and video.get("bytesBase64Encoded"):
            return base64.b64decode(video["bytesBase64Encoded"])
    if response.get("raiMediaFilteredCount"):
        reasons = "; ".join(str(reason) for reason in response.get("raiMediaFilteredReasons") or [])
        raise EndpointCallError("failed", f"Veo withheld the clip (content filter){': ' + reasons if reasons else ''}")
    raise EndpointCallError("bad_response", "Veo finished without a clip")


async def run(request: VideoRequest, transport, out_dir: Path) -> VideoResult:
    model = request.model or DEFAULT_MODEL
    wire = await asyncio.to_thread(to_wire, request)
    started = await transport.send("POST", path_for(model, "predictLongRunning"), json=wire)
    job_id = str(started.get("name") or "") if isinstance(started, dict) else ""
    if not job_id:
        raise EndpointCallError("bad_response", f"Veo started a job without a name: {str(started)[:200]}")

    async def clip_when_done() -> bytes | None:
        operation = await transport.send(
            "POST", path_for(model, "fetchPredictOperation"), json={"operationName": job_id}
        )
        if not isinstance(operation, dict):
            raise EndpointCallError("bad_response", f"Veo answered the job status with no object: {operation!s:.200}")
        # The clip arrives as base64 inside the answer: decode it off the event loop.
        return await asyncio.to_thread(clip_of, operation) if operation.get("done") else None

    clip = await poll_job(job_id, clip_when_done, every=POLL_SECONDS, timeout=JOB_TIMEOUT_SECONDS, vendor="Veo")
    file = out_dir / f"video-{job_id.rsplit('/', 1)[-1][:12]}.mp4"
    await asyncio.to_thread(file.write_bytes, clip)
    return VideoResult(file=str(file.resolve()), model=model, job_id=job_id)
