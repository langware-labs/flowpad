"""Base ``TranscriptEntry`` and ``EntryKind`` enum.

The class hierarchy under ``entries/`` is the canonical type discriminator —
``EntryKind`` is a tag exposed for ergonomic filtering on
``AgentTranscript.filter(kind=...)``.
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
    SYSTEM = "system"
    SUMMARY = "summary"
    META = "meta"
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
    ) -> None:
        self.id = id
        self.session_id = session_id
        self.timestamp = timestamp
        self.worker = worker
        self.parent_id = parent_id
        # ``is_sidechain`` distinguishes sub-agent (Task tool) lines from
        # main-session lines. Defaults to False so workers without a
        # sidechain concept (codex stream-events) don't have to populate it.
        self.is_sidechain = is_sidechain
        # ``raw_data`` is None for known typed entries (parser populated only
        # for ``UnknownEntry``). Existing typed entries extract whatever they
        # need at parse time.
        self.raw_data = raw_data

    def to_flow_data(self) -> list["FlowData"]:
        """Convert this entry to zero or more ``FlowData`` items.

        Default returns ``[]`` — subclasses override. Returning a list means
        a single transcript line carrying multiple content blocks (text +
        tool_use + thinking) yields multiple ``FlowData`` items in one shot.
        """
        return []

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
        }

    def __repr__(self) -> str:
        return f"{type(self).__name__}(id={self.id!r}, kind={self.kind.value})"
