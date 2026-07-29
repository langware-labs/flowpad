"""Child process for ``SubprocessScanIndexer`` — runs the walk, streams candidates.

Invoked as ``python -m flow_sdk.fs_store.indexer.scan_child`` with one JSON
request object on **stdin** (then EOF), and speaks the NDJSON protocol defined in
``ndjson_stream`` on **stdout**.

The request rides on stdin rather than argv because a full all-projects root set
overflows the ARGV limit — the Rust adapter already had to spill its roots to a
temp file for exactly that reason, and stdin needs no temp file and no cleanup.

**This process never opens the instance DB.** It runs ``FSIndexer.scan()``, which
is pure discovery, and hands the results back for the parent to persist. That is
the whole point of the split.
"""
from __future__ import annotations

import json
import logging
import sys

# ── stdout protection, before anything else can print ────────────────────────
#
# stdout is the protocol channel: one JSON object per line, nothing else. Any
# stray `print` from an imported module (flow_sdk's service_log banner is a real
# example) would corrupt the stream and be silently dropped by the parser at
# best. So capture the real stdout for our own use and repoint `sys.stdout` at
# stderr, where noise is harmless and still visible for debugging.
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
log = logging.getLogger("scan_child")


def _emit(obj: dict, *, flush: bool = True) -> None:
    """Write one protocol line.

    Progress lines flush immediately — the parent renders them live. Candidate
    lines don't: the parent acts on none of them until the terminal ``result``
    line arrives, so flushing per candidate would turn a bulk transfer into one
    pipe write per discovered ref (tens of thousands on a real workspace).
    """
    _PROTOCOL_OUT.write(json.dumps(obj, default=str) + "\n")
    if flush:
        _PROTOCOL_OUT.flush()


def _adopt_store_paths(request: dict) -> None:
    """Point this process at the parent's records/data roots when it sent them."""
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.fs_store.record_paths import (  # noqa: PLC0415
        set_default_records_data_root,
        set_default_records_root,
    )

    root = request.get("records_root")
    data_root = request.get("records_data_root")
    if root:
        set_default_records_root(Path(root))
    if data_root:
        set_default_records_data_root(Path(data_root))


async def _run(request: dict) -> int:
    from flow_sdk.fs_store.indexer.auto_index import ScanMode  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.builtin import build_default_indexer  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.ndjson_stream import (  # noqa: PLC0415
        candidates_with_parents,
        fsrefs_from_candidates,
        table_to_payload,
    )
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    raw_opts = request.get("opts") or {}
    raw_roots = request.get("roots")
    want_progress = bool(request.get("progress"))

    # Adopt the parent's effective shadow-store paths BEFORE building the indexer.
    # These are process globals the parent may have overridden at runtime, and
    # walkers that discover projects read them — re-deriving from instance settings
    # here would make the child walk a different store than the caller intended.
    _adopt_store_paths(request)

    types = None
    if raw_opts.get("types"):
        types = []
        for name in raw_opts["types"]:
            try:
                types.append(RecordType(name))
            except ValueError:
                log.warning("unknown record type %r in request; ignoring", name)

    roots = tuple(fsrefs_from_candidates(raw_roots)) if raw_roots is not None else None

    async def on_progress(table) -> None:
        _emit(table_to_payload(table))

    # ScanMode.THREAD is passed EXPLICITLY, never defaulted. Taking the default
    # would re-read the index_function preference, resolve SUBPROCESS again, and
    # fork-bomb: every child would spawn its own child.
    indexer = build_default_indexer(scan_mode=ScanMode.THREAD)

    refs = await indexer.scan(
        IndexerOptions(
            types=types,
            limit=raw_opts.get("limit"),
            limit_per_type=raw_opts.get("limit_per_type"),
            include_temp=bool(raw_opts.get("include_temp")),
            gitignore=bool(raw_opts.get("gitignore", True)),
            project_id=raw_opts.get("project_id"),
            force=bool(raw_opts.get("force")),
            verbose=False,
            roots=roots,
            on_progress=on_progress if want_progress else None,
        )
    )

    # Emit with parent links: index() reads ref._parent to derive each record's
    # enclosure parent, so a flattened candidate would drop parent_type_id.
    for payload in candidates_with_parents(refs):
        _emit(payload, flush=False)

    # The terminal line. Its presence is what tells the parent the walk finished
    # rather than the process dying part-way through; the count lets the parent
    # detect a stream truncated after the fact.
    _emit({"result": {"candidates": len(refs)}})
    return 0


def _main() -> int:
    import asyncio  # noqa: PLC0415

    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as e:
        log.error("could not read the request from stdin: %s", e)
        return 1
    if not isinstance(request, dict):
        log.error("request must be a JSON object, got %s", type(request).__name__)
        return 1
    try:
        return asyncio.run(_run(request))
    except Exception:
        log.exception("scan failed")
        return 1


if __name__ == "__main__":
    sys.exit(_main())
