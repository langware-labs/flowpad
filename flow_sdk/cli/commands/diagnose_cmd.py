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


class _Renderer:
    """Compact transcript renderer for `flow diagnose`.

    Shows the agent's narration on its own line (``▸ …`` — the valuable part) and
    collapses each tool action into a single inline progress dot (``·``), so the
    user sees liveness while the agent works (Bash/Read calls) without a line per
    call and without the tool-result noise.
    """

    def __init__(self) -> None:
        self._row_open = False  # an unfinished "· · ·" progress row is on screen

    def _close_row(self) -> None:
        if self._row_open:
            typer.echo("")  # terminate the inline progress row
            self._row_open = False

    def feed(self, entry: dict) -> None:
        msg = entry.get("message")
        if not isinstance(msg, dict):
            return
        role = msg.get("role")
        content = msg.get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if role == "assistant" and btype == "text":
                text = (block.get("text") or "").strip()
                if text:
                    self._close_row()
                    typer.echo(f"  ▸ {text}")
            elif role == "assistant" and btype == "tool_use":
                # One inline dot per tool action — a liveness pulse, no detail.
                if not self._row_open:
                    typer.echo("  ", nl=False)
                    self._row_open = True
                typer.echo("· ", nl=False)
            # tool_result blocks are intentionally not rendered.

    def finish(self) -> None:
        self._close_row()


async def _run_diagnose(message: str, transcript_timeout: float) -> int:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.config import flowpad_assistant_project_root
    from flow_sdk.migrations.runner import _bootstrap_local

    # The skill ships inside the package (flow_sdk/system_projects/...), so it
    # resolves the same whether `flow diagnose` runs from a dev checkout or an
    # installed wheel, and from ANY working directory — not just the repo root.
    skill_dir = flowpad_assistant_project_root() / ".claude" / "skills" / "flow-diagnose"
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

    # stream_transcript re-reads the transcript from the start on each call, so
    # track how many entries we've already printed and skip them on the re-stream
    # after a nudge (avoids duplicating the earlier narration).
    renderer = _Renderer()
    rendered = 0

    async def _stream() -> None:
        nonlocal rendered
        idx = 0
        async for entry in ap.stream_transcript(timeout=transcript_timeout):
            if idx >= rendered:
                renderer.feed(entry)
            idx += 1
        rendered = idx
        renderer.finish()  # close any open progress row before the next message

    async def _recorded() -> bool:
        """Per-run completion signal: the worker's Step 7 cross-links a
        flowpad_diagnosis into THIS process's private context. A fresh DB read
        (the worker is a separate process writing the same instance DB) tells us
        whether the recording step actually ran."""
        fresh = await AgenticProcess.get_by_id(ap.id)
        if fresh is None:
            return False
        return any(t.type == "flowpad_diagnosis" for t in fresh.private_context_entities)

    nudge_text = (
        "You have NOT recorded the diagnosis yet, so nothing was saved. Complete the "
        "skill's final recording step now (Step 7): create the flowpad_diagnosis "
        "record, cross-link it to THIS process, and record it to the Feed via "
        "create_diagnostic_report. Do not stop until it is recorded."
    )

    try:
        await ap.prompt(prompt_text)
        typer.echo(f"  Diagnosing (session={(ap.session_id or '')[:8]})…")
        await _stream()
        # The worker can end its turn early — diagnosing but not recording. Nudge
        # the SAME session once to finish, then re-check.
        if not await _recorded():
            typer.echo("  …agent stopped before recording — nudging it to finish.")
            await ap.prompt(nudge_text)
            await _stream()
    except (KeyboardInterrupt, asyncio.CancelledError):
        typer.echo("Diagnose interrupted.", err=True)
        return 130

    if await _recorded():
        typer.echo("  ✓ Diagnostic complete — recorded to the app's Home Feed.")
        return 0
    typer.echo(
        "  ! Diagnostic finished but the result was not recorded — see the report "
        "above; re-run `flow diagnose` to retry.",
        err=True,
    )
    return 1


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
