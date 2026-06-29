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


import requests
import typer
from typing import Optional
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
    fail as _fail,
    ok as _ok,
)


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


def _navigate(url: str, body: dict, success_keys: list[str], error_mapping: dict) -> None:
    """POST a navigate request, echo the success fields, exit-map failures.

    The two subcommands differ only in the URL, request body, the response
    fields echoed on success, and the error_code→exit_code mapping — everything
    else (transport errors, non-JSON responses, the 200/ok branch) is identical.
    """
    try:
        resp = requests.post(url, json=body, timeout=5)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return  # unreachable — _fail raises typer.Exit

    # Non-JSON body = a connection-layer failure (5xx with HTML, proxy error, …).
    try:
        rbody = resp.json()
    except ValueError:
        _fail(
            EXIT_CONNECTION_ERROR,
            "CONNECTION_ERROR",
            f"Unexpected server response (status {resp.status_code}): {resp.text[:200]}",
        )
        return

    if resp.status_code == 200 and rbody.get("ok"):
        _ok({k: rbody.get(k) for k in success_keys})
        return

    error_code = str(rbody.get("error_code") or "UNKNOWN")
    error_msg = str(rbody.get("error") or f"HTTP {resp.status_code}")
    _fail(error_mapping.get(error_code, EXIT_CONNECTION_ERROR), error_code, error_msg)


@navigate_app.command(
    "entity",
    help="Navigate the active browser tab to an entity's view. Argument is a canonical TypeId (e.g. 'shell-<uuid>', 'project-@local').",
)
def navigate_entity(
    typeid: Annotated[
        str,
        typer.Argument(help="Entity TypeId in '<type>-<id>' form (e.g. 'shell-550e8400-...')"),
    ],
    connection_id: Annotated[
        Optional[str],
        typer.Option("--connection-id", "-c", help="Target a specific WS connection by id."),
    ] = None,
) -> None:
    """POST to /api/v1/agent/navigate/entity and surface the server's verdict.

    The server validates that the entity exists, picks the active tab, and
    pushes a WS message. The CLI just translates HTTP status codes into
    agent-friendly exit codes.
    """
    if not typeid or "-" not in typeid:
        _fail(EXIT_INVALID_ARG, "INVALID_TYPEID", f"Not a TypeId: {typeid!r}")

    port = _discover_port()
    body = {"typeid": typeid}
    if connection_id:
        body["connection_id"] = connection_id

    _navigate(
        f"http://127.0.0.1:{port}/api/v1/agent/navigate/entity",
        body,
        ["connection_id", "type", "id"],
        {
            "NO_ACTIVE_TAB": EXIT_NO_ACTIVE_TAB,
            "ENTITY_NOT_FOUND": EXIT_ENTITY_NOT_FOUND,
            "CONNECTION_NOT_FOUND": EXIT_ENTITY_NOT_FOUND,
            "INVALID_TYPEID": EXIT_INVALID_ARG,
        },
    )


@navigate_app.command(
    "file",
    help="Navigate the active browser tab to a file by path. Opens the indexed "
    "asset if the path is known, else a raw VFS view (no indexing required).",
)
def navigate_file(
    path: Annotated[
        str,
        typer.Argument(help="File path, absolute or ~-relative (e.g. '~/Flowpad workspace/proj/hello.md')"),
    ],
    connection_id: Annotated[
        Optional[str],
        typer.Option("--connection-id", "-c", help="Target a specific WS connection by id."),
    ] = None,
) -> None:
    """POST to /api/v1/agent/navigate/file and surface the server's verdict.

    The server resolves the path to an asset entity when one exists (stable
    entity view), otherwise tells the browser to open the raw VFS path. The CLI
    just translates the outcome into agent-friendly exit codes.
    """
    if not path or not path.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_PATH", "Empty path")

    port = _discover_port()
    body: dict = {"path": path}
    if connection_id:
        body["connection_id"] = connection_id

    _navigate(
        f"http://127.0.0.1:{port}/api/v1/agent/navigate/file",
        body,
        ["connection_id", "mode", "path", "type", "id"],
        {
            "NO_ACTIVE_TAB": EXIT_NO_ACTIVE_TAB,
            "CONNECTION_NOT_FOUND": EXIT_ENTITY_NOT_FOUND,
            "INVALID_PATH": EXIT_INVALID_ARG,
        },
    )
