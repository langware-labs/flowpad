"""``SkillCallEntry`` — an agent invoking a skill, normalized across workers.

Workers expose skills differently:

* **Claude** invokes the native ``Skill`` tool — ``tool_input={"skill": "<name>"}``.
* **Copilot** invokes its native ``skill`` tool — same shape.
* **Codex** has no skill tool; it loads a skill by reading the skill's
  ``SKILL.md`` (a shell ``sed``/``cat`` of ``…/skills/<name>/SKILL.md``).

Each parser maps its worker-specific shape onto this one entry so callers can
``filter(kind=EntryKind.SKILL_CALL)`` uniformly. ``invocation_kind`` records how
the skill surfaced — see :class:`SkillInvocationKind`.
"""

from __future__ import annotations

from typing import Any

from flow_sdk._compat import StrEnum
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry
from .tool_use import ToolUseEntry


class SkillInvocationKind(StrEnum):
    """How a skill surfaced in the transcript."""

    TOOL = "tool"  # native Skill/skill tool-use (Claude, Copilot)
    FILE_LOAD = "file_load"  # SKILL.md read (Codex)


class SkillCallEntry(ToolUseEntry):
    kind = EntryKind.SKILL_CALL

    def __init__(
        self,
        *,
        skill_name: str,
        invocation_kind: SkillInvocationKind = SkillInvocationKind.TOOL,
        tool_name: str = "Skill",
        tool_use_id: str = "",
        tool_input: dict | None = None,
        **base: Any,
    ) -> None:
        TranscriptEntry.__init__(self, **base)
        self.skill_name = skill_name
        self.invocation_kind = SkillInvocationKind(invocation_kind)
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id
        self.tool_input = tool_input or {}

    def to_flow_data(self) -> list[FlowData]:
        return [FlowData(
            flow_value={
                "tool_name": self.tool_name,
                "tool_use_id": self.tool_use_id,
                "tool_call_id": self.tool_use_id,
                "skill_name": self.skill_name,
                "invocation_kind": self.invocation_kind,
                "input": self.tool_input,
                "args": self.tool_input,
            },
            created_time=self.timestamp,
            attributes={
                "element-type": FlowElementType.TOOL_CALL,
                "data-type": FlowDataType.OBJECT,
                "tool-name": self.tool_name,
                "tool-use-id": self.tool_use_id,
                "skill-name": self.skill_name,
            },
        )]

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "skill_name": self.skill_name,
            "invocation_kind": self.invocation_kind,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [
            f"skill_name: {self.skill_name}",
            f"invocation_kind: {self.invocation_kind}",
        ]
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        if self.tool_input:
            out.extend(render_block("tool_input", self.tool_input))
        return out
