"""`flow navigate ...` CLI subgroup.

Agent-oriented commands that drive the browser UI by POSTing to the
local Flowpad server. Every navigation answers a ``NavigateResult``; its
``exit_code`` IS the exit code (the same enum ``flow op`` exits with):

    exit 0 — shown, and it can be used
    exit 1 — not yet: no Flowpad tab is open to show it in, or the place is shown
             but cannot be used yet (nothing answers, it errors) — see "verdict"
    exit 4 — not found here (no such entity, file or view target)
    exit 7 — refused: the page refuses to be shown inside Flowpad
    exit 2 — invalid arguments (e.g. malformed typeid or view)
    exit 5 — connection error (server unreachable)

The answer is one JSON line on stdout (``exit_code``, ``verdict``, ``detail``, …);
when it is not OK the sentence also goes to stderr. Exits 2 and 5 print the
usual error envelope to stderr.
"""

from __future__ import annotations

import json
from typing import NoReturn, Optional

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

navigate_app = typer.Typer(
    name="navigate",
    help="Drive the Flowpad UI (navigate the active browser tab).",
    add_completion=False,
    no_args_is_help=True,
)


# Exit codes — stable contract for agents parsing the outcome. The outcomes are
# ``ExitCode``'s values (``returned_value_spec``); 2 and 5 are the request's own.
EXIT_OK = 0
EXIT_NOT_YET = 1
EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_REFUSED = 7

#: The fields of a ``NavigateResult`` worth a line on stdout.
_RESULT_KEYS = ("exit_code", "verdict", "detail", "delivered", "connection_id", "pointer", "value")


def emit_navigate_result(data: dict, extra: "dict | None" = None) -> NoReturn:
    """Print a ``NavigateResult`` as one JSON line and exit with its ``exit_code`` —
    shared by ``flow navigate`` and ``flow show``."""
    code = int(data.get("exit_code", EXIT_CONNECTION_ERROR))
    line = {"ok": code == EXIT_OK, **(extra or {})}
    line.update({key: data[key] for key in _RESULT_KEYS if data.get(key) not in (None, "")})
    if code != EXIT_OK and data.get("detail"):
        typer.echo(str(data["detail"]), err=True)
    typer.echo(json.dumps(line))
    raise typer.Exit(code)


def _navigate(url: str, body: dict) -> None:
    """POST a navigate request and exit with its answer's code.

    Every subcommand differs only in the URL and the body: transport errors and a
    non-JSON body are exit 5, a malformed request (HTTP 400) is exit 2, and anything
    the server answered is a ``NavigateResult``.
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

    if resp.status_code == 200 and isinstance(rbody.get("data"), dict):
        emit_navigate_result(rbody["data"])

    error_code = str(rbody.get("error_code") or "UNKNOWN")
    error_msg = str(rbody.get("error") or rbody.get("message") or f"HTTP {resp.status_code}")
    _fail(EXIT_INVALID_ARG if resp.status_code == 400 else EXIT_CONNECTION_ERROR, error_code, error_msg)


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

    _navigate(f"http://127.0.0.1:{port}/api/v1/agent/navigate/entity", body)


@navigate_app.command(
    "view",
    # NB: no square brackets in help strings — Rich parses them as markup tags.
    help=(
        "Navigate the active browser tab to a SCREEN by dock address, "
        "'viewType' plus an optional '/pointer' and '?opts'. Examples: "
        "'automations', 'assets/list/skill', 'preferences/appearance'. "
        "Run `flow schema views`."
    ),
)
def navigate_view(
    address: Annotated[
        str,
        typer.Argument(help="Dock address, e.g. 'automations' or \"tag/graph/eng.db?view=tree\" (quote it if it has a ?)."),
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

    _navigate(f"http://127.0.0.1:{port}/api/v1/agent/navigate/view", body)


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

    _navigate(f"http://127.0.0.1:{port}/api/v1/agent/navigate/file", body)
