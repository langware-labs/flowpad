"""`flow schema ...` CLI subgroup.

Lets the agent introspect the type registry — what record/entity types
exist, and what the JSON shape of any one of them looks like — so it can
construct new records via ``flow record index``.
"""

from __future__ import annotations

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


def _why_not_indexed(folder: Path) -> str:
    """The indexer walks into a schema folder only through folders that are schemas themselves."""
    from flow_sdk.schema.data_spec.declared import FAMILY, MAIN  # noqa: PLC0415

    for parent in folder.parents:
        if parent.parent.name == FAMILY and not (parent / MAIN).is_file():
            return (
                f"not indexed: {parent} groups schemas but has no {MAIN}; "
                f'write {{"type": "{FAMILY}", "ns": "<the schemas\' ns>"}} there (a documentation node) and apply again'
            )
    return "not indexed"


def _walk_root(root: Path) -> Path:
    """Where a walk must start to see ``root``'s schemas: the folder HOLDING ``agentic-assets``."""
    from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR  # noqa: PLC0415
    from flow_sdk.schema.data_spec.declared import FAMILY  # noqa: PLC0415

    if root.name == FAMILY and root.parent.name == AGENTIC_ASSETS_DIR:
        return root.parent.parent
    return root.parent if root.name == AGENTIC_ASSETS_DIR else root


def schema_folders_under(root: Path) -> "list[Path]":
    """Every data schema folder at or below ``root``: a schema and the ones it groups, its family
    folder, an ``agentic-assets`` folder, or any tree."""
    from flow_sdk.schema.data_spec.declared import MAIN, data_schema_folders  # noqa: PLC0415

    below = [f for f in data_schema_folders(_walk_root(root)) if root in f.parents]
    return [root, *below] if (root / MAIN).is_file() else below


def apply_report(rows: "dict[Path, dict | None]") -> "list[dict]":
    """One entry per data schema folder, from the row indexed at its path (``None``: none was).
    The kind is the folder name; the file's ``name`` can be stale after a rename."""
    first: dict[str, Path] = {}  # kind -> the folder that defines it; a second folder is a duplicate
    out: list[dict] = []
    for folder, row in rows.items():
        kind = folder.name
        owner = first.setdefault(kind, folder)
        if owner != folder:
            error = f"kind {kind!r} is already defined by {owner}"
        elif row is None:
            error = _why_not_indexed(folder)
        else:
            error = row.get("error") or ""
        entry = {"folder": str(folder), "kind": kind}
        if error:
            out.append({**entry, "status": "error", "error": error})
        else:
            fields = sorted((row.get("fields") or {}).keys())
            ok = {**entry, "status": "ok", "subkind": row.get("subkind"), "fields": fields}
            ignored = _ignored_keys(folder)
            out.append({**ok, "ignored": ignored} if ignored else ok)
    return out


def _ignored_keys(folder: Path) -> "list[str]":
    """Keys a ``data_schema.json`` carries that the schema does not read -- dropped silently
    otherwise (``name``: the folder name IS the kind)."""
    import json  # noqa: PLC0415

    from flow_sdk.schema.data_spec.data_schema_spec import DataSchemaDocSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.declared import MAIN  # noqa: PLC0415

    try:
        doc = json.loads((folder / MAIN).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    known = set(DataSchemaDocSpec.model_fields) | {"type", "id"}
    return sorted(k for k in (doc if isinstance(doc, dict) else {}) if k not in known)


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
    from flow_sdk.schema.data_spec.declared import FAMILY, MAIN  # noqa: PLC0415

    root = Path(_caller_abs_path(path))
    if not root.exists():
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"Path does not exist: {path}")
    folders = schema_folders_under(root)
    if not folders:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No data schema folder under {root}")

    port = _discover_port()
    calls = []
    if (root / MAIN).is_file():  # the folder itself: the direct path always re-reads it
        calls.append({"path": str(root)})
    if folders != [root]:  # the ones below: a walk, forced so an unchanged one that failed re-registers
        calls.append({"path": str(_walk_root(root)), "force": "true"})
    for params in calls:
        _graph_json(
            "POST",
            _graph_url(port, "compute_node/@local/fs-records/index"),
            params={"type": FAMILY, **params},
            timeout=120,
            on_error=_server_error,
        )
    rows: dict[Path, "dict | None"] = {}
    for f in folders:
        row = _get_graph_json(
            f"http://127.0.0.1:{port}/api/v1/assets/entity", params={"path": str(f)}, on_error=_server_error
        )
        # The lookup falls back to the CONTAINING asset; only a row at this folder's own path counts.
        at = {Path(o.get("path") or "") for o in (row or {}).get("asset_occurrences") or []}
        rows[f] = row if row and (Path(row.get("asset_ref") or "") == f or f in at) else None
    report = apply_report(rows)
    errors = [r for r in report if r["status"] == "error"]
    if errors:
        _fail(
            EXIT_SCHEMA_ERRORS,
            "SCHEMA_ERRORS",
            f"{len(errors)} of {len(report)} schemas did not register",
            {"schemas": report},
        )
    _ok({"schemas": report})
