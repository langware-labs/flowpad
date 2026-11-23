"""What a hub ``APIEndpoint`` can be asked to do: each capability's kind, request and result.

A capability is named by a KIND -- the word a root endpoint is tagged with and a call names
(``x-flowpad-kind``) -- and typed by a request spec and a result spec. This is the one table: the
call (``flow_sdk.endpoint_call``), the block (``EndpointOp``) and the listing all read it.
"""

from __future__ import annotations

from flow_sdk.schema.data_spec.decision_spec import DecisionResult, DecisionSpec
from flow_sdk.schema.data_spec.media_spec import (
    FILE_UPLOAD,
    IMAGE_GENERATE,
    VIDEO_GENERATE,
    ImageRequest,
    ImageResult,
    VideoRequest,
    VideoResult,
)
from flow_sdk.schema.data_spec.spec import DataSpec

DECISION = "decision"

#: kind -> (what is asked, what comes back). ``file.upload`` is a kind a root may serve and a dialect
#: may use, but not a capability: nothing above the dialects asks for it.
CAPABILITIES: dict[str, tuple[type[DataSpec], type[DataSpec]]] = {
    DECISION: (DecisionSpec, DecisionResult),
    IMAGE_GENERATE: (ImageRequest, ImageResult),
    VIDEO_GENERATE: (VideoRequest, VideoResult),
}

__all__ = ["CAPABILITIES", "DECISION", "FILE_UPLOAD", "IMAGE_GENERATE", "VIDEO_GENERATE"]
