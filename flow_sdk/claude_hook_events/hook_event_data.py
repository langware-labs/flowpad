"""Unified Pydantic model for hook event data.

Phase 9 collapse: the 30+ optional flat fields that previously modeled every
hook variant (tool_name / tool_input / tool_response / prompt / message / …)
are gone. Two replacements:

1. ``process_entry`` — typed conversational payload synthesized from the
   raw hook by ``flow_sdk.transcript_analyzer.synthesizers.synth_process_entry``.
   Read this for the canonical content. Same `id` as the corresponding
   live-stream / JSONL observation, so cross-channel dedup just works.

2. ``extra`` — the raw hook payload dict. Holds variant-specific fields
   (worktree_path, task_subject, …) that aren't captured by ``process_entry``.
   Use field_extractors helpers to read it.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class HookEventData(BaseModel):
    """Provider-agnostic hook event data.

    Lifecycle envelope only. All conversational payload lives on
    ``process_entry``; variant-specific lifecycle fields live on ``extra``.
    """

    model_config = ConfigDict(extra="allow")

    hook_event_name: str
    session_id: Optional[str] = None
    transcript_path: Optional[str] = None
    cwd: Optional[str] = None
    permission_mode: Optional[str] = None

    # Legacy flat hook fields kept for trigger masks and older renderers.
    tool_name: Optional[str] = None
    tool_use_id: Optional[str] = None
    tool_input: Optional[dict[str, Any]] = None
    tool_response: Any = None
    prompt: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None
    stop_reason: Optional[str] = None
    task_subject: Optional[str] = None
    raw_hook_data: Optional[dict[str, Any]] = None

    # Phase 9 — typed conversational payload (synthesized) + raw spillover.
    process_entry: Optional[dict] = None
    extra: dict[str, Any] = {}
