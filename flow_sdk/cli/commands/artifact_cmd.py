"""`flow artifact ...` CLI subgroup — register what this run produced.

`flow artifact` creates a durable record of a produced deliverable and may also
present it. This is distinct from `flow show`, which changes display focus
without creating an Artifact:

* the artifact is a durable, queryable row carrying ``generated_by``, so "what
  did this run make" survives the run;
* it is shown to the calling process's watchers by default — pass ``--no-show``
  to register without stealing the display.

Registration is explicit and deliberate. Not every file an agent writes is an
artifact: an artifact is a distinct deliverable (an app, a plan, a document, a
skill — something the user asked for, or the direct product of what they asked
for). Nothing is inferred from file writes and nothing is swept off disk.

The target process is the calling AgenticProcess (``FLOWPAD_EXECUTION_SCOPE``,
injected into every worker) or an explicit ``--process``. The command POSTs to
``/api/v1/graph/agentic_process/<id>/register-artifact``.

Error contract (agents parse these):

    exit 0 — artifact registered
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
from flow_sdk.cli.commands._common import (
    resolve_process_id as _resolve_process_id,
)

artifact_app = typer.Typer(
    name="artifact",
    help="Register a deliverable this run produced (and show it).",
    add_completion=False,
    no_args_is_help=True,
)

# Exit codes — stable contract for agents parsing the outcome. Deliberately the
# same numbers `flow show` used, so an agent's error handling carries over.
EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_ENTITY_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5

_PROCESS_HELP = "Target AgenticProcess id (defaults to the calling process via FLOWPAD_EXECUTION_SCOPE)."
_NAME_HELP = "Display name for the artifact (defaults to the referenced asset's name)."
_SHOW_HELP = "Also present it to this process's watchers (default: yes)."


def _register(process_opt: Optional[str], body: dict) -> None:
    """POST the register action for the resolved process and exit-map the outcome."""
    process_id = _resolve_process_id(process_opt)
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process/{process_id}/register-artifact"

    def _on_error(status_code: int, rbody: dict) -> None:
        message = str(rbody.get("message") or f"HTTP {status_code}")
        if status_code == 404:
            _fail(EXIT_ENTITY_NOT_FOUND, "ENTITY_NOT_FOUND", message)
        if status_code == 400:
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", message)
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", message)

    data = _post_graph_json(url, body, timeout=5, on_error=_on_error)
    artifact = (data or {}).get("artifact") or {}
    _ok(
        {
            "process_id": process_id,
            "artifact_id": artifact.get("id"),
            "shown": bool((data or {}).get("shown")),
        }
    )


@artifact_app.command(
    "entity",
    help="Register an existing entity as this run's artifact. Argument is a canonical TypeId.",
)
def artifact_entity(
    typeid: Annotated[
        str,
        typer.Argument(help="Entity TypeId in '<type>-<id>' form (e.g. 'skill-550e8400-...')"),
    ],
    name: Annotated[Optional[str], typer.Option("--name", help=_NAME_HELP)] = None,
    show: Annotated[bool, typer.Option("--show/--no-show", help=_SHOW_HELP)] = True,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    if not typeid or "-" not in typeid:
        _fail(EXIT_INVALID_ARG, "INVALID_TYPEID", f"Not a TypeId: {typeid!r}")
    _register(process, {"typeid": typeid, "name": name, "show": show})


@artifact_app.command(
    "file",
    help="Register a file this run produced. Resolves to the indexed asset when known.",
)
def artifact_file(
    path: Annotated[
        str,
        typer.Argument(help="File path, absolute or ~-relative (e.g. '~/Flowpad workspace/proj/report.html')"),
    ],
    name: Annotated[Optional[str], typer.Option("--name", help=_NAME_HELP)] = None,
    show: Annotated[bool, typer.Option("--show/--no-show", help=_SHOW_HELP)] = True,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    if not path or not path.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_PATH", "Empty path")
    _register(process, {"path": path, "name": name, "show": show})


@artifact_app.command(
    "webapp",
    help="Register a running web app by port as this run's artifact.",
)
def artifact_webapp(
    port: Annotated[
        int,
        typer.Option("--port", help="Port the dev server / app listens on (e.g. 3000)."),
    ],
    name: Annotated[Optional[str], typer.Option("--name", help=_NAME_HELP)] = None,
    show: Annotated[bool, typer.Option("--show/--no-show", help=_SHOW_HELP)] = True,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    if port <= 0 or port > 65535:
        _fail(EXIT_INVALID_ARG, "INVALID_PORT", f"Invalid port: {port}")
    _register(process, {"port": port, "name": name, "show": show})
