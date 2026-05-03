"""``AgentTranscript`` — eager-parsed unified transcript across workers."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from .entries import ToolUseEntry
from .entry import EntryKind, TranscriptEntry
from .parsers import get_parser_class

if TYPE_CHECKING:
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

logger = logging.getLogger(__name__)


class AgentTranscript:
    """Parsed view of a single agent's transcript JSONL file.

    Construction is eager: the file is read, every line dispatched through
    the worker-specific ``Parser``, and ``self.entries`` is populated. This
    matches v1's static-only scope; live event streams are not handled here.
    """

    def __init__(
        self,
        worker_type: str,
        path: Path | str,
        *,
        session_id: str = "",
    ) -> None:
        self.worker_type = worker_type
        self.path = Path(path)
        parser_cls = get_parser_class(worker_type)
        self._parser = parser_cls(session_id=session_id)
        self.entries: list[TranscriptEntry] = self._parse()

    @property
    def session_id(self) -> str:
        """Session id, resolved from whichever line first carries one."""
        return self._parser.session_id

    # ── parsing ──────────────────────────────────────────────────────────────

    def _parse(self) -> list[TranscriptEntry]:
        out: list[TranscriptEntry] = []
        if not self.path.exists():
            logger.debug("AgentTranscript: file not found at %s", self.path)
            return out
        try:
            with self.path.open("r", encoding="utf-8") as f:
                for idx, line in enumerate(f):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        logger.debug(
                            "AgentTranscript: skipping malformed JSONL line %d in %s",
                            idx, self.path,
                        )
                        continue
                    out.extend(self._parser.feed(raw, idx))
        except OSError as exc:
            logger.debug("AgentTranscript: read failed %s: %s", self.path, exc)
        return out

    # ── access ───────────────────────────────────────────────────────────────

    def __iter__(self) -> Iterator[TranscriptEntry]:
        return iter(self.entries)

    def __len__(self) -> int:
        return len(self.entries)

    def filter(
        self,
        *,
        kind: EntryKind | None = None,
        tool_name: str | None = None,
    ) -> Iterator[TranscriptEntry]:
        """Yield entries matching all provided filters.

        ``tool_name`` only matches ``ToolUseEntry`` (and subclasses). Pass
        both filters together to combine — they're AND-ed.
        """
        for e in self.entries:
            if kind is not None and e.kind is not kind:
                continue
            if tool_name is not None:
                if not isinstance(e, ToolUseEntry):
                    continue
                if e.tool_name != tool_name:
                    continue
            yield e

    def latest_tool_use(self, tool_name: str) -> ToolUseEntry | None:
        """Return the most recent ``ToolUseEntry`` whose ``tool_name`` matches.

        Reverse-iterates ``entries`` so the first match wins. Returns the
        actual subclass instance (e.g. ``ExitPlanModeEntry`` for
        ``tool_name="ExitPlanMode"``) when applicable.
        """
        for e in reversed(self.entries):
            if isinstance(e, ToolUseEntry) and e.tool_name == tool_name:
                return e
        return None

    def to_flow_data(self) -> list["FlowData"]:
        """Concatenated ``FlowData`` stream from every entry."""
        return [fd for e in self.entries for fd in e.to_flow_data()]
