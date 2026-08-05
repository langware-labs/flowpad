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

import json
import os
import sys
from pathlib import Path
from typing import Any, NoReturn, Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)
from flow_sdk.cli.commands._common import (
    post_graph_json as _post_graph_json,
)

record_app = typer.Typer(
    name="record",
    help="CRUD on Flowpad records (entities backed by on-disk files).",
    add_completion=False,
    no_args_is_help=True,
)


EXIT_OK = 0
EXIT_INVALID_ARG = 2
#: "You need to do something, nothing is damaged." Distinct from ACTION_FAILED
#: (7) so an agent can tell a fixable gate from a broken operation without
#: parsing prose.
EXIT_SHARE_BLOCKED = 3
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_INDEX_FAILED = 6
EXIT_ACTION_FAILED = 7


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
    # Pass the path so the server scopes the walk to this one file/dir (and
    # returns its TypeId) instead of walking every known root — the difference
    # between a sub-second index and a full-workspace hang.
    abs_path = os.path.abspath(os.path.expanduser(path))
    calls: list[dict] = [{"type": t, "path": abs_path} for t in type_list] or [{"path": abs_path}]

    per_type: dict[str, Any] = {}
    typeids: list[str] = []
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
        for tid in data.get("typeids") or []:
            if tid and tid not in typeids:
                typeids.append(tid)

    _ok(
        {
            "path": abs_path,
            "total_indexed": total_indexed,
            "total_errors": total_errors,
            "duration_ms": duration_ms,
            "per_type": per_type,
            # The TypeId(s) the indexer minted for this path — navigate straight
            # to typeids[0] (no fuzzy search needed).
            "typeid": typeids[0] if typeids else None,
            "typeids": typeids,
        }
    )


# ─────────────────────────────────────────────────────────────────────────────
# `flow record url` — the record's clickable deep link, for THIS instance
# ─────────────────────────────────────────────────────────────────────────────

#: Route `error_code` → exit code. Several failures share exit 4; the code in
#: the envelope is what lets an agent tell "not indexed yet" from "wrong kind
#: of thing" without parsing prose.
_URL_EXIT_CODES = {
    "INVALID_ARG": EXIT_INVALID_ARG,
    "NOT_FOUND": EXIT_NOT_FOUND,
    "NOT_INDEXED": EXIT_NOT_FOUND,
    "NO_ASSET_EDITOR": EXIT_NOT_FOUND,
}


@record_app.command(
    "url",
    help=(
        "Print the asset-editor deep link for a record — a URL a human can "
        "click, resolved against this instance and env. Takes the path the "
        "record was written to, or its TypeId. Read-only: never indexes."
    ),
)
def url_record(
    target: Annotated[
        str,
        typer.Argument(
            help=(
                "A file path, or a TypeId ('<type>-<uuid>'). An existing path "
                "always wins — that is what an agent has just written."
            )
        ),
    ],
) -> None:
    """Resolve a record's canonical editor URL.

    The URL is built SERVER-side, not here. In a dev instance the UI is served
    by Vite on a different port than the API, and ``_discover_port`` returns the
    API's — a link built locally would 404 there. The server knows both.

    Exit codes (the ``error_code`` in the failure envelope distinguishes the
    three exit-4 cases, so an agent need not parse prose):

        0 — resolved; ``url`` is in the payload
        2 — INVALID_ARG: empty argument, or neither a path nor a TypeId
        4 — NOT_FOUND / NOT_INDEXED / NO_ASSET_EDITOR
        5 — INSTANCE_NOT_RUNNING / CONNECTION_ERROR
        7 — anything else the server refused
    """
    raw = (target or "").strip()
    if not raw:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "target is required")

    # An existing path wins over TypeId parsing: the agent just wrote the file,
    # and a file literally named `<type>-<uuid>` is the far stranger case.
    expanded = os.path.abspath(os.path.expanduser(raw))
    if os.path.exists(expanded):
        body = {"path": expanded}
    elif "-" in raw:
        body = {"typeid": raw}
    else:
        _fail(
            EXIT_INVALID_ARG,
            "INVALID_ARG",
            f"Not an existing path and not a TypeId: {raw!r}",
        )

    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/display/url"

    def _on_error(status_code: int, rbody: dict) -> NoReturn:
        # Branch on the body's `error_code`, never the transport status:
        # `ApiFailResponse.status_code` is a body field, so these all arrive as
        # HTTP 200 and every failure would otherwise collapse into one code.
        code = str((rbody.get("data") or {}).get("error_code") or "ACTION_FAILED")
        _fail(
            _URL_EXIT_CODES.get(code, EXIT_ACTION_FAILED),
            code,
            str(rbody.get("message") or f"HTTP {status_code}"),
        )

    data = _post_graph_json(url, body, timeout=15, on_error=_on_error)
    _ok({"target": raw, **data})


# ─────────────────────────────────────────────────────────────────────────────
# `flow record share` — put an asset in the cloud, get a reviewer's link
# ─────────────────────────────────────────────────────────────────────────────

#: Route `error_code` → exit code. Everything a user can fix is exit 3; only a
#: genuinely broken operation is 7.
_SHARE_EXIT_CODES = {
    "INVALID_ARG": EXIT_INVALID_ARG,
    "NOT_PUBLISHABLE": EXIT_INVALID_ARG,
    "NOT_FOUND": EXIT_NOT_FOUND,
    "NOT_INDEXED": EXIT_NOT_FOUND,
    "NO_PROJECT": EXIT_NOT_FOUND,
    "PROJECT_NOT_LINKED": EXIT_SHARE_BLOCKED,
    "PROJECT_NOT_READY": EXIT_SHARE_BLOCKED,
    "CLOUD_LOGIN_REQUIRED": EXIT_SHARE_BLOCKED,
    "AUTHENTICATED_USER_REQUIRED": EXIT_SHARE_BLOCKED,
    "GITHUB_NOT_CONNECTED": EXIT_SHARE_BLOCKED,
    "LOCAL_MODE": EXIT_SHARE_BLOCKED,
    "BRANCH_AHEAD": EXIT_SHARE_BLOCKED,
    "BRANCH_DIVERGED": EXIT_SHARE_BLOCKED,
    "NOT_IN_REPO": EXIT_SHARE_BLOCKED,
    "MISSING_REMOTE": EXIT_SHARE_BLOCKED,
    "UNSUPPORTED_ORIGIN": EXIT_SHARE_BLOCKED,
    "DETACHED_HEAD": EXIT_SHARE_BLOCKED,
    "NO_COMMIT": EXIT_SHARE_BLOCKED,
    "DIRTY": EXIT_SHARE_BLOCKED,
    "UNPUSHED": EXIT_SHARE_BLOCKED,
    "STATUS_FAILURE": EXIT_SHARE_BLOCKED,
    # From AssetPublishCode — both are gates the user can act on.
    "ORIGIN_INVALID": EXIT_SHARE_BLOCKED,
    "PROJECT_NOT_PUBLISHED": EXIT_SHARE_BLOCKED,
}


@record_app.command(
    "share",
    help=(
        "Put a git-backed asset in the cloud and print a link a reviewer can "
        "open. Commits ONLY the paths named — the asset plus each --with — and "
        "pushes the branch. Read-only until every gate has passed."
    ),
)
def share_record(
    target: Annotated[
        str,
        typer.Argument(help="A file path, or a TypeId ('<type>-<uuid>'). An existing path wins."),
    ],
    with_paths: Annotated[
        Optional[list[str]],
        typer.Option("--with", help="Another repo path to commit alongside it (repeatable)."),
    ] = None,
    message: Annotated[Optional[str], typer.Option("--message", "-m", help="Commit message.")] = None,
    link_project: Annotated[
        bool,
        typer.Option(
            "--link-project",
            help="Also link the owning project to the cloud if it isn't already. Off by default: "
            "linking publishes a repo declaration to every member, so it is never a side effect.",
        ),
    ] = False,
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Report every gate, mutate nothing.")] = False,
    no_commit: Annotated[
        bool, typer.Option("--no-commit", help="Publish only; assume the paths are already committed and pushed.")
    ] = False,
) -> None:
    """Share an asset and print its cloud URL.

    Exit codes:

        0 — shared; ``url`` is in the payload
        2 — INVALID_ARG / NOT_PUBLISHABLE
        3 — a gate you can fix (project not linked, git not ready, no GitHub);
            nothing was committed or pushed
        4 — NOT_FOUND / NOT_INDEXED / NO_PROJECT
        5 — the instance or the server is unreachable
        7 — the operation itself failed (commit, push, or hub registration)
    """
    raw = (target or "").strip()
    if not raw:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "target is required")

    # Same rule as `flow record url`: an existing path wins, because that is
    # what the agent just wrote.
    expanded = os.path.abspath(os.path.expanduser(raw))
    if os.path.exists(expanded):
        body = {"path": expanded}
    elif "-" in raw:
        body = {"typeid": raw}
    else:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"Not an existing path and not a TypeId: {raw!r}")
    body.update(
        {
            "with_paths": [os.path.abspath(os.path.expanduser(p)) for p in (with_paths or [])],
            "link_project": link_project,
            "dry_run": dry_run,
            "no_commit": no_commit,
        }
    )
    if message:
        body["message"] = message

    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/assets/share"

    def _on_error(status_code: int, rbody: dict) -> "NoReturn":
        data = rbody.get("data") or {}
        code = str(data.get("error_code") or "ACTION_FAILED")
        extra = {k: v for k, v in data.items() if k != "error_code"}
        _fail(
            _SHARE_EXIT_CODES.get(code, EXIT_ACTION_FAILED),
            code,
            str(rbody.get("message") or f"HTTP {status_code}"),
            extra or None,
        )

    data = _post_graph_json(url, body, timeout=180, on_error=_on_error)
    _ok({"target": raw, **data})


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
    raise ValueError(f"Unknown time window: {time_arg!r}. Use one of: {', '.join(_TIME_WINDOWS.keys())}")


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


# ─────────────────────────────────────────────────────────────────────────────
# `flow record favorite/unfavorite` — toggle the current user's favorite
# Bookmark for an entity. Mirrors `useFavorites` on the frontend; the watched
# bookmark query reflects the change in real time without any UI plumbing.
# ─────────────────────────────────────────────────────────────────────────────


def _parse_typeid(raw: str) -> tuple[str, str]:
    """Split a `<type>-<id>` TypeId string into (type, id). Validates via TypeId."""
    from flow_sdk.api.type_id import TypeId  # noqa: PLC0415

    try:
        tid = TypeId(raw)
    except Exception as e:  # noqa: BLE001
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"Invalid TypeId {raw!r}: {e}")
        raise  # unreachable
    return tid.type, str(tid.id)


def _post_json(
    url: str,
    payload: Optional[dict],
    *,
    timeout: int = 15,
    not_found_hint: Optional[str] = None,
) -> dict:
    """POST JSON to a graph endpoint and return its ``data`` envelope.

    Transport/parse handling is the shared ``post_graph_json``; this wrapper
    only supplies record's exit contract. Pass ``not_found_hint`` to map a 404
    to ``EXIT_NOT_FOUND`` with that message; omit it to let a 404 fall through
    to the generic action-failed path.
    """

    def _on_error(status_code: int, body: dict) -> None:
        if status_code == 404 and not_found_hint is not None:
            _fail(EXIT_NOT_FOUND, "NOT_FOUND", not_found_hint)
        _fail(
            EXIT_ACTION_FAILED,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {status_code}"),
        )

    return _post_graph_json(url, payload, timeout=timeout, on_error=_on_error)


def _post_action(action_name: str, typeid_raw: str, payload: Optional[dict] = None) -> dict:
    entity_type, entity_id = _parse_typeid(typeid_raw)
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/{entity_type}/{entity_id}/{action_name}"
    return _post_json(url, payload, timeout=15, not_found_hint=f"Entity not found: {typeid_raw}")


#: Types whose birth path is NOT "materialize a file, then index it".
#: ``source_item`` is minted by the ingestor, which owns its deterministic v5
#: id and its content digest — so creating one means posting it through the
#: ingest route, and re-creating the same item is an idempotent upsert rather
#: than a duplicate. Data, not an ``if``: the second such type just adds a row.
_INGESTED_TYPES: dict[str, str] = {
    "source_item": "/api/v1/ingest/items",
}


@record_app.command(
    "create",
    help=(
        "Create a record from JSON. Types the ingestor owns (source_item) go "
        "through the ingest chokepoint, so re-creating the same item updates it "
        "in place instead of duplicating. Other types are file-backed — "
        "materialize the file and use `flow record index` instead."
    ),
)
def create_record(
    type_name: Annotated[
        str,
        typer.Argument(metavar="TYPE", help="Entity type, e.g. 'source_item'."),
    ],
    json_path: Annotated[
        Optional[str],
        typer.Option(
            "--json",
            "-j",
            help="Path to a JSON file, or '-' for stdin. One object, or an array to batch.",
        ),
    ] = None,
    first_run: Annotated[
        bool,
        typer.Option(
            "--first-run",
            help="Declare this a backfill: saves quietly and emits one summary "
                 "event instead of one per item (the storm caps make that the "
                 "only safe shape for a large first sync).",
        ),
    ] = False,
) -> None:
    type_name = (type_name or "").strip()
    route = _INGESTED_TYPES.get(type_name)
    if not route:
        _fail(
            EXIT_INVALID_ARG,
            "INVALID_ARG",
            f"'{type_name}' is not an ingested type. File-backed records are created by "
            f"writing the file and running `flow record index <path> --types {type_name}`.",
        )

    if not json_path:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "--json is required (a file path, or '-' for stdin)")
    try:
        raw = sys.stdin.read() if json_path == "-" else Path(json_path).read_text(encoding="utf-8")
    except OSError as e:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"Cannot read {json_path}: {e}")
    try:
        parsed = json.loads(raw)
    except ValueError as e:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"Not valid JSON: {e}")

    items = parsed if isinstance(parsed, list) else [parsed]
    if not items:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "No items to create")

    url = f"http://127.0.0.1:{_discover_port()}{route}"

    def _on_error(status_code: int, body: dict) -> None:
        _fail(EXIT_ACTION_FAILED, "ACTION_FAILED",
              body.get("message") or f"Create failed (HTTP {status_code})")

    data = _post_graph_json(
        url, {"items": items, "first_run": first_run}, on_error=_on_error
    )
    _ok({"type": type_name, **data})


@record_app.command(
    "favorite",
    help=(
        "Mark an entity as a favorite for the current user. Idempotent — "
        "running twice on the same entity is a no-op. The frontend reflects "
        "the change in real time via the watched bookmark query."
    ),
)
def favorite_record(
    typeid: Annotated[
        str,
        typer.Argument(help="Entity TypeId, e.g. 'markdown-<uuid>' or 'agentic_process-<uuid>'."),
    ],
    name: Annotated[
        Optional[str],
        typer.Option(
            "--name",
            "-n",
            help="Custom display label for the favorite tile / star tooltip. Defaults to the entity's name.",
        ),
    ] = None,
) -> None:
    if not typeid or not typeid.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "typeid is required")
    payload = {"title": name} if name else None
    data = _post_action("favorite", typeid.strip(), payload=payload)
    _ok({"typeid": typeid, **data})


@record_app.command(
    "unfavorite",
    help=(
        "Remove an entity from the current user's favorites. Idempotent — "
        "running on an un-favorited entity returns deleted=false."
    ),
)
def unfavorite_record(
    typeid: Annotated[
        str,
        typer.Argument(help="Entity TypeId, e.g. 'markdown-<uuid>' or 'agentic_process-<uuid>'."),
    ],
) -> None:
    if not typeid or not typeid.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "typeid is required")
    data = _post_action("unfavorite", typeid.strip(), payload=None)
    _ok({"typeid": typeid, **data})


# ─────────────────────────────────────────────────────────────────────────────
# `flow record comment add/list` — read/write standard ``Comment`` entities on
# any entity (e.g. a task). This is the sanctioned way for a Bash-only wizard
# agent to leave / read notes: it drives the SAME generic comment create/query
# the frontend uses (``comment.save(parentTypeId)`` / ``QueryRequest`` of type
# ``comment`` scoped to the parent). On a hub-remote parent the created comment
# auto-shares to the hub as an ``is_child`` and reaches authorized peers.
# ─────────────────────────────────────────────────────────────────────────────

comment_app = typer.Typer(
    name="comment",
    help="Read/write comments on an entity (tasks, docs, …).",
    add_completion=False,
    no_args_is_help=True,
)


@comment_app.command(
    "add",
    help=(
        "Add a comment to an entity. On a hub-remote parent the comment "
        "auto-shares to the hub and reaches authorized peers. Pass --data to "
        "attach a machine-readable JSON object to the comment's ``data`` field."
    ),
)
def comment_add(
    parent_typeid: Annotated[
        str,
        typer.Argument(help="Parent entity TypeId, e.g. 'task-<uuid>'."),
    ],
    text: Annotated[
        str,
        typer.Argument(help="Comment text (raw_content)."),
    ],
    data: Annotated[
        Optional[str],
        typer.Option(
            "--data",
            help='Optional JSON object for the comment\'s ``data`` field, e.g. \'{"submission_url":"https://…"}\'.',
        ),
    ] = None,
) -> None:
    if not parent_typeid or not parent_typeid.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "parent_typeid is required")
    if not text or not text.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "text is required")
    parent_type, parent_id = _parse_typeid(parent_typeid.strip())
    body: dict[str, Any] = {"raw_content": text}
    if data:
        try:
            parsed = json.loads(data)
        except ValueError as e:
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"--data must be valid JSON: {e}")
            return
        if not isinstance(parsed, dict):
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", "--data must be a JSON object")
            return
        body["data"] = parsed
    port = _discover_port()
    # Create scoped to the parent — mirrors the frontend's create URL
    # (``<scope_path>/<type>``): the create handler sets ``parent_type_id`` from
    # the URL target and auto-shares the child when the parent is hub-remote.
    url = f"http://127.0.0.1:{port}/api/v1/graph/{parent_type}/{parent_id}/comment"
    resp = _post_json(url, body, timeout=15, not_found_hint=f"Entity not found: {parent_typeid}")
    new_id = resp.get("id") or (resp.get("entity") or {}).get("id")
    _ok(
        {
            "parent_typeid": parent_typeid,
            "id": new_id,
            "typeid": f"comment-{new_id}" if new_id else None,
        }
    )


@comment_app.command(
    "list",
    help=(
        "List an entity's comments as JSON (raw_content + data + created_date), "
        "oldest first. For a group task, read each member task's comments to "
        "find the member's submission note."
    ),
)
def comment_list(
    parent_typeid: Annotated[
        str,
        typer.Argument(help="Parent entity TypeId, e.g. 'task-<uuid>'."),
    ],
) -> None:
    if not parent_typeid or not parent_typeid.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "parent_typeid is required")
    parent_type, parent_id = _parse_typeid(parent_typeid.strip())
    parent_key = f"{parent_type}-{parent_id}"
    port = _discover_port()
    # Scoped list route (mirrors the frontend's scoped QueryRequest). The scope
    # query is permissive — it returns comments regardless of parent — so we
    # filter by ``parent_type_id`` ourselves, exactly like ``useDocComments``.
    # ``expand=blobs`` so the blob-excluded ``raw_content`` is served.
    url = f"http://127.0.0.1:{port}/api/v1/graph/{parent_type}/{parent_id}/comment"
    try:
        resp = requests.get(url, params={"expand": "blobs"}, timeout=15)
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
            EXIT_ACTION_FAILED,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {resp.status_code}"),
        )
        return
    raw = body.get("data") or []
    comments = [
        {
            "id": c.get("id"),
            "raw_content": c.get("raw_content"),
            "data": c.get("data") or {},
            "created_date": c.get("created_date"),
        }
        for c in raw
        if isinstance(c, dict) and c.get("parent_type_id") == parent_key
    ]
    comments.sort(key=lambda c: c.get("created_date") or "")
    _ok({"parent_typeid": parent_typeid, "total": len(comments), "comments": comments})


record_app.add_typer(comment_app, name="comment")


# ─────────────────────────────────────────────────────────────────────────────
# `flow record adopt-claude-session` — create an AgenticProcess record that
# points at an existing Claude Code session transcript. The new record is
# saved via the generic POST /api/v1/graph/agentic_process endpoint and shows
# up immediately in the UI via the watched bookmark/process queries.
# ─────────────────────────────────────────────────────────────────────────────


def _find_claude_session_jsonl(session_id: str) -> tuple[str, str] | None:
    """Locate ``~/.claude/projects/*/<session_id>.jsonl`` and return (path, cwd).

    cwd is read from the first JSONL entry's ``cwd`` envelope field. Returns
    None if no transcript with that session_id exists on disk.
    """
    import json as _json

    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    projects_dir = get_instance_settings().claude_projects_dir
    if not projects_dir.is_dir():
        return None
    fname = f"{session_id}.jsonl"
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / fname
        if not candidate.exists():
            continue
        cwd = ""
        try:
            with candidate.open("r", encoding="utf-8", errors="replace") as f:
                # Scan the first ~20 lines for an envelope carrying ``cwd``;
                # Claude writes a few synthetic events before the user prompt.
                for _ in range(20):
                    raw_line = f.readline()
                    if not raw_line:
                        break
                    try:
                        raw = _json.loads(raw_line)
                    except _json.JSONDecodeError:
                        continue
                    if isinstance(raw, dict) and raw.get("cwd"):
                        cwd = str(raw["cwd"])
                        break
        except OSError:
            return (str(candidate), "")
        return (str(candidate), cwd)
    return None


@record_app.command(
    "adopt-claude-session",
    help=(
        "Create an agentic_process record pointing at an existing Claude "
        "Code session transcript. The session's cwd is auto-discovered from "
        "the JSONL envelope; pass --workdir to override. Returns the new "
        "TypeId, which can be piped into `flow record favorite`."
    ),
)
def adopt_claude_session(
    session_id: Annotated[
        str,
        typer.Argument(help="Claude Code session UUID (the .jsonl filename without extension)."),
    ],
    workdir: Annotated[
        Optional[str],
        typer.Option(
            "--workdir",
            "-w",
            help="Override the cwd recorded on the agentic_process. Defaults to the cwd extracted from the JSONL envelope.",
        ),
    ] = None,
    name: Annotated[
        Optional[str],
        typer.Option(
            "--name",
            "-n",
            help="Display name for the new agentic_process. Defaults to 'claude-session <session_id-prefix>'.",
        ),
    ] = None,
    visible: Annotated[
        bool,
        typer.Option(
            "--visible/--invisible",
            help="Whether the process is visible in the tabs view. Default: True.",
        ),
    ] = True,
) -> None:
    if not session_id or not session_id.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "session_id is required")
    sid = session_id.strip()

    found = _find_claude_session_jsonl(sid)
    if found is None:
        _fail(
            EXIT_NOT_FOUND,
            "NOT_FOUND",
            f"No transcript found for session {sid} in the Claude projects directory",
        )
    jsonl_path, discovered_cwd = found
    effective_workdir = workdir or discovered_cwd
    if not effective_workdir:
        _fail(
            EXIT_INVALID_ARG,
            "INVALID_ARG",
            f"Could not determine workdir for session {sid}; pass --workdir explicitly.",
        )
    display_name = name or f"claude-session {sid[:8]}"

    body = {
        "session_id": sid,
        "workdir": effective_workdir,
        "name": display_name,
        "visible": visible,
    }
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process"
    data = _post_json(url, body, timeout=30)
    new_id = data.get("id") or (data.get("entity") or {}).get("id")
    new_typeid = f"agentic_process-{new_id}" if new_id else None
    _ok(
        {
            "session_id": sid,
            "jsonl_path": jsonl_path,
            "workdir": effective_workdir,
            "name": display_name,
            "id": new_id,
            "typeid": new_typeid,
        }
    )
