"""The parent↔child NDJSON protocol for out-of-process indexer work.

One wire format, two children: the external Rust binary (``RSIndexerAdapter``)
and the Python scan child (``SubprocessScanIndexer`` →
``flow_sdk.fs_store.indexer.scan_child``). Extracted from ``rs_adapter`` so the
second child reuses the decoders rather than growing a parallel dialect that
drifts.

Wire shape — one JSON object per line on the child's **stdout**, logs on stderr:

* ``{"path": …, "record_type": …, "scope": …, "project_id": …, "json_path": …,
  "read_only": …, "type_id": …}`` — a discovered candidate.
* ``{"job_name": …, "rows": [...], "current": …, "done": …, "total": …,
  "text": …, "ts": …}`` — a progress snapshot (decoded by
  ``rs_adapter._table_from_json``).
* ``{"result": {...}}`` — the terminal line. **Required.** Its absence means the
  child died mid-stream, which a truncated candidate list cannot be
  distinguished from otherwise — and a truncated candidate list reaching
  ``index()`` would let the orphan sweep delete every record the child never got
  to emit.

``scope`` / ``project_id`` / ``read_only`` are emitted as their **resolved**
values, so inheritance survives without the receiver needing a chain.

The parent chain itself still has to cross, though: ``index()`` derives a
record's enclosure parent from ``ref._parent`` directly
(``index_function.ref_typeid(getattr(ref, "_parent", None))``), so a purely
flattened candidate silently loses ``parent_type_id`` on every received asset.
Each candidate therefore carries ``i`` (its position in the stream) plus either
``parent_i`` (the parent's position, for a parent that is itself a candidate) or
``parent_ref`` (an inline minimal parent, for one that is not). The decoder
rebuilds every node first and links parents in a second pass, so stream order
does not matter.

A producer that omits these — the Rust binary's existing 5-field contract —
decodes to parentless refs exactly as before.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any, Awaitable, Callable

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.progress_table import IndexProgressTable, TypeProgressRow
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)

# Exit codes the parent accepts as a completed run. 2 = finished, but with
# per-record errors the result payload already reports.
OK_RETURNCODES = (0, 2)


def table_to_payload(table: IndexProgressTable) -> dict[str, Any]:
    """Encode a progress snapshot for the wire. Inverse of ``table_from_json``."""
    return asdict(table)


def table_from_json(d: dict) -> IndexProgressTable:
    """Decode a progress line. Inverse of ``table_to_payload``.

    Lives here, beside the rest of the protocol, so both children speak one
    dialect and the encode/decode pair cannot drift apart.
    """
    rows = tuple(
        TypeProgressRow(
            type_name=str(r.get("type_name", "")),
            done=int(r.get("done", 0)),
            total=int(r.get("total", 0)),
            errors=int(r.get("errors", 0)),
            skipped=int(r.get("skipped", 0)),
        )
        for r in d.get("rows", [])
    )
    return IndexProgressTable(
        job_name=str(d.get("job_name", "index")),
        rows=rows,
        current=d.get("current"),
        done=int(d.get("done", 0)),
        total=int(d.get("total", 0)),
        text=d.get("text"),
        ts=str(d.get("ts", "")),
    )


def candidate_from_fsref(ref: FSRef) -> dict[str, Any]:
    """Serialize an ``FSRef`` to a candidate line payload.

    Reads the **properties**, not the private fields, so inherited
    ``scope`` / ``project_id`` / ``read_only`` are resolved before crossing the
    boundary. Used for both emitted candidates and the roots payload handed to a
    child, so one function defines the whole ref wire shape.
    """
    return {
        "path": ref.path,
        "record_type": str(ref.record_type) if ref.record_type is not None else None,
        "scope": ref.scope,
        "project_id": ref.project_id,
        "json_path": ref.json_path,
        "read_only": ref.read_only,
    }


def fsref_from_candidate(c: dict[str, Any]) -> FSRef:
    """Rebuild an ``FSRef`` from a candidate line.

    Empty strings coerce to ``None`` — the Rust binary emits ``""`` for absent
    optionals where Python emits ``null``, and both must land on ``None`` so
    downstream ``is None`` checks behave. An unknown ``record_type`` degrades to
    ``None`` rather than raising, matching the pre-extraction behaviour.
    """
    raw_type = c.get("record_type")
    try:
        rt = RecordType(raw_type) if raw_type else None
    except ValueError:
        rt = None
    # type_id is not on the wire: no walker or root in the indexer tree ever sets
    # a non-default one, so FSRef's own default is the only value it can take.
    return FSRef(
        Path(c["path"]),
        record_type=rt,
        scope=c.get("scope") or None,
        project_id=c.get("project_id") or None,
        json_path=c.get("json_path") or None,
        read_only=bool(c.get("read_only")),
    )


def candidates_with_parents(refs: list[FSRef]) -> list[dict[str, Any]]:
    """Serialize a scan result, preserving each ref's parent link.

    Parents that are themselves in ``refs`` become an index (``parent_i``); a
    parent outside the list is inlined (``parent_ref``) with just enough to
    resolve its typeid, which is all the enclosure derivation reads off it.
    """
    position = {id(r): i for i, r in enumerate(refs)}
    out: list[dict[str, Any]] = []
    for i, ref in enumerate(refs):
        payload = candidate_from_fsref(ref)
        payload["i"] = i
        parent = getattr(ref, "_parent", None)
        if parent is not None:
            pi = position.get(id(parent))
            if pi is not None:
                payload["parent_i"] = pi
            else:
                payload["parent_ref"] = candidate_from_fsref(parent)
        out.append(payload)
    return out


def fsrefs_from_candidates(candidates: list[dict[str, Any]]) -> list[FSRef]:
    """Rebuild candidate lines into real ``FSRef``s, restoring parent links.

    Two passes so the result never depends on emission order: build every node,
    then attach parents. ``_parent`` is assigned directly because the resolved
    ``scope`` / ``project_id`` / ``read_only`` are already set explicitly on each
    node, so the chain is only needed for the enclosure-parent derivation.
    """
    built = [fsref_from_candidate(c) for c in candidates]
    for ref, c in zip(built, candidates):
        parent_i = c.get("parent_i")
        if isinstance(parent_i, int) and 0 <= parent_i < len(built):
            ref._parent = built[parent_i]
        elif isinstance(c.get("parent_ref"), dict):
            ref._parent = fsref_from_candidate(c["parent_ref"])
    return built


async def stream_ndjson(
    proc: "asyncio.subprocess.Process",
    on_progress: Callable[[Any], Awaitable[None]] | None,
    *,
    collect_candidates: bool,
    label: str = "indexer child",
) -> tuple[dict | None, list[dict]]:
    """Drive an already-spawned child, translating its stdout NDJSON.

    Returns ``(result_json, candidates)``. Raises ``RuntimeError`` when the
    child exits with a code outside ``OK_RETURNCODES``.

    Two details are load-bearing:

    * **stderr is drained concurrently.** A chatty child that fills the stderr
      pipe would otherwise block forever writing to it, while we block forever
      reading stdout — a deadlock, not a slow run.
    * **the child is killed in ``finally``.** On cancellation (server shutdown,
      the caller's activity unwinding) the child must die with its parent
      instead of being orphaned to keep walking the filesystem. This is a
      lifetime guarantee, not a timeout — no wait budget is introduced here.
    """
    result_json: dict | None = None
    candidates: list[dict] = []
    assert proc.stdout is not None and proc.stderr is not None
    stderr_task = asyncio.create_task(proc.stderr.read())
    try:
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(d, dict):
                continue
            if "result" in d:
                result_json = d["result"]
            elif collect_candidates and "path" in d and "record_type" in d:
                candidates.append(d)
            elif "job_name" in d and on_progress is not None:
                await on_progress(table_from_json(d))
        stderr = await stderr_task
        rc = await proc.wait()
        if rc not in OK_RETURNCODES:
            raise RuntimeError(
                f"{label} failed (rc={rc}): "
                f"{stderr.decode('utf-8', errors='replace')[-2000:]}"
            )
        return result_json, candidates
    finally:
        if not stderr_task.done():
            stderr_task.cancel()
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            else:
                await proc.wait()
