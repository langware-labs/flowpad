"""`flow navigate ...` CLI subgroup.

Agent-oriented commands that drive the browser UI by POSTing to the
local Flowpad server. Error contract (important — the agent parses these):

    exit 0 — navigation succeeded
    exit 3 — no active tab (nothing is open in a browser)
    exit 4 — entity not found (or unknown type)
    exit 5 — connection error (server unreachable)
    exit 2 — invalid arguments (e.g. malformed typeid)

Success prints one JSON line to stdout. Failure prints a plain-text line
to stderr *and* a JSON line to stderr, so both humans and programs can
parse the outcome.
"""

from __future__ import annotations
from flow_sdk.instance_settings import get_instance_settings

import json
import os
from typing import Any

import requests
import typer
from typing_extensions import Annotated


navigate_app = typer.Typer(
    name="navigate",
    help="Drive the Flowpad UI (navigate the active browser tab).",
    add_completion=False,
    no_args_is_help=True,
)


# Exit codes — stable contract for agents parsing the outcome.
EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NO_ACTIVE_TAB = 3
EXIT_ENTITY_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5


def _discover_port() -> int:
    """Find the running server's port (same helper pattern as flow_cli)."""
    from flow_sdk.discovery.flowpad_discovery import read_server_info

    server_info = read_server_info()
    if server_info:
        return server_info.port
    return get_instance_settings().port


def _fail(exit_code: int, error_code: str, message: str) -> None:
    """Print a parseable error envelope to stderr and exit with the given code."""
    typer.echo(f"Error: {message}", err=True)
    typer.echo(json.dumps({"ok": False, "error_code": error_code, "error": message}), err=True)
    raise typer.Exit(exit_code)


def _ok(payload: dict[str, Any]) -> None:
    typer.echo(json.dumps({"ok": True, **payload}))


@navigate_app.command(
    "entity",
    help="Navigate the active browser tab to an entity's view. Argument is a canonical TypeId (e.g. 'shell-<uuid>', 'project-@local').",
)
def navigate_entity(
    typeid: Annotated[
        str,
        typer.Argument(help="Entity TypeId in '<type>-<id>' form (e.g. 'shell-550e8400-...')"),
    ],
) -> None:
    """POST to /api/v1/agent/navigate/entity and surface the server's verdict.

    The server validates that the entity exists, picks the active tab, and
    pushes a WS message. The CLI just translates HTTP status codes into
    agent-friendly exit codes.
    """
    if not typeid or "-" not in typeid:
        _fail(EXIT_INVALID_ARG, "INVALID_TYPEID", f"Not a TypeId: {typeid!r}")

    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/agent/navigate/entity"

    try:
        resp = requests.post(url, json={"typeid": typeid}, timeout=5)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return  # unreachable — _fail raises typer.Exit

    # Parse JSON body; if the server returned something non-JSON, treat it as
    # a connection-layer failure (5xx with HTML, proxy error, etc.).
    try:
        body = resp.json()
    except ValueError:
        _fail(
            EXIT_CONNECTION_ERROR,
            "CONNECTION_ERROR",
            f"Unexpected server response (status {resp.status_code}): {resp.text[:200]}",
        )
        return

    if resp.status_code == 200 and body.get("ok"):
        _ok({"connection_id": body.get("connection_id"), "type": body.get("type"), "id": body.get("id")})
        return

    error_code = str(body.get("error_code") or "UNKNOWN")
    error_msg = str(body.get("error") or f"HTTP {resp.status_code}")

    mapping = {
        "NO_ACTIVE_TAB": EXIT_NO_ACTIVE_TAB,
        "ENTITY_NOT_FOUND": EXIT_ENTITY_NOT_FOUND,
        "INVALID_TYPEID": EXIT_INVALID_ARG,
    }
    exit_code = mapping.get(error_code, EXIT_CONNECTION_ERROR)
    _fail(exit_code, error_code, error_msg)
