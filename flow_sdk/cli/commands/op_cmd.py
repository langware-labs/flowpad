"""``flow op ...`` — compute ops from the command line.

    flow op list                 — every op and what it is for
    flow op check <name>         — ask the question; change nothing
    flow op run <name>           — ask, make the one call, prove

A thin HTTP caller over the same entity actions the UI calls; no logic here.

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

from flow_sdk.schema.data_spec.compute_op_spec import AGENT_TIMEOUT
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

#: The longest a single op may legitimately take (an agent call), taken from the
#: one place that defines it rather than re-spelled here. The client waits as
#: long as the server may, so a run still in progress is never reported as a
#: failure.
RUN_TIMEOUT_SECONDS = int(AGENT_TIMEOUT)


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


@op_app.command("check", help="Ask whether the goal already holds. Makes no call.")
def check(name: Annotated[str, typer.Argument(help="The op's name.")]) -> None:
    row = _find(name)
    returned = get_graph_json(_url(f"compute_op/{row['id']}/check"), on_error=_on_error()) or {}
    ok({"op": name, "returned": returned})
    raise typer.Exit(int(returned.get("exit_code", EXIT_NOT_YET)))


@op_app.command("run", help="Make the goal hold: check, make the one call, then prove.")
def run(
    name: Annotated[str, typer.Argument(help="The op's name.")],
    approved: Annotated[bool, typer.Option("--approved", help="Authorize an op this instance does not ship.")] = False,
) -> None:
    row = _find(name)
    returned: Optional[dict] = post_graph_json(
        _url(f"compute_op/{row['id']}/run"),
        {"approved": approved},
        timeout=RUN_TIMEOUT_SECONDS,
        on_error=_on_error(f"Compute op not found: {name}"),
    )
    returned = returned or {}
    ok({"op": name, "returned": returned})
    raise typer.Exit(int(returned.get("exit_code", EXIT_NOT_YET)))
