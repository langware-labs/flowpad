from __future__ import annotations

import logging
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.transcript_analyzer.transcript import AgentTranscript

from .handler import TranscriptContext, TranscriptHandler

logger = logging.getLogger(__name__)


_WORKER_BY_RECORD_TYPE: dict[RecordType, str] = {
    RecordType.CLAUDE_SESSION: "claude",
    RecordType.CODEX_SESSION: "codex",
}


def _worker_type_for(record_type: RecordType | None) -> str | None:
    if record_type is None:
        return None
    return _WORKER_BY_RECORD_TYPE.get(record_type)


async def _is_fresh(jsonl_path: Path, worker_type: str) -> bool:
    """True iff the transcript entity's updated_date >= JSONL mtime.
    Both timestamps are floored to µs — APFS carries sub-µs precision
    that datetime can't represent, so unflooring trips a false-newer.
    """
    try:
        mtime = jsonl_path.stat().st_mtime
    except OSError:
        return False

    if worker_type == "claude":
        from flow_sdk.builtin.claude_session import ClaudeSession
        entity_cls = ClaudeSession
    else:
        return False  # codex/etc. — opt in per-worker as needed

    session_id = jsonl_path.stem
    entity = await entity_cls.get_by_id(session_id)
    if entity is None or entity.updated_date is None:
        return False
    mtime_us = int(mtime * 1_000_000)
    entity_ts_us = int(entity.updated_date.timestamp() * 1_000_000)
    return mtime_us <= entity_ts_us


class TranscriptIndexer:
    """Dispatch parsed transcript entries to registered TranscriptHandlers.

    Wired into FSIndexer as an IndexerFunc for `RecordType.CLAUDE_SESSION`.
    Returns `[]` (side-effect only — no children). Routing piggybacks on
    `AgentTranscript.filter()` so matcher logic lives in the analyzer.
    """

    def __init__(self) -> None:
        self._handlers: list[TranscriptHandler] = []

    def add_handler(self, handler: TranscriptHandler) -> None:
        self._handlers.append(handler)

    async def __call__(self, nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
        for node in nodes:
            worker_type = _worker_type_for(node.record_type)
            if worker_type is None:
                continue
            try:
                await self._process(Path(node.path), worker_type, opts)
            except Exception:
                logger.warning(
                    "TranscriptIndexer failed to process %s", node.path, exc_info=True
                )
        return []

    async def _process(
        self, jsonl_path: Path, worker_type: str, opts: IndexerOptions
    ) -> None:
        if not self._handlers:
            return
        if not opts.force and await _is_fresh(jsonl_path, worker_type):
            return
        transcript = AgentTranscript(worker_type, str(jsonl_path))
        ctx = TranscriptContext(jsonl_path=jsonl_path, transcript=transcript)
        for handler in self._handlers:
            for entry in transcript.filter(
                kind=handler.match_kind,
                tool_name=handler.match_tool_name,
            ):
                try:
                    await handler.handle(entry, ctx)
                except Exception:
                    logger.warning(
                        "TranscriptHandler %s failed on entry %r in %s",
                        type(handler).__name__,
                        getattr(entry, "id", None),
                        jsonl_path,
                        exc_info=True,
                    )
