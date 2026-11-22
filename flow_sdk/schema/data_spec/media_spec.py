"""Image and video generation as values: what is asked for, and the files that come back.

One pair per capability. The capability is named by a KIND (``image.generate``,
``video.generate``) -- the word a hub ``APIEndpoint`` root is tagged with -- and typed by its
request and result here. A vendor's own words (``createTask``, ``generateContent``,
``responseModalities``) stop at its dialect in ``external_apis``; nothing above spells them.

``model`` is the vendor's own model name, and the one field that is not portable: empty means
the dialect's default.
"""

from __future__ import annotations

from typing import ClassVar

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec

IMAGE_GENERATE = "image.generate"
VIDEO_GENERATE = "video.generate"
#: Hosting a local file where a vendor can fetch it. A dialect uses it for a request's local
#: files (a video's key frames); nothing above the dialects calls it.
FILE_UPLOAD = "file.upload"


class ImageRequest(DataSpec):
    spec_kind: ClassVar[str] = "image.request"

    prompt: str = Field(min_length=1)
    model: str = ""
    #: ``"16:9"``, ``"1:1"``; empty leaves it to the model.
    aspect_ratio: str = ""
    #: Local image files the model should follow (a logo, a character, a style).
    reference_images: list[str] = []


class ImageResult(DataSpec):
    spec_kind: ClassVar[str] = "image.result"

    #: Absolute paths of the images written, in the order the model gave them.
    files: list[str]
    model: str = ""
    #: The APIEndpoint that answered, as ``api_endpoint-<id>``.
    endpoint: str = ""
    latency_ms: float = 0.0


class VideoRequest(DataSpec):
    spec_kind: ClassVar[str] = "video.request"

    prompt: str = Field(min_length=1)
    model: str = ""
    duration_s: int = Field(default=5, ge=1, le=60)
    #: ``"720p"``, ``"768p"``; empty takes the model's default.
    resolution: str = ""
    aspect_ratio: str = "16:9"
    audio: bool = False
    #: The frames the clip starts and ends on: a local image file, or the public URL of one that is
    #: already hosted. What a vendor cannot take as given, its dialect converts (a file is hosted
    #: through the same endpoint, ``file.upload``) or refuses.
    first_frame: str = ""
    last_frame: str = ""


class VideoResult(DataSpec):
    spec_kind: ClassVar[str] = "video.result"

    #: Absolute path of the clip written.
    file: str
    model: str = ""
    endpoint: str = ""
    #: The vendor's id for the job that made it: what to look up when a call was cut short.
    job_id: str = ""
    latency_ms: float = 0.0


def is_url(frame: str) -> bool:
    return frame.startswith(("http://", "https://"))


__all__ = [
    "FILE_UPLOAD",
    "IMAGE_GENERATE",
    "VIDEO_GENERATE",
    "ImageRequest",
    "ImageResult",
    "VideoRequest",
    "VideoResult",
    "is_url",
]
