"""`flow schema ...` CLI subgroup.

Lets the agent introspect the type registry — what record/entity types
exist, and what the JSON shape of any one of them looks like — so it can
construct new records via ``flow record index``.
"""

from __future__ import annotations

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
    "list",
    help="List every registered type with its TypeInfo metadata as JSON.",
)
def list_schema() -> None:
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/agent/schema"
    try:
        resp = requests.get(url, timeout=10)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Bad response: {resp.text[:200]}")
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
        resp = requests.get(url, timeout=5)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Bad response: {resp.text[:200]}")
        return
    if resp.status_code == 200 and body.get("ok"):
        _ok({"type": body.get("type") or {}})
        return
    error_code = str(body.get("error_code") or "UNKNOWN")
    mapping = {"NOT_FOUND": EXIT_NOT_FOUND}
    _fail(mapping.get(error_code, EXIT_CONNECTION_ERROR), error_code, str(body.get("error") or "unknown"))
