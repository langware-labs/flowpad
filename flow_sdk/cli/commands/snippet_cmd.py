"""`flow snippet run` — run a snippet exactly as the snippet view's Run button does.

In-process (no server): the same ``run_snippet`` the route calls, so what an
agent sees here is what the user sees under the editor. Prints the
``ShellResult`` as JSON; the exit code is the snippet's own, 124 on a timeout,
and 2 when it could not run at all (missing file, unknown language).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer
from typing_extensions import Annotated

snippet_app = typer.Typer(name="snippet", help="Code snippets (see `flow show snippet`).", add_completion=False, no_args_is_help=True)

EXIT_TIMED_OUT = 124
EXIT_NOT_RUN = 2


@snippet_app.command("run", help="Run a snippet file as written; prints stdout/stderr/returncode as JSON.")
def run(
    path: Annotated[str, typer.Argument(help="Snippet file (.py, .js, .rs, .sh).")],
    timeout: Annotated[float, typer.Option("--timeout", min=0.1, max=600, help="Seconds before the run is killed.")] = 30.0,
) -> None:
    from flow_sdk.core.snippet import run_snippet  # noqa: PLC0415

    result = asyncio.run(run_snippet(Path(path).expanduser(), timeout_seconds=timeout))
    typer.echo(json.dumps(result.model_dump()))
    if result.timed_out:
        raise typer.Exit(EXIT_TIMED_OUT)
    raise typer.Exit(EXIT_NOT_RUN if result.returncode is None else result.returncode)
