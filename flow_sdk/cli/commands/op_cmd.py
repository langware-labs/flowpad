"""``flow op ...`` — compute ops from the command line.

    flow op list                 — every op and what it is for
    flow op check <name>         — ask the question; change nothing
    flow op run <name>           — ask, act cheapest-first, prove

A thin HTTP caller over the same entity actions the UI calls; no logic here.

**The exit code is the product.** It is what a wizard's ``verify`` check reads
and what a shell script tests, so both verbs answer in exit codes and not only
in prose:

    0  the goal holds  (check: satisfied · run: proven by the re-check)
    1  it does not     (check: work to do · run: attempts exhausted)
    3  not applicable on this machine — a silent skip, never a failure
    4  no op by that name

Keeping "not applicable" distinct from "satisfied" is deliberate: an op skipped
on a machine it does not apply to must never report as one that succeeded, or a
caller believes a goal was reached that nobody attempted.
"""
from __future__ import annotations

from typing import Any, NoReturn, Optional

import typer
from typing_extensions import Annotated

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
    help="Check and run compute ops — a goal, its check, and the attempts that reach it.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_NOT_YET = 1
#: NOT 2 — that is the CLI-wide "invalid argument", and a check whose skip
#: is indistinguishable from a typo is worse than no skip at all.
EXIT_NOT_APPLICABLE = 3
EXIT_NOT_FOUND = 4
EXIT_ACTION_FAILED = 7

#: Mirrors ``ProcessActionSpec.timeout_seconds`` — the budget the DOCUMENT already
#: declares for its slowest rung. The client waits as long as the server may
#: legitimately take, so a run still in progress is never reported as a failure.
RUN_TIMEOUT_SECONDS = 1800


def _on_error(not_found: str = ""):
    def handle(status: int, body: dict) -> NoReturn:
        if status == 404 and not_found:
            fail(EXIT_NOT_FOUND, "NOT_FOUND", not_found)
        fail(
            EXIT_ACTION_FAILED,
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
        {k: row.get(k) for k in ("name", "description", "requires", "shipped", "enabled")}
        for row in rows
    ]})


@op_app.command("check", help="Ask whether the goal already holds. Runs no attempt.")
def check(name: Annotated[str, typer.Argument(help="The op's name.")]) -> None:
    row = _find(name)
    data = get_graph_json(_url(f"compute_op/{row['id']}/check"), on_error=_on_error()) or {}
    outcome = str(data.get("outcome") or "")
    ok({"op": name, "outcome": outcome})
    if outcome == "satisfied":
        raise typer.Exit(0)
    raise typer.Exit(EXIT_NOT_APPLICABLE if outcome == "not_applicable" else EXIT_NOT_YET)


@op_app.command("run", help="Make the goal hold: check, then attempts cheapest-first, then prove.")
def run(
    name: Annotated[str, typer.Argument(help="The op's name.")],
    approved: Annotated[bool, typer.Option("--approved", help="Authorize an op this instance does not ship.")] = False,
) -> None:
    row = _find(name)
    verdict: Optional[dict] = post_graph_json(
        _url(f"compute_op/{row['id']}/run"),
        {"approved": approved},
        timeout=RUN_TIMEOUT_SECONDS,
        on_error=_on_error(f"Compute op not found: {name}"),
    )
    verdict = verdict or {}
    ok({"op": name, "verdict": verdict})
    raise typer.Exit(0 if verdict.get("ready") else EXIT_NOT_YET)
