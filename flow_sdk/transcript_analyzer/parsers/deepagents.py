"""Deep Agents transcript parser.

The line vocabulary is OURS — the events ``cli_drivers/deepagents/runner.py`` prints (its module
docstring is the schema), teed verbatim into the process transcript. Unlike opencode, a tool call
and its result are separate lines, the user's own turn is in the stream, and every ``usage`` line
names its model, so there is nothing to synthesize and no state to carry beyond the session id.
"""

from __future__ import annotations

from typing import Any

from ..entries import (
    AgentSpawnEntry,
    AssistantMessageEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    MetaEntry,
    SearchEntry,
    ShellCommandEntry,
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UsageEntry,
    UserMessageEntry,
)
from ..entry import TranscriptEntry

# deepagents' built-in tool names (its filesystem + shell + subagent middleware).
_SHELL_TOOLS = {"execute"}
_READ_TOOLS = {"read_file"}
_WRITE_TOOLS = {"write_file"}
_EDIT_TOOLS = {"edit_file"}
_SEARCH_KINDS = {"grep": "grep", "glob": "glob", "ls": "find"}
_SPAWN_TOOLS = {"task"}

_TERMINALS = {"result", "flowpad.interrupted", "flowpad.error"}

# usage line field → the usage pipeline's ``io`` dimension
_USAGE_DIMS = (
    ("input_tokens", "input"),
    ("output_tokens", "output"),
    ("reasoning_tokens", "reasoning"),
    ("cache_read_tokens", "cache_read"),
)


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class DeepAgentsParser:
    worker_type = "deepagents"

    def __init__(self, session_id: str = "") -> None:
        self.session_id = session_id
        self._current_model: str | None = None

    def _base(self, raw: dict, line_index: int) -> dict[str, Any]:
        return {
            "id": f"{self.session_id or 'deepagents'}:{line_index}",
            "session_id": self.session_id,
            "timestamp": str(raw.get("timestamp") or ""),
            "worker": self.worker_type,
            "parent_id": None,
        }

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        if not self.session_id and raw.get("session_id"):
            self.session_id = str(raw["session_id"])
        if raw.get("model"):
            self._current_model = str(raw["model"])
        event_type = str(raw.get("type") or "")
        base = self._base(raw, line_index)
        message_id = str(raw.get("message_id") or "") or None

        if event_type == "init":
            payload = {"id": self.session_id, "model_provider": "deepagents", **{k: raw.get(k) for k in ("model", "cwd", "resumed")}}
            return [MetaEntry(meta_kind="session_meta", payload=payload, **base)]

        if event_type == "user":
            return [UserMessageEntry(text=str(raw.get("text") or ""), **base)]

        if event_type == "text":
            text = str(raw.get("text") or "")
            if not text:
                return [MetaEntry(meta_kind=event_type, payload=raw, **base)]
            return [AssistantMessageEntry(text=text, entry_id=message_id, model=self._current_model, **base)]

        if event_type == "reasoning":
            thinking = str(raw.get("text") or "")
            if not thinking:
                return [MetaEntry(meta_kind=event_type, payload=raw, **base)]
            return [AssistantMessageEntry(text="", thinking=thinking, entry_id=message_id, model=self._current_model, **base)]

        if event_type == "tool_call":
            return [self._tool_call(raw, base)]

        if event_type == "tool_result":
            output = raw.get("output")
            return [
                ToolResultEntry(
                    tool_use_id=str(raw.get("tool_call_id") or base["id"]),
                    tool_output="" if output is None else str(output),
                    is_error=bool(raw.get("is_error")),
                    tool_name=str(raw.get("name") or "tool"),
                    **base,
                )
            ]

        if event_type == "usage":
            return self._usage(raw, base, message_id)

        if event_type == "error" or event_type in _TERMINALS:
            return [SystemEntry(subtype=event_type, payload=raw, **base)]

        return [MetaEntry(meta_kind=event_type or "unknown", payload=raw, **base)]

    def _tool_call(self, raw: dict, base: dict[str, Any]) -> TranscriptEntry:
        name = str(raw.get("name") or "tool")
        tool_input = raw.get("input") if isinstance(raw.get("input"), dict) else {}
        common = {"tool_name": name, "tool_use_id": str(raw.get("tool_call_id") or base["id"]), **base}
        path = tool_input.get("file_path") or tool_input.get("path")

        if name in _SHELL_TOOLS:
            return ShellCommandEntry(
                command=str(tool_input.get("command") or ""),
                timeout=_as_int(tool_input.get("timeout")),
                **common,
            )
        if name in _READ_TOOLS and path:
            return FileReadEntry(path=str(path), **common)
        if name in _WRITE_TOOLS and path:
            return FileWriteEntry(path=str(path), content=str(tool_input.get("content") or ""), **common)
        if name in _EDIT_TOOLS and path:
            return FileEditEntry(path=str(path), **common)
        if name in _SEARCH_KINDS:
            query = tool_input.get("pattern") or tool_input.get("path") or ""
            return SearchEntry(search_kind=_SEARCH_KINDS[name], query=str(query), **common)
        if name in _SPAWN_TOOLS:
            return AgentSpawnEntry(
                agent_type=str(tool_input.get("subagent_type") or ""),
                prompt=str(tool_input.get("description") or ""),
                description=str(tool_input.get("description") or ""),
                **common,
            )
        return ToolUseEntry(tool_input=tool_input, **common)

    def _usage(self, raw: dict, base: dict[str, Any], message_id: str | None) -> list[TranscriptEntry]:
        out: list[TranscriptEntry] = []
        for field, io in _USAGE_DIMS:
            count = _as_int(raw.get(field))
            if not count or count <= 0:
                continue
            out.append(
                UsageEntry(
                    count=count,
                    io=io,
                    unit="token",
                    # Stable per-message key, so a replayed line bills once.
                    entry_id=f"{message_id}:usage:{io}" if message_id else None,
                    model=self._current_model,
                    **{**base, "id": f"{base['id']}:usage:{io}"},
                )
            )
        return out or [MetaEntry(meta_kind="usage", payload=raw, **base)]


class DeepAgentsStreamParser(DeepAgentsParser):
    """The runner's stdout tee (``TranscriptFormat.DEEPAGENTS_STREAM``)."""
