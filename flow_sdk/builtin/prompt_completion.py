"""PromptCompletion — the result of running a Prompt in a RemoteWorkerSession.

Symmetric to ``Prompt`` (builtin/prompt.py): where a Prompt is the request a guest
sends, a PromptCompletion is the answer the host's worker produced. It rides back as a
``prompt_completion-<id>`` TYPE_ID attachment on a reply FlowMessage (mirroring how a
Prompt attaches), carrying ``result_preview`` so the guest can read it before the
body bundle downloads. A result is turn-grained (one per answered prompt) and may
carry more than text — ``asset_refs`` points at files/assets the run produced.
"""
from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class PromptCompletion(Entity):
    type: str = APIField(default="prompt_completion")
    prompt_id: Optional[str] = APIField(
        default=None, description="Id of the Prompt this result answers."
    )
    remote_worker_session_id: Optional[str] = APIField(
        default=None, description="RemoteWorkerSession this result belongs to."
    )
    text: Optional[str] = APIField(
        default=None, description="The assistant reply text (the visible answer)."
    )
    result_preview: Optional[str] = APIField(
        default=None,
        description="Inline copy of the text so a guest previews it before downloading the body.",
    )
    asset_refs: list[str] = APIField(
        default_factory=list,
        description="TypeIds of files/assets the run produced (a result can be more than text).",
    )
    status: str = APIField(
        default="complete", description="Result status (complete, error)."
    )
    source_session_id: Optional[str] = APIField(
        default=None, description="Host worker session id that produced this result."
    )
    host_process_id: Optional[str] = APIField(
        default=None, description="Host AgenticProcess id that produced this result."
    )
