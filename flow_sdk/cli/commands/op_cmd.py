"""``flow op ...`` — compute ops from the command line.

    flow op list                 — every op and what it is for
    flow op check <name>         — ask the question; change nothing
    flow op run <name>           — ask, make the one call, prove

A thin HTTP caller over the same entity actions the UI calls; no logic here. With NO backend
running, ``check`` / ``run`` run a SHIPPED op in this process instead (``core.wizard.local_run``),
and ``run --yes`` answers its confirm question.

**The exit code is the product.** It is the op's own verdict — the same one a
wizard step reads — in the form a shell script can test, so both verbs answer in
exit codes and not only in prose:

    0  the goal holds  (check: satisfied · run: proven by the re-check)
    1  it does not     (check: work to do · run: the call did not reach it)
    2  the request itself failed (a bad document, a server error)
    3  not applicable on this machine — a silent skip, never a failure
    4  no op by that name
    7  refused — not approved to run here

Keeping "not applicable" distinct from "satisfied" is deliberate: an op skipped
on a machine it does not apply to must never report as one that succeeded, or a
caller believes a goal was reached that nobody attempted.
"""
from __future__ import annotations

from typing import Any, NoReturn, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.schema.data_spec.compute_op_spec import AGENT_TIMEOUT, CHECK_TIMEOUT
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

from flow_sdk.cli.commands._common import (
    discover_port,
    fail,
    get_graph_json,
    graph_url,
    ok,
    post_graph_json,
)

op_app = typer.Typer(
    name="op",
    help="Check and run compute ops — a goal, its check, and the one call that reaches it.",
    add_completion=False,
    no_args_is_help=True,
)

#: The exit codes ARE `ExitCode` — the same enum an in-process call returns,
#: so a shell pipeline and Python agree by construction. (2 is absent on
#: purpose: the CLI spends it on "invalid argument".)
EXIT_NOT_YET = int(ExitCode.NOT_YET)
EXIT_NOT_FOUND = int(ExitCode.NOT_FOUND)
#: The request failed before any op answered — the CLI's "invalid", never an
#: ExitCode: a bad document or a 500 is not a refusal.
EXIT_REQUEST_FAILED = 2

#: The longest a single op may legitimately take by default (an agent call),
#: taken from the one place that defines it rather than re-spelled here.
RUN_TIMEOUT_SECONDS = int(AGENT_TIMEOUT)
#: What the client waits beyond the op's own budget — the server answers when
#: the op does, and a client that gave up first reported a still-running op as
#: a connection error (exit 5) and lost its answer.
_HTTP_MARGIN_S = 15.0


def _wait_for(row: dict) -> float:
    """How long ``run`` waits: as long as THIS op may take, never less.

    An op may declare a longer ``timeout_seconds`` than the default, and a run is
    check + call + re-check — so the client outwaits all three.
    """
    exe = row.get("exe_data") if isinstance(row.get("exe_data"), dict) else {}
    check = row.get("completion_check") if isinstance(row.get("completion_check"), dict) else {}
    call = max(float(exe.get("timeout_seconds") or 0), float(RUN_TIMEOUT_SECONDS))
    per_check = float(check.get("timeout_seconds") or CHECK_TIMEOUT)
    return call + 2 * per_check + _HTTP_MARGIN_S


def _exit_with(returned: Optional[dict]) -> NoReturn:
    """Exit the answer's own code. A 200 carrying no answer is a broken server,
    not a verdict — exit 2, never a made-up NOT_YET."""
    if not isinstance(returned, dict) or "exit_code" not in returned:
        fail(EXIT_REQUEST_FAILED, "NO_ANSWER", "The server returned no answer.")
    raise typer.Exit(int(returned["exit_code"]))


def _on_error(not_found: str = ""):
    def handle(status: int, body: dict) -> NoReturn:
        if status == 404 and not_found:
            fail(EXIT_NOT_FOUND, "NOT_FOUND", not_found)
        fail(
            EXIT_REQUEST_FAILED,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("detail") or f"HTTP {status}"),
        )

    return handle


def _url(path: str) -> str:
    return graph_url(discover_port(), path)


def _rows(payload: Any) -> list[dict]:
    if isinstance(payload, dict):
        payload = payload.get("entities", payload)
    return [row for row in (payload or []) if isinstance(row, dict)]


def _find(name: str) -> dict:
    """The op row named ``name``.

    Exits 4 when there is none, listing what IS indexed: a name that resolves to
    nothing is the caller's bug, and the useful thing to do is say so before
    anything runs — not to fail later inside an action.
    """
    rows = _rows(get_graph_json(_url("compute_op"), on_error=_on_error()))
    for row in rows:
        if row.get("name") == name:
            return row
    known = ", ".join(sorted(str(row.get("name") or "") for row in rows)) or "none are indexed"
    fail(EXIT_NOT_FOUND, "OP_NOT_FOUND", f"No compute op named {name!r}. Known: {known}")


@op_app.command("list", help="Every compute op this instance can run.")
def list_ops() -> None:
    rows = _rows(get_graph_json(_url("compute_op"), on_error=_on_error()))
    ok({"ops": [
        {k: row.get(k) for k in ("name", "description", "shipped")}
        for row in rows
    ]})


def _here(name: str, *, yes: bool = False, check_only: bool = False) -> NoReturn:
    """No backend running: run (or check) the SHIPPED op *name* in this process, exit its code.

    ``by`` says which call settled it (``already`` / ``nothing`` / ``cli`` / ``agent`` / ``ask``).
    """
    from flow_sdk.cli.commands._common import quiet_logs, run_async, safe_echo  # noqa: PLC0415
    from flow_sdk.core.wizard.local_run import run_shipped_op, satisfied_by  # noqa: PLC0415
    from flow_sdk.migrations.runner import _bootstrap_local  # noqa: PLC0415

    quiet_logs()

    async def run():
        await _bootstrap_local()
        return await run_shipped_op(
            name, yes=yes, check_only=check_only, say=lambda text: safe_echo(f"  {text}", err=True)
        )

    returned = run_async(run())
    if returned is None:
        fail(EXIT_NOT_FOUND, "OP_NOT_FOUND", f"No shipped compute op named {name!r} (no backend is running to look further).")
    ok({"op": name, "returned": returned.trimmed().model_dump(mode="json"), "by": satisfied_by(returned)})
    raise typer.Exit(int(returned.exit_code))


@op_app.command("check", help="Ask whether the goal already holds. Makes no call.")
def check(name: Annotated[str, typer.Argument(help="The op's name.")]) -> None:
    if discover_port(required=False) is None:
        _here(name, check_only=True)
    row = _find(name)
    returned = get_graph_json(_url(f"compute_op/{row['id']}/check"), on_error=_on_error())
    ok({"op": name, "returned": returned or {}})
    _exit_with(returned)


@op_app.command("run", help="Make the goal hold: check, make the one call, then prove.")
def run(
    name: Annotated[str, typer.Argument(help="The op's name.")],
    approved: Annotated[bool, typer.Option("--approved", help="Authorize an op this instance does not ship.")] = False,
    yes: Annotated[
        bool,
        typer.Option("--yes", help="No backend running: answer the op's confirm question yes, here."),
    ] = False,
) -> None:
    if discover_port(required=False) is None:
        _here(name, yes=yes)
    if yes:
        fail(
            EXIT_REQUEST_FAILED,
            "YES_NEEDS_NO_BACKEND",
            "--yes answers questions in this terminal, which only happens with no backend running; "
            "with one running, its questions are asked in the app.",
        )
    row = _find(name)
    returned: Optional[dict] = post_graph_json(
        _url(f"compute_op/{row['id']}/run"),
        {"approved": approved},
        timeout=_wait_for(row),
        on_error=_on_error(f"Compute op not found: {name}"),
    )
    ok({"op": name, "returned": returned or {}})
    _exit_with(returned)
