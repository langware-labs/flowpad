"""Google Vertex dialect for images: our ``ImageRequest`` to ``generateContent``, its inline images to files.

The endpoint's target already names the project and location, so the path starts at
``publishers``. Vertex's words (``contents``, ``parts``, ``inlineData``, ``responseModalities``)
stop at this file. Imagen's ``:predict`` was retired on 2026-06-30; every current image model
is a Gemini model on ``generateContent``.
"""

from __future__ import annotations

import asyncio
import base64
import time
from pathlib import Path
from typing import Any

from flow_sdk.endpoint_call.dialect import read_image
from flow_sdk.endpoint_call.errors import EndpointCallError
from flow_sdk.schema.data_spec.io.names import ext_for_media
from flow_sdk.schema.data_spec.media_spec import IMAGE_GENERATE, ImageRequest, ImageResult

KIND = IMAGE_GENERATE
HOSTS = ("aiplatform.googleapis.com",)
DEFAULT_MODEL = "gemini-nano-banana-2.1"


def path_for(model: str) -> str:
    return f"publishers/google/models/{model}:generateContent"


def to_wire(request: ImageRequest) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    for reference in request.reference_images:
        _file, mime, data = read_image(reference, "reference image")
        parts.append({"inlineData": {"mimeType": mime, "data": data}})
    parts.append({"text": request.prompt})
    config: dict[str, Any] = {"responseModalities": ["TEXT", "IMAGE"]}
    if request.aspect_ratio:
        config["imageConfig"] = {"aspectRatio": request.aspect_ratio}
    return {"contents": [{"role": "user", "parts": parts}], "generationConfig": config}


def images_of(body: Any) -> list[tuple[str, bytes]]:
    """``(mime, bytes)`` of every image in the answer, without repeats (a thinking model may send
    the same image twice: once as a draft, once as the answer)."""
    if not isinstance(body, dict) or not isinstance(body.get("candidates"), list):
        raise EndpointCallError("bad_response", f"Vertex answered without `candidates`: {str(body)[:200]}")
    found: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    for candidate in body["candidates"]:
        for part in ((candidate or {}).get("content") or {}).get("parts") or []:
            inline = part.get("inlineData") if isinstance(part, dict) else None
            if not isinstance(inline, dict) or not inline.get("data") or part.get("thought"):
                continue
            if inline["data"] in seen:
                continue
            seen.add(inline["data"])
            found.append((str(inline.get("mimeType") or "image/png"), base64.b64decode(inline["data"])))
    if not found:
        raise EndpointCallError("bad_response", "Vertex answered without an image")
    return found


async def run(request: ImageRequest, transport, out_dir: Path) -> ImageResult:
    model = request.model or DEFAULT_MODEL
    # Asking twice only draws twice: a lost connection is tried once more.
    body = await transport.send(
        "POST", path_for(model), json=await asyncio.to_thread(to_wire, request), repeatable=True
    )
    stamp = time.strftime("%Y%m%d-%H%M%S")
    files: list[str] = []
    for index, (mime, data) in enumerate(images_of(body), start=1):
        file = out_dir / f"image-{stamp}-{index}{ext_for_media(mime)}"
        file.write_bytes(data)
        files.append(str(file.resolve()))
    return ImageResult(files=files, model=str(body.get("modelVersion") or model))
