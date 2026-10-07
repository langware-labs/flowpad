"""`flow schema ...` CLI subgroup.

Lets the agent introspect the type registry — what record/entity types
exist, and what the JSON shape of any one of them looks like — so it can
construct new records via ``flow record index``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    _graph_json,
)
from flow_sdk.cli.commands._common import (
    bad_response_message as _bad_response_message,
)
from flow_sdk.cli.commands._common import (
    caller_abs_path as _caller_abs_path,
)
from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    get_graph_json as _get_graph_json,
)
from flow_sdk.cli.commands._common import (
    graph_url as _graph_url,
)
from flow_sdk.cli.commands._common import (
    local_get as _local_get,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)
from flow_sdk.cli.commands._common import (
    server_error as _server_error,
)

schema_app = typer.Typer(
    name="schema",
    help="Inspect the Flowpad type registry.",
    add_completion=False,
    no_args_is_help=True,
)


EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5


@schema_app.command(
    "views",
    help="List every addressable dock view — what `flow show view` can open.",
)
def list_views() -> None:
    """The view half of the addressing vocabulary (`list` is the entity half).

    Each row carries `pointer: none|optional|required`, so an agent can tell
    `flow show view events` (no pointer) from `flow show view helpdesk/<id>`
    (required) without guessing and eating an exit 2.
    """
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/agent/schema/views"
    try:
        resp = _local_get(url, timeout=10)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
        return
    if resp.status_code == 200 and body.get("ok"):
        _ok({"views": body.get("views") or []})
        return
    _fail(EXIT_CONNECTION_ERROR, str(body.get("error_code") or "UNKNOWN"), str(body.get("error") or "unknown"))


@schema_app.command(
    "list",
    help="List every registered type with its TypeInfo metadata as JSON.",
)
def list_schema() -> None:
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/agent/schema"
    try:
        resp = _local_get(url, timeout=10)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
        return
    if resp.status_code == 200 and body.get("ok"):
        _ok({"types": body.get("types") or []})
        return
    _fail(EXIT_CONNECTION_ERROR, str(body.get("error_code") or "UNKNOWN"), str(body.get("error") or "unknown"))


@schema_app.command(
    "info",
    help="Print TypeInfo + JSON-schema + creation hints for a single type.",
)
def info_schema(
    type_name: Annotated[
        str,
        typer.Argument(help="Type name (e.g. 'task', 'skill', 'subagent')."),
    ],
) -> None:
    if not type_name:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "type name is required")
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/agent/schema/{type_name}"
    try:
        resp = _local_get(url, timeout=5)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
        return
    if resp.status_code == 200 and body.get("ok"):
        _ok({"type": body.get("type") or {}})
        return
    error_code = str(body.get("error_code") or "UNKNOWN")
    mapping = {"NOT_FOUND": EXIT_NOT_FOUND}
    _fail(mapping.get(error_code, EXIT_CONNECTION_ERROR), error_code, str(body.get("error") or "unknown"))


EXIT_SCHEMA_ERRORS = 6


def apply_report(folders: "list[str]", rows: "list[dict]") -> "list[dict]":
    """One entry per data schema folder: the row the index wrote for it, or why there is none."""
    by_path = {
        os.path.realpath(occ.get("path") or ""): row for row in rows for occ in (row.get("asset_occurrences") or [])
    }
    first: dict[str, str] = {}  # kind -> the folder that defines it; a second folder is a duplicate
    out: list[dict] = []
    for folder in folders:
        row = by_path.get(os.path.realpath(folder))
        if row is None:
            out.append({"folder": folder, "status": "error", "error": "not indexed"})
            continue
        kind = row.get("name")
        owner = first.setdefault(kind, folder)
        error = row.get("error") or (f"kind {kind!r} is already defined by {owner}" if owner != folder else "")
        if error:
            out.append({"folder": folder, "kind": kind, "status": "error", "error": error})
        else:
            fields = sorted((row.get("fields") or {}).keys())
            out.append(
                {"folder": folder, "kind": kind, "status": "ok", "subkind": row.get("subkind"), "fields": fields}
            )
    return out


@schema_app.command(
    "apply",
    help=(
        "Register every data schema folder under PATH now -- after any edit, add, move or rename -- "
        "and report each one's live kind or why it did not register. Never restart Flowpad for this."
    ),
)
def apply_schemas(
    path: Annotated[str, typer.Argument(help="A data schema folder, or any tree containing them.")],
) -> None:
    from flow_sdk.schema.data_spec.declared import MAIN, data_schema_folders  # noqa: PLC0415

    root = Path(_caller_abs_path(path))
    if not root.exists():
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"Path does not exist: {path}")
    folders = [root] if (root / MAIN).is_file() else data_schema_folders(root)
    if not folders:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No data schema folder under {root}")

    port = _discover_port()
    # force: an unchanged folder that failed before (its kind held by a moved folder) re-registers.
    _graph_json(
        "POST",
        _graph_url(port, "compute_node/@local/fs-records/index"),
        params={"type": "data_schema", "path": str(root), "force": "true"},
        timeout=120,
        on_error=_server_error,
    )
    rows: list[dict] = []
    for name in sorted({f.name for f in folders}):  # `$IN` does not match `name`; equality does
        found = _get_graph_json(
            _graph_url(port, "data_schema"), params={"filter": json.dumps({"name": name})}, on_error=_server_error
        )
        rows.extend(found if isinstance(found, list) else [])
    report = apply_report([str(f) for f in folders], rows)
    errors = [r for r in report if r["status"] == "error"]
    if errors:
        _fail(
            EXIT_SCHEMA_ERRORS,
            "SCHEMA_ERRORS",
            f"{len(errors)} of {len(report)} schemas did not register",
            {"schemas": report},
        )
    _ok({"schemas": report})
