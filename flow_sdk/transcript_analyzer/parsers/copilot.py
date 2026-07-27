"""GitHub Copilot CLI JSONL transcript parser."""

from __future__ import annotations

import json
from typing import Any

from ..entries import (
    AssistantMessageEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    MetaEntry,
    ShellCommandEntry,
    SkillCallEntry,
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UserMessageEntry,
)
from .._helpers import truncate_file_content
from ..derive import SHELL_TOOL_NAMES
from ..entries.usage import UsageEntry
from ..entry import TranscriptEntry


def _file_path(ti: dict) -> str:
    for key in ("file_path", "path", "filePath", "filename"):
        val = ti.get(key)
        if isinstance(val, str) and val:
            return val
    return ""


def _tool_or_skill_entry(*, tool_name: str, tool_use_id: str, tool_input: dict, **base: Any) -> TranscriptEntry:
    """Map a Copilot tool use onto a semantic entry kind.

    Copilot names its file tools differently from Claude and does not publish a
    stable list, so file ops are recognized by their *input shape* rather than
    by name — a path plus content is a write, a path plus an old/new pair is an
    edit, a bare path on a read-ish tool is a read. MCP tools (``mcp__*``) are
    excluded: their inputs are arbitrary and a coincidental ``path`` key must
    not masquerade as a file op. Everything unrecognized stays a generic
    :class:`ToolUseEntry`, exactly as before.
    """
    ti = tool_input if isinstance(tool_input, dict) else {}
    name = str(tool_name)
    lower = name.lower()
    common: dict[str, Any] = {"tool_name": name, "tool_use_id": tool_use_id, **base}

    if lower == "skill":
        return SkillCallEntry(
            skill_name=str(ti.get("skill") or ti.get("name") or ""),
            tool_input=ti,
            **common,
        )
    if lower in SHELL_TOOL_NAMES and isinstance(ti.get("command"), str):
        return ShellCommandEntry(command=str(ti.get("command") or ""), **common)

    generic = ToolUseEntry(tool_input=ti, **common)
    # One rule per guard, all at one indent: which shape won is otherwise
    # invisible under four levels of nesting.
    if lower.startswith("mcp__"):
        return generic
    path = _file_path(ti)
    if not path:
        return generic

    old = ti.get("old_string", ti.get("old_str"))
    new = ti.get("new_string", ti.get("new_str"))
    if old is not None or new is not None:
        return FileEditEntry(
            path=path,
            hunks=[{"old": str(old or ""), "new": str(new or ""), "replace_all": False}],
            **common,
        )
    content = ti.get("content", ti.get("file_text"))
    if isinstance(content, str):
        return FileWriteEntry(
            path=path,
            # Truncated like every other worker's write entry — retaining full
            # file bodies here is what makes one worker's transcript balloon.
            content=truncate_file_content(content),
            line_count=content.count("\n") + 1 if content else None,
            bytes_count=len(content.encode("utf-8")) if content else None,
            **common,
        )
    if any(tok in lower for tok in ("read", "view", "open", "cat")):
        return FileReadEntry(path=path, **common)
    return generic


class CopilotParser:
    worker_type = "copilot"

    def __init__(self, session_id: str = "") -> None:
        self.session_id = session_id
        self._current_model: str | None = None
        self._tool_names: dict[str, str] = {}
        self._seen_tool_uses: set[str] = set()

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        event_type = str(raw.get("type") or "")
        self._capture_common_state(raw)

        if event_type == "session.start":
            data = _data(raw)
            context = data.get("context") if isinstance(data.get("context"), dict) else {}
            payload = {
                "id": self.session_id,
                "cwd": context.get("cwd"),
                "cli_version": data.get("copilotVersion"),
                "originator": data.get("producer"),
                "model_provider": "github-copilot",
            }
            return [MetaEntry(meta_kind="session_meta", payload=payload, **self._base(raw, line_index))]

        if event_type.startswith("session."):
            return [MetaEntry(meta_kind=event_type, payload=_data(raw), **self._base(raw, line_index))]

        if event_type == "system.message":
            data = _data(raw)
            return [
                SystemEntry(
                    subtype=event_type,
                    payload={"role": data.get("role"), "content": data.get("content")},
                    **self._base(raw, line_index),
                )
            ]

        if event_type == "user.message":
            data = _data(raw)
            # Copilot's stdin transport records the line terminator used to
            # submit the prompt as part of ``data.content``. It is transport
            # framing, not user text. Remove exactly one terminator (preserving
            # any additional intentional trailing newlines) so normalized
            # prompts match the text supplied to Flowpad.
            text = _strip_stdin_line_ending(str(data.get("content") or ""))
            return [UserMessageEntry(text=text, **self._base(raw, line_index))]

        if event_type in {"assistant.turn_start", "assistant.turn_end"}:
            return [SystemEntry(subtype=event_type, payload=_data(raw), **self._base(raw, line_index))]

        if event_type == "assistant.reasoning":
            data = _data(raw)
            thinking = str(data.get("content") or "")
            if not thinking:
                return [MetaEntry(meta_kind=event_type, payload=data, **self._base(raw, line_index))]
            reasoning_id = str(data.get("reasoningId") or raw.get("id") or "")
            return [
                AssistantMessageEntry(
                    text="",
                    thinking=thinking,
                    entry_id=reasoning_id or None,
                    model=self._current_model,
                    **self._base(raw, line_index),
                )
            ]

        if event_type in {"assistant.reasoning_delta", "assistant.message_start", "assistant.message_delta"}:
            return [MetaEntry(meta_kind=event_type, payload=_data(raw), **self._base(raw, line_index))]

        if event_type == "assistant.message":
            return self._assistant_message(raw, line_index)

        if event_type == "tool.execution_start":
            return self._tool_execution_start(raw, line_index)

        if event_type == "tool.execution_complete":
            return self._tool_execution_complete(raw, line_index)

        if event_type == "result":
            return [SystemEntry(subtype="result", payload=raw, **self._base(raw, line_index))]

        if event_type in {"flowpad.interrupted", "flowpad.error"}:
            return [SystemEntry(subtype=event_type, payload=raw, **self._base(raw, line_index))]

        return [MetaEntry(meta_kind=event_type or "unknown", payload=raw, **self._base(raw, line_index))]

    def _assistant_message(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        data = _data(raw)
        model = data.get("model")
        if model:
            self._current_model = str(model)
        base = self._base(raw, line_index)
        out: list[TranscriptEntry] = []

        content = str(data.get("content") or "")
        message_id = str(data.get("messageId") or raw.get("id") or "")
        if content:
            out.append(
                AssistantMessageEntry(
                    text=content,
                    entry_id=message_id or None,
                    model=self._current_model,
                    **base,
                )
            )

        # Copilot only reports ``outputTokens`` per assistant message (no
        # input/cache/reasoning breakdown in the transcript). Emit the one
        # dim it does carry so ProcessCounters folds it like any other worker.
        out.extend(self._emit_usage(data, message_id, base))

        tool_requests = data.get("toolRequests")
        if isinstance(tool_requests, list):
            for idx, request in enumerate(tool_requests):
                if not isinstance(request, dict):
                    continue
                call_id = str(request.get("toolCallId") or request.get("id") or "")
                name = str(request.get("name") or request.get("toolName") or "tool")
                if call_id:
                    self._tool_names[call_id] = name
                    self._seen_tool_uses.add(call_id)
                out.append(
                    _tool_or_skill_entry(
                        tool_name=name,
                        tool_use_id=call_id or f"{base['id']}:tool:{idx}",
                        tool_input=_coerce_arguments(request.get("arguments")),
                        id=f"{base['id']}:tool_use:{idx}",
                        session_id=base["session_id"],
                        timestamp=base["timestamp"],
                        worker=base["worker"],
                        parent_id=base["parent_id"],
                        model=self._current_model,
                    )
                )
        if out:
            return out
        return [MetaEntry(meta_kind="assistant.message", payload=data, **base)]

    def _emit_usage(self, data: dict, message_id: str, base: dict) -> list[TranscriptEntry]:
        """One ``io=output`` UsageEntry from ``data.outputTokens`` (>0 only).

        Copilot exposes no input/cache/reasoning token counts, so output is
        the sole chargeable dim we can fold. ``entry_id = <messageId>:usage``
        mirrors the Claude/Codex convention; ``id`` is suffixed for uniqueness.
        """
        out_toks = _as_int(data.get("outputTokens"))
        if not out_toks or out_toks <= 0:
            return []
        return [
            UsageEntry(
                count=out_toks,
                io="output",
                unit="token",
                id=f"{base['id']}:usage",
                entry_id=f"{message_id}:usage" if message_id else None,
                session_id=base["session_id"],
                timestamp=base["timestamp"],
                worker=base["worker"],
                parent_id=base["parent_id"],
                model=self._current_model,
            )
        ]

    def _tool_execution_start(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        data = _data(raw)
        call_id = str(data.get("toolCallId") or "")
        name = str(data.get("toolName") or "tool")
        if data.get("model"):
            self._current_model = str(data.get("model"))
        if call_id:
            self._tool_names[call_id] = name
        base = self._base(raw, line_index)
        if call_id and call_id in self._seen_tool_uses:
            return [MetaEntry(meta_kind="tool.execution_start", payload=data, **base)]
        if call_id:
            self._seen_tool_uses.add(call_id)
        return [
            _tool_or_skill_entry(
                tool_name=name,
                tool_use_id=call_id or base["id"],
                tool_input=_coerce_arguments(data.get("arguments")),
                model=self._current_model,
                **base,
            )
        ]

    def _tool_execution_complete(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        data = _data(raw)
        call_id = str(data.get("toolCallId") or "")
        if data.get("model"):
            self._current_model = str(data.get("model"))
        result = data.get("result") if isinstance(data.get("result"), dict) else {}
        telemetry = data.get("toolTelemetry") if isinstance(data.get("toolTelemetry"), dict) else {}
        metrics = telemetry.get("metrics") if isinstance(telemetry.get("metrics"), dict) else {}
        exit_code = _as_int(metrics.get("exit_code"))
        output = result.get("detailedContent") or result.get("content") or ""
        is_error = (data.get("success") is False) or (exit_code not in (None, 0))
        return [
            ToolResultEntry(
                tool_use_id=call_id,
                tool_name=self._tool_names.get(call_id),
                tool_output=str(output),
                is_error=is_error,
                exit_code=exit_code,
                model=self._current_model,
                **self._base(raw, line_index),
            )
        ]

    def _capture_common_state(self, raw: dict) -> None:
        event_type = str(raw.get("type") or "")
        if event_type == "result" and raw.get("sessionId"):
            self.session_id = str(raw["sessionId"])
        data = _data(raw)
        sid = data.get("sessionId")
        if sid and not self.session_id:
            self.session_id = str(sid)
        context = data.get("context") if isinstance(data.get("context"), dict) else {}
        if context.get("sessionId") and not self.session_id:
            self.session_id = str(context["sessionId"])
        if event_type == "session.model_change" and data.get("newModel"):
            self._current_model = str(data["newModel"])
        if event_type == "session.tools_updated" and data.get("model"):
            self._current_model = str(data["model"])
        if event_type == "session.shutdown" and raw.get("currentModel"):
            self._current_model = str(raw["currentModel"])

    def _base(self, raw: dict, line_index: int) -> dict[str, Any]:
        return {
            "id": self._synth_id(raw, line_index),
            "session_id": self.session_id,
            "timestamp": str(raw.get("timestamp") or ""),
            "worker": self.worker_type,
            "parent_id": raw.get("parentId"),
        }

    def _synth_id(self, raw: dict, line_index: int) -> str:
        value = raw.get("id")
        if value:
            return str(value)
        return f"{self.session_id or 'copilot'}:{line_index}"


class CopilotStreamParser(CopilotParser):
    """Parser for process-local Copilot stdout JSONL."""


class CopilotEventsParser(CopilotParser):
    """Parser for ``~/.copilot/session-state/<id>/events.jsonl``."""


def _data(raw: dict) -> dict[str, Any]:
    data = raw.get("data")
    return data if isinstance(data, dict) else {}


def _strip_stdin_line_ending(text: str) -> str:
    if text.endswith("\r\n"):
        return text[:-2]
    if text.endswith("\n"):
        return text[:-1]
    return text


def _coerce_arguments(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {"value": value}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {}


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
