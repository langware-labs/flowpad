"""`flow browser ...` — the browsers a session can be given, as the footer menu lists them.

The list an agent reads here is the one a person sees: both come from the project's
``browser-status`` action, so neither can show a browser the other does not.

    flow browser list                    every browser kind on this machine, with its state and times
    flow browser show                    the browser this session has, and what decided it
    flow browser select <kind>           give this session a kind (applies at its next launch)
    flow browser default <kind>          set the project's default on this computer
    flow browser error <kind> <message>  report a failing kind; then stop and ask the user

Error contract (parsed by the agent — keep stable):

    exit 0 — success, JSON written to stdout
    exit 2 — invalid arguments / no project or session to ask / a kind the server refused
    exit 5 — connection error (server unreachable)
"""

from __future__ import annotations

import os
from typing import NoReturn, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    EXIT_INVALID_ARG,
    current_process_id,
    discover_port,
    fail,
    get_graph_json,
    graph_url,
    ok,
    post_graph_json,
    project_for_path,
    server_error,
)

browser_app = typer.Typer(
    name="browser",
    help="The browsers a session can be given — the same list the footer's browser menu shows.",
    add_completion=False,
    no_args_is_help=True,
)

ProcessOpt = Annotated[
    Optional[str],
    typer.Option("--process", "-p", help="Target AgenticProcess id (defaults to the calling process)."),
]


def _target(process: Optional[str]) -> tuple[int, str, str]:
    """``(port, project id, process id)`` for the session named or the calling one; a command run
    outside a session answers for the working directory's project, with no process."""
    port = discover_port()
    process_id = (process or current_process_id() or "").strip().removeprefix("agentic_process-")
    project_id = None
    if process_id:
        row = get_graph_json(graph_url(port, f"agentic_process/{process_id}"), on_error=server_error) or {}
        project_id = row.get("project_id") if isinstance(row, dict) else None
    if not project_id:
        project_id = project_for_path(port, os.getcwd(), create=False)
    if not project_id:
        fail(EXIT_INVALID_ARG, "NO_PROJECT", "Run inside a session or a project folder, or pass --process")
    return port, project_id, process_id


def _refused(status_code: int, body: dict) -> NoReturn:
    """A 4xx is the caller's argument (an unknown kind, no such session); anything else the server's."""
    if 400 <= status_code < 500:
        fail(EXIT_INVALID_ARG, "REFUSED", str(body.get("message") or f"HTTP {status_code}"))
    server_error(status_code, body)


def _status(process: Optional[str]) -> dict:
    port, project_id, process_id = _target(process)
    params = {"process_id": process_id} if process_id else None
    return get_graph_json(graph_url(port, f"project/{project_id}/browser-status"), params=params, on_error=server_error) or {}


def _do(process: Optional[str], action: str, payload: dict, *, needs_session: bool = False) -> None:
    port, project_id, process_id = _target(process)
    if needs_session and not process_id:
        fail(EXIT_INVALID_ARG, "NO_PROCESS", "Run inside a session or pass --process")
    body = {**payload, "process_id": process_id} if needs_session else payload
    ok(post_graph_json(graph_url(port, f"project/{project_id}/{action}"), body, on_error=_refused))


@browser_app.command("list", help="Print every browser kind on this machine as JSON: kind, name, state, error, created, last_used.")
def list_browsers(process: ProcessOpt = None) -> None:
    ok({"kinds": [k for k in _status(process).get("kinds") or [] if not k.get("hidden")]})


@browser_app.command("show", help="Print the browser this session has as JSON: its kind and driver, what decided it, and its last call.")
def show_browser(process: ProcessOpt = None) -> None:
    status = _status(process)
    kind = status.get("effective_kind") or ""
    ok({
        "kind": kind,
        "driver": status.get("effective") or "",
        "source": status.get("source") or "",
        "requested": status.get("requested") or "",
        "browser": next((k for k in status.get("kinds") or [] if k.get("kind") == kind), None),
        "last_use": status.get("last_use"),
    })


@browser_app.command("select", help="Give THIS session a browser kind (from `flow browser list`); it applies at the session's next launch. \"\" gives the choice back to the project.")
def select_browser(kind: Annotated[str, typer.Argument(help="A browser kind, or a driver's name.")], process: ProcessOpt = None) -> None:
    _do(process, "select-browser", {"browser": kind}, needs_session=True)


@browser_app.command("default", help="Set the project's default browser on this computer; \"\" goes back to what the project recommends. Sessions that already chose keep theirs.")
def default_browser(kind: Annotated[str, typer.Argument(help="A browser kind, or a driver's name.")], process: ProcessOpt = None) -> None:
    _do(process, "set-browser", {"browser": kind})


@browser_app.command("error", help="Report that a browser kind is failing: the message shows on its row. Then stop and ask the user what to do.")
def browser_error(
    kind: Annotated[str, typer.Argument(help="The failing browser kind (`flow browser show`).")],
    message: Annotated[str, typer.Argument(help="What failed, in one sentence; \"\" clears the report.")],
    process: ProcessOpt = None,
) -> None:
    _do(process, "browser-error", {"kind": kind, "message": message})
