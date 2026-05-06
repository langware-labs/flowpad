"""Codex transcript parser.

Codex ships transcripts in two distinct shapes — the parser detects which
on the first non-empty line and dispatches accordingly:

1. **Stream-event shape** (process-local ``codex_transcript.jsonl``):
   ``thread.started`` / ``turn.started`` / ``item.started`` /
   ``item.completed`` / ``turn.completed``. ``item.type`` ∈
   ``agent_message`` | ``command_execution`` | ``file_change``.

2. **Rollout shape** (``~/.codex/sessions/.../rollout-*.jsonl``):
   ``session_meta`` then a stream of ``response_item`` lines whose
   ``payload`` is one of ``message`` / ``function_call`` /
   ``function_call_output`` / ``custom_tool_call`` /
   ``custom_tool_call_output`` / ``reasoning`` / ``web_search_call`` /
   ``tool_search_call`` / ``tool_search_output``. Real rollouts also carry
   ``event_msg``, ``turn_context``, ``token_count``, top-level ``compacted``.

Stateful: the parser caches ``thread_id`` (or ``session_meta.payload.id``)
to backfill ``session_id`` on subsequent lines that don't carry it. It
also caches ``call_id → tool_name`` so ``function_call_output`` and
``event_msg.{exec_command_end,mcp_tool_call_end,patch_apply_end}`` can
carry the right tool name on their ``ToolResultEntry``. And it remembers
the last ``turn_context.model`` so subsequent assistant lines carry it
on the envelope.
"""

from __future__ import annotations

import json
from typing import Any

from ..entries import (
    AssistantMessageEntry,
    MetaEntry,
    SummaryEntry,
    SystemEntry,
    TokenUsageEntry,
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
        # call_id → tool_name. Populated when we see a function_call /
        # custom_tool_call / tool_search_call so the matching outputs
        # (rollout-shape function_call_output, custom_tool_call_output,
        # tool_search_output, plus event_msg.{exec_command_end,
        # mcp_tool_call_end, patch_apply_end}) can carry tool_name on
        # their ``ToolResultEntry``.
        self._call_tool_name: dict[str, str] = {}
        # Last seen ``turn_context.model`` — propagated onto subsequent
        # ``AssistantMessageEntry`` and ``TokenUsageEntry`` envelopes.
        self._current_model: str | None = None

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        rtype = raw.get("type") or ""

        # Capture session id whenever it shows up.
        if rtype == "thread.started":
            tid = str(raw.get("thread_id") or "")
            if tid:
                self.session_id = tid
        elif rtype == "session_meta":
            payload = raw.get("payload") or {}
            sid = str(payload.get("id") or "")
            if sid and not self.session_id:
                self.session_id = sid

        # Capture model from turn_context for downstream assistant lines.
        if rtype == "turn_context":
            payload = raw.get("payload") or {}
            m = payload.get("model")
            if m:
                self._current_model = str(m)

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
        if rtype == "event_msg":
            return self._parse_event_msg(raw, base)
        if rtype == "turn_context":
            return [SystemEntry(subtype="turn_context", payload=raw.get("payload") or raw, **base)]
        if rtype == "compacted":
            return self._parse_compacted(raw, base)
        if rtype == "token_count":
            payload = raw.get("payload") or raw
            return [self._make_token_usage(payload, base)]
        if rtype in {"task_started", "task_complete"}:
            return [SystemEntry(subtype=rtype, payload=raw.get("payload") or raw, **base)]

        return [UnknownEntry(raw_data=raw, **base)]

    # ── helpers ──────────────────────────────────────────────────────────────

    def _synth_id(self, raw: dict, rtype: str, line_index: int) -> str:
        item = raw.get("item") if rtype in ("item.completed", "item.started") else None
        if isinstance(item, dict):
            iid = item.get("id")
            if iid:
                return str(iid)
        if rtype == "response_item":
            payload = raw.get("payload") or {}
            pid = payload.get("id") if isinstance(payload, dict) else None
            if pid:
                return str(pid)
        thread = self.session_id or "codex"
        return f"{thread}:{line_index}"

    @staticmethod
    def _join_text_blocks(content: Any, *, kinds: tuple[str, ...] = ("input_text", "output_text")) -> str:
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in kinds:
                t = block.get("text")
                if t:
                    parts.append(str(t))
        return "\n".join(parts)

    @staticmethod
    def _safe_json(value: Any) -> Any:
        """Decode a JSON-string ``arguments`` blob; pass dicts/lists through."""
        if isinstance(value, str):
            try:
                return json.loads(value)
            except (ValueError, TypeError):
                return value
        return value

    def _make_token_usage(self, payload: dict, base: dict) -> TokenUsageEntry:
        info = payload.get("info") if isinstance(payload, dict) else None
        if not isinstance(info, dict):
            info = payload if isinstance(payload, dict) else {}
        last = info.get("last_token_usage") or {}
        total = info.get("total_token_usage") or {}
        if not isinstance(last, dict):
            last = {}
        if not isinstance(total, dict):
            total = {}
        turn_id = info.get("turn_id")
        if not turn_id and isinstance(payload, dict):
            turn_id = payload.get("turn_id")
        return TokenUsageEntry(
            input_tokens=last.get("input_tokens"),
            output_tokens=last.get("output_tokens"),
            cached_input_tokens=last.get("cached_input_tokens"),
            reasoning_output_tokens=last.get("reasoning_output_tokens"),
            total_input_tokens=total.get("input_tokens"),
            total_output_tokens=total.get("output_tokens"),
            turn_id=str(turn_id) if turn_id else None,
            model=self._current_model,
            **base,
        )

    def _parse_compacted(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        payload = raw.get("payload") or raw
        text = ""
        if isinstance(payload, dict):
            text = str(
                payload.get("replacement_history")
                or payload.get("message")
                or payload.get("text")
                or ""
            )
        if not text:
            try:
                text = json.dumps(payload, sort_keys=True)
            except (TypeError, ValueError):
                text = str(payload)
        return [SummaryEntry(summary_text=text, **base)]

    # ── stream-event item.completed ─────────────────────────────────────────

    def _parse_item_completed(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        item: dict[str, Any] = raw.get("item") or {}
        itype = item.get("type")
        if itype == "agent_message":
            text = str(item.get("text") or "")
            return [AssistantMessageEntry(text=text, model=self._current_model, **base)]
        if itype == "command_execution":
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
                    is_error=isinstance(exit_code, int) and exit_code != 0,
                    file_path=None,
                    tool_name="shell",
                    **result_base,
                ),
            ]
        if itype == "file_change":
            return [MetaEntry(meta_kind="file_change", payload=item, **base)]
        return [UnknownEntry(raw_data=raw, **base)]

    # ── rollout response_item ──────────────────────────────────────────────

    def _parse_response_item(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        payload = raw.get("payload") or {}
        ptype = payload.get("type")
        eid = payload.get("id")
        envelope: dict[str, Any] = {}
        if eid:
            envelope["entry_id"] = str(eid)

        if ptype == "message":
            return self._parse_response_message(payload, base, envelope)
        if ptype == "function_call":
            tool_name = str(payload.get("name") or "")
            call_id = str(payload.get("call_id") or "")
            if call_id and tool_name:
                self._call_tool_name[call_id] = tool_name
            return [ToolUseEntry(
                tool_name=tool_name,
                tool_use_id=call_id or str(eid or base["id"]),
                tool_input=self._safe_json(payload.get("arguments") or {}) or {},
                **envelope,
                **base,
            )]
        if ptype == "function_call_output":
            call_id = str(payload.get("call_id") or "")
            output = payload.get("output")
            return [ToolResultEntry(
                tool_use_id=call_id or str(eid or base["id"]),
                tool_output="" if output is None else str(output),
                tool_name=self._call_tool_name.get(call_id),
                **envelope,
                **base,
            )]
        if ptype == "custom_tool_call":
            tool_name = str(payload.get("name") or "custom_tool")
            call_id = str(payload.get("call_id") or "")
            if call_id and tool_name:
                self._call_tool_name[call_id] = tool_name
            return [ToolUseEntry(
                tool_name=tool_name,
                tool_use_id=call_id or str(eid or base["id"]),
                tool_input=self._safe_json(payload.get("input") or payload.get("arguments") or {}) or {},
                **envelope,
                **base,
            )]
        if ptype == "custom_tool_call_output":
            call_id = str(payload.get("call_id") or "")
            output = payload.get("output")
            return [ToolResultEntry(
                tool_use_id=call_id or str(eid or base["id"]),
                tool_output="" if output is None else str(output),
                tool_name=self._call_tool_name.get(call_id),
                **envelope,
                **base,
            )]
        if ptype == "reasoning":
            summary = payload.get("summary") or []
            thinking_parts: list[str] = []
            if isinstance(summary, list):
                for s in summary:
                    if isinstance(s, dict):
                        t = s.get("text") or ""
                        if t:
                            thinking_parts.append(str(t))
            if thinking_parts:
                thinking = "\n".join(thinking_parts)
            elif payload.get("encrypted_content"):
                # Plain-text summary unavailable; mark explicitly so the
                # rendered entry isn't a blank assistant_message block.
                thinking = "[encrypted reasoning, content dropped]"
            else:
                thinking = None
            return [AssistantMessageEntry(
                text="",
                thinking=thinking,
                model=self._current_model,
                **envelope,
                **base,
            )]
        if ptype == "web_search_call":
            action = payload.get("action") or {}
            tool_input: dict[str, Any] = {}
            if isinstance(action, dict):
                if action.get("query"):
                    tool_input["query"] = action["query"]
                if action.get("queries"):
                    tool_input["queries"] = action["queries"]
                if action.get("type"):
                    tool_input["action_type"] = action["type"]
            call_id = str(payload.get("call_id") or eid or base["id"])
            return [ToolUseEntry(
                tool_name="web_search",
                tool_use_id=call_id,
                tool_input=tool_input,
                **envelope,
                **base,
            )]
        if ptype == "tool_search_call":
            tool_input = self._safe_json(payload.get("arguments") or {}) or {}
            call_id = str(payload.get("call_id") or eid or base["id"])
            self._call_tool_name[call_id] = "tool_search"
            return [ToolUseEntry(
                tool_name="tool_search",
                tool_use_id=call_id,
                tool_input=tool_input,
                **envelope,
                **base,
            )]
        if ptype == "tool_search_output":
            call_id = str(payload.get("call_id") or "")
            output = payload.get("output")
            return [ToolResultEntry(
                tool_use_id=call_id or str(eid or base["id"]),
                tool_output="" if output is None else str(output),
                tool_name=self._call_tool_name.get(call_id, "tool_search"),
                **envelope,
                **base,
            )]

        return [MetaEntry(
            meta_kind=f"response_item:{ptype}",
            payload=payload,
            **envelope,
            **base,
        )]

    def _parse_response_message(
        self,
        payload: dict,
        base: dict,
        envelope: dict[str, Any],
    ) -> list[TranscriptEntry]:
        role = str(payload.get("role") or "")
        content = payload.get("content") or []
        if role == "user":
            text = self._join_text_blocks(content, kinds=("input_text",)).strip()
            return [UserMessageEntry(
                text=text,
                role="user",
                **envelope,
                **base,
            )]
        if role == "assistant":
            text = self._join_text_blocks(content, kinds=("output_text",)).strip()
            phase = payload.get("phase")
            return [AssistantMessageEntry(
                text=text,
                phase=str(phase) if phase else None,
                model=self._current_model,
                **envelope,
                **base,
            )]
        if role in ("developer", "system"):
            return [SystemEntry(
                subtype=f"{role}_message",
                payload=payload,
                **envelope,
                **base,
            )]
        return [MetaEntry(
            meta_kind=f"response_item:message:{role}",
            payload=payload,
            **envelope,
            **base,
        )]

    # ── rollout event_msg ──────────────────────────────────────────────────

    def _parse_event_msg(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        payload = raw.get("payload") or {}
        if not isinstance(payload, dict):
            return [MetaEntry(meta_kind="event_msg", payload={"value": payload}, **base)]
        etype = str(payload.get("type") or "")
        # Drop the ``agent_message`` / ``user_message`` event_msg mirrors —
        # the canonical record is the paired ``response_item.message`` line
        # which produces a typed AssistantMessage / UserMessage entry.
        if etype in ("agent_message", "user_message"):
            return []
        if etype == "token_count":
            return [self._make_token_usage(payload, base)]
        if etype in {
            "task_started",
            "task_complete",
            "turn_aborted",
            "context_compacted",
            "update_plan",
        }:
            return [SystemEntry(
                subtype=f"event_msg.{etype}",
                payload=payload,
                **base,
            )]
        if etype == "error":
            return [SystemEntry(
                subtype="event_msg.error",
                payload=payload,
                **base,
            )]
        if etype in ("exec_command_end", "mcp_tool_call_end", "patch_apply_end"):
            call_id = str(payload.get("call_id") or "")
            output = (
                payload.get("aggregated_output")
                or payload.get("output")
                or payload.get("formatted_output")
                or ""
            )
            exit_code = payload.get("exit_code")
            return [ToolResultEntry(
                tool_use_id=call_id or base["id"],
                tool_output=str(output),
                is_error=isinstance(exit_code, int) and exit_code != 0,
                tool_name=self._call_tool_name.get(call_id),
                **base,
            )]
        if etype == "view_image_tool_call":
            call_id = str(payload.get("call_id") or base["id"])
            tool_input = {"path": payload.get("path") or payload.get("image_path") or ""}
            use_base = {**base, "id": f"{base['id']}:tool_use"}
            result_base = {**base, "id": f"{base['id']}:tool_result"}
            return [
                ToolUseEntry(
                    tool_name="view_image",
                    tool_use_id=call_id,
                    tool_input=tool_input,
                    **use_base,
                ),
                ToolResultEntry(
                    tool_use_id=call_id,
                    tool_output=str(payload.get("output") or ""),
                    tool_name="view_image",
                    **result_base,
                ),
            ]
        return [MetaEntry(
            meta_kind=f"event_msg.{etype}",
            payload=payload,
            **base,
        )]
