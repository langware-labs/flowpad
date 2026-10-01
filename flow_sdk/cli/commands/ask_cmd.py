"""`flow ask ...` — answer a question an op put to a person.

AI Assist hands a question to an agent; the agent answers it here, through the same route a person's
answer takes, so the asking op cannot tell who answered. The value is read from stdin or a file and
never printed: it must not pass through the agent's command line or transcript.

Prints one JSON line (``{"ok": true, ...}``); a refused value (it does not match what was asked for)
or a question no longer waiting exits 7 with the reason — fix the value and answer again.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import discover_port, fail, local_request, ok

ask_app = typer.Typer(
    name="ask",
    help="Answer a question an op put to a person (AI Assist answers through this).",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_REFUSED = 7


@ask_app.callback()
def _group() -> None:
    """A group even with one command, so ``flow ask answer`` reads the same wherever it is mounted."""


@ask_app.command("answer", help="Answer a question with a value from stdin, or a file's content.")
def answer(
    question_id: Annotated[str, typer.Argument(help="The question's id.")],
    stdin: Annotated[bool, typer.Option("--stdin", help="Read the value from stdin (one trailing newline dropped).")] = False,
    file: Annotated[Optional[Path], typer.Option("--file", help="Answer with this file's content.")] = None,
) -> None:
    import requests  # noqa: PLC0415

    if stdin == (file is not None):
        fail(2, "USAGE", "give exactly one of --stdin or --file")
    if file is not None:
        try:
            value = file.read_text()
        except OSError as exc:
            fail(2, "USAGE", f"cannot read {file}: {exc}")
    else:
        value = sys.stdin.read()
        value = value[:-1] if value.endswith("\n") else value
    if not value.strip():
        fail(EXIT_REFUSED, "REFUSED", "the value is empty")

    url = f"http://127.0.0.1:{discover_port()}/api/v1/ask/{question_id}/answer"
    try:
        body = local_request("POST", url, json={"value": value}, timeout=30).json()
    except (requests.exceptions.RequestException, ValueError) as exc:
        fail(5, "CONNECTION_ERROR", f"Cannot reach Flowpad at {url}: {exc}")
    if body.get("status") != "SUCCESS":
        fail(EXIT_REFUSED, "REFUSED", str(body.get("message") or body))
    ok({"answered": question_id})
