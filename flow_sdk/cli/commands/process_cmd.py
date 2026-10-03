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

import contextlib
import logging
import tempfile
import uuid
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
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

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


#: A backend for this instance is already running. ``start`` writes the process row in-process,
#: and a second writer beside a live server is the SQLite contention ``flow llm`` routes around.
EXIT_INSTANCE_RUNNING = int(ExitCode.REFUSED)


@process_app.command(
    "start",
    help=(
        "Run one headless turn here and stream the agent's messages: no server, no login. "
        "Funded by whatever this box resolves — e.g. a public hub endpoint bound with "
        "`flow llm user use <endpoint-id>`. Exit code is the turn's (0 = answered)."
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
) -> None:
    if _discover_port(required=False) is not None:
        _fail(
            EXIT_INSTANCE_RUNNING,
            "INSTANCE_RUNNING",
            "A Flowpad backend is running for this instance; `flow process start` runs without one. "
            "Stop it, or point FLOW_INSTANCE at an instance that is not running.",
        )
    worker_type = None
    if worker:
        from flow_sdk.flowpad_types.vendors import vendor_or_none  # noqa: PLC0415

        vendor = vendor_or_none(worker)
        if vendor is None:
            _fail(EXIT_INVALID_ARG, "UNKNOWN_WORKER", f"No worker named {worker!r}.")
        worker_type = vendor.worker_type
    # ERROR too: a turn that fails says why through its own verdict, so the log would only repeat it.
    quiet_logs(logging.ERROR)
    raise typer.Exit(run_async(_run_start(prompt, worker_type=worker_type, model=model, workdir=workdir)))


async def _run_start(
    prompt: str,
    *,
    worker_type: Optional[str] = None,
    model: Optional[str] = None,
    workdir: Optional[str] = None,
) -> int:
    """One turn, streamed: the process id and tool steps to stderr, the agent's messages to
    stdout. No ``worker_type`` takes the builtin-process rule — the selected harness when
    installed, else the bootstrap worker (``deepagents``, shipped in the wheel)."""
    from flow_sdk.builtin.agent_serve import Turn, TurnEngine  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.core.capabilities.registry import resolve_builtin_worker_type  # noqa: PLC0415
    from flow_sdk.migrations.runner import _bootstrap_local  # noqa: PLC0415

    await _bootstrap_local()
    cli_config: dict = {"permission_mode": "bypassPermissions"}
    if model:
        cli_config["model"] = model
    ap = await AgenticProcess(
        worker_type=worker_type or await resolve_builtin_worker_type(),
        workdir=workdir or tempfile.mkdtemp(prefix="flow-process-"),
        cli_config=cli_config,
        pty_mode=False,
        visible=False,
        load_flowpad_assistant=False,
    ).save()
    safe_echo(f"running agentic process {ap.typeid}…", err=True)
    answer = None
    try:
        turn = Turn(session=str(ap.typeid), key=str(uuid.uuid4()), body=prompt)
        async for event in TurnEngine().run_stream(turn, process=ap):
            if event.kind == "text":
                safe_echo(event.text)
            elif event.kind == "tool":
                safe_echo(f"· {event.name}", err=True)
            elif event.kind == "done":
                answer = event.answer
    finally:
        with contextlib.suppress(Exception):
            await ap.exit()
    if not answer.ok:
        safe_echo(answer.detail or "The turn did not finish.", err=True)
    return int(answer.exit_code)
