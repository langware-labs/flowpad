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
import json
import logging
import re
import sys
from pathlib import Path

import typer

from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S


def _extract_report_result(text: str) -> dict | None:
    """Pull ``report.py``'s result JSON (a dict with ``diagnosis_id``) out of a
    chunk of transcript text. report.py prints it to stdout, which rides through
    the agent's ``tool_result`` (and the agent usually echoes it in text too), so
    the parent can detect completion + read the ids from the stream it is already
    consuming — no cross-process DB read or marker file. Returns the parsed dict,
    or None if not present."""
    if not text or "diagnosis_id" not in text:
        return None
    for m in re.finditer(r'\{[^{}]*"diagnosis_id"[^{}]*\}', text):
        try:
            d = json.loads(m.group(0))
        except ValueError:
            continue
        if isinstance(d, dict) and d.get("diagnosis_id"):
            return d
    return None


def _quiet_logs() -> None:
    """Silence backend INFO/WARNING logging so the user only sees the diagnose
    stream — not internal noise like the service_log INFO line or the pre-existing
    ``@local … legacy random id`` warnings from bootstrap. ERROR/CRITICAL still
    surface.
    """
    logging.disable(logging.WARNING)


class _TerminalSink:
    """Default ``emit`` target: renders diagnose events to the terminal exactly as
    `flow diagnose` always has — narration on its own line (``▸ …`` — the valuable
    part) and each tool action collapsed into a single inline progress dot (``·``),
    so the user sees liveness while the agent works without a line per call.

    ``_run_diagnose`` is output-agnostic: it pushes structured events through an
    ``emit`` callback. The CLI uses this sink (identical terminal output); the UI's
    HTTP endpoint passes its own ``emit`` that forwards the same events as SSE.
    """

    def __init__(self) -> None:
        self._row_open = False  # an unfinished "· · ·" progress row is on screen

    def _close_row(self) -> None:
        if self._row_open:
            typer.echo("")  # terminate the inline progress row
            self._row_open = False

    def __call__(self, event: dict) -> None:
        etype = event.get("type")
        if etype == "narration":
            self._close_row()
            typer.echo(f"  ▸ {event.get('text', '')}")
        elif etype == "progress":
            # One inline dot per tool action — a liveness pulse, no detail.
            if not self._row_open:
                typer.echo("  ", nl=False)
                self._row_open = True
            typer.echo("· ", nl=False)
        elif etype == "status":
            self._close_row()
            typer.echo(event.get("text", ""))
        elif etype == "error":
            self._close_row()
            typer.echo(event.get("text", ""), err=True)
        elif etype == "flush":
            self._close_row()
        # "done" carries structured fields for the UI; the terminal already printed
        # the ✓/! status line, so there is nothing more to render here.


class _Renderer:
    """Translates raw transcript entries into diagnose events (narration / progress
    dots) and pushes them through ``emit``. Tool-result blocks are intentionally
    dropped — only the agent's narration and a liveness pulse per tool call surface.
    """

    def __init__(self, emit) -> None:
        self._emit = emit

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
                    self._emit({"type": "narration", "text": text})
            elif role == "assistant" and btype == "tool_use":
                self._emit({"type": "progress"})
            # tool_result blocks are intentionally not rendered.

    def finish(self) -> None:
        self._emit({"type": "flush"})


async def _run_diagnose(message: str, transcript_timeout: float, *, emit=None) -> int:
    """Run the flow-diagnose skill headless and stream the worker's narration.

    ``emit`` is a callable invoked with structured event dicts (``narration`` /
    ``progress`` / ``status`` / ``error`` / ``done``). When omitted it defaults to
    ``_TerminalSink`` so the CLI renders exactly as before; the UI's HTTP endpoint
    passes its own ``emit`` to forward the same events as SSE. Behavior is otherwise
    identical between the two callers — same skill, same recording, same completion.
    """
    if emit is None:
        emit = _TerminalSink()

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
        "user what to do. You MUST run the skill's final recording step (report.py) "
        "EVERY time — even if everything is healthy and no action is needed (use "
        "--status ok). Do NOT end your turn before it has printed its JSON.\n\n"
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
    renderer = _Renderer(emit)
    rendered = 0
    recorded: dict | None = None  # report.py's result JSON, scraped from the stream

    _diag_cls = SchemaRegistry.get_entity_cls(EntityType.FLOWPAD_DIAGNOSIS)

    def _scan(entry: dict) -> None:
        """Detect report.py's completion JSON in a transcript entry — its stdout
        rides the tool_result, and the agent usually echoes it in text too."""
        nonlocal recorded
        if recorded is not None:
            return
        msg = entry.get("message")
        if not isinstance(msg, dict):
            return
        content = msg.get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict):
                continue
            raw = block.get("content") if block.get("type") == "tool_result" else block.get("text")
            if isinstance(raw, list):  # tool_result content can be a list of parts
                raw = " ".join(
                    p.get("text", "") for p in raw if isinstance(p, dict) and p.get("type") == "text"
                )
            if not isinstance(raw, str):
                continue
            res = _extract_report_result(raw)
            if res is not None:
                recorded = res
                return

    async def _completed() -> bool:
        """Authoritative completion signal: report.py printed its result JSON, which
        we scraped from the transcript stream we are already consuming. No
        cross-process DB read and no marker file — the agent's own output tells us
        it recorded (and gives us the diagnosis id), so this is correct for a clean
        sweep that posts no Feed entry too."""
        return recorded is not None

    async def _consume() -> None:
        nonlocal rendered
        idx = 0
        async for entry in ap.stream_transcript(timeout=transcript_timeout):
            _scan(entry)
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
        "You have NOT recorded the diagnosis yet, so nothing was saved. Run the skill's "
        "final recording step now (Step 7): the report.py reporter script with the "
        "diagnosis fields (--title/--symptoms/--rca/--fix) and --status. You MUST run it "
        "even if everything was healthy — use --status ok. It always creates the "
        "flowpad_diagnosis record (and posts a Feed entry only for real issues). Do not "
        "stop until it has printed its JSON."
    )

    try:
        await ap.prompt(prompt_text)
        emit({"type": "status", "text": f"  Diagnosing (session={(ap.session_id or '')[:8]})…"})
        await _stream()
        # The worker can end its turn early — diagnosing but not recording. Nudge
        # the SAME session once to finish, then re-check.
        if not await _completed():
            emit({"type": "status", "text": "  …agent stopped before recording — nudging it to finish."})
            await ap.prompt(nudge_text)
            await _stream()
    except (KeyboardInterrupt, asyncio.CancelledError):
        emit({"type": "error", "text": "Diagnose interrupted."})
        return 130

    if recorded is not None:
        # Cross-link the diagnosis this run produced into THIS process's context.
        # The CLI owns the process id, so this works on every platform — the worker
        # can't always self-identify to do it itself (notably on Windows, where its
        # uv-run subprocess doesn't inherit FLOWPAD_EXECUTION_SCOPE). The diagnosis
        # id came from report.py's own output (recorded); load it by id.
        did = recorded.get("diagnosis_id")
        try:
            if did and _diag_cls is not None:
                fresh = await AgenticProcess.get_by_id(ap.id)
                diag = await _diag_cls.get_by_id(did)
                if fresh is not None and diag is not None:
                    await cross_link_entities(fresh, diag)
        except Exception:
            pass
        emit({"type": "status", "text": "  ✓ Diagnostic complete — diagnosis recorded."})
        emit({
            "type": "done",
            "ok": True,
            "diagnosis_id": did,
            "feed_posted": bool(recorded.get("feed_posted")),
            "feed_entry_id": recorded.get("feed_entry_id"),
        })
        return 0
    emit({
        "type": "error",
        "text": (
            "  ! Diagnostic finished but the result was not recorded — see the report "
            "above; re-run `flow diagnose` to retry."
        ),
    })
    emit({"type": "done", "ok": False, "diagnosis_id": None, "feed_posted": False, "feed_entry_id": None})
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
