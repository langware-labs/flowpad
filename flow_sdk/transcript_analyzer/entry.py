"""Base ``TranscriptEntry`` and ``EntryKind`` enum.

The class hierarchy under ``entries/`` is the canonical type discriminator —
``EntryKind`` is a tag exposed for ergonomic filtering on
``AgentTranscriptFile.filter(kind=...)``.
"""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData


class EntryKind(str, Enum):
    USER_MESSAGE = "user_message"
    ASSISTANT_MESSAGE = "assistant_message"
    TOOL_USE = "tool_use"
    TOOL_RESULT = "tool_result"
    # Semantic operation kinds — the parser maps worker-specific tools onto
    # these so the renderer never has to sniff input shapes. ``TOOL_USE`` is
    # the catch-all bucket for anything not recognized.
    FILE_WRITE = "file_write"
    FILE_EDIT = "file_edit"
    FILE_READ = "file_read"
    SHELL_COMMAND = "shell_command"
    # A skill invocation, normalized across workers: Claude/Copilot emit a
    # native ``Skill`` tool-use; Codex loads a skill by reading its
    # ``SKILL.md``. See ``SkillCallEntry``.
    SKILL_CALL = "skill_call"
    SEARCH = "search"
    WEB_FETCH = "web_fetch"
    TODO_UPDATE = "todo_update"
    AGENT_SPAWN = "agent_spawn"
    # Context compaction / summarization boundary (checkpoint + resume). See
    # ``entries/compaction.py``.
    COMPACTION = "compaction"
    SYSTEM = "system"
    SUMMARY = "summary"
    META = "meta"
    TOKEN_USAGE = "token_usage"
    UNKNOWN = "unknown"


class TranscriptEntry:
    """A single line parsed from an agent's transcript JSONL.

    Subclasses live under ``entries/`` and override ``kind`` plus
    ``to_flow_data()``. The base class only carries the envelope fields
    common to every entry, regardless of worker.
    """

    kind: EntryKind = EntryKind.UNKNOWN

    def __init__(
        self,
        *,
        id: str,
        session_id: str,
        timestamp: str,
        worker: str,
        parent_id: str | None = None,
        is_sidechain: bool = False,
        raw_data: dict | None = None,
        entry_id: str | None = None,
        model: str | None = None,
        attribution_skill: str | None = None,
    ) -> None:
        self.id = id
        self.session_id = session_id
        self.timestamp = timestamp
        self.worker = worker
        self.parent_id = parent_id
        # The skill this line is attributed to (Claude's ``attributionSkill``),
        # i.e. the authoritative multi-turn owner — survives turn boundaries,
        # unlike a per-turn skill stack. None for un-skilled / session lines.
        self.attribution_skill = attribution_skill
        # ``is_sidechain`` distinguishes sub-agent (Task tool) lines from
        # main-session lines. Defaults to False so workers without a
        # sidechain concept (codex stream-events) don't have to populate it.
        self.is_sidechain = is_sidechain
        # ``raw_data`` is None for known typed entries (parser populated only
        # for ``UnknownEntry``). Existing typed entries extract whatever they
        # need at parse time.
        self.raw_data = raw_data
        # Worker-side stable id (codex ``response_item.id``, claude
        # ``message.id``). Distinct from ``self.id`` which the parser may
        # synthesize when no upstream id is present.
        self.entry_id = entry_id
        # Model name when the worker carries one on this line (claude
        # ``message.model``, codex ``turn_context.model``). Surfaced on
        # AssistantMessage / TokenUsage lines for analytic filtering.
        self.model = model

    def to_flow_data(self) -> list["FlowData"]:
        """Convert this entry to zero or more ``FlowData`` items.

        Default returns ``[]`` — subclasses override. Returning a list means
        a single transcript line carrying multiple content blocks (text +
        tool_use + thinking) yields multiple ``FlowData`` items in one shot.
        """
        return []

    def _tool_flow_data(
        self,
        args: dict,
        *,
        default_name: str = "Tool",
        extra: dict | None = None,
    ) -> list["FlowData"]:
        """Build a single TOOL_CALL ``FlowData`` carrying the fields the UI needs
        to name the tool (``tool-name`` attr) and pair it with its result
        (``tool_call_id`` in flow_value). Semantic tool entries delegate here so
        replayed tools render identically to the live stream.
        """
        from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
            FlowData,
            FlowDataType,
            FlowElementType,
        )

        name = getattr(self, "tool_name", "") or default_name
        tuid = getattr(self, "tool_use_id", "") or ""
        flow_value = {
            "tool_name": name,
            "tool_use_id": tuid,
            "tool_call_id": tuid,
            "input": args,
            "args": args,
        }
        if extra:
            flow_value.update(extra)
        return [FlowData(
            flow_value=flow_value,
            created_time=self.timestamp,
            attributes={
                "element-type": FlowElementType.TOOL_CALL,
                "data-type": FlowDataType.OBJECT,
                "tool-name": name,
                "tool-use-id": tuid,
            },
        )]

    def to_dict(self) -> dict:
        """Serialize the envelope fields for REST round-trip.

        Subclasses override to add their specific fields. The TS analyzer
        mirror's ``fromJson`` factory discriminates on ``kind`` and
        re-instantiates the right subclass from this payload.
        """
        return {
            "kind": self.kind.value,
            "id": self.id,
            "session_id": self.session_id,
            "timestamp": self.timestamp,
            "worker": self.worker,
            "parent_id": self.parent_id,
            "is_sidechain": self.is_sidechain,
            "entry_id": self.entry_id,
            "model": self.model,
            "attribution_skill": self.attribution_skill,
        }

    # ── string rendering ─────────────────────────────────────────────────────

    def to_string(self) -> str:
        """Human-readable single-entry rendering.

        Layout: a header banner with kind+id, then the common envelope
        fields, then subclass-specific lines via :meth:`_body_lines`. The
        envelope only emits fields that carry information (parent_id is
        skipped when None, is_sidechain only printed when True) so the
        output reads like a stripped-down version of the source JSONL.
        """
        head = f"==== {self.kind.value} {self.id} ===="
        lines: list[str] = [head]
        if self.timestamp:
            lines.append(f"timestamp: {self.timestamp}")
        lines.append(f"worker: {self.worker}")
        if self.session_id:
            lines.append(f"session_id: {self.session_id}")
        if self.entry_id:
            lines.append(f"entry_id: {self.entry_id}")
        if self.model:
            lines.append(f"model: {self.model}")
        if self.parent_id:
            lines.append(f"parent_id: {self.parent_id}")
        if self.is_sidechain:
            lines.append("is_sidechain: true")
        body = self._body_lines()
        if body:
            lines.append("--")
            lines.extend(body)
        return "\n".join(lines)

    def _body_lines(self) -> list[str]:
        """Subclass hook returning specialized field lines.

        Each line is a complete output line (no trailing newline). Multi-line
        values (text, code, JSON) should be returned as one block per logical
        field, e.g. ``text:`` followed by indented content. Default is empty
        for entries that have no specialized fields beyond the envelope.
        """
        return []

    def __repr__(self) -> str:
        return f"{type(self).__name__}(id={self.id!r}, kind={self.kind.value})"
