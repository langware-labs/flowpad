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

from typing import Optional

import requests
import typer
from typing_extensions import Annotated

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
    local_post as _local_post,
)
from flow_sdk.cli.commands._common import (
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
        resp = _local_post(url, json=body, timeout=5)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return  # unreachable — _fail raises typer.Exit

    # Non-JSON body = a connection-layer failure (5xx with HTML, proxy error, …).
    try:
        rbody = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
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
    "view",
    # NB: no square brackets in help strings — Rich parses them as markup tags.
    help=(
        "Navigate the active browser tab to a SCREEN by dock address, "
        "'viewType' plus an optional '/pointer' and '?opts'. Examples: "
        "'events', 'assets/list/skill', 'preferences/appearance'. "
        "Run `flow schema views`."
    ),
)
def navigate_view(
    address: Annotated[
        str,
        typer.Argument(help="Dock address, e.g. 'events' or \"tag/graph/eng.db?view=tree\" (quote it if it has a ?)."),
    ],
    connection_id: Annotated[
        Optional[str],
        typer.Option("--connection-id", "-c", help="Target a specific WS connection by id."),
    ] = None,
) -> None:
    """POST to /api/v1/agent/navigate/view and surface the server's verdict.

    This HIJACKS the tab the user is looking at, so reserve it for an explicit
    "take me there". To hand over a screen without interrupting, use
    ``flow show view`` — it opens the same address as a tab and never navigates.
    """
    if not address or not address.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_VIEW", "Empty view address")

    port = _discover_port()
    body: dict = {"view": address.strip()}
    if connection_id:
        body["connection_id"] = connection_id

    _navigate(
        f"http://127.0.0.1:{port}/api/v1/agent/navigate/view",
        body,
        ["connection_id", "mode", "view_type", "pointer"],
        {
            "NO_ACTIVE_TAB": EXIT_NO_ACTIVE_TAB,
            "CONNECTION_NOT_FOUND": EXIT_ENTITY_NOT_FOUND,
            "ENTITY_NOT_FOUND": EXIT_ENTITY_NOT_FOUND,
            "INVALID_VIEW": EXIT_INVALID_ARG,
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
        typer.Argument(
            help=(
                "File path - absolute, ~-relative, or relative to YOUR cwd "
                "(resolved here before it is sent; e.g. './hello.md')"
            )
        ),
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
    # Absolutized in the CALLER's process: the server resolves in its own,
    # and the caller's cwd never crosses the wire (`flow show file` likewise).
    body: dict = {"path": _caller_abs_path(path)}
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
