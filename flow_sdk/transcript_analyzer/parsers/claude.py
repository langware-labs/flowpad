"""Claude Code transcript JSONL parser.

Line-stateless: every Claude entry carries ``sessionId`` per-line, so no
cross-line state is needed. The dispatcher branches on the raw ``type``
discriminator and (for ``assistant``/``user``) on the inner content blocks.
"""

from __future__ import annotations

from typing import Any

from .._helpers import (
    extract_text,
    extract_thinking,
    first_block_of_type,
    flatten_tool_result,
    truncate_file_content,
)
from ..entries import (
    AgentSpawnEntry,
    AssistantMessageEntry,
    CompactionEntry,
    ExitPlanModeEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    MetaEntry,
    SearchEntry,
    ShellCommandEntry,
    SkillCallEntry,
    SummaryEntry,
    SystemEntry,
    TodoUpdateEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UsageEntry,
    UserMessageEntry,
    WebFetchEntry,
)
from ..entry import TranscriptEntry

# Per-type uid fallback — mirrors `uid_mapping` ClassVar in
# ``flow_sdk/fs_records/claude/transcript_records/*``. Lines with no
# ``uuid`` (file-history-snapshot, summary, queue-operation, custom-title,
# pr-link) fall back to one of these dot-paths.
_UID_FALLBACK_BY_TYPE: dict[str, str] = {
    "file-history-snapshot": "messageId",
    "summary": "leafUuid",
    "queue-operation": "sessionId",
    "custom-title": "sessionId",
    "pr-link": "sessionId",
}

# Recognized Claude line types that carry no chat content — they map to
# ``MetaEntry`` so they don't pollute the "unknown" warnings stream.
_META_TYPES = frozenset({
    "file-history-snapshot",
    "queue-operation",
    "custom-title",
    "ai-title",
    "pr-link",
    "attachment",
    "permission-mode",
    "last-prompt",
    "custom-title",
    # Newer Claude Code session-envelope lines (no chat content).
    "mode",
    "agent-name",
    "bridge-session",
})

_ATTACHMENT_TYPE_PLAN_MODE_EXIT = "plan_mode_exit"


def _is_flowpad_prompt_envelope(text: str) -> bool:
    """True for Flowpad-composed embedded-agent prompt wrappers.

    Headless Claude receives embedded agents by flattening their instructions
    into the user prompt, then appending the real user text under
    ``# User message``. Claude writes that full wrapper to its JSONL as a user
    message, but it is framework context rather than a human chat turn.
    """
    if "\n# User message\n" not in text:
        return False
    return (
        text.startswith("# You are the '")
        or text.startswith("# Embedded agent specs")
    )


def _resolve_id(raw: dict) -> str:
    """Pick the most stable id for this raw line, with type-specific fallback."""
    uid = raw.get("uuid")
    if uid:
        return str(uid)
    fallback_path = _UID_FALLBACK_BY_TYPE.get(raw.get("type") or "", "")
    if fallback_path:
        return str(raw.get(fallback_path) or "")
    return ""


class ClaudeParser:
    worker_type = "claude"

    def __init__(self, session_id: str = "") -> None:
        self.session_id = session_id
        # Per-message usage dedup, KEEP-LAST. Claude Code writes an assistant
        # message multiple times in the JSONL as it streams (streaming snapshots
        # + finalized snapshot all share message.id). cache_read/input/
        # cache_creation are constant across snapshots, but ``output_tokens``
        # GROWS — only the final snapshot carries the true (billed) output.
        # Keeping the FIRST snapshot under-counts output (partial, sometimes 0);
        # summing ALL over-counts. So on a repeated message.id we zero the
        # superseded entries and re-emit from the latest snapshot — matching
        # what Anthropic bills (and ccusage). ``_usage_entries_by_msg_id`` holds
        # the live entry objects so a later snapshot can null them in place.
        self._usage_entries_by_msg_id: dict[str, list[UsageEntry]] = {}

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        rtype = raw.get("type") or ""
        # Cache session_id from the first line that carries one.
        line_session_id = str(raw.get("sessionId") or "")
        if line_session_id and not self.session_id:
            self.session_id = line_session_id

        base = dict(
            id=_resolve_id(raw) or f"{self.session_id or 'claude'}:{line_index}",
            session_id=line_session_id or self.session_id,
            timestamp=str(raw.get("timestamp") or ""),
            worker=self.worker_type,
            parent_id=str(raw.get("parentUuid") or "") or None,
            is_sidechain=bool(raw.get("isSidechain", False)),
            attribution_skill=str(raw.get("attributionSkill") or "") or None,
        )

        # Compaction boundary — the summary that survives a context reset.
        # Claude flags it with ``isCompactSummary`` (on a user/assistant line);
        # a manual ``/compact`` slash command is the trigger vs auto.
        if raw.get("isCompactSummary"):
            message = raw.get("message") or {}
            text = extract_text(message.get("content") or [])
            return [CompactionEntry(
                trigger="manual" if "/compact" in text else "auto",
                summary_preview=text[:500],
                **base,
            )]

        if rtype == "assistant":
            return self._parse_assistant(raw, base)
        if rtype == "user":
            return [self._parse_user(raw, base)]
        if rtype == "system":
            return [SystemEntry(
                subtype=str(raw.get("subtype") or ""),
                payload={k: v for k, v in raw.items() if k not in {
                    "type", "subtype", "uuid", "parentUuid", "sessionId",
                    "timestamp", "cwd", "version", "gitBranch", "userType",
                    "isSidechain", "message",
                }},
                **base,
            )]
        if rtype == "progress":
            data = raw.get("data") or {}
            return [SystemEntry(
                subtype=str(data.get("type") or "progress"),
                payload=data,
                **base,
            )]
        if rtype == "summary":
            return [SummaryEntry(
                summary_text=str(raw.get("summary") or ""),
                **base,
            )]
        if rtype == "attachment":
            att = raw.get("attachment")
            if isinstance(att, dict) and att.get("type") == _ATTACHMENT_TYPE_PLAN_MODE_EXIT:
                plan_file_path = str(att.get("planFilePath") or "")
                if plan_file_path:
                    return [ExitPlanModeEntry(
                        tool_name="ExitPlanMode",
                        tool_use_id=base["id"],
                        tool_input={"plan": "", "planFilePath": plan_file_path},
                        **base,
                    )]
        if rtype in _META_TYPES:
            return [MetaEntry(meta_kind=rtype, payload=raw, **base)]
        return [UnknownEntry(raw_data=raw, **base)]

    # ── assistant / user dispatchers ─────────────────────────────────────────

    def _parse_assistant(self, raw: dict, base: dict) -> list[TranscriptEntry]:
        message = raw.get("message") or {}
        content = message.get("content") or []
        msg_id = str(message.get("id") or "") or None
        model = str(message.get("model") or "") or None
        envelope: dict[str, str] = {}
        if msg_id:
            envelope["entry_id"] = msg_id

        tool_block = first_block_of_type(content, "tool_use")
        if tool_block:
            tool_name = str(tool_block.get("name") or "")
            tool_use_id = str(tool_block.get("id") or "")
            tool_input = tool_block.get("input") or {}
            main = self._build_semantic_tool_entry(
                tool_name=tool_name,
                tool_use_id=tool_use_id,
                tool_input=tool_input,
                envelope=envelope,
                base=base,
            )
        else:
            text = extract_text(content)
            thinking = extract_thinking(content)
            main = AssistantMessageEntry(
                text=text,
                thinking=thinking,
                model=model,
                **envelope,
                **base,
            )

        out: list[TranscriptEntry] = [main]
        out.extend(self._emit_usage(message, base, model=model))
        return out

    def _emit_usage(
        self,
        message: dict,
        base: dict,
        *,
        model: str | None,
    ) -> list[UsageEntry]:
        """One ``UsageEntry`` per nonzero chargeable stream from ``message.usage``.

        Splits Claude's flat ``usage`` dict into per-dimension entries so
        each one matches a single ``pricing.ItemPrice`` rule (1.25× 5m
        cache write, 2× 1h cache write, 0.1× cache read, etc). Zero-token
        streams are skipped — they don't contribute cost and clutter
        downstream iteration.
        """
        usage = message.get("usage")
        if not isinstance(usage, dict):
            return []
        # Keep-last dedup by message.id (see note in __init__). A repeated
        # message.id is a later streaming snapshot of the same billed message —
        # null the earlier snapshot's entries (count=0, so they cost nothing and
        # add no tokens) and re-emit from this, the latest, snapshot.
        msg_id = str(message.get("id") or "") or None
        if msg_id and msg_id in self._usage_entries_by_msg_id:
            for prior in self._usage_entries_by_msg_id[msg_id]:
                prior.count = 0
        out: list[UsageEntry] = []
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
                model=model,
                **base_envelope,
                **fields,  # type: ignore[arg-type]
            ))

        # Bare input (NOT in cache) — the prefix the model actually had to
        # process this turn.
        _emit(count=usage.get("input_tokens") or 0, io="input", cache="none")
        # Output.
        _emit(count=usage.get("output_tokens") or 0, io="output")
        # Cache read — pre-cached prefix served at 0.1× input price.
        _emit(
            count=usage.get("cache_read_input_tokens") or 0,
            io="input",
            cache="read",
        )
        # Cache writes — disaggregated by tier (5-min default vs 1-hour
        # opt-in). Claude exposes both nested under ``cache_creation`` AND
        # the legacy ``cache_creation_input_tokens`` flat total. Prefer the
        # nested per-tier breakdown when present so we can apply the right
        # price multiplier (1.25× for 5m, 2× for 1h).
        ce = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else None
        if ce:
            _emit(
                count=ce.get("ephemeral_5m_input_tokens") or 0,
                io="input", cache="write", cache_tier="5m",
            )
            _emit(
                count=ce.get("ephemeral_1h_input_tokens") or 0,
                io="input", cache="write", cache_tier="1h",
            )
        else:
            # No tier breakdown — fall back to the flat total and assume 5m
            # (the API default when ``cache_control`` doesn't specify TTL).
            _emit(
                count=usage.get("cache_creation_input_tokens") or 0,
                io="input", cache="write", cache_tier="5m",
            )
        # Server-tool usage — billed per-request, not per-token. The unit
        # change tells the price table to use the per-request rate.
        stu = usage.get("server_tool_use") if isinstance(usage.get("server_tool_use"), dict) else None
        if stu:
            _emit(
                count=stu.get("web_search_requests") or 0,
                io="input", unit="request", tool="web_search",
            )
            _emit(
                count=stu.get("web_fetch_requests") or 0,
                io="input", unit="request", tool="web_fetch",
            )
        if msg_id is not None:
            self._usage_entries_by_msg_id[msg_id] = out
        return out

    def _build_semantic_tool_entry(
        self,
        *,
        tool_name: str,
        tool_use_id: str,
        tool_input: dict,
        envelope: dict,
        base: dict,
    ) -> TranscriptEntry:
        """Map a Claude ``tool_use`` block onto a semantic entry kind.

        Falls through to :class:`ToolUseEntry` for any tool not in the
        recognized set — this keeps MCP tools (``mcp__*``) and unknown
        bespoke tools rendering as the generic catch-all rather than
        silently dropping fields.
        """
        common: dict[str, Any] = {
            "tool_name": tool_name,
            "tool_use_id": tool_use_id,
            **envelope,
            **base,
        }
        ti = tool_input if isinstance(tool_input, dict) else {}

        if tool_name == "Skill":
            return SkillCallEntry(
                skill_name=str(ti.get("skill") or ti.get("name") or ti.get("command") or ""),
                tool_input=ti,
                **common,
            )
        if tool_name == "ExitPlanMode":
            return ExitPlanModeEntry(tool_input=ti, **common)
        if tool_name == "Write":
            full_content = ti.get("content")
            full_str = str(full_content) if full_content is not None else None
            line_count = full_str.count("\n") + 1 if full_str else None
            bytes_count = len(full_str.encode("utf-8")) if full_str else None
            return FileWriteEntry(
                path=str(ti.get("file_path") or ""),
                content=truncate_file_content(full_str),
                bytes_count=bytes_count,
                line_count=line_count,
                is_new=True,
                **common,
            )
        if tool_name in ("Edit", "MultiEdit"):
            hunks: list[dict] = []
            if tool_name == "Edit":
                if ti.get("old_string") is not None or ti.get("new_string") is not None:
                    hunks.append({
                        "old": str(ti.get("old_string") or ""),
                        "new": str(ti.get("new_string") or ""),
                        "replace_all": bool(ti.get("replace_all", False)),
                    })
            else:
                edits = ti.get("edits") or []
                if isinstance(edits, list):
                    for ed in edits:
                        if isinstance(ed, dict):
                            hunks.append({
                                "old": str(ed.get("old_string") or ""),
                                "new": str(ed.get("new_string") or ""),
                                "replace_all": bool(ed.get("replace_all", False)),
                            })
            return FileEditEntry(
                path=str(ti.get("file_path") or ""),
                hunks=hunks,
                **common,
            )
        if tool_name == "NotebookEdit":
            return FileEditEntry(
                path=str(ti.get("notebook_path") or ti.get("file_path") or ""),
                hunks=[],
                change_summary=str(ti.get("new_source") or "") or None,
                **common,
            )
        if tool_name in ("Read", "NotebookRead"):
            offset = ti.get("offset")
            limit = ti.get("limit")
            start_line = int(offset) if isinstance(offset, (int, float)) else None
            end_line: int | None = None
            if start_line is not None and isinstance(limit, (int, float)):
                end_line = start_line + int(limit)
            return FileReadEntry(
                path=str(ti.get("file_path") or ti.get("notebook_path") or ""),
                start_line=start_line,
                end_line=end_line,
                **common,
            )
        if tool_name == "Bash":
            timeout_raw = ti.get("timeout")
            timeout_val = int(timeout_raw) if isinstance(timeout_raw, (int, float)) else None
            return ShellCommandEntry(
                command=str(ti.get("command") or ""),
                timeout=timeout_val,
                **common,
            )
        if tool_name in ("Glob", "Grep"):
            return SearchEntry(
                search_kind=tool_name.lower(),
                query=str(ti.get("pattern") or ""),
                path=str(ti.get("path") or "") or None,
                **common,
            )
        if tool_name in ("WebFetch", "WebSearch"):
            return WebFetchEntry(
                url=str(ti.get("url") or "") or None,
                query=str(ti.get("query") or "") or None,
                prompt=str(ti.get("prompt") or "") or None,
                **common,
            )
        if tool_name == "TodoWrite":
            todos_raw = ti.get("todos")
            items = todos_raw if isinstance(todos_raw, list) else []
            return TodoUpdateEntry(
                items=items,
                **common,
            )
        if tool_name in ("Task", "Agent"):
            return AgentSpawnEntry(
                agent_type=str(ti.get("subagent_type") or ti.get("agent_type") or ""),
                prompt=str(ti.get("prompt") or "") or None,
                description=str(ti.get("description") or "") or None,
                **common,
            )
        return ToolUseEntry(tool_input=ti, **common)

    def _parse_user(self, raw: dict, base: dict) -> TranscriptEntry:
        message = raw.get("message") or {}
        content = message.get("content") or []
        result_block = first_block_of_type(content, "tool_result")
        if result_block:
            tool_use_result = raw.get("toolUseResult") or {}
            tur = tool_use_result if isinstance(tool_use_result, dict) else {}
            file_path = tur.get("filePath")
            # Claude carries ``durationMs`` on grep-style results and
            # ``totalDuration`` (rare) on others. Use whichever exists.
            duration_ms_raw = tur.get("durationMs")
            if duration_ms_raw is None:
                duration_ms_raw = tur.get("totalDuration")
            duration_ms: int | None = None
            if isinstance(duration_ms_raw, (int, float)):
                duration_ms = int(round(duration_ms_raw))
            # ``exitCode`` is rare in claude bash results in practice but
            # supported for forward-compat.
            exit_code_raw = tur.get("exitCode")
            exit_code: int | None = None
            if isinstance(exit_code_raw, int):
                exit_code = exit_code_raw
            return ToolResultEntry(
                tool_use_id=str(result_block.get("tool_use_id") or ""),
                tool_output=flatten_tool_result(result_block.get("content")),
                is_error=bool(result_block.get("is_error", False)),
                file_path=str(file_path) if file_path else None,
                duration_ms=duration_ms,
                exit_code=exit_code,
                **base,
            )
        text = extract_text(content)
        return UserMessageEntry(
            text=text,
            is_meta=bool(raw.get("isMeta", False)) or _is_flowpad_prompt_envelope(text),
            **base,
        )
