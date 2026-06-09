"""OpenAI Codex WorkerDriver — vendor glue for the AgenticProcess driver layer.

Concentrates everything previously expressed as ``if worker_type == CODEX`` in
``AgenticProcess`` so the entity stays vendor-pure: cli_options building,
headless ``codex exec --json`` turn execution, transcript location (process-
local file the worker tee'd), tail-status mapping, history loading, and
prompt composition that inlines embedded agents (codex has no native sub-
agent dispatch in --ephemeral mode).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticProcessContextKey,
    WorkerDriver,
    WorkerCLIOptions,
    restart_payload_from_cli_options,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    codex_transcript_path_for_process,
    find_latest_codex_session_jsonl,
    find_codex_session_jsonl,
    load_session_history as _codex_load_session_history,
    load_transcript_history as _codex_load_transcript_history,
    read_codex_rollout_meta,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.status import codex_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker import (
    CodexCLIStreamWorker,
)
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.builtin.worker_status import WorkerStatus
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


class CodexDriver:
    """Vendor glue for OpenAI Codex. Implements the ``WorkerDriver`` Protocol."""

    name = WorkerType.CODEX.value

    # ── CLI shape ────────────────────────────────────────────────────────────

    def cli_options(self, process: "AgenticProcess") -> CodexCliOptions:
        """Build a Codex CLI command for ``process``.

        Codex doesn't accept inline ``--agents`` like Claude — it discovers
        skills from ``~/.codex/skills/``. We surface the embedded agent names
        as ``skill_names`` so ``cmd_line`` reflects them (some tests assert
        on this), and the runtime path inlines the agent body via
        ``compose_prompt`` instead.
        """
        cmd = CodexCliOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        cmd.add_dirs = process.resolved_add_dirs
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.skill_names = list(agents_json.keys())
        # ``visible=True`` means the entity is wired into a PTY tab — codex's
        # interactive TUI is the bare ``codex`` invocation, NOT ``codex exec
        # --json``. Toggle ``json_stream`` so ``to_spawn_args`` emits the right
        # argv. Headless print-mode turns flip back through ``CodexCLIStreamWorker``
        # which always uses the json-stream shape.
        if process.visible:
            cmd.json_stream = False
            cmd.ephemeral = False
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: WorkerCLIOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    # ── Per-turn execution ───────────────────────────────────────────────────

    async def headless_prompt(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        """Headless ``codex exec --json`` execution.

        No Shell entity, no PTY: codex events stream from a child process
        whose stdout is tee'd into ``<process_record_dir>/codex_transcript.jsonl``.
        ``stream_transcript()`` and ``tail_status()`` operate on that file.
        """
        try:
            await process.get_project()
        except Exception:
            logger.debug("CodexDriver.headless_prompt: get_project failed", exc_info=True)
        if not process.workdir:
            return ApiFailResponse(message="codex prompt: workdir is not set")

        full_prompt = self.compose_prompt(instruction, process.get_agents_json())

        cli_cfg = process.cli_config or {}
        context = AgenticContext(
            workdir=process.workdir,
            env_vars=dict(cli_cfg.get("env_vars") or {}),
            model=cli_cfg.get("model"),
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            resume_session_id=process.session_id if process.session_id else None,
        )

        worker = CodexCLIStreamWorker.for_process(process.id)
        from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS
        _PROMPT_WORKERS[process.id] = worker  # type: ignore[assignment]

        # Touch the transcript file so ``tail_status`` returns INITIALIZING
        # (rather than None) before the worker writes its first event. Mirrors
        # the Claude path's eager session_id assignment.
        try:
            transcript_path = worker.transcript_path
            if transcript_path is not None and not transcript_path.exists():
                transcript_path.parent.mkdir(parents=True, exist_ok=True)
                transcript_path.touch()
        except OSError:
            logger.debug("CodexDriver.headless_prompt: failed to pre-touch transcript", exc_info=True)

        from flow_sdk.builtin.process_lifecycle import ProcessStatus
        if process.status != ProcessStatus.RUNNING.value:
            process.status = ProcessStatus.RUNNING.value
            try:
                await process.save()
            except Exception:
                logger.debug("CodexDriver.headless_prompt: lifecycle save failed", exc_info=True)

        process_ref = process
        process_id = process.id

        # Multi-turn correctness: see ClaudeDriver.headless_prompt + the
        # AgenticProcess._discover_status_from_transcript override.
        object.__setattr__(process_ref, "_turn_in_flight", True)
        try:
            await process_ref.notify_updated()
        except Exception:
            logger.exception("CodexDriver.headless_prompt: start-of-turn notify_updated failed")

        async def _run_turn() -> None:
            session_id_persisted = False
            try:
                async for fd in worker.execute(prompt=full_prompt, context=context):
                    if not session_id_persisted and worker.get_session_id():
                        sid = worker.get_session_id()
                        try:
                            process_ref.session_id = sid
                            await process_ref.save()
                            session_id_persisted = True
                        except Exception:
                            logger.debug("CodexDriver.headless_prompt: session_id save failed", exc_info=True)
                    try:
                        await process_ref.emit_flow_data(fd.model_dump())
                    except Exception:
                        logger.debug("CodexDriver.headless_prompt: emit_flow_data failed", exc_info=True)
            except Exception:
                logger.exception("CodexDriver.headless_prompt: worker error")
            finally:
                _PROMPT_WORKERS.pop(process_id, None)
                object.__setattr__(process_ref, "_turn_in_flight", False)
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
                    logger.exception("CodexDriver.headless_prompt: terminal notify_updated failed")

        asyncio.create_task(_run_turn(), name=f"codex-{process.id[:8]}")
        return ApiSuccessResponse(data={"status": "started", "worker": self.name})

    def stream_worker(self, process: "AgenticProcess") -> CodexCLIStreamWorker:
        return CodexCLIStreamWorker.for_process(process.id)

    # ── Transcript discovery ─────────────────────────────────────────────────

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Resolve the Codex transcript path and native format for ``process``."""
        if process.visible:
            rollout = self._rollout_descriptor(process)
            if rollout is not None:
                return rollout

        local = self._process_local_descriptor(process)
        if local is not None:
            return local

        return self._rollout_descriptor(process)

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def _process_local_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Process-local JSONL the headless codex worker tee'd."""
        path = codex_transcript_path_for_process(process.id)
        if not path.exists():
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.CODEX_STREAM,
            source=TranscriptSource.PROCESS_LOCAL,
            session_id=process.session_id or "",
        )

    def _rollout_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        path: Path | None = None
        if process.session_id:
            path = find_codex_session_jsonl(process.session_id)
        if path is None:
            path = find_latest_codex_session_jsonl(
                cwd=process.workdir,
                started_at=self._worker_started_at(process),
            )
        if path is None or not path.exists():
            return None
        meta = read_codex_rollout_meta(path)
        session_id = str(meta.get("id") or process.session_id or "")
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.CODEX_ROLLOUT,
            source=TranscriptSource.WORKER_SESSION,
            session_id=session_id,
        )

    def _worker_started_at(self, process: "AgenticProcess") -> str | None:
        context = process.context_data or {}
        value = context.get(AgenticProcessContextKey.WORKER_STARTED_AT.value)
        return str(value) if value else None

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        return codex_tail_status(transcript_path)

    def has_resumable_session(self, process: "AgenticProcess") -> bool:
        return bool(process.session_id) and find_codex_session_jsonl(process.session_id) is not None

    # ── History materialisation ──────────────────────────────────────────────

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        descriptor = self.transcript_descriptor(process)
        if descriptor is not None:
            return _codex_load_transcript_history(descriptor.path)
        return _codex_load_session_history(process.session_id or "", process_id=process.id)

    # ── Prompt composition ───────────────────────────────────────────────────

    def compose_prompt(
        self,
        instruction: str,
        agents_json: dict | None,
    ) -> str:
        """Inline embedded-agent definitions so codex executes them directly.

        Codex has its own collaboration/delegation system but it can't fork the
        current ``codex exec --ephemeral`` thread, so attempting to delegate
        causes "thread can't be forked for a sub-agent" errors. Instead, we
        flatten each embedded agent's instructions into the user prompt and
        tell codex explicitly to follow them in-process.
        """
        agents_json = agents_json or {}
        if not agents_json:
            return instruction
        sections: list[str] = [
            "# Inline sub-agent definitions",
            (
                "Each ## block below defines a named sub-agent. Do NOT try to "
                "delegate, fork, or spawn a separate agent — there is no "
                "sub-agent runtime here. When the user instruction asks you "
                "to use one of these agents, follow that agent's instructions "
                "yourself, in this same turn."
            ),
            (
                "Be fast: as soon as every required artifact (file, command "
                "output) exists on disk, end the turn immediately with a one-"
                "line confirmation. Do NOT write recaps, summaries, "
                "explanations, verification steps, or follow-up suggestions."
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
        """Snapshot of ``~/.codex/sessions/`` rollout file names.

        ``--ephemeral`` should keep this set empty between turns, mirroring
        the Claude driver's ``flow-records-agentic`` invariant.
        """
        from flow_sdk.instance_settings import get_instance_settings
        sessions_root = get_instance_settings().codex_sessions_dir
        if not sessions_root.is_dir():
            return set()
        return {p.name for p in sessions_root.rglob("rollout-*.jsonl")}
