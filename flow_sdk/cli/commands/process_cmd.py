"""`flow process ...` CLI subgroup — lifecycle control for AgenticProcess.

``flow process restart [--process <id>]``

Restart an agentic-process session (the Claude/Codex worker + its PTY),
preserving the conversation session so the resumed worker continues where it
left off. The headline use case is *self-restart from inside a session* — e.g.
after installing an MCP server the agent runs ``flow process restart`` so the
new MCP config is loaded into a fresh worker. ``--process`` defaults to the
current process via ``FLOWPAD_EXECUTION_SCOPE``.

The command targets the backend ``self-restart`` action, which schedules the
restart on the server and returns immediately. That detachment matters: this
CLI process is a child of the worker the restart kills, so an inline restart
would sever the request mid-flight. Because the server owns the work, the
restart completes regardless, and the frontend terminal re-attaches to the new
PTY via the ``worker.restarted`` entity event the action emits.

``flow process start "<prompt>"``

Run one headless turn IN THIS PROCESS and stream what the agent writes: no
server, no login. Funding is whatever the box resolves — on a machine that has
never signed in to anything, a PUBLIC hub endpoint bound with
``flow llm user use <endpoint-id>``. The process id goes to stderr, the
agent's messages to stdout (whole messages: a transcript records messages, not
tokens), and the exit code is the turn's ``ExitCode``. With no ``--worker``
the selected harness runs when its CLI is installed, else the builtin
``deepagents`` worker, which ships with the wheel — so a box with only
flow_sdk installed answers with no flags at all.

``flow process`` is the home for future lifecycle siblings (``stop``,
``status``).
"""

from __future__ import annotations

import logging
from typing import Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    EXIT_CONNECTION_ERROR,
    EXIT_INVALID_ARG,
    quiet_logs,
    run_async,
    safe_echo,
)
from flow_sdk.cli.commands._common import (
    bad_response_message as _bad_response_message,
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
from flow_sdk.cli.commands._common import (
    resolve_process_id as _resolve_process_id,
)
from flow_sdk.core.headless_turn import HeadlessTurnRequest, headless_turn

process_app = typer.Typer(
    name="process",
    help="Lifecycle control for AgenticProcess sessions (restart, …).",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_ACTION_FAILED = 7


@process_app.command(
    "restart",
    help=(
        "Restart an agentic-process session (kills the worker + PTY, then "
        "re-spawns it, resuming the same session). Defaults to the current "
        "process (FLOWPAD_EXECUTION_SCOPE). Run this after installing an MCP "
        "server so the new config is picked up. The restart is scheduled "
        "server-side and returns immediately; this command (and the worker it "
        "runs in) is then replaced."
    ),
)
def restart_process(
    process: Annotated[
        Optional[str],
        typer.Option(
            "--process",
            "-p",
            help="AgenticProcess id or TypeId. Defaults to FLOWPAD_EXECUTION_SCOPE.",
        ),
    ] = None,
) -> None:
    process_id = _resolve_process_id(process)
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process/{process_id}/self-restart"

    try:
        resp = _local_post(url, json={}, timeout=15)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
        return

    if resp.status_code != 200 or body.get("status") != "SUCCESS":
        _fail(
            EXIT_ACTION_FAILED,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {resp.status_code}"),
        )
        return

    data = body.get("data") or {}
    _ok(
        {
            "process_id": process_id,
            "scheduled": bool(data.get("scheduled", True)),
            "note": "Restart scheduled. If this is a self-restart, the session is being replaced now.",
            **{k: v for k, v in data.items() if k != "scheduled"},
        }
    )


@process_app.command(
    "start",
    help=(
        "Run one headless turn and stream the agent's messages. Runs inside the instance's backend "
        "when one is up, else here with no server. Funded by whatever this box resolves — e.g. a "
        "public hub endpoint bound with `flow llm user use <endpoint-id>`. Exit code is the turn's "
        "(0 = answered)."
    ),
)
def start_process(
    prompt: Annotated[str, typer.Argument(help="What to ask the agent.")],
    worker: Annotated[
        Optional[str],
        typer.Option(
            "--worker",
            "-w",
            help="Harness to run (claude, codex, deepagents, …). Default: the selected one if installed, else deepagents.",
        ),
    ] = None,
    model: Annotated[
        Optional[str], typer.Option("--model", "-m", help="Model slug. Default: what the funding source resolves.")
    ] = None,
    workdir: Annotated[
        Optional[str], typer.Option("--workdir", help="Where the agent works. Default: a fresh temp directory.")
    ] = None,
    llm: Annotated[
        Optional[str],
        typer.Option(
            "--llm",
            help="Source that funds this run only: a `flow llm list` number, endpoint id or name prefix. "
            "Pins the process, never the box default.",
        ),
    ] = None,
) -> None:
    worker_type = None
    if worker:
        from flow_sdk.flowpad_types.vendors import vendor_or_none  # noqa: PLC0415

        vendor = vendor_or_none(worker)
        if vendor is None:
            _fail(EXIT_INVALID_ARG, "UNKNOWN_WORKER", f"No worker named {worker!r}.")
        worker_type = vendor.worker_type
    endpoint_typeid = None
    if llm:
        from flow_sdk.cli.commands.llm_cmd import _pick, _rows, _status  # noqa: PLC0415

        endpoint_typeid = _pick(_rows(_status()), llm).typeid
    port = _discover_port(required=False)
    request = HeadlessTurnRequest(prompt=prompt, worker=worker_type, model=model, workdir=workdir, llm=endpoint_typeid)
    if port is not None:
        raise typer.Exit(_run_on_server(port, request))
    # ERROR too: a turn that fails says why through its own verdict, so the log would only repeat it.
    quiet_logs(logging.ERROR)
    raise typer.Exit(run_async(_run_start(request)))


class _Printer:
    """Prints a turn's events as ``flow process start`` always has -- the process id and tool steps on
    stderr, the agent's words on stdout -- and keeps the turn's exit code: 1 until a ``done`` arrives."""

    def __init__(self) -> None:
        self.exit_code: int | None = None

    def feed(self, event: dict) -> None:
        kind = event.get("kind")
        if kind == "process":
            safe_echo(f"running agentic process {event.get('id')}…", err=True)
        elif kind == "tool":
            safe_echo(f"· {event.get('name')}", err=True)
        elif kind == "text":
            safe_echo(event.get("text") or "")
        elif kind == "done":
            if event.get("text"):
                safe_echo(event["text"])
            if not event.get("ok"):
                safe_echo(event.get("detail") or "The turn did not finish.", err=True)
            self.exit_code = int(event.get("exit_code") or 0)

    def result(self) -> int:
        if self.exit_code is None:
            safe_echo("The turn ended before it reported a result.", err=True)
            return 1
        return self.exit_code


def _run_on_server(port: int, request: HeadlessTurnRequest) -> int:
    """The turn, run by the live backend (one SQLite writer) and streamed back as NDJSON."""
    import json  # noqa: PLC0415

    url = f"http://127.0.0.1:{port}/api/v1/agentic_process/headless-turn"
    try:
        resp = _local_post(url, json=request.model_dump(), stream=True, timeout=(10, None))
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return 1
    if resp.status_code != 200:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
        return 1
    printer = _Printer()
    for line in resp.iter_lines(decode_unicode=True):
        if line:
            printer.feed(json.loads(line))
    return printer.result()


async def _run_start(request: HeadlessTurnRequest) -> int:
    """One turn in THIS process (no backend up), printed as it streams."""
    from flow_sdk.migrations.runner import _bootstrap_local  # noqa: PLC0415

    await _bootstrap_local()
    printer = _Printer()
    async for event in headless_turn(request):
        printer.feed(event)
    return printer.result()
