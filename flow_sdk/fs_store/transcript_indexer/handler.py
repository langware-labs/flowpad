from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, Protocol

from flow_sdk.transcript_analyzer.entry import EntryKind, TranscriptEntry
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile


@dataclass(frozen=True, slots=True)
class TranscriptContext:
    jsonl_path: Path
    transcript: AgentTranscriptFile


class TranscriptHandler(Protocol):
    match_kind: ClassVar[EntryKind | None]
    match_tool_name: ClassVar[str | None]

    async def handle(self, entry: TranscriptEntry, ctx: TranscriptContext) -> None: ...
