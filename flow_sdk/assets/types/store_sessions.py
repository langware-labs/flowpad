"""Sessions of workers that keep them in a store (OpenCode's SQLite, DeepAgents' runner).

The transcript is FlowPad's own JSONL inside the run's records -- OpenCode's stream
(``opencode_transcript*.jsonl``) or the session rebuilt from its store
(``session_ses_<id>.jsonl``), DeepAgents' ``deepagents_transcript*.jsonl`` -- and is
snapshotted when the session is shared. Each worker differs only in where its events
name the session; OpenCode's ``ses_`` ids are not UUIDs, so its row id is derived.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

_HEAD_LINES = 64


def iter_head_json(path: Path) -> Iterator[dict]:
    """The JSON events on a JSONL's first lines (unparseable lines skipped; a missing file yields none)."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for _, line in zip(range(_HEAD_LINES), fh):
                if line := line.strip():
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
    except OSError:
        return


def _opencode_session_id(event: dict) -> str | None:
    # The parser's rule (``OpenCodeParser._capture_session``): ``sessionID``, else ``part.sessionID``.
    sid = event.get("sessionID") or (event.get("part") or {}).get("sessionID")
    return sid if isinstance(sid, str) and sid else None


def _deepagents_session_id(event: dict) -> str | None:
    sid = event.get("session_id")
    return sid if isinstance(sid, str) and sid else None


def _identity_key(pick: Callable[[dict], str | None]) -> Callable[[FSRef | Path], str]:
    def key(ref: FSRef | Path) -> str:
        path = Path(getattr(ref, "_path", ref))
        found = next((sid for event in iter_head_json(path) if (sid := pick(event))), None)
        return found or path.stem.removeprefix("session_")

    return key


def _id_from_file(key: Callable[[FSRef | Path], str]) -> Callable[[FSRef | Path], str | None]:
    def read(ref: FSRef | Path) -> str | None:
        value = key(ref)
        return value if is_valid_entity_id(value) else None

    return read


def _extractor(record_type: RecordType, worker: str, key: Callable[[FSRef | Path], str]):
    def extract(ref: FSRef, resolved_id: str) -> list[FSRecord]:
        from flow_sdk.transcript_analyzer import worker_summary_log  # noqa: PLC0415

        path = Path(ref._path)
        session_id = key(path)
        rec = FSRecord(
            type=record_type,
            id=resolved_id,
            name=session_id,
            session_id=session_id,
            jsonl_path=str(path),
            worker_type=worker,
            source_file=str(path),
            path=str(path),
            content=worker_summary_log(path, worker),
        )
        object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True))
        return [rec]

    return extract


opencode_session_identity_key = _identity_key(_opencode_session_id)
opencode_session_id_from_file = _id_from_file(opencode_session_identity_key)
extract_opencode_session = _extractor(RecordType.OPENCODE_SESSION, "opencode", opencode_session_identity_key)

deepagents_session_identity_key = _identity_key(_deepagents_session_id)
deepagents_session_id_from_file = _id_from_file(deepagents_session_identity_key)
extract_deepagents_session = _extractor(RecordType.DEEPAGENTS_SESSION, "deepagents", deepagents_session_identity_key)
