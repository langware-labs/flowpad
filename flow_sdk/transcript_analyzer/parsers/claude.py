"""Claude Code transcript JSONL parser.

Line-stateless: every Claude entry carries ``sessionId`` per-line, so no
cross-line state is needed. The dispatcher branches on the raw ``type``
discriminator and (for ``assistant``/``user``) on the inner content blocks.
"""

from __future__ import annotations

from .._helpers import (
    extract_text,
    extract_thinking,
    first_block_of_type,
    flatten_tool_result,
)
from ..entries import (
    AssistantMessageEntry,
    ExitPlanModeEntry,
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
})


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
        )

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
            tool_kwargs = dict(
                tool_name=tool_name,
                tool_use_id=str(tool_block.get("id") or ""),
                tool_input=tool_block.get("input") or {},
                **envelope,
                **base,
            )
            if tool_name == "ExitPlanMode":
                main: TranscriptEntry = ExitPlanModeEntry(**tool_kwargs)
            else:
                main = ToolUseEntry(**tool_kwargs)
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
        usage_entry = self._maybe_token_usage(message, base, model=model)
        if usage_entry is not None:
            out.append(usage_entry)
        return out

    def _maybe_token_usage(
        self,
        message: dict,
        base: dict,
        *,
        model: str | None,
    ) -> TokenUsageEntry | None:
        usage = message.get("usage")
        if not isinstance(usage, dict):
            return None
        # Cached input may be reported as either ``cache_read_input_tokens``
        # (read hit) or ``cache_creation_input_tokens`` (write). Prefer the
        # read count when both are present (more meaningful for cost).
        cached = usage.get("cache_read_input_tokens")
        if cached is None:
            cached = usage.get("cache_creation_input_tokens")
        usage_base = {**base, "id": f"{base['id']}:usage"}
        return TokenUsageEntry(
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            cached_input_tokens=cached,
            model=model,
            **usage_base,
        )

    def _parse_user(self, raw: dict, base: dict) -> TranscriptEntry:
        message = raw.get("message") or {}
        content = message.get("content") or []
        result_block = first_block_of_type(content, "tool_result")
        if result_block:
            tool_use_result = raw.get("toolUseResult") or {}
            file_path = tool_use_result.get("filePath") if isinstance(tool_use_result, dict) else None
            return ToolResultEntry(
                tool_use_id=str(result_block.get("tool_use_id") or ""),
                tool_output=flatten_tool_result(result_block.get("content")),
                is_error=bool(result_block.get("is_error", False)),
                file_path=str(file_path) if file_path else None,
                **base,
            )
        return UserMessageEntry(text=extract_text(content), **base)
