"""ProcessRunner -- launch Claude Code as a subprocess with record tracking.

Provides a simple dataclass-based config for spawning Claude CLI processes
that are tracked via AgenticProcessRecord on disk.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord, ProcessorStatus

logger = logging.getLogger(__name__)


@dataclass
class ProcessConfig:
    """Configuration for a Claude CLI subprocess."""

    skill_name: str
    instruction: str
    workdir: str | None = None
    model: str | None = None
    permission_mode: str = "bypassPermissions"
    output_type: str = "agentic_process"
    env_vars: dict[str, str] = field(default_factory=dict)
    timeout: int | None = None


# -- Pre-built configs --------------------------------------------------------

ANALYSIS_CONFIG = ProcessConfig(
    skill_name="session_analysis",
    instruction="Analyze the session transcript in the current directory. Write analysis.md with findings.",
    permission_mode="bypassPermissions",
    output_type="session_analysis",
)

CLASSIFICATION_CONFIG = ProcessConfig(
    skill_name="session_classification",
    instruction="Classify the session transcript in the current directory. Write classification.json with results.",
    permission_mode="bypassPermissions",
    output_type="session_classification",
)

FIX_IT_CONFIG = ProcessConfig(
    skill_name="fix_it",
    instruction="Review the errors and apply fixes. Write a summary of changes to fix_report.md.",
    permission_mode="bypassPermissions",
    output_type="agentic_process",
)


def run_process(
    config: ProcessConfig,
    workdir: str | None = None,
    session_id: str | None = None,
) -> tuple[AgenticProcessRecord, subprocess.Popen]:
    """Launch a Claude CLI subprocess tracked by an AgenticProcessRecord.

    Args:
        config: ProcessConfig describing the skill and parameters.
        workdir: Override working directory (falls back to config.workdir or cwd).
        session_id: Optional pre-generated session ID.

    Returns:
        Tuple of (record, process) where record is the saved AgenticProcessRecord
        and process is the Popen handle.
    """
    effective_workdir = workdir or config.workdir or os.getcwd()
    sid = session_id or str(uuid4())
    process_id = str(uuid4())

    # Create and persist the record
    record = AgenticProcessRecord(
        id=process_id,
        name=f"{config.skill_name}:{sid[:8]}",
        state=ProcessorStatus.RUNNING,
        worker_session_id=sid,
        skill_name=config.skill_name,
    )

    # Save to the workdir's .flow_records directory
    records_dir = Path(effective_workdir) / ".flow_records"
    records_dir.mkdir(parents=True, exist_ok=True)
    record_path = records_dir / f"{process_id}.json"
    record.save_record_json(record_path)

    # Build the command
    env = os.environ.copy()
    # Remove CLAUDECODE so the subprocess can launch inside an existing session
    env.pop("CLAUDECODE", None)
    env.update(config.env_vars)
    env["CLAUDE_PROJECT_DIR"] = effective_workdir

    args = ["claude"]
    if config.permission_mode == "bypassPermissions":
        args.append("--dangerously-skip-permissions")
    args.extend(["--session-id", sid])
    if config.model:
        args.extend(["--model", config.model])
    args.extend(["-p", config.instruction])

    logger.info("ProcessRunner: launching %s (id=%s, session=%s)", config.skill_name, process_id, sid[:8])

    proc = subprocess.Popen(
        args,
        cwd=effective_workdir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    return record, proc


def run_process_domain(
    config: ProcessConfig,
    workdir: str | None = None,
    session_id: str | None = None,
) -> tuple:
    """Launch a Claude CLI subprocess and return an AgenticProcess DomainObject.

    Thin wrapper over run_process() that hydrates the record.

    Returns:
        Tuple of (AgenticProcess, Popen).
    """
    record, proc = run_process(config, workdir, session_id)
    from flow_sdk.builtin.agentic_process import AgenticProcess
    return AgenticProcess.fromRecord(record), proc
