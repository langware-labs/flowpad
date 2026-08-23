"""OpenCode transcript parser.

One parser serves both FlowPad-owned formats, because they share a line
vocabulary: the headless stdout tee (``OPENCODE_STREAM``) and the projection
assembled from the vendor's SQLite store (``OPENCODE_SESSION``) both emit
``{type, timestamp, sessionID, part}`` with the *same* ``part`` object — the
store literally persists the part shape the stream prints.

Two vendor quirks shape the mapping:

* A ``tool_use`` event carries the call **and** its result in one object
  (``part.state`` holds both ``input`` and ``output``), so one line yields a
  ``ToolUseEntry`` *plus* a ``ToolResultEntry`` sharing the call id — the same
  split codex needs for ``item.completed:command_execution``.
* ``step_finish`` carries the per-step token counts, so usage folds from there
  rather than from an assistant message.
"""

from __future__ import annotations

from datetime import datetime, timezone
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
    WebFetchEntry,
)
from ..entry import TranscriptEntry

# OpenCode publishes a stable, documented tool set, so tools are mapped by name
# (copilot has to sniff input shapes precisely because it does not).
_SHELL_TOOLS = {"bash"}
_READ_TOOLS = {"read"}
_WRITE_TOOLS = {"write"}
_EDIT_TOOLS = {"edit", "patch"}
_SEARCH_TOOLS = {"grep", "glob", "list"}
# ``websearch`` belongs here, NOT with grep/glob: the shared semantic table
# (``derivation/handlers/tool_maps._COMMON``) maps both ``websearch`` and
# ``webfetch`` to WEB_FETCH for every worker. Classing it as a search made an
# opencode web search render as a grep-style chip while the same tool shows a
# web chip on claude/codex/copilot — a divergence from the shared vocabulary on
# day one, which is exactly what that table exists to prevent.
_FETCH_TOOLS = {"webfetch", "websearch"}
_SPAWN_TOOLS = {"task"}


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None



def _iso_timestamp(value: Any) -> str:
    """Normalise OpenCode's epoch-MILLIS to the ISO-8601 every consumer expects.

    Alone among the four vendors, opencode timestamps events with an integer
    epoch-ms (both in the stdout stream and in the store's ``time_created``).
    Stringifying that verbatim yields a bare numeric string, which every reader
    that does `new Date(ts)` / `datetime.fromisoformat(ts)` sees as an INVALID
    date — the terminal's `PtySyncSession.getRefLines` turns it into a
    `RangeError: Invalid time value` that takes down the whole pane through the
    error boundary. Normalising here keeps the entry contract single-shaped, so
    no consumer needs to know which vendor produced the entry.
    """
    if value is None or value == "":
        return ""
    if isinstance(value, str):
        # Already ISO (or something we cannot improve on) — pass through, but
        # accept a numeric string, which is what a JSON round-trip can yield.
        if not value.lstrip("-").isdigit():
            return value
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(value)
    # Milliseconds since epoch. Seconds-resolution values would land in 1970;
    # opencode has only ever emitted ms, so treat anything else as opaque.
    try:
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return str(value)


class OpenCodeParser:
    worker_type = "opencode"

    def __init__(self, session_id: str = "") -> None:
        self.session_id = session_id
        self._current_model: str | None = None

    # -- plumbing ---------------------------------------------------------

    def _base(self, raw: dict, line_index: int) -> dict[str, Any]:
        return {
            "id": self._synth_id(raw, line_index),
            "session_id": self.session_id,
            "timestamp": _iso_timestamp(raw.get("timestamp")),
            "worker": self.worker_type,
            "parent_id": None,
        }

    def _synth_id(self, raw: dict, line_index: int) -> str:
        part = raw.get("part") if isinstance(raw.get("part"), dict) else {}
        for candidate in (part.get("id"), raw.get("id")):
            if candidate:
                return str(candidate)
        return f"{self.session_id or 'opencode'}:{line_index}"

    def _capture_session(self, raw: dict) -> None:
        if self.session_id:
            return
        sid = raw.get("sessionID")
        if not sid:
            part = raw.get("part") if isinstance(raw.get("part"), dict) else {}
            sid = part.get("sessionID")
        if sid:
            self.session_id = str(sid)

    def _capture_model(self, raw: dict) -> None:
        """Learn the model id, which opencode's stdout stream never carries.

        Neither ``step_start``, ``text`` nor ``step_finish`` names a model, so
        without this every entry would be stamped ``model=None`` and the pricing
        layer would silently fall back to its default table — correct only by
        coincidence when the configured model happens to BE that default, and
        wrong for every other one. Both FlowPad-owned formats supply it
        explicitly: the stream worker stamps the resolved slug onto the
        synthesized user-prompt line, and the store projection carries
        ``providerID/modelID`` off the assistant message row.
        """
        model = raw.get("model")
        if model:
            self._current_model = str(model)

    # -- entry point ------------------------------------------------------

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        self._capture_session(raw)
        self._capture_model(raw)
        event_type = str(raw.get("type") or "")
        part = raw.get("part") if isinstance(raw.get("part"), dict) else {}
        base = self._base(raw, line_index)

        if event_type == "step_start":
            payload = {
                "id": self.session_id,
                "messageID": part.get("messageID"),
                "model_provider": "opencode",
            }
            return [MetaEntry(meta_kind="session_meta", payload=payload, **base)]

        if event_type == "flowpad.user_prompt":
            return [UserMessageEntry(text=str(part.get("text") or ""), **base)]

        if event_type == "text":
            text = str(part.get("text") or "")
            if not text:
                return [MetaEntry(meta_kind=event_type, payload=part, **base)]
            return [
                AssistantMessageEntry(
                    text=text,
                    entry_id=str(part.get("messageID") or "") or None,
                    model=self._current_model,
                    **base,
                )
            ]

        if event_type == "reasoning":
            thinking = str(part.get("text") or "")
            if not thinking:
                return [MetaEntry(meta_kind=event_type, payload=part, **base)]
            return [
                AssistantMessageEntry(
                    text="",
                    thinking=thinking,
                    entry_id=str(part.get("messageID") or "") or None,
                    model=self._current_model,
                    **base,
                )
            ]

        if event_type == "tool_use":
            return self._tool_use(part, base)

        if event_type == "step_finish":
            return self._step_finish(part, base)

        if event_type == "error":
            return [SystemEntry(subtype="error", payload=raw, **base)]

        if event_type in {"flowpad.interrupted", "flowpad.error", "flowpad.result"}:
            return [SystemEntry(subtype=event_type, payload=raw, **base)]

        return [MetaEntry(meta_kind=event_type or "unknown", payload=raw, **base)]

    # -- per-event --------------------------------------------------------

    def _tool_use(self, part: dict, base: dict[str, Any]) -> list[TranscriptEntry]:
        state = part.get("state") if isinstance(part.get("state"), dict) else {}
        name = str(part.get("tool") or "tool")
        call_id = str(part.get("callID") or part.get("id") or base["id"])
        tool_input = state.get("input") if isinstance(state.get("input"), dict) else {}
        status = str(state.get("status") or "")

        out: list[TranscriptEntry] = [self._semantic_tool_entry(name, call_id, tool_input, base)]

        # OpenCode collapses call and result into one event. Only a completed
        # (or errored) call actually has a result to pair.
        if status in {"completed", "error"}:
            output = state.get("output")
            out.append(
                ToolResultEntry(
                    tool_use_id=call_id,
                    tool_output="" if output is None else str(output),
                    is_error=status == "error",
                    tool_name=name,
                    file_path=tool_input.get("filePath") or tool_input.get("path"),
                    **{**base, "id": f"{base['id']}:result"},
                )
            )
        return out

    def _semantic_tool_entry(
        self, name: str, call_id: str, tool_input: dict, base: dict[str, Any]
    ) -> TranscriptEntry:
        lower = name.lower()
        common = {"tool_name": name, "tool_use_id": call_id, **base}
        path = tool_input.get("filePath") or tool_input.get("path")

        if lower in _SHELL_TOOLS:
            return ShellCommandEntry(
                command=str(tool_input.get("command") or ""),
                timeout=_as_int(tool_input.get("timeout")),
                **common,
            )
        if lower in _READ_TOOLS and path:
            return FileReadEntry(path=str(path), **common)
        if lower in _WRITE_TOOLS and path:
            return FileWriteEntry(
                path=str(path), content=str(tool_input.get("content") or ""), **common
            )
        if lower in _EDIT_TOOLS and path:
            return FileEditEntry(path=str(path), **common)
        if lower in _SEARCH_TOOLS:
            query = tool_input.get("pattern") or tool_input.get("query") or tool_input.get("path")
            return SearchEntry(
                search_kind="grep" if lower == "grep" else ("glob" if lower == "glob" else "find"),
                query=str(query or ""),
                **common,
            )
        if lower in _FETCH_TOOLS:
            # A web SEARCH carries a query, not a url; keep the entry's single
            # field populated either way so the chip is never blank.
            target = tool_input.get("url") or tool_input.get("query") or ""
            return WebFetchEntry(url=str(target), **common)
        if lower in _SPAWN_TOOLS:
            return AgentSpawnEntry(
                agent_type=str(tool_input.get("subagent_type") or tool_input.get("agent") or ""),
                prompt=str(tool_input.get("prompt") or ""),
                description=str(tool_input.get("description") or ""),
                **common,
            )
        return ToolUseEntry(tool_input=tool_input, **common)

    def _step_finish(self, part: dict, base: dict[str, Any]) -> list[TranscriptEntry]:
        out: list[TranscriptEntry] = [
            SystemEntry(
                subtype="step_finish",
                # ``cost`` is carried for observability only. USD is derived from
                # tokens by the pricing layer — a worker must never report its
                # own dollars into the usage pipeline.
                payload={"reason": part.get("reason"), "vendor_cost": part.get("cost")},
                **base,
            )
        ]
        tokens = part.get("tokens") if isinstance(part.get("tokens"), dict) else {}
        message_id = str(part.get("messageID") or "")
        cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
        dims: list[tuple[str, Any]] = [
            ("input", tokens.get("input")),
            ("output", tokens.get("output")),
            ("reasoning", tokens.get("reasoning")),
            ("cache_read", cache.get("read")),
            ("cache_write", cache.get("write")),
        ]
        for io, value in dims:
            count = _as_int(value)
            if not count or count <= 0:
                continue
            out.append(
                UsageEntry(
                    count=count,
                    io=io,
                    unit="token",
                    id=f"{base['id']}:usage:{io}",
                    # Stable per-message key: repeated snapshots of the same
                    # logical step must bill once, not once per emission.
                    entry_id=f"{message_id}:usage:{io}" if message_id else None,
                    session_id=base["session_id"],
                    timestamp=base["timestamp"],
                    worker=base["worker"],
                    parent_id=base["parent_id"],
                    model=self._current_model,
                )
            )
        return out


class OpenCodeStreamParser(OpenCodeParser):
    """Headless stdout tee (``TranscriptFormat.OPENCODE_STREAM``)."""


class OpenCodeSessionParser(OpenCodeParser):
    """Projection of the vendor store (``TranscriptFormat.OPENCODE_SESSION``)."""
