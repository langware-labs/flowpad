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
from flow_sdk.agentic_warmup import await_worker_started


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


# Glyph → ASCII fallbacks for consoles whose codepage can't encode the decorative
# characters (Windows cp1252 has no ▸ / ✓, so ``typer.echo`` raises
# UnicodeEncodeError on them). Only consulted when a direct echo fails, so UTF-8
# terminals render the real glyphs unchanged.
_GLYPH_FALLBACKS = {"▸": ">", "✓": "v", "✗": "x", "·": ".", "…": "...", "—": "-", "–": "-"}


def _safe_echo(message: str = "", *, nl: bool = True, err: bool = False) -> None:
    """``typer.echo`` that degrades gracefully instead of crashing the run on a
    non-UTF-8 console. The encode error fires before any bytes are written, so the
    ASCII-fallback retry cannot double-print.
    """
    try:
        typer.echo(message, nl=nl, err=err)
    except UnicodeEncodeError:
        safe = "".join(_GLYPH_FALLBACKS.get(c, c) for c in message)
        typer.echo(safe.encode("ascii", "replace").decode("ascii"), nl=nl, err=err)


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
            _safe_echo("")  # terminate the inline progress row
            self._row_open = False

    def __call__(self, event: dict) -> None:
        etype = event.get("type")
        if etype == "narration":
            self._close_row()
            _safe_echo(f"  ▸ {event.get('text', '')}")
        elif etype == "progress":
            # One inline dot per tool action — a liveness pulse, no detail.
            if not self._row_open:
                _safe_echo("  ", nl=False)
                self._row_open = True
            _safe_echo("· ", nl=False)
        elif etype == "status":
            self._close_row()
            _safe_echo(event.get("text", ""))
        elif etype == "error":
            self._close_row()
            _safe_echo(event.get("text", ""), err=True)
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


async def _post_home_feed_entry(
    *,
    summary: str,
    conversation_id: str | None = None,
    flow_message_id: str | None = None,
    diagnosis_id: str | None = None,
) -> str | None:
    """Post the Home-Feed card for a recorded diagnosis, SDK-direct.

    The single creator the runner uses for every completed diagnose run — the CLI
    and the UI modal alike. We create the ``MessageSuggest`` content entity and a
    generic ``FeedEntry`` pointing at it here — in a process that is bootstrapped and
    works even when the backend is down.

    Two shapes, keyed on whether there's a support conversation:

    * **Issue** (``conversation_id`` + ``flow_message_id`` given) — the card points at
      the hidden support Conversation/FlowMessage so it can offer Report / Forward.
    * **No issue** (neither given) — there's nothing to report, but the card still
      carries the summary so the result is always recorded on the Home feed.

    Returns the new entry id, or ``None`` on failure (best-effort; never fails the run).
    """
    try:
        from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
        from flow_sdk.builtin.message_suggest import MessageSuggest
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user

        user = await get_or_create_local_user()
        has_issue = bool(conversation_id and flow_message_id)
        header = (
            "An error came up while using Flowpad — here's what the diagnostic found:"
            if has_issue
            else "Flowpad diagnostic finished — here's what we found:"
        )
        suggest = MessageSuggest(
            text=header,
            message_text=(summary or "").strip(),
            conversation_id=conversation_id,
            flow_message_id=flow_message_id,
            diagnosis_id=diagnosis_id,
        )
        suggest = await suggest.save(user.typeid)
        feed = FeedEntry(
            feed_status=FeedStatus.NEW.value,
            data={"type_id": str(suggest.typeid)},
        )
        feed = await feed.save(user.typeid)
        return feed.id
    except Exception:
        return None


async def _load_recorded_diagnosis(diagnosis_cls, diagnosis_id: str | None):
    """Load the diagnosis just recorded by report.py.

    The reporter runs in the worker process and syncs the record before printing
    its JSON completion line, but the CLI process can still observe a short
    cross-process visibility delay. Retry briefly so the Feed card can carry the
    recorded summary instead of posting an empty body.
    """
    if not diagnosis_id:
        return None

    if diagnosis_cls is None:
        try:
            from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis

            diagnosis_cls = FlowpadDiagnosis
        except Exception:
            return None

    last = None
    for _ in range(20):
        try:
            last = await diagnosis_cls.get_by_id(diagnosis_id)
            if last is not None and (getattr(last, "summary", None) or getattr(last, "title", None)):
                return last
        except Exception:
            last = None
        await asyncio.sleep(0.25)
    return last


async def _build_diagnose_process():
    """The diagnose worker process, exactly as `flow diagnose` launches it.

    Built from the named ``diagnose`` Agent, so the permission mode, model and
    assistant flag are the ones a user can read off its card rather than
    literals buried here. A single construction point so tests can exercise the
    real thing.

    ``save=False`` / ``start=False`` are both deliberate: the process is never
    persisted (the exist_in_db gate was dropped for visible=False precisely so
    this could spawn without a record), and the caller drives the turns itself
    with ``ap.prompt``. Never persisted also means it MUST select the headless
    transport — ``prompt()`` routes on ``pty_mode`` and the PTY branch would
    refuse an unsaved process ("not found in database") before any worker
    spawns.
    """
    from flow_sdk.builtin.agent_registry import get_agent_local_deployment

    deployment = await get_agent_local_deployment("diagnose")
    return await deployment.build(
        workdir=str(Path.cwd()),
        name="flow diagnose",
    )


async def _run_diagnose(
    message: str,
    transcript_timeout: float,
    *,
    emit=None,
    project_id: str | None = None,
) -> int:
    """Run the flow-diagnose skill headless and stream the worker's narration.

    ``emit`` is a callable invoked with structured event dicts (``narration`` /
    ``progress`` / ``status`` / ``error`` / ``done``). When omitted it defaults to
    ``_TerminalSink`` so the CLI renders exactly as before; the UI's HTTP endpoint
    passes its own ``emit`` to forward the same events as SSE.

    Every completed run posts exactly one Home-Feed card through
    ``_post_home_feed_entry`` — an issue card carrying the report buttons when
    report.py created a support Conversation/FlowMessage, otherwise a no-issue card
    carrying the summary. This holds for both surfaces (the CLI and the UI modal), so
    the recorded result always reaches the Home feed regardless of how it was launched
    or whether the user was watching.

    report.py is identical for both surfaces: it always records the diagnosis and (for
    an issue) its support Conversation/FlowMessage; posting the Feed card is this
    runner's job, so the behavior is fully deterministic and never relies on the worker.
    """
    if emit is None:
        emit = _TerminalSink()

    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.config import flowpad_assistant_project_root
    from flow_sdk.core.capabilities.discovery import ensure_discovered
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

    # Run capability discovery so the headless worker can resolve the `claude`
    # CLI. `flow diagnose` is a short-lived standalone process — it never starts
    # the server, so the background discovery sweep never runs on its own. Without
    # this, `worker_path_env("claude")` returns None, the worker fails with
    # "claude binary not found in PATH" BEFORE writing any transcript, and the
    # stream below polls to its full deadline and dies with an opaque
    # "transcript file did not appear within timeout". ensure_discovered() is
    # idempotent and caps its env-probe child at 5s.
    await ensure_discovered()

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

    ap = await _build_diagnose_process()

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
                raw = " ".join(p.get("text", "") for p in raw if isinstance(p, dict) and p.get("type") == "text")
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
        reliably — when the diagnosis is recorded (report.py printed its JSON).

        We can't depend solely on the transcript's own end-of-turn detection:
        ``_tail_status`` derives COMPLETE from only the last 4 KB of the JSONL, and
        a long final report (one big assistant line) can push the terminal markers
        out of that window, so the stream never sees COMPLETE and polls to its
        deadline — the command hangs long after the work is done (seen on Windows).
        ``_completed()`` is authoritative: once report.py's result lands the run is
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
        "flowpad_diagnosis record (and a support conversation only for real issues). Do "
        "not stop until it has printed its JSON."
    )

    async def _terminate_worker() -> None:
        # Don't leak the worker: it is spawned detached (via the backend), so an
        # interrupted OR finished run would otherwise leave an orphaned claude
        # process behind — and a pile-up of those starves new runs (they spawn but
        # never produce output → hang). Kill it on EVERY exit.
        with contextlib.suppress(Exception):
            shell = await ap.shell()
            if shell is not None:
                await shell.terminate_worker()

    try:
        try:
            await ap.prompt(prompt_text)
            emit({"type": "status", "text": f"  Diagnosing (session={(ap.session_id or '')[:8]})…"})
            if not await await_worker_started(ap, transcript_timeout):
                emit(
                    {
                        "type": "error",
                        "text": (
                            "  ! The diagnostic agent failed to start — it produced no transcript. "
                            "Check that the `claude` CLI is installed and on your PATH, then re-run "
                            "`flow diagnose`."
                        ),
                    }
                )
                emit(
                    {
                        "type": "done",
                        "ok": False,
                        "diagnosis_id": None,
                        "conversation_id": None,
                        "flow_message_id": None,
                        "feed_posted": False,
                        "feed_entry_id": None,
                    }
                )
                return 1
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
            # The diagnosis id came from report.py's own output (recorded).
            did = recorded.get("diagnosis_id")
            conv_id = recorded.get("conversation_id")
            msg_id = recorded.get("flow_message_id")

            # Stamp the user's own free-text description onto the record. report.py
            # (run by the agent) only ever sees the agent-observed ``symptoms`` — the
            # raw text the user typed lives only here in the CLI runner — so we persist
            # it now, after the record exists, where the "Report issue" email reads it.
            if did and message:
                with contextlib.suppress(Exception):
                    from flow_sdk.fs_store.fs_record import FSRecord

                    rec = FSRecord.load_or_none(EntityType.FLOWPAD_DIAGNOSIS.value, did)
                    if rec is not None:
                        rec.save_metadata_field("user_report", message)
                        rec = FSRecord.load_or_none(EntityType.FLOWPAD_DIAGNOSIS.value, did)
                        if rec is not None:
                            await rec.sync_to_db()

            # Stamp the origin project — the project the user was in when they ran
            # the diagnosis. Resolved from the id the UI passed (the CLI has no
            # active project, so this is skipped there). The name travels with the
            # record so a helper on another machine can see where it happened.
            if did and project_id:
                with contextlib.suppress(Exception):
                    from flow_sdk.builtin.project import Project
                    from flow_sdk.fs_store.fs_record import FSRecord

                    origin_project = await Project.get_one({"id": project_id})
                    origin_name = getattr(origin_project, "name", None) if origin_project else None
                    rec = FSRecord.load_or_none(EntityType.FLOWPAD_DIAGNOSIS.value, did)
                    if rec is not None:
                        rec.save_metadata_field("origin_project_id", project_id)
                        if origin_name:
                            rec.save_metadata_field("origin_project_name", origin_name)
                        rec = FSRecord.load_or_none(EntityType.FLOWPAD_DIAGNOSIS.value, did)
                        if rec is not None:
                            await rec.sync_to_db()

            # Load the recorded diagnosis (retrying briefly for cross-process
            # visibility) so the Feed card carries its summary, then cross-link it into
            # THIS process's context. The CLI owns the process id, so this works on every
            # platform — the worker can't always self-identify to do it itself (notably
            # on Windows, where its uv-run subprocess doesn't inherit
            # FLOWPAD_EXECUTION_SCOPE).
            diag = await _load_recorded_diagnosis(_diag_cls, did)
            try:
                if diag is not None:
                    fresh = await AgenticProcess.get_by_id(ap.id)
                    if fresh is not None:
                        await cross_link_entities(fresh, diag)
            except Exception:
                pass

            # Post the Home-Feed card — ALWAYS, for every completed run. conv_id +
            # msg_id present ⇔ report.py created a support Conversation/FlowMessage, so
            # this is an issue card with the report buttons; otherwise it is a no-issue
            # card carrying the summary. Either way the result reaches the Home feed,
            # from the CLI or the UI modal, watched or not.
            summary = (getattr(diag, "summary", None) or getattr(diag, "title", None) or "") if diag else ""
            feed_entry_id = await _post_home_feed_entry(
                summary=summary,
                conversation_id=conv_id,
                flow_message_id=msg_id,
                diagnosis_id=did,
            )
            emit({"type": "status", "text": "  ✓ Diagnostic complete — diagnosis recorded."})
            emit(
                {
                    "type": "done",
                    "ok": True,
                    "diagnosis_id": did,
                    "conversation_id": conv_id,
                    "flow_message_id": msg_id,
                    "feed_posted": bool(feed_entry_id),
                    "feed_entry_id": feed_entry_id,
                }
            )
            return 0
        emit(
            {
                "type": "error",
                "text": (
                    "  ! Diagnostic finished but the result was not recorded — see the report "
                    "above; re-run `flow diagnose` to retry."
                ),
            }
        )
        emit(
            {
                "type": "done",
                "ok": False,
                "diagnosis_id": None,
                "conversation_id": None,
                "flow_message_id": None,
                "feed_posted": False,
                "feed_entry_id": None,
            }
        )
        return 1
    finally:
        await _terminate_worker()


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
        typer.echo("Describe the issue or paste the error, then press Enter (leave empty for a full diagnostic sweep):")
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
