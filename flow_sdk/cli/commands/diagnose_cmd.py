"""`flow diagnose` — run the flow-diagnose skill, and `flow diagnose-report` —
the SDK-direct reporting helper the skill calls at the end of a run.

`flow diagnose [MESSAGE]` drives a **headless** AgenticProcess on the
flow-diagnose skill (same blueprint as the migration runner). MESSAGE is the
user's free text or pasted error; empty runs a full sweep. All behavior lives in
the skill's `SKILL.md` — this command just injects the user's text and streams
the worker's output.

`flow diagnose-report --summary ... --status ... [--details ...] [--platform ...]`
persists the report as a hidden Conversation + FlowMessage + FeedEntry via the
SDK (no HTTP), so it works even when the backend is down. The skill's reporting
phase shells out to this.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import List, Optional

import typer

from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S


def _quiet_logs() -> None:
    """Silence backend INFO/WARNING logging so the user only sees the diagnose
    stream and the final result — not internal noise like the service_log INFO
    line or the pre-existing ``@local … legacy random id`` warnings from
    bootstrap. ERROR/CRITICAL still surface.
    """
    logging.disable(logging.WARNING)


async def _feed_entry_ids() -> set[str]:
    """Current FeedEntry ids (best-effort; empty set on any failure)."""
    try:
        from flow_sdk.builtin.feed_entry import FeedEntry

        items = await FeedEntry.get_all()
        return {fe.id for fe in items if getattr(fe, "id", None)}
    except Exception:
        return set()


class _Renderer:
    """Compact transcript renderer for `flow diagnose`.

    Shows the agent's narration on its own line (``▸ …`` — the valuable part) and
    collapses each tool action into a single inline progress dot (``·``), so the
    user sees liveness without a line per Bash/Read call and without the
    ``↳ (tool result received)`` noise.

    Glyphs are restricted to non-emoji codepoints — Windows consoles convert
    emoji-presentation chars (e.g. ``▪`` → ``:black_small_square:``, ``⚠`` →
    ``:warning:``) to shortcode text, so we avoid them.
    """

    def __init__(self) -> None:
        self._row_open = False  # an unfinished "▪ ▪ ▪" progress row is on screen

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
                    typer.echo(f"  ▸ {text[:240]}")
            elif role == "assistant" and btype == "tool_use":
                # One inline dot per tool action — a liveness pulse, no detail.
                if not self._row_open:
                    typer.echo("  ", nl=False)
                    self._row_open = True
                typer.echo("· ", nl=False)
            # tool_result blocks are intentionally not rendered — the box already
            # marked the step.

    def finish(self) -> None:
        self._close_row()


def _find_skill_dir() -> Optional[Path]:
    """Locate the installed flow-diagnose skill directory."""
    candidates = [
        Path.cwd() / ".claude" / "skills" / "flow-diagnose",
        # repo root: flow_sdk/cli/commands/diagnose_cmd.py -> parents[3]
        Path(__file__).resolve().parents[3] / ".claude" / "skills" / "flow-diagnose",
    ]
    for c in candidates:
        if (c / "SKILL.md").exists():
            return c
    return None


async def _run_diagnose(message: str, transcript_timeout: float) -> int:
    from flow_sdk.agentic_run_consts import AGENT_WARMUP_INTERVAL_S, AGENT_WARMUP_TICKS
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.migrations.runner import _bootstrap_local

    skill_dir = _find_skill_dir()
    if not skill_dir:
        typer.echo(
            "ERROR: flow-diagnose skill not found (looked under "
            "./.claude/skills/flow-diagnose and the repo root).",
            err=True,
        )
        return 1

    skill_md = (skill_dir / "SKILL.md").read_text(encoding="utf-8")

    # Bootstrap @local + a compute node so the headless worker can run (also
    # guarantees @local exists for the reporting phase).
    cn = await _bootstrap_local()
    feed_before = await _feed_entry_ids()

    prompt_text = (
        "Use the flow-diagnose skill to diagnose the user's Flowpad issue, repair "
        "it ONLY when you safely can, and record the outcome — all in THIS turn.\n\n"
        f"The skill directory is mounted at {skill_dir}; read its SKILL.md and "
        "follow it exactly. You may read sibling files it references (e.g. "
        "references/catalog.md).\n\n"
        "Fix conservatively. Apply a repair ONLY when BOTH hold: (1) you have a "
        "confident diagnosis and know exactly what to do, and (2) it's a safe, "
        "reversible fix you can perform on this machine yourself (e.g. removing a "
        "stale server.lock/server.pid/server.json for a dead PID, freeing port "
        "9007, installing FUSE for a Linux AppImage). If the cause is unclear, or "
        "the fix is the user's to make (re-install, re-sign the app, cloud/account "
        "actions, anything off this machine) or is risky/destructive, do NOT "
        "attempt it — tell the user exactly what to do instead.\n\n"
        "Your FINAL action MUST be to run `flow diagnose-report` to record the "
        "outcome to the app's Feed — set --status to `fixed` when you repaired it, "
        "`needs_action` when the user must act, `informational`, or `unrecognized`. "
        "`flow diagnose-report` writes DIRECTLY to the local database and works "
        "even when the backend is DOWN — it does NOT need a running server, so "
        "never skip it on the assumption that a backend is required. Do NOT end "
        "your turn until diagnose-report has run.\n\n"
        "User-reported text — may be free text or a pasted error; empty means "
        f'run a full sweep:\n"{message}"\n\n'
        f"--- BEGIN SKILL (flow-diagnose/SKILL.md) ---\n{skill_md}\n--- END SKILL ---"
    )

    ap = AgenticProcess(
        compute_node_id=f"compute_node-{cn.id}",
        cli_config={"permission_mode": "bypassPermissions"},
        workdir=str(Path.cwd()),
        visible=False,
    )

    def _tx_size() -> int:
        tp = ap.driver.transcript_path(ap)
        try:
            return tp.stat().st_size if tp and tp.exists() else 0
        except OSError:
            return 0

    async def _await_growth(min_size: int) -> bool:
        """Wait for the transcript to grow past ``min_size`` — i.e. the (re-)
        prompted turn has actually started writing. Reuses the warmup budget."""
        for _ in range(AGENT_WARMUP_TICKS):
            if _tx_size() > min_size:
                return True
            await asyncio.sleep(AGENT_WARMUP_INTERVAL_S)
        return _tx_size() > min_size

    rendered = 0  # entries already printed across turns (transcript is append-only)
    renderer = _Renderer()

    async def _stream_new() -> None:
        nonlocal rendered
        idx = 0
        async for entry in ap.stream_transcript(timeout=transcript_timeout):
            if idx >= rendered:
                renderer.feed(entry)
            idx += 1
        rendered = idx
        renderer.finish()  # close any open progress row before the next message

    # The worker can end its turn early — diagnosing but not repairing/reporting.
    # Drive it across up to MAX_TURNS: turn 0 runs the skill; each retry nudges
    # the SAME session to finish. "Done" == a new Feed entry was recorded.
    nudge = (
        "You have NOT run `flow diagnose-report` yet, so nothing was recorded. "
        "It writes DIRECTLY to the local database and works even when the backend "
        "is down — do not skip it. If you have a confident diagnosis and a safe "
        "fix you can apply yourself, apply it now; otherwise leave it for the "
        'user. Then run `flow diagnose-report --summary "..." --status '
        "fixed|needs_action|informational|unrecognized` as your final action. Do "
        "not stop until diagnose-report has run."
    )
    MAX_TURNS = 3
    try:
        for turn in range(MAX_TURNS):
            size_before = _tx_size()
            await ap.prompt(prompt_text if turn == 0 else nudge)
            if not await _await_growth(size_before):
                typer.echo("ERROR: diagnose agent never started writing within warmup", err=True)
                return 1
            typer.echo(
                f"  Diagnosing (session={(ap.session_id or '')[:8]})…"
                if turn == 0
                else "  …agent stopped before recording — nudging it to finish."
            )
            await _stream_new()
            new_ids = (await _feed_entry_ids()) - feed_before
            if new_ids:
                typer.echo(
                    f"  ✓ Recorded to the Feed (feed_entry {sorted(new_ids)[0][:8]}). "
                    "Open the app's home screen to see it."
                )
                return 0
    except (KeyboardInterrupt, asyncio.CancelledError):
        typer.echo("Diagnose interrupted.", err=True)
        return 130

    typer.echo(
        "  ! The diagnostic could not record a result after retries — the agent "
        "kept ending early. See the findings above; re-run `flow diagnose` to retry.",
        err=True,
    )
    return 1


# Two sibling top-level leaf commands (registered in flow_cli.py via
# ``app.command(...)``, same as the other inline leaf commands). The report
# helper is a hyphenated sibling, not a subcommand, so a free-text message like
# ``flow diagnose report me`` can't be mistaken for it.
def diagnose_command(
    message: Optional[List[str]] = typer.Argument(
        None,
        help=(
            "Ignored — you'll always be prompted to type or paste the issue, so "
            "apostrophes, quotes and special characters work without shell quoting. "
            "Press Enter to submit; empty = full sweep."
        ),
    ),
    timeout: float = typer.Option(
        DEFAULT_TRANSCRIPT_TIMEOUT_S, "--timeout", help="Transcript stream budget in seconds."
    ),
) -> None:
    """Diagnose a Flowpad issue and report the outcome to the app's Feed."""
    _quiet_logs()
    # Always read the message from stdin — never from argv. Anything typed after
    # `flow diagnose` on the command line is intentionally ignored, because the
    # shell mangles free text (apostrophes like "can't", quotes) before we ever
    # see it. Reading from stdin lets the user type/paste anything. A single
    # Enter submits; empty input falls back to a full diagnostic sweep.
    if sys.stdin.isatty():
        typer.echo(
            "Describe the issue or paste the error, then press Enter "
            "(leave empty for a full diagnostic sweep):"
        )
    try:
        text = sys.stdin.readline().strip()
    except (EOFError, KeyboardInterrupt):
        text = ""
    # Immediate acknowledgment — the bootstrap + agent spin-up before the first
    # "Diagnosing (session=…)" line can take several seconds; without this the
    # user is left staring at a blank screen wondering if anything happened.
    typer.echo(
        ("Running a full diagnostic sweep" if not text else "Diagnosing your issue")
        + " — spinning up the agent (this can take a few seconds)…"
    )
    rc = asyncio.run(_run_diagnose(text, timeout))
    raise typer.Exit(rc)


def diagnose_report_command(
    summary: str = typer.Option(..., "--summary", help="One-paragraph human summary."),
    status: str = typer.Option(
        "informational",
        "--status",
        help="fixed | needs_action | informational | unrecognized",
    ),
    details: str = typer.Option("", "--details", help="Full diagnostic report block."),
    platform: str = typer.Option("", "--platform", help="macOS | Windows | Linux."),
) -> None:
    """Persist a flow-diagnose report (Conversation + FlowMessage + FeedEntry) via the SDK."""
    _quiet_logs()
    from flow_sdk.diagnostics.report import create_diagnostic_report

    res = asyncio.run(
        create_diagnostic_report(
            summary=summary, status=status, details=details, platform=platform
        )
    )
    typer.echo(json.dumps(res))
