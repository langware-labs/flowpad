"""TranscriptStreamer — per-session delta streamer over transcript JSONL files.

Public surface:
- ``transcript_streamer_registry``: process singleton.
  - ``subscribe(name, cb)`` — register a delta subscriber; returns unsub.
  - ``notify_change(path)`` — FSOp entry point.
  - ``remove(session_id)`` — PTY-close hook.
  - ``start_idle_sweeper()`` / ``stop_idle_sweeper()`` — server lifecycle.
- ``TranscriptStreamer``: per-session class (consumers rarely construct directly).

Subscriber signature::

    async def my_subscriber(
        session_id: str,
        jsonl_path: Path,
        new_entries: list[TranscriptEntry],
    ) -> None: ...
"""
from flow_sdk.transcript_streamer.registry import (
    TranscriptStreamerRegistry,
    transcript_streamer_registry,
)
from flow_sdk.transcript_streamer.streamer import TranscriptStreamer

__all__ = [
    "TranscriptStreamer",
    "TranscriptStreamerRegistry",
    "transcript_streamer_registry",
]
