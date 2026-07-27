"""`flow show ...` CLI subgroup.

Declarative display focus — the counterpart of `flow navigate`:

* `navigate` steers the user's browser tab (URL changes, interrupts).
* `show` tells the *calling process's* watchers what to present. If a display
  surface is mounted (vibe display pane, process viewer) it renders the
  target; otherwise the event is a silent context change. It never navigates.

The target process is the calling AgenticProcess (``FLOWPAD_EXECUTION_SCOPE``,
injected into every worker) or an explicit ``--process``. The command POSTs to
the entity action ``/api/v1/graph/agentic_process/<id>/show``.

Error contract (agents parse these):

    exit 0 — show event recorded (NOT a guarantee anyone is watching)
    exit 2 — invalid arguments (malformed typeid/port, no process scope)
    exit 4 — entity not found (typeid form only)
    exit 5 — connection error (server unreachable)
"""

from __future__ import annotations

from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
    fail as _fail,
    ok as _ok,
    post_graph_json as _post_graph_json,
    resolve_process_id as _resolve_process_id,
)

show_app = typer.Typer(
    name="show",
    help="Set the display focus for this process's watchers (no navigation).",
    add_completion=False,
    no_args_is_help=True,
)

# Exit codes — stable contract for agents parsing the outcome.
EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_ENTITY_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5

_PROCESS_HELP = "Target AgenticProcess id (defaults to the calling process via FLOWPAD_EXECUTION_SCOPE)."


def _post_show(process_opt: Optional[str], body: dict) -> None:
    """POST the show action for the resolved process and exit-map the outcome.

    Transport/parse handling is the shared ``post_graph_json``; this wrapper
    only supplies show's exit contract (module docstring).
    """
    process_id = _resolve_process_id(process_opt)
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process/{process_id}/show"

    def _on_error(status_code: int, rbody: dict) -> None:
        message = str(rbody.get("message") or f"HTTP {status_code}")
        if status_code == 404:
            _fail(EXIT_ENTITY_NOT_FOUND, "ENTITY_NOT_FOUND", message)
        if status_code == 400:
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", message)
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", message)

    data = _post_graph_json(url, body, timeout=5, on_error=_on_error)
    _ok({"process_id": process_id, **data})


@show_app.command(
    "entity",
    help="Show an entity to the process's watchers. Argument is a canonical TypeId (e.g. 'skill-<uuid>').",
)
def show_entity(
    typeid: Annotated[
        str,
        typer.Argument(help="Entity TypeId in '<type>-<id>' form (e.g. 'markdown-550e8400-...')"),
    ],
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    if not typeid or "-" not in typeid:
        _fail(EXIT_INVALID_ARG, "INVALID_TYPEID", f"Not a TypeId: {typeid!r}")
    _post_show(process, {"typeid": typeid})


@show_app.command(
    "file",
    help="Show a file by path. Resolves to the indexed asset's editor when known, else a raw VFS view.",
)
def show_file(
    path: Annotated[
        str,
        typer.Argument(help="File path, absolute or ~-relative (e.g. '~/Flowpad workspace/proj/index.html')"),
    ],
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    if not path or not path.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_PATH", "Empty path")
    _post_show(process, {"path": path})


@show_app.command(
    "webapp",
    help="Show a running web app by port (live preview in the display).",
)
def show_webapp(
    port: Annotated[
        int,
        typer.Option("--port", help="Port the dev server / app listens on (e.g. 3000)."),
    ],
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    if port <= 0 or port > 65535:
        _fail(EXIT_INVALID_ARG, "INVALID_PORT", f"Invalid port: {port}")
    _post_show(process, {"port": port})
