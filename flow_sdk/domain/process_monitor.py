from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import AsyncGenerator

from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord


class ProcessMonitor:
    """Watch a directory for AgenticProcessRecord status changes.

    Polls .flow_records/ for record files and tracks status changes.
    """

    def __init__(self, workdir: str | Path) -> None:
        self._workdir = Path(workdir)

    async def watch(self, poll_interval: float = 2.0) -> AsyncGenerator[dict, None]:
        """Yield events when process records change status.

        Scans .flow_records/ for AgenticProcessRecord JSON files,
        tracks their status via discover_status(), and yields
        change events when status transitions occur.

        Events have shape:
        {"type": "status_change", "agentic_process_id": str, "status": str, "previous": str}

        Terminates when all tracked processes reach terminal states
        (COMPLETE, ERROR, TERMINATED).
        """
        records_dir = self._workdir / ".flow_records"
        status_cache: dict[str, str] = {}

        while True:
            if not records_dir.is_dir():
                await asyncio.sleep(poll_interval)
                continue

            active_count = 0
            for json_file in records_dir.glob("*.json"):
                try:
                    data = json.loads(json_file.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue

                if data.get("type") != "agentic_process":
                    continue

                pid = data.get("id", json_file.stem)
                record = AgenticProcessRecord(**data)
                current = record.discover_status().value

                if current not in ("complete", "error", "terminated"):
                    active_count += 1

                previous = status_cache.get(pid)
                if previous is None:
                    status_cache[pid] = current
                    continue

                if current != previous:
                    status_cache[pid] = current
                    yield {
                        "type": "status_change",
                        "agentic_process_id": pid,
                        "status": current,
                        "previous": previous,
                    }

            if status_cache and active_count == 0:
                return

            await asyncio.sleep(poll_interval)
