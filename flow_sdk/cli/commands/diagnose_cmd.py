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
import contextlib
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
    from flow_sdk.core.entity.cross_link import cross_link_entities
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.migrations.runner import _bootstrap_local
    from flow_sdk.schema.types import EntityType

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

    _diag_cls = SchemaRegistry.get_entity_cls(EntityType.FLOWPAD_DIAGNOSIS)

    async def _entity_ids(cls) -> set[str]:
        if cls is None:
            return set()
        try:
            rows = await cls.get_all()
        except Exception:
            return set()
        return {r.id for r in rows if getattr(r, "id", None)}

    async def _completed() -> bool:
        """Per-run completion signal: the worker created a NEW flowpad_diagnosis
        record. report.py creates it atomically (and the Feed entry, when an issue
        was found), so the diagnosis appearing means the recording step finished —
        even for a clean sweep that posts no Feed entry. Snapshot-diff, so it does
        NOT depend on the worker cross-linking or knowing its own process id (which
        it can't do in its `uv run python` subprocess on Windows — that's why the
        old cross-link signal produced false 'not recorded' failures)."""
        return bool(await _entity_ids(_diag_cls) - diag_before)

    async def _consume() -> None:
        nonlocal rendered
        idx = 0
        async for entry in ap.stream_transcript(timeout=transcript_timeout):
            if idx >= rendered:
                renderer.feed(entry)
            idx += 1
        rendered = idx

    async def _stream() -> None:
        """Render the worker's transcript, stopping when the turn ends OR — more
        reliably — when a new Feed entry is recorded (Step 7 done).

        We can't depend solely on the transcript's own end-of-turn detection:
        ``_tail_status`` derives COMPLETE from only the last 4 KB of the JSONL, and
        a long final report (one big assistant line) can push the terminal markers
        out of that window, so the stream never sees COMPLETE and polls to its
        deadline — the command hangs long after the work is done (seen on Windows).
        ``_completed()`` is authoritative: once the Feed entry exists the run is
        finished, so we stop then. This is a definitive completion check, not a
        wait budget — we exit the instant either the stream ends or recording lands.
        """
        consumer = asyncio.create_task(_consume())
        try:
            while not consumer.done():
                if await _completed():
                    break
                # Re-check cadence only — there is no give-up timeout; we leave
                # the loop as soon as the stream finishes or recording is detected.
                await asyncio.wait({consumer}, timeout=1.5)
        finally:
            if not consumer.done():
                consumer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consumer
            renderer.finish()  # close any open progress row before the next message

    nudge_text = (
        "You have NOT posted the diagnosis to the Feed yet, so nothing was saved. "
        "Complete the skill's final recording step now (Step 7): create the "
        "flowpad_diagnosis record and post it to the Feed via the report.py reporter "
        "script. Do not stop until the Feed entry exists."
    )

    # Snapshot existing diagnoses, so "completed" means THIS run produced a new
    # one — independent of the worker self-identifying as an agentic process.
    diag_before = await _entity_ids(_diag_cls)

    try:
        await ap.prompt(prompt_text)
        typer.echo(f"  Diagnosing (session={(ap.session_id or '')[:8]})…")
        await _stream()
        # The worker can end its turn early — diagnosing but not recording. Nudge
        # the SAME session once to finish, then re-check.
        if not await _completed():
            typer.echo("  …agent stopped before recording — nudging it to finish.")
            await ap.prompt(nudge_text)
            await _stream()
    except (KeyboardInterrupt, asyncio.CancelledError):
        typer.echo("Diagnose interrupted.", err=True)
        return 130

    if await _completed():
        # Cross-link any diagnosis produced this run into THIS process's context.
        # The CLI owns the process id, so this works on every platform — the worker
        # can't always self-identify to do it itself (notably on Windows, where its
        # uv-run subprocess doesn't inherit FLOWPAD_EXECUTION_SCOPE).
        try:
            new_diag = await _entity_ids(_diag_cls) - diag_before
            if new_diag and _diag_cls is not None:
                fresh = await AgenticProcess.get_by_id(ap.id)
                if fresh is not None:
                    for did in new_diag:
                        diag = await _diag_cls.get_by_id(did)
                        if diag is not None:
                            await cross_link_entities(fresh, diag)
        except Exception:
            pass
        typer.echo("  ✓ Diagnostic complete — diagnosis recorded.")
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
