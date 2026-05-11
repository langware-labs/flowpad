"""``ProcessEntry`` — composition wrapper around ``TranscriptEntry``.

The wrapper carries observation provenance (where the envelope saw the
event, when it received it). The inner ``transcript_entry`` is the
canonical, unchanged content type.

The same logical event can produce multiple ``ProcessEntry`` instances:
a `tool_use` observed via the live worker stream, then again via a
PreToolUse hook, then again on JSONL replay — three ``ProcessEntry``
wrappers, each with a different ``observation_kind``, all containing the
same `transcript_entry.id`. Consumers dedupe (or render all three) on
that id.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from .entry import TranscriptEntry

# Where this envelope observed the event. Discriminator for cross-observation
# dedup — same `transcript_entry.id` with different `observation_kind` is the
# same logical event seen via different channels.
ObservationKind = Literal["live", "hook_pre", "hook_post", "replay", "synthesized"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class ProcessEntry:
    transcript_entry: TranscriptEntry
    observation_kind: ObservationKind
    received_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "transcript_entry": self.transcript_entry.to_dict(),
            "observation_kind": self.observation_kind,
            "received_at": self.received_at,
        }
