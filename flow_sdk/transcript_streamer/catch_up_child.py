"""Child process for the startup catch-up walk — parses pending transcripts
off the server process and streams one small record per file.

Invoked as ``python -m flow_sdk.transcript_streamer.catch_up_child`` with one
JSON request on **stdin** (then EOF)::

    {"files": ["/abs/path/a.jsonl", ...], "vendor_homes": {"claude": "/home/.claude", ...}}

and speaks NDJSON on **stdout**, one line per file::

    {"path": ..., "worker_type": ..., "session_id": ..., "has_session_meta": ...,
     "entries": <count>, "size": ..., "mtime_ns": ...}
    {"path": ..., "error": "..."}            # the file could not be parsed
    {"result": {"files": <count>}}           # terminal line, always last

The parsed entries never cross the boundary: the parent only needs the session
id to answer "does a process own this?", the ``session_meta`` fact and vendor
for adoption, and the pre-parse stat for the cursor row. A file somebody owns
is re-parsed in the parent through the live path, so nothing about the entry
objects has to be serializable.

**This process never opens the instance DB.** It reads transcript files and
hands facts back; every lookup and every cursor write happens in the parent.
``vendor_homes`` rides on the request so the child does not have to resolve
instance settings to know which parser a path takes.
"""
from __future__ import annotations

import json
import logging
import sys

# ── stdout protection, before anything else can print ────────────────────────
#
# stdout is the protocol channel: one JSON object per line, nothing else. Any
# stray `print` from an imported module would corrupt the stream, so capture
# the real stdout for our own use and repoint `sys.stdout` at stderr, where
# noise is harmless and still visible for debugging (same guard as
# ``fs_store.indexer.scan_child``).
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
log = logging.getLogger("catch_up_child")


def _emit(obj: dict) -> None:
    """Write one protocol line. Every line flushes: the parent acts on each
    record as it arrives (batches of cursor writes and lookups), and one pipe
    write per transcript file is nothing next to parsing it."""
    _PROTOCOL_OUT.write(json.dumps(obj, default=str) + "\n")
    _PROTOCOL_OUT.flush()


def _run(request: dict) -> int:
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.flowpad_types.vendors import vendor_for_path  # noqa: PLC0415
    from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile  # noqa: PLC0415

    homes = {k: Path(v) for k, v in (request.get("vendor_homes") or {}).items()}
    files = [Path(p) for p in request.get("files") or []]

    for path in files:
        try:
            vendor = vendor_for_path(path, homes)
            if vendor is None:
                raise ValueError(f"Cannot infer worker_type from path: {path}")
            # Stat BEFORE parsing, exactly as ``registry.notify_change`` does:
            # a file that grows mid-parse keeps the older cursor and is
            # re-delivered on its next live event.
            st = path.stat()
            # The real parser, one file at a time. ``parse_delta`` after
            # construction returns the whole history — the same batch the
            # in-process walk would have dispatched — and the object is
            # dropped before the next file is read.
            transcript = AgentTranscriptFile(worker_type=vendor.key, path=path)
            entries = transcript.parse_delta()
            _emit({
                "path": str(path),
                "worker_type": vendor.key,
                "session_id": transcript.session_id,
                "has_session_meta": any(
                    getattr(e, "meta_kind", None) == "session_meta" for e in entries
                ),
                "entries": len(entries),
                "size": st.st_size,
                "mtime_ns": st.st_mtime_ns,
            })
            del transcript, entries
        except Exception as exc:
            _emit({"path": str(path), "error": f"{type(exc).__name__}: {exc}"})

    # The terminal line. Its presence is what tells the parent the walk
    # finished rather than the process dying part-way; the count lets the
    # parent detect a stream truncated after the fact.
    _emit({"result": {"files": len(files)}})
    return 0


def _main() -> int:
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as e:
        log.error("could not read the request from stdin: %s", e)
        return 1
    if not isinstance(request, dict):
        log.error("request must be a JSON object, got %s", type(request).__name__)
        return 1
    try:
        return _run(request)
    except Exception:
        log.exception("catch-up parse failed")
        return 1


if __name__ == "__main__":
    sys.exit(_main())
