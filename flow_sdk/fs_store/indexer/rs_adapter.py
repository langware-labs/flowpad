"""RSIndexerAdapter — drive the external Rust indexer (RSIndexer) behind the
FSIndexer surface.

The Rust binary is NOT vendored: it is resolved from the
``FLOWPAD_RS_INDEXER_BIN`` env var (absolute path to a built ``fsindexer-rs``
release binary). Backend selection happens in ``build_default_indexer``
(``builtin.py``): env ``FLOWPAD_INDEXER_BACKEND`` > pref
``preferences.advanced.indexer_backend`` > default ``python``. When the
backend is ``rust`` but the binary doesn't resolve, we fail OPEN to the
Python FSIndexer with one warning (mirrors ``vendored_flow_rs_enabled``).

Swap surface honored (see docs/data-management/scan-and-discovery.md):
  - ``scan(opts) -> list[FSRef]``  — spawns ``fsindexer-rs scan
    --emit-candidates``; each emitted candidate line materializes a real
    FSRef (record_type/scope/project_id/json_path), so downstream
    ``from_disk_fn`` / ``_ref_gen_id`` / stat projections work unchanged.
  - ``index(opts) -> IndexResult`` — spawns ``fsindexer-rs index
    --json-progress``; each progress line is translated to an
    ``IndexProgressTable`` and awaited on ``opts.on_progress``; the final
    ``{"result": ...}`` line maps to ``IndexResult``.
  - ``add_function`` / ``add_root`` — accepted and recorded for interface
    parity; the walk graph lives in the binary.
  - ``_discover_records_dir_ids`` — reuses the FSIndexer staticmethod so the
    scan-handler diff keeps working.

Known deliberate limits (Python-only paths, documented):
  - The custom-slice builders (``project_list._project_indexer``,
    ``single_file_indexers._index_single_file`` self-heal) always construct
    a Python FSIndexer directly and are unaffected by the toggle.
  - A destructive ``orphan_action`` combined with a ``scope_filter`` is
    downgraded to ``INDEX`` (safety-first: the Rust sweep has no scope-filter
    narrowing yet); a warning is logged.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import (
    FSIndexer,
    IndexerOptions,
    IndexResult,
    OrphanAction,
    PerTypeIndexResult,
)
from flow_sdk.fs_store.indexer.progress_table import IndexProgressTable, TypeProgressRow
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)

ENV_RS_INDEXER_BIN = "FLOWPAD_RS_INDEXER_BIN"
ENV_INDEXER_BACKEND = "FLOWPAD_INDEXER_BACKEND"
PREF_INDEXER_BACKEND = "preferences.advanced.indexer_backend"


def resolve_rs_indexer_bin() -> Path | None:
    """Absolute path to the RSIndexer binary, or None when not configured/usable."""
    raw = os.environ.get(ENV_RS_INDEXER_BIN, "").strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.is_file():
        logger.warning("RSIndexer binary %s does not exist; falling back to FSIndexer", p)
        return None
    if not os.access(p, os.X_OK):
        logger.warning("RSIndexer binary %s is not executable; falling back to FSIndexer", p)
        return None
    return p


def rs_backend_selected() -> bool:
    """True when the instance asks for the Rust indexer backend.

    Env override wins over the preference (needed by tests and the matrix
    harness); default is the Python FSIndexer.
    """
    env = os.environ.get(ENV_INDEXER_BACKEND, "").strip().lower()
    if env:
        return env == "rust"
    from flow_sdk.preferences import read_instance_pref  # noqa: PLC0415

    return str(read_instance_pref(PREF_INDEXER_BACKEND, "python")).lower() == "rust"


def _table_from_json(d: dict) -> IndexProgressTable:
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


def _result_from_json(d: dict) -> IndexResult:
    per_type: dict[RecordType, PerTypeIndexResult] = {}
    for tname, p in (d.get("per_type") or {}).items():
        try:
            rt = RecordType(tname)
        except ValueError:
            continue
        per_type[rt] = PerTypeIndexResult(
            type=rt,
            indexed=int(p.get("indexed", 0)),
            errors=int(p.get("errors", 0)),
            duration_ms=float(p.get("duration_ms", p.get("index_ms", 0.0))),
            skipped=int(p.get("skipped", 0)),
            orphans_found=int(p.get("orphans_found", 0)),
            orphans_db_removed=int(p.get("orphans_db_removed", 0)),
            orphans_disk_removed=int(p.get("orphans_disk_removed", 0)),
            orphan_ids=tuple(p.get("orphan_ids", []) or []),
            duplicate_groups=int(p.get("duplicate_groups", 0)),
            duplicate_occurrences=int(p.get("duplicate_occurrences", 0)),
        )
    return IndexResult(
        per_type=per_type,
        total_indexed=int(d.get("total_indexed", sum(p.indexed for p in per_type.values()))),
        total_errors=int(d.get("total_errors", sum(p.errors for p in per_type.values()))),
        duration_ms=float(d.get("duration_ms", 0.0)),
        total_orphans_found=int(d.get("total_orphans_found", 0)),
        total_orphans_db_removed=int(d.get("total_orphans_db_removed", 0)),
        total_orphans_disk_removed=int(d.get("total_orphans_disk_removed", 0)),
        total_duplicate_groups=int(d.get("total_duplicate_groups", 0)),
        total_duplicate_occurrences=int(d.get("total_duplicate_occurrences", 0)),
    )


class RSIndexerAdapter:
    """FSIndexer-shaped facade over the external ``fsindexer-rs`` binary."""

    # Delegate: the scan-handler diff calls this staticmethod on the shared
    # indexer object; semantics are pure disk enumeration, identical for both
    # backends.
    _discover_records_dir_ids = staticmethod(FSIndexer._discover_records_dir_ids)
    _resolve_orphan_filter_types = staticmethod(FSIndexer._resolve_orphan_filter_types)

    def __init__(self, bin_path: Path) -> None:
        self._bin = bin_path
        self._roots: list[FSRef] = []
        # (input_type, fn, output_type) — recorded for parity/debugging only.
        self._functions: list[tuple[Any, Any, Any]] = []

    # ── interface parity no-ops ───────────────────────────────────────────
    def add_function(self, record_type, fn, output_type=None) -> None:
        self._functions.append((record_type, fn, output_type))

    def add_root(self, node: FSRef) -> None:
        self._roots.append(node)

    # ── option translation ────────────────────────────────────────────────
    def _common_args(self, opts: IndexerOptions, tmpdir: str) -> list[str]:
        args: list[str] = []
        if opts.types:
            args += ["--types", ",".join(str(t) for t in opts.types)]
        if opts.limit_per_type is not None:
            args += ["--limit-per-type", str(opts.limit_per_type)]
        if opts.include_temp:
            args += ["--include-temp"]
        if opts.project_id:
            args += ["--project-id", opts.project_id]
        if not opts.gitignore:
            args += ["--no-gitignore"]
        roots = opts.roots if opts.roots is not None else (tuple(self._roots) or None)
        if roots is not None:
            roots_payload = [
                {
                    "path": str(r._path),
                    "record_type": str(r.record_type) if r.record_type is not None else None,
                    "scope": r.scope,
                    "project_id": r.project_id,
                }
                for r in roots
            ]
            roots_file = Path(tmpdir) / "roots.json"
            roots_file.write_text(json.dumps(roots_payload), encoding="utf-8")
            args += ["--roots-file", str(roots_file)]
        return args

    async def _stream(self, argv: list[str], on_progress, collect_candidates: bool):
        """Run the binary, translating stdout JSON lines. Returns (result_json,
        candidates) — whichever applies to the subcommand."""
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        result_json: dict | None = None
        candidates: list[dict] = []
        assert proc.stdout is not None and proc.stderr is not None
        # Drain stderr concurrently so a chatty binary can't fill the pipe and
        # deadlock against our stdout reads; we keep the tail for error text.
        stderr_task = asyncio.create_task(proc.stderr.read())
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
                await on_progress(_table_from_json(d))
        stderr = await stderr_task
        rc = await proc.wait()
        if rc not in (0, 2):  # 2 = completed with per-record errors
            raise RuntimeError(
                f"fsindexer-rs failed (rc={rc}): {stderr.decode('utf-8', errors='replace')[-2000:]}"
            )
        return result_json, candidates

    # ── FSIndexer surface ─────────────────────────────────────────────────
    async def scan(self, opts: IndexerOptions | None = None) -> list[FSRef]:
        opts = opts if opts is not None else IndexerOptions()
        with tempfile.TemporaryDirectory(prefix="rsidx-") as tmpdir:
            argv = [str(self._bin), "scan", "--emit-candidates", "--quiet"]
            if opts.on_progress is not None:
                argv.append("--json-progress")
            argv += self._common_args(opts, tmpdir)
            _, candidates = await self._stream(argv, opts.on_progress, collect_candidates=True)
        refs: list[FSRef] = []
        for c in candidates:
            try:
                rt = RecordType(c["record_type"]) if c.get("record_type") else None
            except ValueError:
                rt = None
            refs.append(
                FSRef(
                    Path(c["path"]),
                    record_type=rt,
                    scope=c.get("scope") or None,
                    project_id=c.get("project_id") or None,
                    json_path=c.get("json_path") or None,
                )
            )
        return refs

    async def index(self, opts: IndexerOptions | None = None) -> IndexResult:
        opts = opts if opts is not None else IndexerOptions()
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        settings = get_instance_settings()
        orphan_action = opts.orphan_action
        if orphan_action != OrphanAction.INDEX and opts.scope_filter is not None:
            logger.warning(
                "RSIndexer: scope-filtered destructive orphan_action=%s not supported yet; "
                "downgrading to INDEX (run the sweep with the python backend for scoped cleanup)",
                orphan_action,
            )
            orphan_action = OrphanAction.INDEX

        with tempfile.TemporaryDirectory(prefix="rsidx-") as tmpdir:
            argv = [
                str(self._bin), "index",
                "--db", str(settings.db_path),
                "--shadow-root", str(settings.records_root),
                "--json-progress", "--quiet",
                "--orphan-action", orphan_action.value,
            ]
            if opts.force:
                argv.append("--force")
            argv += self._common_args(opts, tmpdir)
            result_json, _ = await self._stream(argv, opts.on_progress, collect_candidates=False)

        if result_json is None:
            raise RuntimeError("fsindexer-rs emitted no result line")
        return _result_from_json(result_json)
