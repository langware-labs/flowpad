"""``AgentSpawnEntry`` — agent dispatched a sub-agent (Task / Agent tool).

Claude ``Task`` / ``Agent`` produce this. Sub-agent transcripts surface as
sidechain entries (``is_sidechain=True``); this entry is the call site.
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class AgentSpawnEntry(TranscriptEntry):
    kind = EntryKind.AGENT_SPAWN

    def __init__(
        self,
        *,
        agent_type: str,
        prompt: str | None = None,
        description: str | None = None,
        tool_name: str = "",
        tool_use_id: str = "",
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.agent_type = agent_type
        self.prompt = prompt
        self.description = description
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id

    def to_flow_data(self) -> list:
        return self._tool_flow_data(
            {"subagent_type": self.agent_type, "description": self.description, "prompt": self.prompt},
            default_name="Task",
        )

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "agent_type": self.agent_type,
            "prompt": self.prompt,
            "description": self.description,
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"agent_type: {self.agent_type}"]
        if self.description:
            out.append(f"description: {self.description}")
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        if self.prompt:
            out.extend(render_block("prompt", self.prompt))
        return out
