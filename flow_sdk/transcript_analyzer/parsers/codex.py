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
import re
from typing import Any

from ..entries import (
    AssistantMessageEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    MetaEntry,
    ShellCommandEntry,
    SummaryEntry,
    SystemEntry,
    TokenUsageEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UserMessageEntry,
    WebFetchEntry,
)
from ..entry import TranscriptEntry
from ._apply_patch import (
    add_op_to_content,
    parse_apply_patch,
    update_op_to_hunks,
)


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

    # Codex's ``function_call_output.output`` may begin with a preamble of
    # the form (any subset, in order):
    #   Chunk ID: <id>
    #   Wall time: <secs> seconds
    #   Process exited with code <code>
    #   Original token count: <n>
    #   Output:
    # The body follows the ``Output:`` marker. The grammar is lenient: we
    # only consume lines that match these patterns; the first non-matching
    # line (or an explicit ``Output:`` marker) terminates the preamble.
    _PREAMBLE_PATTERNS = (
        ("chunk_id", re.compile(r"^Chunk ID:\s*([\w-]+)$")),
        ("wall_time", re.compile(r"^Wall time:\s*([\d.]+)\s*seconds$")),
        ("exit_code", re.compile(r"^Process exited with code\s*(-?\d+)$")),
        ("token_count", re.compile(r"^Original token count:\s*(\d+)$")),
    )

    @classmethod
    def _parse_codex_output_preamble(cls, text: str) -> tuple[dict, str]:
        """Strip the codex output preamble; return ({fields}, body).

        Returns ``({}, text)`` when no preamble is detected — preserves the
        old behavior for transcripts that don't carry the preamble.
        """
        if not text:
            return {}, text
        lines = text.split("\n")
        fields: dict[str, Any] = {}
        i = 0
        consumed_any = False
        while i < len(lines):
            line = lines[i]
            if line == "Output:":
                consumed_any = True
                i += 1
                break
            matched = False
            for key, pat in cls._PREAMBLE_PATTERNS:
                m = pat.match(line)
                if not m:
                    continue
                matched = True
                consumed_any = True
                raw_value = m.group(1)
                if key == "wall_time":
                    try:
                        fields["duration_ms"] = round(float(raw_value) * 1000)
                    except ValueError:
                        pass
                elif key == "exit_code":
                    try:
                        fields["exit_code"] = int(raw_value)
                    except ValueError:
                        pass
                elif key == "token_count":
                    try:
                        fields["output_token_count"] = int(raw_value)
                    except ValueError:
                        pass
                # ``chunk_id`` is captured for completeness but not surfaced.
                break
            if not matched:
                # First non-preamble line: stop without consuming it (so we
                # don't lose body text when there's no ``Output:`` marker).
                break
            i += 1
        if not consumed_any:
            return {}, text
        body = "\n".join(lines[i:])
        return fields, body

    @staticmethod
    def _codex_duration_to_ms(value: Any) -> int | None:
        """Codex ``event_msg.exec_command_end.duration`` is ``{secs, nanos}``.

        Returns total milliseconds, or None when the shape isn't recognized.
        """
        if isinstance(value, dict):
            secs = value.get("secs")
            nanos = value.get("nanos")
            if isinstance(secs, (int, float)) or isinstance(nanos, (int, float)):
                total_ns = (secs or 0) * 1_000_000_000 + (nanos or 0)
                return int(round(total_ns / 1_000_000))
        if isinstance(value, (int, float)):
            # Fallback: assume already milliseconds.
            return int(round(value))
        return None

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
            duration_ms = self._codex_duration_to_ms(item.get("duration"))
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
                    duration_ms=duration_ms,
                    exit_code=exit_code if isinstance(exit_code, int) else None,
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
            tool_use_id = call_id or str(eid or base["id"])
            tool_input = self._safe_json(payload.get("arguments") or {}) or {}
            return self._build_semantic_function_call(
                tool_name=tool_name,
                tool_use_id=tool_use_id,
                tool_input=tool_input if isinstance(tool_input, dict) else {"value": tool_input},
                envelope=envelope,
                base=base,
            )
        if ptype == "function_call_output":
            call_id = str(payload.get("call_id") or "")
            output = payload.get("output")
            raw_text = "" if output is None else str(output)
            preamble, body = self._parse_codex_output_preamble(raw_text)
            exit_code = preamble.get("exit_code")
            return [ToolResultEntry(
                tool_use_id=call_id or str(eid or base["id"]),
                tool_output=body,
                is_error=isinstance(exit_code, int) and exit_code != 0,
                tool_name=self._call_tool_name.get(call_id),
                duration_ms=preamble.get("duration_ms"),
                exit_code=exit_code,
                output_token_count=preamble.get("output_token_count"),
                **envelope,
                **base,
            )]
        if ptype == "custom_tool_call":
            tool_name = str(payload.get("name") or "custom_tool")
            call_id = str(payload.get("call_id") or "")
            if call_id and tool_name:
                self._call_tool_name[call_id] = tool_name
            tool_use_id = call_id or str(eid or base["id"])
            raw_input = payload.get("input") if "input" in payload else payload.get("arguments")
            return self._build_semantic_custom_tool(
                tool_name=tool_name,
                tool_use_id=tool_use_id,
                raw_input=raw_input,
                envelope=envelope,
                base=base,
            )
        if ptype == "custom_tool_call_output":
            call_id = str(payload.get("call_id") or "")
            output = payload.get("output")
            raw_text = "" if output is None else str(output)
            preamble, body = self._parse_codex_output_preamble(raw_text)
            exit_code = preamble.get("exit_code")
            return [ToolResultEntry(
                tool_use_id=call_id or str(eid or base["id"]),
                tool_output=body,
                is_error=isinstance(exit_code, int) and exit_code != 0,
                tool_name=self._call_tool_name.get(call_id),
                duration_ms=preamble.get("duration_ms"),
                exit_code=exit_code,
                output_token_count=preamble.get("output_token_count"),
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
            query: str | None = None
            url: str | None = None
            if isinstance(action, dict):
                q = action.get("query") or (action.get("queries") or [None])[0]
                if isinstance(q, str) and q:
                    query = q
                if isinstance(action.get("url"), str):
                    url = action.get("url")
            call_id = str(payload.get("call_id") or eid or base["id"])
            self._call_tool_name[call_id] = "web_search"
            return [WebFetchEntry(
                url=url,
                query=query,
                tool_name="web_search",
                tool_use_id=call_id,
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
            raw_text = "" if output is None else str(output)
            preamble, body = self._parse_codex_output_preamble(raw_text)
            exit_code = preamble.get("exit_code")
            return [ToolResultEntry(
                tool_use_id=call_id or str(eid or base["id"]),
                tool_output=body,
                is_error=isinstance(exit_code, int) and exit_code != 0,
                tool_name=self._call_tool_name.get(call_id, "tool_search"),
                duration_ms=preamble.get("duration_ms"),
                exit_code=exit_code,
                output_token_count=preamble.get("output_token_count"),
                **envelope,
                **base,
            )]

        return [MetaEntry(
            meta_kind=f"response_item:{ptype}",
            payload=payload,
            **envelope,
            **base,
        )]

    # ── semantic dispatchers (rollout function_call + custom_tool_call) ────

    def _build_semantic_function_call(
        self,
        *,
        tool_name: str,
        tool_use_id: str,
        tool_input: dict,
        envelope: dict[str, Any],
        base: dict,
    ) -> list[TranscriptEntry]:
        """Map a codex ``function_call`` onto a semantic entry.

        Falls through to :class:`ToolUseEntry` for tools the parser doesn't
        recognize so MCP / bespoke tools keep rendering through the
        catch-all path.
        """
        common: dict[str, Any] = {
            "tool_name": tool_name,
            "tool_use_id": tool_use_id,
            **envelope,
            **base,
        }
        ti = tool_input if isinstance(tool_input, dict) else {}

        if tool_name == "exec_command":
            return [ShellCommandEntry(
                command=str(ti.get("cmd") or ti.get("command") or ""),
                cwd=str(ti.get("workdir") or "") or None,
                **common,
            )]
        if tool_name in ("read_file", "view_file"):
            return [FileReadEntry(
                path=str(ti.get("path") or ti.get("file_path") or ""),
                **common,
            )]
        if tool_name in ("write_file",):
            content_str = str(ti.get("content")) if ti.get("content") is not None else None
            line_count = content_str.count("\n") + 1 if content_str else None
            bytes_count = len(content_str.encode("utf-8")) if content_str else None
            return [FileWriteEntry(
                path=str(ti.get("path") or ti.get("file_path") or ""),
                content=content_str,
                bytes_count=bytes_count,
                line_count=line_count,
                is_new=True,
                **common,
            )]
        return [ToolUseEntry(
            tool_name=tool_name,
            tool_use_id=tool_use_id,
            tool_input=ti,
            **envelope,
            **base,
        )]

    def _build_semantic_custom_tool(
        self,
        *,
        tool_name: str,
        tool_use_id: str,
        raw_input: Any,
        envelope: dict[str, Any],
        base: dict,
    ) -> list[TranscriptEntry]:
        """Map a codex ``custom_tool_call`` onto semantic entries.

        ``apply_patch`` is the load-bearing case: its ``input`` is a
        unified-diff-ish text blob that may carry multiple file ops (Add,
        Update, Delete). One semantic entry is emitted per file op so the
        renderer shows e.g. five Add File rows for a five-file add.
        """
        if tool_name == "apply_patch" and isinstance(raw_input, str):
            ops = parse_apply_patch(raw_input)
            entries: list[TranscriptEntry] = []
            for idx, op in enumerate(ops):
                # Synthesize a stable id per op so the row keys don't
                # collide. Result-folding still pairs by the shared
                # tool_use_id (codex returns one output for the whole
                # call); the folder keys on tool_use_id, not row id.
                op_id = base["id"] if idx == 0 else f"{base['id']}:patch{idx}"
                op_base = {**base, "id": op_id}
                if op.op == "add":
                    content = add_op_to_content(op)
                    line_count = content.count("\n") + 1 if content else None
                    bytes_count = len(content.encode("utf-8")) if content else None
                    entries.append(FileWriteEntry(
                        path=op.path,
                        content=content,
                        bytes_count=bytes_count,
                        line_count=line_count,
                        is_new=True,
                        tool_name=tool_name,
                        tool_use_id=tool_use_id,
                        **envelope,
                        **op_base,
                    ))
                elif op.op == "update":
                    entries.append(FileEditEntry(
                        path=op.path,
                        hunks=update_op_to_hunks(op),
                        tool_name=tool_name,
                        tool_use_id=tool_use_id,
                        **envelope,
                        **op_base,
                    ))
                elif op.op == "delete":
                    # No FileDeleteEntry yet — represent as an Edit with a
                    # marker change_summary so the row still renders with
                    # the file path. Future kind: replace with
                    # FileDeleteEntry once the renderer supports it.
                    entries.append(FileEditEntry(
                        path=op.path,
                        hunks=[],
                        change_summary="(file deleted)",
                        tool_name=tool_name,
                        tool_use_id=tool_use_id,
                        **envelope,
                        **op_base,
                    ))
            if entries:
                return entries
        # Unknown custom tool — drop into the catch-all.
        ti = self._safe_json(raw_input) if raw_input is not None else {}
        if not isinstance(ti, dict):
            ti = {"value": ti}
        return [ToolUseEntry(
            tool_name=tool_name,
            tool_use_id=tool_use_id,
            tool_input=ti,
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
            duration_ms = self._codex_duration_to_ms(payload.get("duration"))
            return [ToolResultEntry(
                tool_use_id=call_id or base["id"],
                tool_output=str(output),
                is_error=isinstance(exit_code, int) and exit_code != 0,
                tool_name=self._call_tool_name.get(call_id),
                duration_ms=duration_ms,
                exit_code=exit_code if isinstance(exit_code, int) else None,
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
