"""The stdout-vs-transcript ordering gate shared by the CLI stream workers.

Every vendor CLI we drive prints its assistant reply to stdout BEFORE the
matching row lands in the session file that ``transcript/full`` reads back.
Exposing the reply frame immediately lets a caller receive the answer and then
synchronously read a transcript snapshot that does not contain it yet.

The fix is the same shape for every vendor, so it lives here once: a terminal
assistant frame is only a CANDIDATE, held until the stream proves the turn is
continuing (a following continuation event means the held frames were mid-turn
narration and the whole held run is released live, in order). Passive trailers
join the hold — they may legitimately follow the real answer. Once the vendor's
``result`` event arrives the hold is LOCKED: the remaining suffix is retained
through EOF so late status/result frames cannot move ahead of the answer, and
is released by :meth:`drain` only after the worker's existing
subprocess-settlement path completes. No clock, sleep, timeout, or polling
budget is involved anywhere in this file.

Drivers supply the only two vendor-specific facts by overriding
:meth:`is_terminal_candidate` and :meth:`is_continuation`.
"""

from __future__ import annotations

import json

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData


class TranscriptDurabilityGate:
    """Hold terminal frames until the subprocess has settled."""

    def __init__(self) -> None:
        self._pending_terminal: list[FlowData] = []
        self._result_seen = False

    def is_terminal_candidate(self, event: dict, frames: list[FlowData]) -> bool:
        """True when this event could be the turn's final answer."""
        raise NotImplementedError

    def is_continuation(self, event_type: str) -> bool:
        """True when this event proves the turn continues past a held candidate."""
        raise NotImplementedError

    def feed(self, event: dict | None, frames: list[FlowData]) -> list[FlowData]:
        event_type = str(event.get("type") or "") if event else ""
        if self._result_seen:
            self._pending_terminal.extend(frames)
            return []
        if event_type == "result":
            self._result_seen = True
            self._pending_terminal.extend(frames)
            return []

        terminal = event is not None and self.is_terminal_candidate(event, frames)

        if self._pending_terminal:
            if self.is_continuation(event_type):
                # The turn is provably continuing — the held candidate was
                # narration, not the final answer. Release the held run live,
                # in order, and hold this event instead if it is a candidate.
                released = self._pending_terminal
                self._pending_terminal = list(frames) if terminal else []
                return released if terminal else [*released, *frames]
            self._pending_terminal.extend(frames)
            return []

        if terminal:
            self._pending_terminal.extend(frames)
            return []
        return frames

    def drain(self) -> list[FlowData]:
        pending, self._pending_terminal = self._pending_terminal, []
        self._result_seen = False
        return pending


def stream_event(raw_line: str) -> dict | None:
    """One stdout line as a JSON object, or None when it is neither."""
    try:
        event = json.loads(raw_line)
    except (json.JSONDecodeError, TypeError):
        return None
    return event if isinstance(event, dict) else None
