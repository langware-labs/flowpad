"""One-shot asset-cleanup run — launch the ``asset_cleanup`` agent headless.

``run_asset_cleanup()`` loads the ``asset_cleanup`` SubAgent markdown (user >
system resolution via ``load_subagent``) as the task contract, appends the
scan-root list, and launches the named ``asset-cleanup`` Agent headlessly. The
Agent owns worker/model/system identity; the SubAgent owns the scan and output
instructions. The worker's final reply must end with a fenced ```json report,
which this module parses into dataclasses. The run is identify-only — Flowpad
supplies the candidate contents and this module never touches reported files.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

_log = logging.getLogger(__name__)

# Last fenced ```json block in the reply — the agent's report contract.
_JSON_FENCE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)


@dataclass
class AssetCleanupFinding:
    path: str
    kind: str  # skill | agent | workflow | command | plan | settings_backup | project
    name: str
    verdict: str  # "garbage" | "keep" | "unsure"
    reason: str = ""
    root: str = ""
    entity_id: str = ""  # Flowpad entity id (projects only)


@dataclass
class AssetCleanupResult:
    roots: list[str]
    findings: list[AssetCleanupFinding]
    summary: dict[str, int] = field(default_factory=dict)
    session_id: str | None = None
    models_used: list[str] = field(default_factory=list)
    raw_text: str = ""

    def by_verdict(self) -> dict[str, list[AssetCleanupFinding]]:
        """Findings grouped by verdict — the one tallying authority (markdown
        renderer, entity mapping, and the verdict properties all read this)."""
        out: dict[str, list[AssetCleanupFinding]] = {"garbage": [], "keep": [], "unsure": []}
        for f in self.findings:
            if f.verdict in out:
                out[f.verdict].append(f)
        return out


def transcript_reply(jsonl_path: Path) -> tuple[str, list[str]]:
    """(last assistant text, models seen) from a Claude JSONL transcript.

    ``RunResult.text`` / ``models_used`` are empty on the headless path —
    ``_build_run_result`` reads ``record.last_assistant_text`` /
    ``record.models_used`` but no extractor produces those fields — so both
    are recovered from the transcript directly.
    """
    text = ""
    models: list[str] = []
    try:
        with open(jsonl_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("type") != "assistant":
                    continue
                message = row.get("message") or {}
                model = message.get("model")
                if model and model not in models:
                    models.append(model)
                parts = [
                    c.get("text", "")
                    for c in (message.get("content") or [])
                    if isinstance(c, dict) and c.get("type") == "text"
                ]
                if parts:
                    text = "\n".join(parts)
    except OSError:
        return "", models
    return text, models


def parse_report(text: str) -> dict[str, Any] | None:
    """Extract the agent's report dict from its reply text, or None."""
    matches = _JSON_FENCE.findall(text or "")
    for raw in reversed(matches):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "findings" in data:
            return data
    return None


async def run_asset_cleanup(
    roots: Sequence[str | Path] | None = None,
    hours: int = 24,
    workdir: str | None = None,
    projects: list[dict] | None = None,
) -> AssetCleanupResult:
    """Run the ``asset_cleanup`` agent over ``roots`` and return its findings.

    ``roots=None`` collects the default set (user home + projects active in
    the last ``hours``) AND the full project inventory for junk-project
    classification. Pass explicit ``roots`` (tests, targeted scans) to skip
    projects unless ``projects`` is also given. Raises RuntimeError when the
    agent asset is missing or the worker reply carries no parseable report.
    """
    from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.agentic_process import _build_run_result  # noqa: PLC0415
    from flow_sdk.fs_store.operations.subagent import load_subagent  # noqa: PLC0415

    deployment = await get_agent_local_deployment("asset-cleanup")
    task = load_subagent("asset_cleanup")
    if task is None:
        raise RuntimeError("asset_cleanup task instructions not found")
    task_prompt = (
        task.data.get("prompt") or task.data.get("prompt_text") or getattr(task, "prompt_text", None) or ""
    ).strip()
    if not task_prompt:
        raise RuntimeError("asset_cleanup task instructions are empty")

    if roots is None:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        from .scan import collect_project_inventory, collect_scan_roots  # noqa: PLC0415

        # One enumeration shared by both collectors.
        all_projects = await Project.get_all()
        roots = await collect_scan_roots(hours, projects=all_projects)
        if projects is None:
            projects = await collect_project_inventory(projects=all_projects)
    root_strs = [str(r) for r in roots]
    if not root_strs:
        raise RuntimeError("no scan roots to inspect")

    from .scan import collect_asset_inventory  # noqa: PLC0415

    asset_inventory = await asyncio.to_thread(collect_asset_inventory, root_strs)

    # The agent md is also discoverable as a subagent (--add-dir picks up the
    # system agents dir); a delegating parent paraphrases the report and drops
    # the JSON block. Pin the contract: do the scan inline, JSON in the final
    # message.
    instruction = (
        f"{task_prompt}\n\n"
        "IMPORTANT: perform the scan yourself in this session — do NOT "
        "delegate to a subagent or the Task tool. Your final message must "
        "end with the fenced ```json report. The asset inventory below was "
        "collected deterministically and is complete. Classify exactly those "
        "entries from their supplied content. Do not call filesystem tools, "
        "inspect other paths, or write a report file.\n\n"
        "## Scan roots\n\n" + "\n".join(root_strs) + "\n\n"
        "## Asset inventory\n\n" + json.dumps(asset_inventory, indent=2) + "\n"
    )
    if projects:
        instruction += "\n## Projects\n\n" + json.dumps(projects, indent=2) + "\n"

    # Fail fast rather than let wait() poll a transcript that never appears:
    # resolution is lazy, so this is the same answer the spawn itself would get.
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_path_env,
    )

    if worker_path_env("claude") is None:
        raise RuntimeError("claude CLI not discovered — cannot run asset_cleanup")

    # Launch through the named agent: worker, model and system prompt come from
    # the `asset-cleanup` Agent, so what runs here is the same thing the user
    # can inspect under the flowpad_assistant project. Headless one-shot —
    # pty=False routes prompt() to the print-mode driver (no PTY/Shell) and
    # wait=True polls the transcript to a terminal state.
    proc = await deployment.launch(
        instruction,
        wait=True,
        name="Asset cleanup scan",
        workdir=workdir or root_strs[0],
    )
    result = _build_run_result(proc)
    if not result.ok:
        raise RuntimeError(f"asset_cleanup worker ended {result.status} (session {result.session_id})")

    text = result.text or ""
    models_used = list(result.models_used or [])
    if not text or not models_used:
        transcript = proc.driver.transcript_path(proc)
        if transcript:
            t_text, t_models = transcript_reply(transcript)
            text = text or t_text
            models_used = models_used or t_models

    report = parse_report(text)
    if report is None:
        raise RuntimeError(f"asset_cleanup worker returned no parseable report (session {result.session_id})")

    findings = [
        AssetCleanupFinding(
            path=str(f.get("path", "")),
            kind=str(f.get("kind", "")),
            name=str(f.get("name", "")),
            verdict=str(f.get("verdict", "unsure")),
            reason=str(f.get("reason", "")),
            root=str(f.get("root", "")),
            entity_id=str(f.get("entity_id") or ""),
        )
        for f in report.get("findings", [])
        if isinstance(f, dict)
    ]
    summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
    _log.info(
        "asset_cleanup: scanned %d roots — %d findings (%d garbage) session=%s",
        len(root_strs),
        len(findings),
        sum(1 for f in findings if f.verdict == "garbage"),
        result.session_id,
    )
    return AssetCleanupResult(
        roots=report.get("scanned_roots") or root_strs,
        findings=findings,
        summary=summary,
        session_id=result.session_id,
        models_used=models_used,
        raw_text=text,
    )
