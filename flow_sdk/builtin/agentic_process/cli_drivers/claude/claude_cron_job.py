"""A ``CronCreate`` job the Claude CLI holds, and how Flowpad learns of it.

A cron job lives inside the ``claude`` process and fires only while it runs, so the worker keeps
that process alive for it. The CLI never lists the job among its background tasks, so it is read
from the tool calls (``cron_job_from_result``) and, for a resumed session — whose restored jobs the
new stream never announces — from the transcript (``restored_cron_jobs``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.session_paths import parse_iso_datetime

#: The tools that put a job on the CLI's own scheduler, or take one off it.
SCHEDULE_TOOLS = frozenset({"CronCreate", "CronDelete", "ScheduleWakeup"})
#: A recurring CronCreate job deletes itself this long after it was created (after one last fire).
CRON_EXPIRY_SECONDS = 7 * 24 * 3600


@dataclass(frozen=True)
class ClaudeCronJob:
    """A CronCreate job the CLI holds. Claude Code runs it; Flowpad only needs to know when it is gone."""

    #: The CLI's job id (``tool_use_result.id``), the key ``CronDelete`` names.
    id: str
    recurring: bool
    #: When the CLI drops the job on its own, epoch seconds: a one-shot after its fire
    #: (``nextFireAt``, which already includes the CLI's jitter), a recurring job at expiry.
    ends_at: float


def content_blocks(event: dict) -> list[dict]:
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def cron_job_from_result(result: dict, *, seen_at: float) -> ClaudeCronJob | None:
    """A CronCreate result (``{id, recurring, durable, nextFireAt}``) as the job it created."""
    job_id = result.get("id")
    next_fire_at = result.get("nextFireAt")
    if not isinstance(job_id, str) or not job_id or not isinstance(next_fire_at, (int, float)):
        return None
    recurring = bool(result.get("recurring"))
    ends_at = seen_at + CRON_EXPIRY_SECONDS if recurring else next_fire_at / 1000
    return ClaudeCronJob(id=job_id, recurring=recurring, ends_at=ends_at)


def _seen_at(entry: dict, default: float) -> float:
    stamped = parse_iso_datetime(entry.get("timestamp"))
    return stamped.timestamp() if stamped else default


def restored_cron_jobs(path: Path, now: float) -> dict[str, ClaudeCronJob]:
    """The CronCreate jobs ``claude --resume`` restores from this session's transcript.

    The CLI's own rule: every job created and not deleted, except a recurring job past its
    expiry and a one-shot whose fire time has passed. Scans the whole file — a job can be
    days older than the transcript's tail.
    """
    calls: dict[str, str] = {}
    jobs: dict[str, ClaudeCronJob] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return jobs
    for line in lines:
        # A call names its tool; its result only links back by id (``Cancelled job X.``).
        if "Cron" not in line and not (calls and '"tool_result"' in line):
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "assistant":
            for block in content_blocks(entry):
                if block.get("type") == "tool_use" and block.get("name") in ("CronCreate", "CronDelete"):
                    calls[str(block.get("id"))] = block["name"]
        elif entry.get("type") == "user":
            result = entry.get("toolUseResult")
            if not isinstance(result, dict):
                continue
            for block in content_blocks(entry):
                name = calls.pop(str(block.get("tool_use_id")), None) if block.get("type") == "tool_result" else None
                if name is None or block.get("is_error"):
                    continue
                if name == "CronDelete":
                    jobs.pop(str(result.get("id")), None)
                elif job := cron_job_from_result(result, seen_at=_seen_at(entry, now)):
                    jobs[job.id] = job
    return {job_id: job for job_id, job in jobs.items() if job.ends_at > now}
