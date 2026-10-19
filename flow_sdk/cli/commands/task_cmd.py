"""`flow task ...` — the task ledger, from inside a worker (or a shell).

A Chief of Staff hands work off with ``flow task create``; the subagent that owns a task reports
with ``start`` / ``note`` / ``ask`` / ``done`` / ``fail``; the creator answers a question with
``reply`` and may ``cancel``. Who you are is never an argument: the backend reads it from the
calling process (``FLOWPAD_EXECUTION_SCOPE``) — a task run can only act as its own task's owner.

Every command prints one JSON line (``{"ok": true, ...}``); a refusal exits non-zero with the
ledger's reason (exit 7).
"""

from __future__ import annotations

from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import current_process_typeid, discover_port, fail, local_request, ok

task_app = typer.Typer(
    name="task",
    help="The task ledger: create a task for a subagent, report on one you own, read open tasks.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_REFUSED = 7


def _call(method: str, path: str, *, payload: Optional[dict] = None, params: Optional[dict] = None) -> dict:
    import requests  # noqa: PLC0415

    url = f"http://127.0.0.1:{discover_port()}/api/v1/{path}"
    try:
        resp = local_request(method, url, json=payload, params=params, timeout=30)
        body = resp.json()
    except (requests.exceptions.RequestException, ValueError) as exc:
        fail(5, "CONNECTION_ERROR", f"Cannot reach Flowpad at {url}: {exc}")
    if body.get("status") != "SUCCESS":
        fail(EXIT_REFUSED, "REFUSED", str(body.get("message") or body))
    return body.get("data") or {}


def _caller() -> str:
    return current_process_typeid() or ""


@task_app.command("create", help="Hand a task to an owner (default: the generic worker subagent).")
def create(
    title: Annotated[str, typer.Option("--title", help="A short name for the task.")],
    brief: Annotated[str, typer.Option("--brief", help="The contract: objective, what done means, output format.")],
    owner: Annotated[str, typer.Option("--owner", help="subagent:<name> (or agent:<id>).")] = "subagent:general-worker",
    thread: Annotated[str, typer.Option("--thread", help="Conversation it reports back to; 'current' = yours.")] = "current",
    budget_usd: Annotated[Optional[float], typer.Option("--budget-usd", help="Spend cap for the run.")] = None,
    budget_turns: Annotated[Optional[int], typer.Option("--budget-turns", help="Turn cap for the run.")] = None,
) -> None:
    ok({"task": _call("POST", "tasks", payload={
        "caller": _caller(), "title": title, "brief": brief, "owner": owner, "thread": thread,
        "budget_usd": budget_usd, "budget_turns": budget_turns,
    })})


@task_app.command("list", help="Open tasks you created or own (--all: everyone's; --thread current: this conversation's).")
def list_tasks(
    thread: Annotated[str, typer.Option("--thread", help="'current' or a conversation id.")] = "",
    all_: Annotated[bool, typer.Option("--all", help="Not only yours.")] = False,
) -> None:
    ok(_call("GET", "tasks", params={"caller": _caller(), "thread": thread, "all": all_}))


@task_app.command("show", help="One task, with its whole log.")
def show(task_id: Annotated[str, typer.Argument(help="Task id.")]) -> None:
    ok({"task": _call("GET", f"tasks/{task_id}")})


def _event(verb: str, task_id: str, text: str = "", result: Optional[str] = None, artifacts: Optional[list[str]] = None) -> None:
    ok({"task": _call("POST", f"tasks/{task_id}/{verb}", payload={
        "caller": _caller(), "text": text, "result": result, "artifacts": artifacts or [],
    })})


@task_app.command("start", help="Owner: you are working on it.")
def start(task_id: str, text: Annotated[str, typer.Option("--text")] = "") -> None:
    _event("start", task_id, text)


@task_app.command("note", help="Owner or creator: progress, in a sentence.")
def note(task_id: str, text: Annotated[str, typer.Argument(help="What happened.")]) -> None:
    _event("note", task_id, text)


@task_app.command("ask", help="Owner: you need an answer to go on (the task waits on it).")
def ask(task_id: str, question: Annotated[str, typer.Argument(help="The question, answerable as asked.")]) -> None:
    _event("ask", task_id, question)


@task_app.command("reply", help="Creator: answer the owner's question (or add to the brief).")
def reply(task_id: str, text: Annotated[str, typer.Argument(help="The answer.")]) -> None:
    _event("reply", task_id, text)


@task_app.command("done", help="Owner: finished — the result in a sentence or two, files as --artifact.")
def done(
    task_id: str,
    result: Annotated[str, typer.Option("--result", help="The outcome, as the creator will relay it.")],
    artifact: Annotated[Optional[list[str]], typer.Option("--artifact", help="A file it produced (repeat).")] = None,
) -> None:
    _event("done", task_id, result=result, artifacts=list(artifact or []))


@task_app.command("fail", help="Owner: it cannot be done — say why.")
def fail_task(task_id: str, reason: Annotated[str, typer.Argument(help="Why.")]) -> None:
    _event("fail", task_id, reason)


@task_app.command("cancel", help="Creator: no longer needed.")
def cancel(task_id: str, reason: Annotated[str, typer.Argument(help="Why.")] = "") -> None:
    _event("cancel", task_id, reason)


@task_app.command("keep", help="Keep a delegated task in its project (a task.md folder, in git). Not for a task's own run.")
def keep(task_id: str) -> None:
    ok({"task": _call("POST", f"tasks/{task_id}/keep", payload={"caller": _caller()})})
