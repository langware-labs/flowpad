"""`flow record ...` CLI subgroup.

Persists records the agent has just written to disk into the database
via the canonical FSIndexer pipeline.

The intended workflow is:
    1. ``flow schema info <type>`` — learn the manifest shape and where
       on disk this type lives.
    2. Write the manifest file at the location the schema points to.
    3. ``flow record index <path>`` — run the indexer; the new record
       appears in the DB.
"""

from __future__ import annotations
from flow_sdk.instance_settings import get_instance_settings

import json
import os
from typing import Any, Optional

import requests
import typer
from typing_extensions import Annotated


record_app = typer.Typer(
    name="record",
    help="CRUD on Flowpad records (entities backed by on-disk files).",
    add_completion=False,
    no_args_is_help=True,
)


EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_INDEX_FAILED = 6


def _discover_port() -> int:
    from flow_sdk.discovery.flowpad_discovery import read_server_info

    info = read_server_info()
    if info:
        return info.port
    return get_instance_settings().port


def _fail(exit_code: int, error_code: str, message: str) -> None:
    typer.echo(f"Error: {message}", err=True)
    typer.echo(json.dumps({"ok": False, "error_code": error_code, "error": message}), err=True)
    raise typer.Exit(exit_code)


def _ok(payload: dict[str, Any]) -> None:
    typer.echo(json.dumps({"ok": True, **payload}))


@record_app.command(
    "index",
    help=(
        "Run the FSIndexer over the user's known roots and persist any new "
        "records found. Pass --types to scope parsing to a subset (e.g. "
        "'task' after writing a task manifest)."
    ),
)
def index_record(
    path: Annotated[
        str,
        typer.Argument(help="Absolute path the agent just wrote to (file or directory)."),
    ],
    types: Annotated[
        Optional[str],
        typer.Option(
            "--types",
            "-t",
            help="Comma-separated record types to index (e.g. 'task,skill'). Default: all.",
        ),
    ] = None,
) -> None:
    if not path:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "path is required")

    # The generic indexer walks the full known-root set regardless of `path`;
    # we keep `path` as the agent's sanity check (and to preserve the
    # NOT_FOUND contract the old agent endpoint enforced server-side).
    if not os.path.exists(os.path.expanduser(path)):
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"Path does not exist: {path}")

    type_list = [t.strip() for t in types.split(",") if t.strip()] if types else []

    port = _discover_port()
    # Drive the canonical generic indexer directly — there is no agent-specific
    # index endpoint. The action filters one type per call, so iterate the
    # requested subset (preserving "only parse named types"); with no --types,
    # a single unfiltered call indexes everything.
    url = f"http://127.0.0.1:{port}/api/v1/graph/compute_node/@local/fs-records/index"
    calls: list[dict] = [{"type": t} for t in type_list] or [{}]

    per_type: dict[str, Any] = {}
    total_indexed = 0
    total_errors = 0
    duration_ms = 0.0

    for params in calls:
        try:
            resp = requests.post(url, params=params, timeout=120)
        except requests.exceptions.RequestException as e:
            _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
            return
        try:
            out = resp.json()
        except ValueError:
            _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Bad response: {resp.text[:200]}")
            return

        if resp.status_code != 200 or out.get("status") != "SUCCESS":
            # Map the generic graph envelope onto the CLI's stable error codes.
            msg = str(out.get("message") or out.get("error") or f"HTTP {resp.status_code}")
            if resp.status_code == 400:
                _fail(EXIT_INVALID_ARG, "INVALID_ARG", msg)
            elif resp.status_code == 409:
                _fail(EXIT_INDEX_FAILED, "INDEX_BUSY", msg)
            else:
                _fail(EXIT_INDEX_FAILED, "INDEX_FAILED", msg)
            return

        data = out.get("data") or {}
        # Full index → {types: [...], new, errors, duration_ms};
        # single-type   → flat {type, indexed, errors}.
        rows = data.get("types")
        if rows is None and data.get("type"):
            rows = [data]
        for row in rows or []:
            t = str(row.get("type"))
            per_type[t] = {
                "indexed": int(row.get("new", row.get("indexed", 0)) or 0),
                "errors": int(row.get("errors", 0) or 0),
                "skipped": int(row.get("skipped", 0) or 0),
            }
        total_indexed += int(data.get("new", data.get("indexed", 0)) or 0)
        total_errors += int(data.get("errors", 0) or 0)
        duration_ms += float(data.get("duration_ms", 0.0) or 0.0)

    _ok(
        {
            "path": os.path.expanduser(path),
            "total_indexed": total_indexed,
            "total_errors": total_errors,
            "duration_ms": duration_ms,
            "per_type": per_type,
        }
    )


# ─────────────────────────────────────────────────────────────────────────────
# `flow record search` — FTS5 search across all indexed records
# ─────────────────────────────────────────────────────────────────────────────


# Window → seconds. ``all`` and ``0`` disable the time filter.
_TIME_WINDOWS = {
    "all": None,
    "0": None,
    "1h": 3600,
    "6h": 6 * 3600,
    "12h": 12 * 3600,
    "1d": 86400,
    "7d": 7 * 86400,
    "1w": 7 * 86400,
    "1m": 30 * 86400,
}


def _parse_time_window(time_arg: str) -> "int | None":
    """Resolve a ``time`` argument into a seconds-cutoff; None = no filter."""
    if time_arg is None:
        return None
    key = time_arg.strip().lower()
    if key in _TIME_WINDOWS:
        return _TIME_WINDOWS[key]
    raise ValueError(
        f"Unknown time window: {time_arg!r}. "
        f"Use one of: {', '.join(_TIME_WINDOWS.keys())}"
    )


def _filter_by_time(results: list[dict], window_seconds: "int | None") -> list[dict]:
    """Drop rows whose ``modified_at`` is older than now - window_seconds."""
    if window_seconds is None:
        return results
    from datetime import datetime, timedelta, timezone

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)

    def _is_recent(row: dict) -> bool:
        ts = row.get("modified_at") or ""
        if not ts:
            return False
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return False
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt >= cutoff

    return [r for r in results if _is_recent(r)]


@record_app.command(
    "search",
    help=(
        "FTS5-search the local record DB. Returns matching records as JSON. "
        "Use this to find tasks/skills/agents/specs/plans/markdown/sessions "
        "by name or content before deciding what to open or modify."
    ),
)
def search_record(
    query: Annotated[
        str,
        typer.Argument(help="Search text. FTS5 syntax allowed (AND/OR/prefix*)."),
    ],
    time: Annotated[
        str,
        typer.Argument(
            help=(
                "Time window for ``modified_at``. One of: "
                "all | 1h | 6h | 12h | 1d | 7d | 1w | 1m. "
                "Pass ``all`` to disable the filter."
            ),
        ),
    ],
    limit: Annotated[
        int,
        typer.Argument(help="Maximum results to return (must be >= 1)."),
    ],
) -> None:
    if not query or not query.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "query is required")
    if limit < 1:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "limit must be >= 1")

    try:
        window_seconds = _parse_time_window(time)
    except ValueError as e:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", str(e))
        return

    # Overfetch when post-filtering by time so a tight window doesn't
    # underflow the user's requested limit.
    fetch_limit = limit if window_seconds is None else max(limit * 4, 50)

    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/search"
    params = {"q": query, "limit": fetch_limit}

    try:
        resp = requests.get(url, params=params, timeout=15)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Bad response: {resp.text[:200]}")
        return

    if resp.status_code != 200 or body.get("status") != "SUCCESS":
        _fail(
            EXIT_CONNECTION_ERROR,
            str(body.get("error_code") or "UNKNOWN"),
            str(body.get("message") or body.get("error") or f"HTTP {resp.status_code}"),
        )
        return

    data = body.get("data") or {}
    raw = data.get("results") or []
    filtered = _filter_by_time(raw, window_seconds)[:limit]

    _ok(
        {
            "query": query,
            "time": time,
            "limit": limit,
            "indexer_ready": bool(data.get("indexer_ready", True)),
            "total": len(filtered),
            "results": filtered,
        }
    )
