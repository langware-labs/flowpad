"""Codex transcript parser.

Codex ships transcripts in two distinct shapes — the parser detects which
on the first non-empty line and dispatches accordingly:

1. **Stream-event shape** (process-local ``codex_transcript.jsonl``):
   ``thread.started`` / ``turn.started`` / ``item.started`` /
   ``item.completed`` / ``turn.completed``. ``item.type`` ∈
   ``agent_message`` | ``command_execution`` | ``file_change``.

2. **Rollout shape** (``~/.codex/sessions/.../rollout-*.jsonl``):
   ``session_meta`` then a stream of ``response_item`` lines whose
   ``payload`` is a ``message`` with ``role`` and ``content`` blocks.
   Real rollouts also carry ``event_msg``, ``turn_context``, ``token_count``.

Stateful: the parser caches ``thread_id`` (or ``session_meta.payload.id``)
to backfill ``session_id`` on subsequent lines that don't carry it.
"""

from __future__ import annotations

from typing import Any

from ..entries import (
    AssistantMessageEntry,
    MetaEntry,
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UserMessageEntry,
)
from ..entry import TranscriptEntry


class CodexParser:
    worker_type = "codex"

    def __init__(self, session_id: str = "") -> None:
        self.session_id = session_id

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        rtype = raw.get("type") or ""

        # Capture thread_id whenever it shows up.
        if rtype == "thread.started":
            tid = str(raw.get("thread_id") or "")
            if tid:
                self.session_id = tid
        elif rtype == "session_meta":
            payload = raw.get("payload") or {}
            sid = str(payload.get("id") or "")
            if sid and not self.session_id:
                self.session_id = sid

        base = dict(
            id=self._synth_id(raw, rtype, line_index),
            session_id=self.session_id,
            timestamp=str(raw.get("timestamp") or ""),
            worker=self.worker_type,
            parent_id=None,
        )

        # ── Stream-event shape ──────────────────────────────────────────────
        if rtype.startswith("thread.") or rtype.startswith("turn."):
            return [SystemEntry(subtype=rtype, payload=raw, **base)]
        if rtype == "item.started":
            item = raw.get("item") or {}
            return [MetaEntry(meta_kind="item.started", payload=item, **base)]
        if rtype == "item.completed":
            return self._parse_item_completed(raw, base)

        # ── Rollout shape ───────────────────────────────────────────────────
        if rtype == "session_meta":
            return [MetaEntry(meta_kind="session_meta", payload=raw.get("payload") or {}, **base)]
        if rtype == "response_item":
            return self._parse_response_item(raw, base)
        if rtype in {"event_msg", "turn_context", "token_count", "task_started", "task_complete"}:
            return [MetaEntry(meta_kind=rtype, payload=raw.get("payload") or raw, **base)]

        return [UnknownEntry(raw_data=raw, **base)]

    # ── helpers ──────────────────────────────────────────────────────────────

    def _synth_id(self, raw: dict, rtype: str, line_index: int) -> str:
        # Prefer item.id when present; else <thread_id>:<line_index>.
        item = raw.get("item") if rtype == "item.completed" or rtype == "item.started" else None
        if isinstance(item, dict):
            iid = item.get("id")
            if iid:
                return str(iid)
        thread = self.session_id or "codex"
        return f"{thread}:{line_index}"

    def _parse_item_completed(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        item: dict[str, Any] = raw.get("item") or {}
        itype = item.get("type")
        if itype == "agent_message":
            text = str(item.get("text") or "")
            return [AssistantMessageEntry(text=text, **base)]
        if itype == "command_execution":
            # Synthesize a paired ToolUseEntry → ToolResultEntry so consumers
            # see the same shape as Claude's Bash flow. Both share the line
            # timestamp; ids are derived from the item id.
            cmd = str(item.get("command") or "")
            output = str(item.get("aggregated_output") or "")
            exit_code = item.get("exit_code")
            tool_use_id = str(item.get("id") or base["id"])
            use_base = {**base, "id": f"{tool_use_id}:tool_use"}
            result_base = {**base, "id": f"{tool_use_id}:tool_result"}
            return [
                ToolUseEntry(
                    tool_name="shell",
                    tool_use_id=tool_use_id,
                    tool_input={"command": cmd},
                    **use_base,
                ),
                ToolResultEntry(
                    tool_use_id=tool_use_id,
                    tool_output=output,
                    is_error=bool(exit_code) and exit_code != 0,
                    file_path=None,
                    tool_name="shell",
                    **result_base,
                ),
            ]
        if itype == "file_change":
            return [MetaEntry(meta_kind="file_change", payload=item, **base)]
        # Unknown item type — keep as Unknown rather than silently dropping.
        return [UnknownEntry(raw_data=raw, **base)]

    def _parse_response_item(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        payload = raw.get("payload") or {}
        ptype = payload.get("type")
        if ptype != "message":
            # function_call / reasoning / etc. — not user-visible chat; meta.
            return [MetaEntry(meta_kind=f"response_item:{ptype}", payload=payload, **base)]
        role = payload.get("role")
        content = payload.get("content") or []
        text_parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") in ("input_text", "output_text"):
                text = block.get("text") or ""
                # Skip codex's permission/agents/skills XML preludes — they
                # are framed as "<...>...</...>" blocks the model never wrote.
                if text and not text.startswith("<"):
                    text_parts.append(text)
        text = "\n".join(text_parts).strip()
        if not text:
            # Empty after pruning preludes — treat as meta so it doesn't
            # vanish silently.
            return [MetaEntry(meta_kind="response_item:message:empty", payload=payload, **base)]
        if role == "user":
            return [UserMessageEntry(text=text, **base)]
        if role in ("assistant", "developer"):
            return [AssistantMessageEntry(text=text, **base)]
        return [MetaEntry(meta_kind=f"response_item:message:{role}", payload=payload, **base)]
