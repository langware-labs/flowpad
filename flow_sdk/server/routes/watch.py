"""Server-side transcript watch — streams JSONL entries to WebSocket clients.

Endpoint:
    GET ws://localhost:9007/api/watch/transcript?project_dir=<encoded>

``project_dir`` is the encoded project directory name under ~/.claude/projects/
(replace all non-alphanumeric chars with '-' from the resolved absolute path).

The server watches the directory with watchfiles and streams each new JSONL
line as ``{"type": "transcript_entry", "entry": {...}}``.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from flow_sdk.instance_settings import get_instance_settings

router = APIRouter()


@router.websocket("/api/watch/transcript")
async def watch_transcript(websocket: WebSocket, project_dir: str) -> None:
    """Stream transcript entries from a Claude project directory.

    Args:
        project_dir: Encoded directory name under ~/.claude/projects/.
                     Use ``re.sub(r'[^a-zA-Z0-9]', '-', workdir.resolve().as_posix())``.
    """
    await websocket.accept()

    file_offsets: dict[str, int] = {}

    try:
        from watchfiles import awatch

        watch_path = get_instance_settings().claude_projects_dir / project_dir
        watch_path.mkdir(parents=True, exist_ok=True)

        async for changes in awatch(str(watch_path), debounce=200):
            for _change, file_path in changes:
                if not file_path.endswith(".jsonl"):
                    continue

                path = Path(file_path)
                offset = file_offsets.get(str(path), 0)
                try:
                    with open(path, "rb") as fh:
                        fh.seek(offset)
                        new_bytes = fh.read()
                        file_offsets[str(path)] = offset + len(new_bytes)
                except OSError:
                    continue

                for raw_line in new_bytes.decode("utf-8", errors="replace").splitlines():
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    try:
                        entry = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    try:
                        await websocket.send_json({"type": "transcript_entry", "entry": entry})
                    except Exception:
                        return

    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        pass
    except Exception:
        pass
