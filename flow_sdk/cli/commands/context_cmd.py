"""`flow context ...` CLI subgroup.

Agent-oriented commands that read the browser-side data context — current
project / process / workspace TypeIds, etc. — for use in skills like
``flowpad-assistance`` to compose actions like "navigate to current project"
without asking the user for an id.

Error contract (parsed by the agent — keep stable):

    exit 0 — success, JSON written to stdout
    exit 3 — no active tab (nothing is open in a browser)
    exit 4 — connection not found (when --connection-id is supplied)
    exit 5 — connection error (server unreachable)
    exit 2 — invalid arguments
"""

from __future__ import annotations

from typing import Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
    fail as _fail,
    ok as _ok,
)


context_app = typer.Typer(
    name="context",
    help="Read the browser-side data context for the active (or specified) tab.",
    add_completion=False,
    no_args_is_help=True,
)


# Stable contract — keep aligned with `navigate_cmd.py`.
EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NO_ACTIVE_TAB = 3
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5


@context_app.command(
    "list",
    help=(
        "Print the data-context snapshot for the active tab as JSON. "
        "Pass --connection-id to target a specific tab."
    ),
)
def list_context(
    connection_id: Annotated[
        Optional[str],
        typer.Option("--connection-id", "-c", help="Target a specific WS connection by id."),
    ] = None,
) -> None:
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/agent/context"
    params = {"connection_id": connection_id} if connection_id else None

    try:
        resp = requests.get(url, params=params, timeout=5)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return

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
        _ok(
            {
                "connection_id": body.get("connection_id"),
                "context": body.get("context") or {},
            }
        )
        return

    error_code = str(body.get("error_code") or "UNKNOWN")
    error_msg = str(body.get("error") or f"HTTP {resp.status_code}")
    mapping = {
        "NO_ACTIVE_TAB": EXIT_NO_ACTIVE_TAB,
        "CONNECTION_NOT_FOUND": EXIT_NOT_FOUND,
    }
    _fail(mapping.get(error_code, EXIT_CONNECTION_ERROR), error_code, error_msg)
