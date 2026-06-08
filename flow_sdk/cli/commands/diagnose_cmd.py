"""`flow diagnose` — run the flow-diagnose skill on a headless AgenticProcess.

`flow diagnose` drives a **headless** AgenticProcess on the flow-diagnose skill:
it injects the user's free text / pasted error (empty = full sweep), points the
worker at the skill, and streams the worker's narration. All behavior — diagnose,
repair-when-safe, and recording the outcome to the app Feed — lives in the skill's
`SKILL.md` (its final step records the report itself, via the SDK, even when the
backend is down). This command is just the runner: spin up the worker, stream, exit.
"""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import typer

from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S


def _quiet_logs() -> None:
    """Silence backend INFO/WARNING logging so the user only sees the diagnose
    stream — not internal noise like the service_log INFO line or the pre-existing
    ``@local … legacy random id`` warnings from bootstrap. ERROR/CRITICAL still
    surface.
    """
    logging.disable(logging.WARNING)


def _print_agent_text(entry: dict) -> None:
    """Print the worker's narration (assistant text blocks) as they stream."""
    msg = entry.get("message")
    if not isinstance(msg, dict) or msg.get("role") != "assistant":
        return
    content = msg.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = (block.get("text") or "").strip()
            if text:
                typer.echo(f"  ▸ {text}")


async def _run_diagnose(message: str, transcript_timeout: float) -> int:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.migrations.runner import _bootstrap_local

    skill_dir = Path.cwd() / ".claude" / "skills" / "flow-diagnose"
    if not (skill_dir / "SKILL.md").exists():
        typer.echo(f"ERROR: flow-diagnose skill not found at {skill_dir}.", err=True)
        return 1

    # Bootstrap @local + a compute node so the headless worker can run (also
    # guarantees @local exists for the skill's reporting step).
    await _bootstrap_local()

    prompt_text = (
        f"Read the flow-diagnose skill at {skill_dir}/SKILL.md and follow it to "
        "diagnose Flowpad and record the result.\n\n"
        "Diagnose the user's Flowpad issue, repair it ONLY when you safely can, and "
        "record the outcome — all in THIS turn. You may read sibling files the skill "
        "references (e.g. references/catalog.md). Apply a fix only when you are "
        "confident AND it is safe and reversible on this machine; otherwise tell the "
        "user what to do. The skill's final step records the result to the app Feed — "
        "do NOT end your turn before it has run.\n\n"
        "User-reported text — free text or a pasted error; empty means run a full "
        f'sweep:\n"{message}"'
    )

    ap = AgenticProcess(
        cli_config={"permission_mode": "bypassPermissions"},
        workdir=str(Path.cwd()),
        visible=False,
    )
    ap.enable_assistant()

    await ap.prompt(prompt_text)
    typer.echo(f"  Diagnosing (session={(ap.session_id or '')[:8]})…")
    try:
        async for entry in ap.stream_transcript(timeout=transcript_timeout):
            _print_agent_text(entry)
    except (KeyboardInterrupt, asyncio.CancelledError):
        typer.echo("Diagnose interrupted.", err=True)
        return 130

    typer.echo("  ✓ Diagnostic complete — see the report above and the app's Home Feed.")
    return 0


def diagnose_command(
    timeout: float = typer.Option(
        DEFAULT_TRANSCRIPT_TIMEOUT_S, "--timeout", help="Transcript stream budget in seconds."
    ),
) -> None:
    """Diagnose a Flowpad issue; you'll be prompted to type or paste it.

    Prompts you to describe or paste what you saw (Enter to submit; empty = full
    diagnostic sweep), then diagnoses, repairs what's safe, and records the result
    to the app's Feed. Text given on the command line is ignored — type it at the
    prompt so apostrophes/quotes work without shell quoting.
    """
    _quiet_logs()
    # Always read the message from stdin — never from argv. Anything typed after
    # `flow diagnose` on the command line is intentionally ignored, because the
    # shell mangles free text (apostrophes like "can't", quotes) before we ever
    # see it. A single Enter submits; empty input falls back to a full sweep.
    if sys.stdin.isatty():
        typer.echo(
            "Describe the issue or paste the error, then press Enter "
            "(leave empty for a full diagnostic sweep):"
        )
    try:
        text = sys.stdin.readline().strip()
    except (EOFError, KeyboardInterrupt):
        text = ""
    # Immediate acknowledgment — bootstrap + agent spin-up before the first
    # "Diagnosing (session=…)" line can take several seconds.
    typer.echo(
        ("Running a full diagnostic sweep" if not text else "Diagnosing your issue")
        + " — spinning up the agent (this can take a few seconds)…"
    )
    rc = asyncio.run(_run_diagnose(text, timeout))
    raise typer.Exit(rc)
