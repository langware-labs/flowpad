"""`flow browser ...` — the browsers a session can be given, as the footer menu lists them.

The list an agent reads here is the one a person sees: both come from the project's
``browser-status`` action, so neither can show a browser the other does not.

    flow browser list      every browser kind on this machine, with its state and times
    flow browser show      the browser this session has, and what decided it

Error contract (parsed by the agent — keep stable):

    exit 0 — success, JSON written to stdout
    exit 2 — invalid arguments / no project to ask
    exit 5 — connection error (server unreachable)
"""

from __future__ import annotations

import os
from typing import Optional

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


def _status(process: Optional[str]) -> dict:
    """The project's browser status, for the session named or the calling one; a command run
    outside a session asks the working directory's project what a new session would get."""
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
    params = {"process_id": process_id} if process_id else None
    return get_graph_json(graph_url(port, f"project/{project_id}/browser-status"), params=params, on_error=server_error) or {}


@browser_app.command("list", help="Print every browser kind on this machine as JSON: kind, name, state, created, last_used.")
def list_browsers(process: ProcessOpt = None) -> None:
    ok({"kinds": _status(process).get("kinds") or []})


@browser_app.command("show", help="Print the browser this session has as JSON: its driver, what decided it, its kinds and last call.")
def show_browser(process: ProcessOpt = None) -> None:
    status = _status(process)
    driver = status.get("effective") or ""
    ok({
        "driver": driver,
        "source": status.get("source") or "",
        "requested": status.get("requested") or "",
        "kinds": [kind for kind in status.get("kinds") or [] if kind.get("driver") == driver],
        "last_use": status.get("last_use"),
    })
