"""FlowCall logs: a block's calls, collected as rows of a dataset in temp, and a run read back whole.

A block opts in with ``log`` in its ``compute_op.json`` (``CallLogSpec``). ``run_op`` then hands
each of its answers here, and the call is appended -- after the answer exists, in the background,
never raising -- to this instance's log dataset for the block (a ``TempLog``):

    <FLOWPAD_TEMP_DIR>/<instance>/agentic-assets/dataset/call-log-<block>/

A row is the block's own call: ``input`` and ``output`` as ``{"value": ...}`` of the block's
declared shapes -- or, when ``log.dataset_kind`` names a registered dataset kind (the block's eval
set kind), as that kind's rows, so the eval that reads that set reads this one. ``data`` is the
trace: ``invocation_id`` (the run), ``call_id``, ``parent_call_id`` (the call that made this one),
``block``, ``exit_code``, ``latency_ms`` and ``logged_at``. ``trace(invocation_id)`` reads every
call log and rebuilds the run's tree; ``promote`` copies a run out whole, to keep it.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flow_sdk.core.compute.declared_value import MISSING
from flow_sdk.core.log_dataset import TempLog, rows, temp_datasets

logger = logging.getLogger(__name__)

#: Every call log's folder starts with this, so ``trace`` finds them all and nothing else.
PREFIX = "call-log-"

#: One writer per block log, so its indexed row is looked up once (``TempLog.indexed``).
_logs: dict[str, TempLog] = {}


def log_of(spec: Any) -> TempLog:
    """The log a block's calls go to."""
    name = spec.name or "op"
    # A dataset slot is a value of a schema, never a bare primitive: the block's own shapes are
    # each held as ``{"value": <shape>}``. A declared kind is its own shape.
    shape = spec.log.dataset_kind or {"rows": [{
        "input": {"value": spec.input if spec.input is not None else "string"},
        **({"output": {"value": spec.output_shape}} if spec.output_shape is not None else {}),
    }]}
    folder = spec.log.name or PREFIX + (re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-") or "op")
    found = _logs.get(folder)
    if found is None or found.spec != shape:
        found = _logs[folder] = TempLog(
            folder, spec.log.title or f"CallLog {name}", shape,
            f"Every call of the {name!r} block while its log is on: what went in, what came out, "
            "and the run it belonged to. Review and label the rows to evaluate the block.")
    return found


def wrap(spec: Any, value: Any) -> Any:
    """A block's value as its log holds it: as is for a declared ``dataset_kind``, else ``{"value": ...}``."""
    return value if spec.log is not None and spec.log.dataset_kind else {"value": value}


def unwrap(spec: Any, held: Any) -> Any:
    """``wrap`` undone: the block's own value from what its log holds (a row's ``input``)."""
    return held if spec.log is not None and spec.log.dataset_kind else held.value


def dump(value: Any) -> Any:
    """A value as a row holds it: plain JSON."""
    as_json = getattr(value, "model_dump", None)
    return as_json(mode="json", exclude_none=True) if callable(as_json) else value


def _fits(value: Any, limit: int) -> bool:
    return len(json.dumps(value, default=str).encode()) <= limit


def row_of(spec: Any, input: Any, answer: Any, context: Any, latency_ms: float) -> Optional[dict]:
    """One call as a log row -- None when its input is too big to keep (``max_row_bytes``)."""
    limit = spec.log.max_row_bytes

    def held(value: Any) -> Any:
        return wrap(spec, value)

    given = "" if input is MISSING else dump(input)
    if not _fits(given, limit):
        return None
    data = _trace(spec, answer, context, latency_ms)
    if spec.log.row:
        from flow_sdk.core.compute_op.python import load_module  # noqa: PLC0415

        row = getattr(load_module(context), spec.log.row)(given, answer)
        if row is None:
            return None
        if not _fits(row, limit):
            return None
        return {**row, "data": {**data, **(row.get("data") or {})}}
    row = {"kind": "train", "input": held(given), "data": data}
    if spec.output_shape is not None and answer.has_value:
        output = dump(answer.value)
        if _fits(output, limit):
            row["output"] = held(output)
        else:
            data["truncated"] = ["output"]
    return row


def _trace(spec: Any, answer: Any, context: Any, latency_ms: float) -> dict:
    """What every row's ``data`` carries: the call's place in its run, and how it went."""
    from flow_sdk.core.compute_op.python import block_version  # noqa: PLC0415

    folder = getattr(context, "asset_folder", None)
    return {
        "invocation_id": answer.invocation_id,
        "call_id": getattr(context, "call_id", None),
        "parent_call_id": getattr(context, "parent_call_id", None),
        "block": spec.name,
        # What produced it: the block's files (``block_version``) and the model that answered, if any.
        "block_folder": str(folder) if folder else None,
        "project": getattr(context, "project", None),
        "version": block_version(folder) if folder and Path(folder).is_dir() else None,
        "model": getattr(answer, "endpoint", None),
        "exit_code": answer.exit_code.name,
        "detail": answer.detail,
        "latency_ms": round(latency_ms, 1),
        "logged_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def log_soon(spec: Any, input: Any, answer: Any, context: Any, latency_ms: float) -> None:
    """Log one call of a block whose ``spec.log`` is set. Never raises."""
    try:
        if spec.log.enabled_by:
            from flow_sdk.preferences import read_instance_pref  # noqa: PLC0415

            if not read_instance_pref(spec.log.enabled_by, False):
                return
        row = row_of(spec, input, answer, context, latency_ms)
        if row is None:
            logger.info("call log %s: input over %d bytes, not logged", spec.name, spec.log.max_row_bytes)
            return
        log_of(spec).append_soon(row, max_rows=spec.log.max_rows)
    except Exception as exc:  # noqa: BLE001 -- a log must never break a call
        logger.warning("call log %s: %s", spec.name, exc)


def _run_rows(invocation_id: str) -> list[tuple[Path, Path, dict]]:
    """Every logged call of one run: ``(log folder, example dir, data)`` -- ``row.json`` only."""
    from flow_sdk.schema.data_spec.layout import _load_row_meta  # noqa: PLC0415 -- the cheap per-row read

    root = temp_datasets()
    found = []
    # Every temp log: a block's log may name its own folder (``log.name``).
    for folder in sorted(p for p in root.iterdir() if (p / "dataset.json").is_file()) if root.is_dir() else []:
        for ex_dir in rows(folder):
            data = _load_row_meta(ex_dir)[1]
            if data.get("invocation_id") == invocation_id:
                found.append((folder, ex_dir, data))
    return found


def trace(invocation_id: str) -> list[dict]:
    """One run's logged calls as a tree: the roots, each with its ``children``, in logged order.

    A call whose parent was not logged (its block has no log, or the row aged out) is a root.
    """
    nodes = [{**data, "log": folder.name, "key": ex_dir.name, "children": []}
             for folder, ex_dir, data in _run_rows(invocation_id)]
    nodes.sort(key=lambda n: n.get("logged_at") or "")
    by_call = {n["call_id"]: n for n in nodes if n.get("call_id")}
    roots = []
    for node in nodes:
        parent = by_call.get(node.get("parent_call_id"))
        (parent["children"] if parent is not None and parent is not node else roots).append(node)
    return roots


async def promote(invocation_id: str, to: Any) -> list[str]:
    """Copy one run's logged rows, all of them, into a kept dataset ``to``; the new example ids.

    A run is kept whole or not at all: ``to.append`` writes every row or none.
    """
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

    logs: dict[Path, Any] = {}
    copied = []
    for folder, ex_dir, _ in _run_rows(invocation_id):
        log = logs.setdefault(folder, Dataset.at(folder))
        row = log.row(ex_dir.name)
        if row is not None:
            copied.append({k: row[k] for k in ("input", "output", "context", "kind", "data") if row.get(k) is not None})
    return await to.append(copied) if copied else []


__all__ = ["PREFIX", "dump", "log_of", "log_soon", "promote", "row_of", "trace", "unwrap", "wrap"]
