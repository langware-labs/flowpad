"""Run journal — one append-only JSONL per execution, inside the flow folder.

``<flow folder>/runs/<run-id>.jsonl`` holds the full trace of a run: events,
deliveries, execution phases, stdio, and the terminal status. The
AgenticFlowRun DB row is only start/end bookkeeping — this file is the truth
(WORKFLOW_RUN precedent: a run journal parsed and served like a transcript).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class RunJournal:
    def __init__(self, flow_folder: Path, run_id: str) -> None:
        self.path = flow_folder / "runs" / f"{run_id}.jsonl"
        self._entries: list[dict[str, Any]] = []  # in-memory mirror for live serving

    def append(self, kind: str, payload: dict[str, Any]) -> None:
        from flow_sdk.core.capabilities.models import now_iso

        entry = {"kind": kind, "ts": now_iso(), **payload}
        self._entries.append(entry)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, default=str) + "\n")
        except Exception:
            logger.debug("RunJournal: disk append failed", exc_info=True)

    def entries(self) -> list[dict[str, Any]]:
        return list(self._entries)


def read_run_journal(flow_folder: Path, run_id: str) -> list[dict[str, Any]]:
    """Read a run's journal from disk (works after restarts)."""
    path = flow_folder / "runs" / f"{run_id}.jsonl"
    out: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return out
