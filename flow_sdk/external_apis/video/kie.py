"""Kie.ai dialect for video: our ``VideoRequest`` to a Kie job, its finished clip to a file.

Kie sells many models behind one job API: ``POST api/v1/jobs/createTask {model, input}`` answers
a ``taskId``; ``GET api/v1/jobs/recordInfo?taskId=`` reports ``state`` and, on ``success``, the
clip's URL inside ``resultJson``. Each model spells its inputs its own way (``720P`` or ``720p``,
``audio`` or ``generate_audio``), and those spellings stop at this file.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from flow_sdk.endpoint_call.dialect import poll_job, read_image
from flow_sdk.endpoint_call.errors import EndpointCallError
from flow_sdk.schema.data_spec.media_spec import FILE_UPLOAD, VIDEO_GENERATE, VideoRequest, VideoResult

KIND = VIDEO_GENERATE
HOSTS = ("api.kie.ai",)
CREATE_PATH = "api/v1/jobs/createTask"
RECORD_PATH = "api/v1/jobs/recordInfo"
#: Kie's file store lives on its own host, so it is its own root on the endpoint (kind
#: ``file.upload``). It keeps a file for 24 hours, which outlives any job.
UPLOAD_PATH = "api/file-base64-upload"
DEFAULT_MODEL = "wan/3-0-video"
POLL_SECONDS = 10.0
#: How long a job may take. The slowest model measured took a little over 6 minutes for 8 seconds.
JOB_TIMEOUT_SECONDS = 1500.0

#: model -> (default resolution as the model spells it, the input key that turns audio on, if any).
MODELS: dict[str, tuple[str, str]] = {
    "wan/3-0-video": ("720P", "audio"),
    "minimax-h3/text-to-video": ("768P", ""),
    "minimax-h3/image-to-video": ("768P", ""),
    "kling-4.0/reference-to-video": ("720p", ""),
    "kling-4.0/keyframe-to-video": ("720p", ""),
    "bytedance/seedance-2-5": ("720p", "generate_audio"),
}

#: Kie's own refusal codes (sent with HTTP 200) -> our reason.
_REFUSALS = {402: "billing", 401: "auth", 429: "rate_limited"}


def to_wire(request: VideoRequest) -> dict[str, Any]:
    model = request.model or DEFAULT_MODEL
    default_resolution, audio_key = MODELS.get(model, ("", ""))
    spelled_upper = default_resolution.isupper()
    resolution = request.resolution or default_resolution
    inputs: dict[str, Any] = {"prompt": request.prompt, "duration": request.duration_s}
    if resolution:
        inputs["resolution"] = resolution.upper() if spelled_upper else resolution.lower()
    if request.aspect_ratio:
        inputs["aspect_ratio"] = request.aspect_ratio
    if audio_key and request.audio:
        inputs[audio_key] = True
    if request.first_frame_url:
        inputs["first_frame_url"] = request.first_frame_url
    if request.last_frame_url:
        inputs["last_frame_url"] = request.last_frame_url
    return {"model": model, "input": inputs}


def _data(body: Any, doing: str) -> dict[str, Any]:
    """Kie wraps every answer in ``{code, msg, data}`` and reports a refusal with HTTP 200."""
    if not isinstance(body, dict):
        raise EndpointCallError("bad_response", f"Kie answered {doing} with no object: {str(body)[:200]}")
    if body.get("code") != 200 or not isinstance(body.get("data"), dict):
        code = body.get("code")
        reason = _REFUSALS.get(code, "invalid_request")
        raise EndpointCallError(reason, f"Kie refused {doing}: {body.get('msg') or body}", status=code)
    return body["data"]


def clip_url(record: dict[str, Any]) -> str:
    try:
        urls = json.loads(record.get("resultJson") or "{}").get("resultUrls") or []
    except ValueError:
        urls = []
    if not urls:
        raise EndpointCallError("bad_response", "Kie reported success without a result URL")
    return str(urls[0])


async def hosted(frame: str, transport) -> str:
    """The public URL of local image ``frame``, uploaded to Kie's file store through the same
    endpoint. The folder name is random: the URL is the only thing that opens the file."""
    file, mime, data = await asyncio.to_thread(read_image, frame, "frame")
    body = await transport.send(
        "POST",
        UPLOAD_PATH,
        kind=FILE_UPLOAD,
        json={
            "base64Data": f"data:{mime};base64,{data}",
            "uploadPath": f"frames/{uuid.uuid4().hex}",
            "fileName": file.name,
        },
    )
    url = str(_data(body, "the frame upload").get("downloadUrl") or "")
    if not url:
        raise EndpointCallError("bad_response", "Kie stored a frame without a download URL")
    return url


async def run(request: VideoRequest, transport, out_dir: Path) -> VideoResult:
    async def url_of(url: str, frame: str) -> str:
        return url or (await hosted(frame, transport) if frame else "")

    first, last = await asyncio.gather(
        url_of(request.first_frame_url, request.first_frame), url_of(request.last_frame_url, request.last_frame)
    )
    wire = to_wire(request.model_copy(update={"first_frame_url": first, "last_frame_url": last}))
    job_id = str(_data(await transport.send("POST", CREATE_PATH, json=wire), "the job").get("taskId") or "")
    if not job_id:
        raise EndpointCallError("bad_response", "Kie created a job without a taskId")

    async def record_when_done() -> dict[str, Any] | None:
        record = _data(await transport.send("GET", RECORD_PATH, params={"taskId": job_id}), "the job status")
        if record.get("state") == "fail":
            raise EndpointCallError("failed", f"Kie job failed: {record.get('failMsg') or 'no reason given'}")
        return record if record.get("state") == "success" else None

    record = await poll_job(job_id, record_when_done, every=POLL_SECONDS, timeout=JOB_TIMEOUT_SECONDS, vendor="Kie")
    file = await transport.download(clip_url(record), out_dir / f"video-{job_id[:12]}.mp4")
    return VideoResult(file=str(file.resolve()), model=wire["model"], job_id=job_id)
