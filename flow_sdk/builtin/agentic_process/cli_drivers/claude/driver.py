"""Claude Code WorkerDriver — vendor glue for the AgenticProcess driver layer.

Concentrates everything previously expressed as ``if worker_type == CLAUDE_CODE``
in ``AgenticProcess`` so the entity stays vendor-pure: cli_options building,
headless print-mode turn execution (``claude -p stream-json``), transcript
location, history loading, and prompt composition that inlines embedded
agents.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    WorkerDriver,
    WorkerCLIOptions,
    restart_payload_from_cli_options,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.session_history import (
    load_session_history as _claude_load_session_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
from flow_sdk.fs_records.agent_status import WorkerStatus, _tail_status
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.transcript_analyzer import (
    TranscriptDescriptor,
    TranscriptFormat,
    TranscriptSource,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
    from flow_sdk.responses.response import ApiResponse

logger = logging.getLogger(__name__)

# Module-level cache of in-flight workers (looked up for cancel-prompt).
# Shared with the codex driver via ``AgenticProcess._PROMPT_WORKERS`` —
# the entity owns the dict, drivers just register/deregister.


class ClaudeDriver:
    """Vendor glue for Claude Code. Implements the ``WorkerDriver`` Protocol."""

    name = "claude"

    # ── CLI shape ────────────────────────────────────────────────────────────

    def cli_options(self, process: "AgenticProcess") -> ClaudeCliOptions:
        """Build a Claude CLI command for ``process``.

        Injects ``--add-dir`` for the Flowpad Assistant project (so SDK-shipped
        skills / agents are discoverable) plus any ``additional_dirs``;
        registers embedded agents via ``--agents``; sets ``CLAUDE_PROJECT_DIR``
        env from the workdir.

        The Flowpad Assistant mount is gated by ``ServiceConfig.load_flowpad_assistant``
        — set to ``False`` to keep the SDK-shipped skills/agents out of the session.
        """
        from flow_sdk.config import default_service_config, flowpad_assistant_project_root

        cmd = ClaudeCliOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        if cmd.workdir:
            cmd.env_vars.setdefault("CLAUDE_PROJECT_DIR", cmd.workdir)
        if default_service_config.load_flowpad_assistant:
            core_dir = str(flowpad_assistant_project_root())
            extra = [d for d in (process.additional_dirs or []) if d != core_dir]
            cmd.add_dirs = [core_dir] + extra
        else:
            cmd.add_dirs = list(process.additional_dirs or [])
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.agents_json = agents_json
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: WorkerCLIOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    # ── Per-turn execution ───────────────────────────────────────────────────

    async def run_print_turn(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        """Headless ``claude -p stream-json`` execution for invisible processes.

        Spawns ``ClaudeCLIStreamWorker``, captures the session_id emitted in
        the first ``system:init`` event onto ``process.session_id``, and writes
        the standard JSONL transcript to
        ``~/.claude/projects/<encoded-cwd>/<session-id>.jsonl``.

        ``-p`` mode keeps Claude iterating until ``end_turn``, which is
        required for multi-step prompts (the legacy PTY path forces single-tool
        turns).
        """
        try:
            await process.get_project()
        except Exception:
            logger.debug("ClaudeDriver.run_print_turn: get_project failed", exc_info=True)
        if not process.workdir:
            return ApiFailResponse(message="claude print prompt: workdir is not set")

        # Eagerly assign a session_id so ``is_ready_for_input`` flips to False
        # before the worker writes its first JSONL entry — matches the
        # behaviour the legacy PTY path provides via ``start()``.
        if not process.session_id:
            process.session_id = str(uuid4())

        cli_cfg = process.cli_config or {}
        # Multi-turn: if the session already wrote a transcript on a prior
        # turn, ``--session-id`` would error ("session already exists") so we
        # have to flip into ``--resume`` mode. ``cli_config["resume"]`` honours
        # explicit caller intent; the transcript check covers in-process
        # multi-turn against the same entity.
        is_resume = bool(cli_cfg.get("resume")) or self.transcript_path(process) is not None
        # Fork: caller asked to branch off ``fork_session_id`` into a new
        # session-id (cli_options sets ``cmd.fork_session_id``). When present,
        # we resume from the source and tell the worker to fork; the new
        # session id is ``process.session_id``.
        fork_source = cli_cfg.get("fork_session_id")
        # Default the headless parent to sonnet — opus's parent-side latency
        # blows past the 28-s long-test budget on multi-step flows. Callers
        # can override via cli_config["model"] / ["effort"].
        parent_model = cli_cfg.get("model") or "sonnet"
        parent_effort = cli_cfg.get("effort")
        # Mirror the add_dirs gate used by ``cli_options`` (PTY mode) so the
        # print-mode worker sees the same skill/agent mount surface.
        from flow_sdk.config import default_service_config, flowpad_assistant_project_root
        if default_service_config.load_flowpad_assistant:
            core_dir = str(flowpad_assistant_project_root())
            extra = [d for d in (process.additional_dirs or []) if d != core_dir]
            ctx_add_dirs = [core_dir] + extra
        else:
            ctx_add_dirs = list(process.additional_dirs or [])

        context = AgenticContext(
            workdir=process.workdir,
            env_vars=dict(cli_cfg.get("env_vars") or {}),
            model=parent_model,
            effort=parent_effort,
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            resume_session_id=(fork_source or process.session_id) if (is_resume or fork_source) else None,
            session_id=process.session_id if fork_source else (None if is_resume else process.session_id),
            fork_session=bool(fork_source),
            add_dirs=ctx_add_dirs,
        )

        # Lifecycle: flip to RUNNING before launching the worker.
        from flow_sdk.fs_records.agentic_process_lifecycle import ProcessStatus
        if process.status != ProcessStatus.RUNNING.value:
            process.status = ProcessStatus.RUNNING.value
            try:
                await process.save()
            except Exception:
                logger.debug("ClaudeDriver.run_print_turn: lifecycle save failed", exc_info=True)

        worker = ClaudeCLIStreamWorker()
        from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS
        _PROMPT_WORKERS[process.id] = worker

        composed = self.compose_prompt(instruction, process.get_agents_json())
        process_ref = process
        process_id = process.id

        async def _run_turn() -> None:
            try:
                async for fd in worker.execute(prompt=composed, context=context):
                    sid = worker.get_session_id()
                    if sid and process_ref.session_id != sid:
                        try:
                            process_ref.session_id = sid
                            await process_ref.save()
                        except Exception:
                            logger.debug("ClaudeDriver.run_print_turn: session_id save failed", exc_info=True)
                    try:
                        await process_ref.emit_flow_data(fd.model_dump())
                    except Exception:
                        logger.exception("ClaudeDriver.run_print_turn: emit_flow_data failed")
            except Exception:
                logger.exception("ClaudeDriver.run_print_turn: worker error")
            finally:
                _PROMPT_WORKERS.pop(process_id, None)
                # ``worker_status`` is a computed projection re-derived from
                # the JSONL tail by ``to_dict`` / ``api_json_serializer``, so
                # ``save()`` short-circuits when no real entity field changed.
                # ``notify_updated`` forces a data-op broadcast carrying the
                # fresh ``worker_status=COMPLETE`` projection — that's what
                # flips ``proc.output()`` consumers out of their wait loop on
                # the TS side. Lifecycle ``status`` intentionally stays
                # RUNNING so ``is_ready_for_input(p)`` returns True.
                try:
                    await process_ref.notify_updated()
                except Exception:
                    logger.exception("ClaudeDriver.run_print_turn: terminal notify_updated failed")

        asyncio.create_task(_run_turn(), name=f"claude-{process.id[:8]}")
        return ApiSuccessResponse(data={"status": "started", "worker": self.name})

    # ── Transcript discovery ─────────────────────────────────────────────────

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Path to the Claude session JSONL — None when no session_id yet."""
        if not process.session_id:
            return None
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
        record = ClaudeSessionRecord.get(process.session_id)
        if record and record.jsonl_path:
            path = Path(record.jsonl_path)
            if path.exists():
                return TranscriptDescriptor(
                    path=path,
                    format=TranscriptFormat.CLAUDE_JSONL,
                    source=TranscriptSource.WORKER_SESSION,
                    session_id=process.session_id,
                )
        return None

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        """Map the tail of the Claude JSONL to a WorkerStatus."""
        return _tail_status(transcript_path)

    # ── History materialisation ──────────────────────────────────────────────

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        if not process.session_id:
            return []
        return _claude_load_session_history(process.session_id)

    # ── Prompt composition ───────────────────────────────────────────────────

    def compose_prompt(
        self,
        instruction: str,
        agents_json: dict | None,
    ) -> str:
        """Inline embedded-agent definitions into the user prompt.

        ``--agents`` already registers the agents with Claude (they remain
        invokable via the ``Task`` tool), but in print mode we ask Claude to
        execute the agent's body in-process rather than dispatching to a Task
        sub-agent. Reasons:
        - sub-agent dispatch adds 2–3 round-trips of latency, which pushes
          analyze / fix-it past the 28-s test budget;
        - the parent's Task call paraphrases the user request and routinely
          drops side-effect instructions (file writes), causing tests like
          ``test_clock_agent`` to fail intermittently.
        Inlining keeps the full agent body in the parent's context and tells
        it explicitly to follow those instructions itself.

        Single-agent processes (the "chat with this agent doc" case) get a
        stronger directive: the user is chatting WITH that agent, so adopt
        its persona for every reply — even when the user does not name the
        agent. The "execute literally on name match" semantics still apply,
        so multi-turn instructions like "Use the clock agent to write
        clock.txt" continue to work.
        """
        agents_json = agents_json or {}
        if not agents_json:
            return instruction

        if len(agents_json) == 1:
            name, entry = next(iter(agents_json.items()))
            body = (entry or {}).get("prompt") or ""
            desc = (entry or {}).get("description") or ""
            sections: list[str] = [
                f"# You are the '{name}' agent",
                (
                    "The user is chatting with you (this agent) directly. "
                    "Adopt the persona and follow the instructions below for "
                    "every reply, even when the user does not name the agent. "
                    "Execute side-effect instructions literally (file writes, "
                    "command outputs); do not paraphrase or summarise away "
                    "required artifacts."
                ),
            ]
            if desc:
                sections.append(f"\n## Description\n{desc}")
            if body:
                sections.append(f"\n## Instructions\n{body}")
            sections.append("\n# User message")
            sections.append(instruction)
            return "\n".join(sections)

        sections = [
            "# Embedded agent specs",
            (
                "Each ## block below is the canonical instruction body for a "
                "named agent. When the user instruction names one of these "
                "agents (\"use the X agent\", \"have the X agent do Y\"), do "
                "NOT delegate via the Task tool — execute the agent's "
                "instructions yourself, in this same turn. Follow every "
                "side-effect literally (file writes, command outputs); do "
                "not paraphrase or summarise away required artifacts."
            ),
        ]
        for name, entry in agents_json.items():
            body = (entry or {}).get("prompt") or ""
            desc = (entry or {}).get("description") or ""
            sections.append(f"\n## {name}")
            if desc:
                sections.append(desc)
            if body:
                sections.append(body)
        sections.append("\n# User instruction")
        sections.append(instruction)
        return "\n".join(sections)

    # ── External-session probe ───────────────────────────────────────────────

    def external_session_dirs(self) -> set[str]:
        """Snapshot of ``~/.claude/projects/`` entries that encode an
        agentic-process records path. Tests assert this set doesn't grow.
        """
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
        claude_projects = get_instance_settings().claude_projects_dir
        if not claude_projects.is_dir():
            return set()
        return {
            d.name for d in claude_projects.iterdir()
            if d.is_dir() and "flow-records-agentic" in d.name
        }
