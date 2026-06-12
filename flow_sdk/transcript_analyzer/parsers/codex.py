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

from flow_sdk._compat import StrEnum

from ..entries import (
    AssistantMessageEntry,
    CodexUsageEntry,
    ExitPlanModeEntry,
    FileEditEntry,
    FileWriteEntry,
    MetaEntry,
    SkillCallEntry,
    SummaryEntry,
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UsageEntry,
    UserMessageEntry,
)
from ..entry import TranscriptEntry
from ._apply_patch import (
    add_op_to_content,
    parse_apply_patch,
    update_op_to_hunks,
)

# Codex has no native skill tool — it loads a skill by reading its
# ``…/skills/<name>/SKILL.md``. Recognising that read lets us surface a
# normalized SkillCallEntry alongside the shell command.
_SKILL_MD_RE = re.compile(r"/skills/([^/\s\"']+)/SKILL\.md\b")


def _skill_name_from_command(command: object) -> str | None:
    """Skill name if ``command`` loads a ``…/skills/<name>/SKILL.md``, else None."""
    if command is None:
        return None
    text = command if isinstance(command, str) else json.dumps(command, default=str)
    match = _SKILL_MD_RE.search(text)
    return match.group(1) if match else None


# Codex Plan Mode emits the finalized plan inside an assistant message wrapped
# in ``<proposed_plan>...</proposed_plan>``. We synthesize an
# ``ExitPlanModeEntry`` from that marker so downstream code (PlanHandler,
# ``AgentTranscriptFile.latest_plan``, the UI "Open last plan" button) treats Codex
# plans identically to Claude's ``ExitPlanMode`` tool_use entries.
PROPOSED_PLAN_RE = re.compile(r"<proposed_plan>(.*?)</proposed_plan>", re.DOTALL)


def _codex_plan_path_for_session(session_id: str) -> str:
    """Deterministic plan-file path used by both the stream worker (writer)
    and the parser (reader). Returns empty string when ``session_id`` is empty
    so the caller can avoid emitting a bogus path.
    """
    if not session_id:
        return ""
    from flow_sdk.instance_settings import get_instance_settings

    return str(get_instance_settings().claude_plans_dir / f"codex-{session_id}.md")


class CodexLineType(StrEnum):
    THREAD_STARTED = "thread.started"
    TURN_STARTED = "turn.started"
    TURN_COMPLETED = "turn.completed"
    ITEM_STARTED = "item.started"
    ITEM_COMPLETED = "item.completed"
    SESSION_META = "session_meta"
    RESPONSE_ITEM = "response_item"
    EVENT_MSG = "event_msg"
    TURN_CONTEXT = "turn_context"
    COMPACTED = "compacted"
    TOKEN_COUNT = "token_count"
    TASK_STARTED = "task_started"
    TASK_COMPLETE = "task_complete"


class CodexResponseItemType(StrEnum):
    MESSAGE = "message"
    FUNCTION_CALL = "function_call"
    FUNCTION_CALL_OUTPUT = "function_call_output"
    CUSTOM_TOOL_CALL = "custom_tool_call"
    CUSTOM_TOOL_CALL_OUTPUT = "custom_tool_call_output"
    REASONING = "reasoning"
    WEB_SEARCH_CALL = "web_search_call"
    TOOL_SEARCH_CALL = "tool_search_call"
    TOOL_SEARCH_OUTPUT = "tool_search_output"


class CodexMessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    DEVELOPER = "developer"
    SYSTEM = "system"


def _coerce_line_type(value: object) -> CodexLineType | None:
    try:
        return CodexLineType(str(value or ""))
    except ValueError:
        return None


def _coerce_response_item_type(value: object) -> CodexResponseItemType | None:
    try:
        return CodexResponseItemType(str(value or ""))
    except ValueError:
        return None


class _CodexParserBase:
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
        # Last token_count info dict — duplicate-emission guard (old-format
        # rollouts write each token_count event twice).
        self._last_usage_info: dict | None = None
        # Previous cumulative totals — usage is billed as the increment of
        # ``total_token_usage`` between token_count events.
        self._prev_usage_totals: dict | None = None

    def _capture_common_state(self, raw: dict, rtype: CodexLineType | None) -> None:
        # Capture session id whenever it shows up.
        if rtype is CodexLineType.THREAD_STARTED:
            tid = str(raw.get("thread_id") or "")
            if tid:
                self.session_id = tid
        elif rtype is CodexLineType.SESSION_META:
            payload = raw.get("payload") or {}
            sid = str(payload.get("id") or "")
            if sid and not self.session_id:
                self.session_id = sid

        # Capture model from turn_context for downstream assistant lines.
        if rtype is CodexLineType.TURN_CONTEXT:
            payload = raw.get("payload") or {}
            m = payload.get("model")
            if m:
                self._current_model = str(m)

    def _base(self, raw: dict, rtype: str, line_index: int) -> dict[str, Any]:
        return dict(
            id=self._synth_id(raw, rtype, line_index),
            session_id=self.session_id,
            timestamp=str(raw.get("timestamp") or ""),
            worker=self.worker_type,
            parent_id=None,
        )

    def _unknown(self, raw: dict, rtype: str, line_index: int) -> list[TranscriptEntry]:
        return [UnknownEntry(raw_data=raw, **self._base(raw, rtype, line_index))]

    def _maybe_synthesize_plan_entry(
        self, text: str, base: dict
    ) -> list[TranscriptEntry]:
        """Synthesize ``ExitPlanModeEntry`` from a ``<proposed_plan>`` block.

        Codex Plan Mode finalizes the plan inside an assistant message wrapped
        in ``<proposed_plan>...</proposed_plan>``. We map that to the same
        ``ExitPlanModeEntry`` Claude's parser emits so the downstream contract
        stays uniform: ``tool_name == "ExitPlanMode"``,
        ``tool_input == {"plan": body, "planFilePath": <deterministic path>}``.

        The on-disk file is written by the Codex stream worker as soon as it
        sees the same marker; the path here is computed from ``session_id``
        with the same convention so the two agree without side-channel state.
        """
        m = PROPOSED_PLAN_RE.search(text or "")
        if not m:
            return []
        body = m.group(1).strip()
        plan_path = _codex_plan_path_for_session(self.session_id)
        use_id = f"{base['id']}:exit_plan_mode"
        return [ExitPlanModeEntry(
            tool_name="ExitPlanMode",
            tool_use_id=use_id,
            tool_input={"plan": body, "planFilePath": plan_path},
            **{**base, "id": use_id},
        )]

    # ── helpers ──────────────────────────────────────────────────────────────

    def _synth_id(self, raw: dict, rtype: str, line_index: int) -> str:
        item = raw.get("item") if rtype in (
            CodexLineType.ITEM_COMPLETED.value,
            CodexLineType.ITEM_STARTED.value,
        ) else None
        if isinstance(item, dict):
            iid = item.get("id")
            if iid:
                return str(iid)
        if rtype == CodexLineType.RESPONSE_ITEM.value:
            payload = raw.get("payload") or {}
            pid = payload.get("id") if isinstance(payload, dict) else None
            if pid:
                return str(pid)
        thread = self.session_id or "codex"
        return f"{thread}:{line_index}"

    @staticmethod
    def _join_text_blocks(
        content: Any,
        *,
        kinds: tuple[str, ...] = ("input_text", "output_text"),
        skip_angle_blocks: bool = False,
    ) -> str:
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in kinds:
                t = block.get("text")
                if t:
                    text = str(t)
                    if skip_angle_blocks and text.lstrip().startswith("<"):
                        continue
                    parts.append(text)
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

    def _emit_usage(self, payload: dict, base: dict) -> list[TranscriptEntry]:
        """Per-dim ``UsageEntry`` list + one ``CodexUsageEntry`` for cumulative totals.

        Codex packs both per-turn (``last_token_usage``) and cumulative
        (``total_token_usage``) into one ``token_count`` event. We emit
        per-dim entries from ``last`` (so cost math sees only this turn's
        spend) and one separate cumulative carrier for sanity-checking.

        Dimension semantics (validated against real rollouts and the file's
        own monotonic cumulative counter, 2026-06-12): ``input_tokens``
        INCLUDES ``cached_input_tokens`` and ``output_tokens`` INCLUDES
        ``reasoning_output_tokens`` — so billing dims are split as uncached
        input (input − cached), cache read (cached), and output (as-is, no
        separate reasoning dim).

        Which counter to bill from: old-format rollouts are unreliable on
        ``last_token_usage`` in BOTH directions — every token_count event is
        written twice (naive summing doubles every count) AND many events
        carry ``info: null`` so their per-turn delta never appears at all.
        The cumulative ``total_token_usage`` is the only complete record, so
        when it's present we bill the per-event INCREMENT of the cumulative
        counter (a drop means the counter reset — e.g. compaction — and the
        new total is the delta). ``last_token_usage`` is the fallback for
        events that carry no cumulative block.
        """
        info = payload.get("info") if isinstance(payload, dict) else None
        if not isinstance(info, dict):
            info = payload if isinstance(payload, dict) else {}
        # Duplicate-event guard: skip an event whose info is byte-identical
        # to the previous token_count (old-format double emission).
        if info and info == self._last_usage_info:
            return []
        if info:
            self._last_usage_info = info
        last = info.get("last_token_usage") or {}
        total = info.get("total_token_usage") or {}
        if not isinstance(last, dict):
            last = {}
        if not isinstance(total, dict):
            total = {}
        turn_id = info.get("turn_id")
        if not turn_id and isinstance(payload, dict):
            turn_id = payload.get("turn_id")
        turn_id_str = str(turn_id) if turn_id else None

        out: list[TranscriptEntry] = []
        base_id = base["id"]
        base_envelope = {k: v for k, v in base.items() if k != "id"}
        entry_id = f"{base_id}:usage"

        def _emit(**fields: object) -> None:
            count = fields.get("count")
            if not isinstance(count, (int, float)) or count <= 0:
                return
            dim_id = f"{base_id}:usage:dim_{len(out)}"
            out.append(UsageEntry(
                id=dim_id,
                entry_id=entry_id,
                model=self._current_model,
                **base_envelope,
                **fields,  # type: ignore[arg-type]
            ))

        if total:
            # Bill the increment of the cumulative counter (complete record).
            prev = self._prev_usage_totals or {}
            deltas: dict[str, int] = {}
            reset = any(
                (total.get(k) or 0) < (prev.get(k) or 0)
                for k in ("input_tokens", "output_tokens", "cached_input_tokens")
            )
            for k in ("input_tokens", "output_tokens", "cached_input_tokens"):
                now = total.get(k) or 0
                deltas[k] = now if reset else now - (prev.get(k) or 0)
            self._prev_usage_totals = dict(total)
            billed = deltas
        else:
            billed = last
        cached = billed.get("cached_input_tokens") or 0
        # Uncached input only — ``input_tokens`` includes the cached subset.
        _emit(count=max(0, (billed.get("input_tokens") or 0) - cached), io="input", cache="none")
        # Output as-is — already includes reasoning tokens; emitting a
        # separate reasoning dim would bill them twice.
        _emit(count=billed.get("output_tokens") or 0, io="output")
        _emit(count=cached, io="input", cache="read")

        # Cumulative totals — one carrier per token_count event, even if
        # all per-dim entries were zero. Useful for matching against
        # OpenAI's own session totals.
        if total or turn_id_str:
            out.append(CodexUsageEntry(
                id=f"{base_id}:usage:cumulative",
                entry_id=entry_id,
                model=self._current_model,
                count=0,
                io="input",
                total_input_tokens=total.get("input_tokens"),
                total_output_tokens=total.get("output_tokens"),
                turn_id=turn_id_str,
                **base_envelope,
            ))
        return out

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
            out: list[TranscriptEntry] = [
                AssistantMessageEntry(text=text, model=self._current_model, **base)
            ]
            out.extend(self._maybe_synthesize_plan_entry(text, base))
            return out
        if itype == "command_execution":
            cmd = str(item.get("command") or "")
            output = str(item.get("aggregated_output") or "")
            exit_code = item.get("exit_code")
            duration_ms = self._codex_duration_to_ms(item.get("duration"))
            tool_use_id = str(item.get("id") or base["id"])
            use_base = {**base, "id": f"{tool_use_id}:tool_use"}
            result_base = {**base, "id": f"{tool_use_id}:tool_result"}
            entries: list[TranscriptEntry] = []
            skill_name = _skill_name_from_command(cmd)
            if skill_name:
                entries.append(SkillCallEntry(
                    skill_name=skill_name,
                    invocation_kind="file_load",
                    tool_name="shell",
                    tool_use_id=f"{tool_use_id}:skill",
                    tool_input={"command": cmd},
                    **{**base, "id": f"{tool_use_id}:skill_call"},
                ))
            entries.append(ToolUseEntry(
                tool_name="shell",
                tool_use_id=tool_use_id,
                tool_input={"command": cmd},
                **use_base,
            ))
            entries.append(ToolResultEntry(
                tool_use_id=tool_use_id,
                tool_output=output,
                is_error=isinstance(exit_code, int) and exit_code != 0,
                file_path=None,
                tool_name="shell",
                duration_ms=duration_ms,
                exit_code=exit_code if isinstance(exit_code, int) else None,
                **result_base,
            ))
            return entries
        if itype == "file_change":
            return [MetaEntry(meta_kind="file_change", payload=item, **base)]
        return [UnknownEntry(raw_data=raw, **base)]

    # ── rollout response_item ──────────────────────────────────────────────

    def _parse_response_item(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        payload = raw.get("payload") or {}
        ptype = _coerce_response_item_type(payload.get("type"))
        eid = payload.get("id")
        envelope: dict[str, Any] = {}
        if eid:
            envelope["entry_id"] = str(eid)

        if ptype is CodexResponseItemType.MESSAGE:
            return self._parse_response_message(payload, base, envelope)
        if ptype is CodexResponseItemType.FUNCTION_CALL:
            tool_name = str(payload.get("name") or "")
            call_id = str(payload.get("call_id") or "")
            if call_id and tool_name:
                self._call_tool_name[call_id] = tool_name
            tool_use_id = call_id or str(eid or base["id"])
            tool_input = self._safe_json(payload.get("arguments") or {}) or {}
            out: list[TranscriptEntry] = []
            skill_name = _skill_name_from_command(tool_input)
            if skill_name:
                out.append(SkillCallEntry(
                    skill_name=skill_name,
                    invocation_kind="file_load",
                    tool_name=tool_name or "shell",
                    tool_use_id=f"{tool_use_id}:skill",
                    tool_input=tool_input if isinstance(tool_input, dict) else {},
                    **{**envelope, **base, "id": f"{base['id']}:skill_call"},
                ))
            out.append(ToolUseEntry(
                tool_name=tool_name,
                tool_use_id=tool_use_id,
                tool_input=tool_input if isinstance(tool_input, dict) else {},
                **envelope,
                **base,
            ))
            return out
        if ptype is CodexResponseItemType.FUNCTION_CALL_OUTPUT:
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
        if ptype is CodexResponseItemType.CUSTOM_TOOL_CALL:
            tool_name = str(payload.get("name") or "custom_tool")
            call_id = str(payload.get("call_id") or "")
            if call_id and tool_name:
                self._call_tool_name[call_id] = tool_name
            tool_use_id = call_id or str(eid or base["id"])
            raw_input = payload.get("input") or payload.get("arguments") or ""

            # apply_patch decomposes into one File*Entry per file op so
            # downstream consumers can isinstance-check uniformly with Claude's
            # native Write/Edit. Delete ops have no FileDeleteEntry — skipped.
            if tool_name == "apply_patch" and isinstance(raw_input, str) and raw_input:
                file_entries: list[TranscriptEntry] = []
                for op in parse_apply_patch(raw_input):
                    if op.op == "add":
                        content = add_op_to_content(op)
                        trailing = 0 if not content or content.endswith("\n") else 1
                        file_entries.append(FileWriteEntry(
                            path=op.path,
                            content=content,
                            bytes_count=len(content.encode("utf-8")),
                            line_count=content.count("\n") + trailing,
                            is_new=True,
                            tool_name="apply_patch",
                            tool_use_id=tool_use_id,
                            **envelope, **base,
                        ))
                    elif op.op == "update":
                        file_entries.append(FileEditEntry(
                            path=op.path,
                            hunks=update_op_to_hunks(op),
                            tool_name="apply_patch",
                            tool_use_id=tool_use_id,
                            **envelope, **base,
                        ))
                if file_entries:
                    return file_entries
                # Zero parseable ops → fall through to generic ToolUseEntry.

            return [ToolUseEntry(
                tool_name=tool_name,
                tool_use_id=tool_use_id,
                tool_input=self._safe_json(raw_input or {}) or {},
                **envelope,
                **base,
            )]
        if ptype is CodexResponseItemType.CUSTOM_TOOL_CALL_OUTPUT:
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
        if ptype is CodexResponseItemType.REASONING:
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
        if ptype is CodexResponseItemType.WEB_SEARCH_CALL:
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
        if ptype is CodexResponseItemType.TOOL_SEARCH_CALL:
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
        if ptype is CodexResponseItemType.TOOL_SEARCH_OUTPUT:
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
            meta_kind=f"response_item:{payload.get('type') or ''}",
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
        role_raw = str(payload.get("role") or "")
        try:
            role = CodexMessageRole(role_raw)
        except ValueError:
            role = None
        content = payload.get("content") or []
        if role is CodexMessageRole.USER:
            text = self._join_text_blocks(
                content,
                kinds=("input_text",),
                skip_angle_blocks=True,
            ).strip()
            return [UserMessageEntry(
                text=text,
                role=CodexMessageRole.USER.value,
                **envelope,
                **base,
            )]
        if role is CodexMessageRole.ASSISTANT:
            text = self._join_text_blocks(content, kinds=("output_text",)).strip()
            phase = payload.get("phase")
            out: list[TranscriptEntry] = [AssistantMessageEntry(
                text=text,
                phase=str(phase) if phase else None,
                model=self._current_model,
                **envelope,
                **base,
            )]
            out.extend(self._maybe_synthesize_plan_entry(text, base))
            return out
        if role in (CodexMessageRole.DEVELOPER, CodexMessageRole.SYSTEM):
            return [SystemEntry(
                subtype=f"{role.value}_message",
                payload=payload,
                **envelope,
                **base,
            )]
        return [MetaEntry(
            meta_kind=f"response_item:message:{role_raw}",
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
            return self._emit_usage(payload, base)
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


class CodexStreamParser(_CodexParserBase):
    """Parser for process-local ``codex exec --json`` stream transcripts."""

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        rtype_raw = str(raw.get("type") or "")
        rtype = _coerce_line_type(rtype_raw)
        self._capture_common_state(raw, rtype)
        base = self._base(raw, rtype_raw, line_index)

        if rtype in {
            CodexLineType.THREAD_STARTED,
            CodexLineType.TURN_STARTED,
            CodexLineType.TURN_COMPLETED,
        }:
            return [SystemEntry(subtype=rtype.value, payload=raw, **base)]
        if rtype is CodexLineType.ITEM_STARTED:
            item = raw.get("item") or {}
            return [MetaEntry(meta_kind=CodexLineType.ITEM_STARTED.value, payload=item, **base)]
        if rtype is CodexLineType.ITEM_COMPLETED:
            return self._parse_item_completed(raw, base)
        return [UnknownEntry(raw_data=raw, **base)]


class CodexRolloutParser(_CodexParserBase):
    """Parser for Codex rollout JSONL under ``~/.codex/sessions``."""

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        rtype_raw = str(raw.get("type") or "")
        rtype = _coerce_line_type(rtype_raw)
        self._capture_common_state(raw, rtype)
        base = self._base(raw, rtype_raw, line_index)

        if rtype is CodexLineType.SESSION_META:
            return [MetaEntry(
                meta_kind=CodexLineType.SESSION_META.value,
                payload=raw.get("payload") or {},
                **base,
            )]
        if rtype is CodexLineType.RESPONSE_ITEM:
            return self._parse_response_item(raw, base)
        if rtype is CodexLineType.EVENT_MSG:
            return self._parse_event_msg(raw, base)
        if rtype is CodexLineType.TURN_CONTEXT:
            return [SystemEntry(
                subtype=CodexLineType.TURN_CONTEXT.value,
                payload=raw.get("payload") or raw,
                **base,
            )]
        if rtype is CodexLineType.COMPACTED:
            return self._parse_compacted(raw, base)
        if rtype is CodexLineType.TOKEN_COUNT:
            payload = raw.get("payload") or raw
            return self._emit_usage(payload, base)
        if rtype in {CodexLineType.TASK_STARTED, CodexLineType.TASK_COMPLETE}:
            return [SystemEntry(
                subtype=rtype.value,
                payload=raw.get("payload") or raw,
                **base,
            )]
        return [UnknownEntry(raw_data=raw, **base)]


class CodexParser:
    """Backwards-compatible Codex parser that auto-detects the JSONL shape."""

    worker_type = "codex"

    def __init__(self, session_id: str = "") -> None:
        self.session_id = session_id
        self._delegate: _CodexParserBase | None = None

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        if self._delegate is None:
            self._delegate = self._select_delegate(raw)
        entries = self._delegate.feed(raw, line_index)
        self.session_id = self._delegate.session_id
        return entries

    def _select_delegate(self, raw: dict) -> _CodexParserBase:
        rtype = _coerce_line_type(raw.get("type"))
        if rtype in {
            CodexLineType.THREAD_STARTED,
            CodexLineType.TURN_STARTED,
            CodexLineType.TURN_COMPLETED,
            CodexLineType.ITEM_STARTED,
            CodexLineType.ITEM_COMPLETED,
        }:
            return CodexStreamParser(session_id=self.session_id)
        if rtype in {
            CodexLineType.SESSION_META,
            CodexLineType.RESPONSE_ITEM,
            CodexLineType.EVENT_MSG,
            CodexLineType.TURN_CONTEXT,
            CodexLineType.COMPACTED,
            CodexLineType.TOKEN_COUNT,
            CodexLineType.TASK_STARTED,
            CodexLineType.TASK_COMPLETE,
        }:
            return CodexRolloutParser(session_id=self.session_id)
        return CodexRolloutParser(session_id=self.session_id)
