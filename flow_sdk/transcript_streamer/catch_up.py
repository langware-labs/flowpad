"""Startup catch-up through a child process — the server never parses a
transcript nobody owns.

On a fresh instance "pending" is every transcript on the machine, and parsing
them in the server's worker threads held the GIL back to back: the backend
sat near 100% CPU and a status call took up to a second for the whole walk.
The work is kept (the cursor store must learn every file) but moved out of the
process: ``catch_up_child`` parses one file at a time and streams back only
what the parent needs to decide — the session id, whether the file carries a
``session_meta`` header, its vendor and the pre-parse stat.

The parent resolves claims in batches (one ``session_id IN (...)`` query per
``BATCH_SIZE`` records instead of one lookup per file), then:

* a file no process owns, and that no id-less running process could adopt,
  only gets its cursor row (``registry.mark_consumed``) — the same row the
  in-process path writes, at the same pre-parse stat;
* anything else goes through ``registry.catch_up`` in-process, exactly as
  before: the owner needs the live streamer object, and the subscriber's
  adoption step needs the entries. That is the rare case.

Entries never cross the boundary — they are ~3x the file's bytes and have no
``from_dict`` — and the child never opens the instance DB (the rule stated at
``graph_workflow_manager/function_runner.py``).

Failure is **fail-open**, mirroring ``fs_store.indexer.subprocess_scan``: a
child that cannot be spawned latches ``_CHILD_UNAVAILABLE`` so later walks do
not pay a doomed spawn; a stream that dies part-way is not retried — the
files the child did not get to are handed back to the caller, which runs
today's in-process loop over them.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from flow_sdk.fs_store.indexer.ndjson_stream import stream_ndjson

_log = logging.getLogger(__name__)

CHILD_MODULE = "flow_sdk.transcript_streamer.catch_up_child"

# Records resolved per DB round-trip. One ``IN`` query per batch replaces one
# lookup per file; the batch is also the unit of cursor writes, so a child
# that dies mid-stream still leaves everything before it consumed.
BATCH_SIZE = 200

# Latched when the child cannot run in this deployment at all — a frozen build
# whose sys.executable isn't a Python, a sandbox that forbids spawning. Per-run
# data failures do NOT latch.
_CHILD_UNAVAILABLE = False


def reset_child_availability() -> None:
    """Re-enable child probing (tests)."""
    global _CHILD_UNAVAILABLE
    _CHILD_UNAVAILABLE = False


def child_env() -> dict[str, str]:
    """The environment the child is spawned with.

    ``FLOW_INSTANCE`` is re-stamped hard rather than setdefault-ed: an empty or
    absent value resolves the child to the ``prod`` instance, and anything in
    it that consults instance settings would then read the wrong instance.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    env = dict(os.environ)
    env["FLOW_INSTANCE"] = get_instance_settings().instance_name
    return env


async def catch_up_via_child(pending: list[Path]) -> list[Path]:
    """Catch up ``pending`` through the child. Returns the files it did NOT
    finish — empty on success — for the caller to catch up in-process."""
    global _CHILD_UNAVAILABLE
    if _CHILD_UNAVAILABLE or not pending:
        return list(pending)

    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    settings = get_instance_settings()
    request = {
        "files": [str(p) for p in pending],
        "vendor_homes": {k: str(v) for k, v in settings.vendor_homes.items()},
    }
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            CHILD_MODULE,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=child_env(),
        )
    except (OSError, ValueError) as e:
        _CHILD_UNAVAILABLE = True
        _log.warning(
            "Transcript streamer catch-up: child cannot be spawned (%s); "
            "parsing in-process for the rest of this process", e,
        )
        return list(pending)

    assert proc.stdin is not None
    proc.stdin.write(json.dumps(request).encode())
    await proc.stdin.drain()
    proc.stdin.close()

    # Files not yet resolved, in discovery order. A record pops its file once
    # handled; whatever is left when the stream ends goes back to the caller.
    remaining: dict[Path, None] = {p: None for p in pending}
    batch: list[dict] = []

    async def on_record(rec: dict) -> None:
        if "path" not in rec:
            return
        batch.append(rec)
        if len(batch) >= BATCH_SIZE:
            await _resolve(batch, remaining)
            batch.clear()

    try:
        result, _ = await stream_ndjson(
            proc, None, collect_candidates=False, label="catch_up_child", on_record=on_record,
        )
        if result is None:
            raise RuntimeError("catch_up_child emitted no result line — treating as a truncated stream")
        reported = result.get("files")
        if reported is not None and int(reported) != len(pending):
            raise RuntimeError(
                f"catch_up_child file count mismatch: reported {reported}, sent {len(pending)}"
            )
    except Exception:
        _log.warning(
            "Transcript streamer catch-up: child stream failed; "
            "catching up the remaining files in-process", exc_info=True,
        )
    # Records already received are complete facts whichever way the stream
    # ended; resolving them is work the fallback loop does not have to redo.
    await _resolve(batch, remaining)
    return list(remaining)


async def _resolve(records: list[dict], remaining: dict[Path, None]) -> None:
    """Act on one batch of child records: cursor-only for the unowned, the
    live path for anything a process owns or could adopt. A record the child
    could not parse stays in ``remaining`` so the in-process loop reports it
    the way it always has."""
    if not records:
        return
    from flow_sdk.flowpad_types.vendors import vendor_by  # noqa: PLC0415
    from flow_sdk.transcript_streamer import transcript_streamer_registry as registry  # noqa: PLC0415

    parsed = [r for r in records if "error" not in r]
    for rec in records:
        if "error" in rec:
            _log.debug("Transcript streamer catch-up: child could not parse %s: %s", rec["path"], rec["error"])
    # Session-id parity with ``notify_change``: the parser-resolved id, else
    # the path stem.
    sid_of = {rec["path"]: (rec.get("session_id") or Path(rec["path"]).stem) for rec in parsed}
    owned = await _owned_session_ids(sorted(set(sid_of.values())))
    adoptable = await _adoptable_worker_types() if any(r.get("has_session_meta") for r in parsed) else set()

    for rec in parsed:
        path = Path(rec["path"])
        remaining.pop(path, None)
        vendor = vendor_by("key", rec.get("worker_type"))
        live = bool(rec.get("entries")) and (
            sid_of[rec["path"]] in owned
            or (bool(rec.get("has_session_meta")) and vendor is not None and vendor.worker_type in adoptable)
        )
        if live:
            try:
                await registry.catch_up(path)
            except Exception:
                _log.exception("Transcript streamer catch-up failed for %s", path)
        else:
            registry.mark_consumed(path, size=int(rec["size"]), mtime_ns=int(rec["mtime_ns"]))


async def _owned_session_ids(session_ids: list[str]) -> set[str]:
    """The subset of ``session_ids`` some local process row owns — one query
    for the whole batch. The same lookup ``_route_to_ap`` makes per file."""
    if not session_ids:
        return set()
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    try:
        rows = await AgenticProcess.local_rows(entities_filter=QueryFilter(
            match=ExpressionNode(op=QueryOp.IN, operands=["session_id", session_ids]),
        ))
    except Exception:
        _log.exception("Transcript streamer catch-up: owner lookup failed")
        return set()
    return {row.session_id for row in rows if row.session_id}


async def _adoptable_worker_types() -> set[str]:
    """Worker types with an id-less RUNNING process — the precondition of
    ``_adopt_unstamped_session``. A ``session_meta`` file of any other vendor
    cannot be adopted, so it does not need the live path."""
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter  # noqa: PLC0415

    try:
        rows = await AgenticProcess.local_rows(entities_filter=QueryFilter(
            match=ExpressionNode(status=ProcessStatus.RUNNING.value),
        ))
    except Exception:
        _log.exception("Transcript streamer catch-up: adoption lookup failed")
        return set()
    return {
        str(getattr(row.worker_type, "value", row.worker_type))
        for row in rows if not row.session_id and row.worker_type
    }
