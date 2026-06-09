"""Migrate CLI surface.

``flow migrate run [--version X]`` — apply the migration recipe for the
current (or specified) version, if a ``SKILL.md`` exists under
``<flowpad_assistant>/migrations/<version>/skill/``. Idempotent: completed
migrations short-circuit; in-flight migrations are detected via filelock.

``flow migrate status`` — print a stdlib-formatted table of every
migration row in ``<flow_home>/global/migrations/``.

Both commands are usable from inside ``flow start``'s boot path (see
``flow_sdk/cli/flow_cli.py``).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Optional

import typer

from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S
from flow_sdk.migrations import runner as migration_runner
from flow_sdk.migrations import status as migration_status

migrate_app = typer.Typer(
    name="migrate",
    help="Run and inspect version-specific migrations.",
    add_completion=False,
    no_args_is_help=True,
)


@migrate_app.command("run")
def run(
    version: Annotated[
        Optional[str],
        typer.Option(
            "--version",
            help="Override the migration version (defaults to flow_sdk.__version__).",
        ),
    ] = None,
    transcript_timeout: Annotated[
        float,
        typer.Option(
            "--timeout",
            help="Max seconds to wait for the migration agent's transcript to settle.",
        ),
    ] = DEFAULT_TRANSCRIPT_TIMEOUT_S,
) -> None:
    """Run the migration recipe for ``--version`` (or the current version).

    No-op when no recipe exists for the version, when the migration is
    already completed, or when another coordinator is already running it.
    """
    exit_code = migration_runner.run_if_needed(
        version=version,
        transcript_timeout=transcript_timeout,
    )
    raise typer.Exit(exit_code)


@migrate_app.command("status")
def status() -> None:
    """Print a table of all on-disk migration records."""
    status_dir = migration_runner._resolve_status_dir()
    rows = migration_status.list_all(status_dir)

    if not rows:
        typer.echo("No migrations recorded.")
        typer.echo(f"(status dir: {status_dir})")
        raise typer.Exit(0)

    # stdlib-only table — column widths picked for typical version strings,
    # uuid-prefixed ids, and ISO timestamps trimmed to seconds.
    fmt = "{:<12} {:<10} {:<7} {:<6} {:<20} {:<10} {}"
    typer.echo(fmt.format(
        "VERSION", "STATUS", "PID", "ALIVE", "STARTED", "DURATION", "SESSION",
    ))
    typer.echo("-" * 100)
    for r in rows:
        pid_str = str(r.pid) if r.pid else "-"
        alive = "yes" if r.pid and migration_runner._is_process_alive(r.pid) else "-"
        started = (r.started_at or "-")[:19].replace("T", " ")
        dur = (
            f"{r.duration_seconds:.1f}s"
            if r.duration_seconds is not None
            else _live_elapsed(r.started_at)
        )
        sid = (r.claude_session_id or "-")[:8]
        typer.echo(fmt.format(
            r.version, r.status, pid_str, alive, started, dur, sid,
        ))


def _live_elapsed(started_at: str | None) -> str:
    """For non-terminal rows, render time since started_at."""
    if not started_at:
        return "-"
    try:
        started_dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        delta = (datetime.now(timezone.utc) - started_dt).total_seconds()
        return f"{delta:.1f}s*"  # trailing * marks "still in flight"
    except ValueError:
        return "-"
