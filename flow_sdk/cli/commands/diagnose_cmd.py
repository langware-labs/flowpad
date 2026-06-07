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
from pathlib import Path
from typing import List, Optional

import typer

from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S


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
    from flow_sdk.migrations.runner import _bootstrap_local, _render_entry

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

    prompt_text = (
        "Use the flow-diagnose skill to diagnose and (where safe) repair the "
        "user's Flowpad issue, then run its reporting phase.\n\n"
        f"The skill directory is mounted at {skill_dir}; read its SKILL.md and "
        "follow it exactly. You may read sibling files it references (e.g. "
        "references/catalog.md).\n\n"
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
    await ap.prompt(prompt_text)

    # Wait for the worker to write its first transcript line (canonical "started"
    # signal — see the migration runner).
    for _ in range(AGENT_WARMUP_TICKS):
        tp = ap.driver.transcript_path(ap)
        if tp and tp.exists() and tp.stat().st_size > 0:
            break
        await asyncio.sleep(AGENT_WARMUP_INTERVAL_S)
    tp = ap.driver.transcript_path(ap)
    if not tp or not tp.exists() or tp.stat().st_size == 0:
        typer.echo("ERROR: diagnose agent never wrote a transcript line during warmup", err=True)
        return 1

    typer.echo(f"  Diagnosing (session={(ap.session_id or '')[:8]})…")
    try:
        async for entry in ap.stream_transcript(timeout=transcript_timeout):
            _render_entry(entry)
    except (KeyboardInterrupt, asyncio.CancelledError):
        typer.echo("Diagnose interrupted.", err=True)
        return 130
    return 0


# Two sibling top-level leaf commands (registered in flow_cli.py via
# ``app.command(...)``, same as the other inline leaf commands). The report
# helper is a hyphenated sibling, not a subcommand, so a free-text message like
# ``flow diagnose report me`` can't be mistaken for it.
def diagnose_command(
    message: Optional[List[str]] = typer.Argument(
        None,
        help="What you saw — free text or a pasted error. Omit to run a full sweep.",
    ),
    timeout: float = typer.Option(
        DEFAULT_TRANSCRIPT_TIMEOUT_S, "--timeout", help="Transcript stream budget in seconds."
    ),
) -> None:
    """Diagnose a Flowpad issue and report the outcome to the app's Feed."""
    text = " ".join(message).strip() if message else ""
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
    from flow_sdk.diagnostics.report import create_diagnostic_report

    res = asyncio.run(
        create_diagnostic_report(
            summary=summary, status=status, details=details, platform=platform
        )
    )
    typer.echo(json.dumps(res))
