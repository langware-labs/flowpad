"""`flow snippet run` — run a snippet exactly as the snippet view's Run button does.

In-process (no server): the same ``run_snippet`` the route calls, so what an
agent sees here is what the user sees under the editor. Prints the
``CliResult`` as JSON — the snippet's own ``returncode`` is in it — and exits
the answer's ``exit_code``, like every `flow` command that runs something: 0 it
succeeded, 1 it did not (``timed_out`` says when it was cut off), 3 no runner for
this kind of file, 4 no such file.

Exiting the raw ``returncode`` was the old way, and it broke on a stopped run:
a process killed by a signal reports ``-9``, which a shell reads as 247.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer
from typing_extensions import Annotated

snippet_app = typer.Typer(name="snippet", help="Code snippets (see `flow show snippet`).", add_completion=False, no_args_is_help=True)

@snippet_app.command("run", help="Run a snippet file as written; prints stdout/stderr/returncode as JSON.")
def run(
    path: Annotated[str, typer.Argument(help="Snippet file (.py, .js, .rs, .sh).")],
    timeout: Annotated[float, typer.Option("--timeout", min=0.1, max=600, help="Seconds before the run is killed.")] = 30.0,
) -> None:
    from flow_sdk.core.snippet import run_snippet  # noqa: PLC0415

    result = asyncio.run(run_snippet(Path(path).expanduser(), timeout_seconds=timeout))
    typer.echo(json.dumps(result.model_dump(mode="json")))
    raise typer.Exit(int(result.exit_code))
