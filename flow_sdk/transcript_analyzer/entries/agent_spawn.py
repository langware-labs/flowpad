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
        children: list[TranscriptEntry] | None = None,
        child_transcript_path: str | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.agent_type = agent_type
        self.prompt = prompt
        self.description = description
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id
        # Absolute path to this spawned agent's own transcript JSONL, when one
        # exists on disk (set for workflow runs by the transcripts route so the
        # UI can drill into the child). None for ordinary Task/Agent spawns.
        self.child_transcript_path = child_transcript_path
        # The spawned sub-agent's parsed entries, stitched on by
        # ``assembly.assemble_tree`` (joined on ``tool_use_id`` ==
        # subagent ``meta.toolUseId``). Empty until a transcript is
        # assembled — the streaming reader leaves this alone.
        self.children: list[TranscriptEntry] = children or []

    def iter_children(self) -> list[TranscriptEntry]:
        return self.children

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
            # Additive — present only for workflow spawns with an openable child.
            **({"child_transcript_path": self.child_transcript_path}
               if self.child_transcript_path else {}),
            # Recursive — the sub-agent's subtree serializes inline so the
            # transcript doc carries the whole nested run. Empty list when
            # the transcript wasn't assembled.
            "children": [c.to_dict() for c in self.children],
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"agent_type: {self.agent_type}"]
        if self.description:
            out.append(f"description: {self.description}")
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        if self.prompt:
            out.extend(render_block("prompt", self.prompt))
        if self.children:
            out.append(f"children: {len(self.children)} sub-agent entries")
        return out
