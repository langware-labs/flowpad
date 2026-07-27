"""`flow terminal ...` CLI subgroup.

The terminal the USER is looking at — not the worker's own Bash tool.

A worker's Bash runs in a detached subprocess: its output reaches the
transcript, never the screen. When the user says "do it in the terminal" they
mean the visible one, and these verbs drive it. Writes land on the same
backend-owned PTY a guided journey types into, so agent-typed and user-typed
commands are indistinguishable on screen.

    flow terminal open [--cwd PATH] [--command CMD]
    flow terminal run "<command>" [--shell ID]

``open`` is idempotent: it re-shows the terminal this process already opened
rather than stacking up new ones, so ``run`` needs no ``--shell``.

The target process is the calling AgenticProcess (``FLOWPAD_EXECUTION_SCOPE``,
injected into every worker) or an explicit ``--process``.

Error contract (agents parse these):

    exit 0 — terminal opened / command typed
    exit 2 — invalid arguments (empty command, no process scope)
    exit 4 — no open terminal (run `flow terminal open` first)
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

terminal_app = typer.Typer(
    name="terminal",
    help="Open and drive the user-visible terminal (not your own Bash tool).",
    add_completion=False,
    no_args_is_help=True,
)

# Exit codes — stable contract for agents parsing the outcome.
EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NO_TERMINAL = 4
EXIT_CONNECTION_ERROR = 5

_PROCESS_HELP = "Target AgenticProcess id (defaults to the calling process via FLOWPAD_EXECUTION_SCOPE)."


def _post_terminal(process_opt: Optional[str], action: str, body: dict) -> None:
    """POST a terminal action for the resolved process and exit-map the outcome."""
    process_id = _resolve_process_id(process_opt)
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process/{process_id}/{action}"

    def _on_error(status_code: int, rbody: dict) -> None:
        message = str(rbody.get("message") or f"HTTP {status_code}")
        if status_code == 404:
            _fail(EXIT_NO_TERMINAL, "NO_TERMINAL", message)
        if status_code == 400:
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", message)
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", message)

    data = _post_graph_json(url, body, timeout=10, on_error=_on_error)
    _ok({"process_id": process_id, **data})


@terminal_app.command(
    "open",
    help="Open the user-visible terminal and show it. Reuses the one already open, if any.",
)
def terminal_open(
    cwd: Annotated[
        Optional[str],
        typer.Option("--cwd", help="Working directory (defaults to the process's workdir)."),
    ] = None,
    command: Annotated[
        Optional[str],
        typer.Option("--command", "-c", help="Optional command to type once the terminal is open."),
    ] = None,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    body: dict = {}
    if cwd and cwd.strip():
        body["cwd"] = cwd.strip()
    if command and command.strip():
        body["command"] = command.strip()
    _post_terminal(process, "terminal", body)


@terminal_app.command(
    "run",
    help="Type a command into the user-visible terminal and press Enter.",
)
def terminal_run(
    command: Annotated[
        str,
        typer.Argument(help="The command to type, e.g. 'npm test'"),
    ],
    shell: Annotated[
        Optional[str],
        typer.Option("--shell", help="Target Shell id (defaults to the terminal this process opened)."),
    ] = None,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
) -> None:
    if not command or not command.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_COMMAND", "Empty command")
    body: dict = {"command": command.strip()}
    if shell and shell.strip():
        body["shell_id"] = shell.strip()
    _post_terminal(process, "terminal-input", body)
