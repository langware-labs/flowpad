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
from typing import Callable

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
    *, summary: str, conversation_id: str | None = None, flow_message_id: str | None = None
) -> str | None:
    """Post the Home-Feed ``message_suggest`` card for a recorded diagnosis, SDK-direct.

    The single creator both surfaces use (the CLI runner, and the UI's
    ``diagnose_post_feed`` action). We create the ``FeedEntry`` here — in a process that
    is bootstrapped and works even when the backend is down.

    Two shapes, keyed on whether there's a support conversation:

    * **Issue** (``conversation_id`` + ``flow_message_id`` given) — the card points at
      the hidden support Conversation/FlowMessage so it can offer Report / Forward.
    * **No issue** (neither given) — there's nothing to report, but the card still
      carries the summary so a user who wasn't watching the modal still gets the answer.

    Returns the new entry id, or ``None`` on failure (best-effort; never fails the run).
    """
    try:
        from flow_sdk.builtin.feed_entry import FeedEntry, FeedKind, FeedStatus, MessageSuggest
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
        )
        feed = FeedEntry(
            kind=FeedKind.MESSAGE_SUGGEST.value,
            feed_status=FeedStatus.NEW.value,
            feed_data=suggest.model_dump(),
        )
        feed = await feed.save(user.typeid)
        return feed.id
    except Exception:
        return None


async def _run_diagnose(
    message: str,
    transcript_timeout: float,
    *,
    emit=None,
    create_feed_entry: "bool | Callable[[bool], bool]" = True,
) -> int:
    """Run the flow-diagnose skill headless and stream the worker's narration.

    ``emit`` is a callable invoked with structured event dicts (``narration`` /
    ``progress`` / ``status`` / ``error`` / ``done``). When omitted it defaults to
    ``_TerminalSink`` so the CLI renders exactly as before; the UI's HTTP endpoint
    passes its own ``emit`` to forward the same events as SSE.

    ``create_feed_entry`` decides whether to post the Home-Feed card. It is given the
    run's ``has_issue`` and returns whether to post; it may also be a bool, where
    ``True`` means "post for an issue only" (the no-issue card needs an explicit
    callable). A callable is evaluated at posting time, so a late decision — "did the
    UI modal close / go unwatched before we finished?" — is possible.

    * **CLI** passes ``True``: post a card for an issue (its Report/Forward actions are
      the CLI's lasting output); a clean sweep prints to the terminal, no card.
    * **UI** passes ``lambda has_issue: <user wasn't watching>``: while the modal is
      open and focused it shows the result itself, so nothing is posted; if the user
      defocused / minimized, a card is posted **for any result** — an issue card with
      the report buttons, or a no-issue card carrying the summary so they still get
      the answer.

    report.py is identical for both surfaces: it always records the diagnosis and (for
    an issue) its support Conversation/FlowMessage; only this Feed posting differs, so
    the split is fully deterministic and never relies on the worker.
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
                emit({"type": "error", "text": (
                    "  ! The diagnostic agent failed to start — it produced no transcript. "
                    "Check that the `claude` CLI is installed and on your PATH, then re-run "
                    "`flow diagnose`."
                )})
                emit({
                    "type": "done", "ok": False, "diagnosis_id": None, "conversation_id": None,
                    "flow_message_id": None, "feed_posted": False, "feed_entry_id": None,
                })
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
            # Cross-link the diagnosis this run produced into THIS process's context.
            # The CLI owns the process id, so this works on every platform — the worker
            # can't always self-identify to do it itself (notably on Windows, where its
            # uv-run subprocess doesn't inherit FLOWPAD_EXECUTION_SCOPE). The diagnosis
            # id came from report.py's own output (recorded); load it by id.
            did = recorded.get("diagnosis_id")
            conv_id = recorded.get("conversation_id")
            msg_id = recorded.get("flow_message_id")
            diag = None
            try:
                if did and _diag_cls is not None:
                    fresh = await AgenticProcess.get_by_id(ap.id)
                    diag = await _diag_cls.get_by_id(did)
                    if fresh is not None and diag is not None:
                        await cross_link_entities(fresh, diag)
            except Exception:
                pass
            # Post the Home-Feed card. has_issue ⇔ report.py created a support
            # Conversation/FlowMessage. A bool create_feed_entry posts for an issue only
            # (CLI); a callable gets has_issue and may also post a no-issue summary card
            # (UI, when the user wasn't watching). Evaluated now so the decision can read
            # live state (e.g. whether the modal is still connected).
            has_issue = bool(conv_id and msg_id)
            if callable(create_feed_entry):
                want_feed = create_feed_entry(has_issue)
            else:
                want_feed = bool(create_feed_entry) and has_issue
            feed_entry_id = None
            if want_feed:
                summary = (getattr(diag, "summary", None) or getattr(diag, "title", None) or "") if diag else ""
                feed_entry_id = await _post_home_feed_entry(
                    summary=summary, conversation_id=conv_id, flow_message_id=msg_id
                )
            emit({"type": "status", "text": "  ✓ Diagnostic complete — diagnosis recorded."})
            emit({
                "type": "done",
                "ok": True,
                "diagnosis_id": did,
                "conversation_id": conv_id,
                "flow_message_id": msg_id,
                "feed_posted": bool(feed_entry_id),
                "feed_entry_id": feed_entry_id,
            })
            return 0
        emit({
            "type": "error",
            "text": (
                "  ! Diagnostic finished but the result was not recorded — see the report "
                "above; re-run `flow diagnose` to retry."
            ),
        })
        emit({
            "type": "done", "ok": False, "diagnosis_id": None, "conversation_id": None,
            "flow_message_id": None, "feed_posted": False, "feed_entry_id": None,
        })
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
