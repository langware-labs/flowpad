"""GitHub Copilot WorkerDriver."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticProcessContextKey,
    WorkerCLIOptions,
    restart_payload_from_cli_options,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    copilot_session_state_root,
    copilot_transcript_path_for_process,
    find_copilot_session_jsonl,
    find_latest_copilot_session_jsonl,
    load_session_history as _copilot_load_session_history,
    load_transcript_history as _copilot_load_transcript_history,
    read_copilot_session_meta,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.status import copilot_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.stream_worker import (
    CopilotCLIStreamWorker,
)
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.flowpad_types.enums import WorkerType
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


class CopilotDriver:
    """Vendor glue for GitHub Copilot CLI."""

    name = WorkerType.COPILOT.value
    preassign_interactive_session_id = True

    def cli_options(self, process: "AgenticProcess") -> CopilotCliOptions:
        cmd = CopilotCliOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        cmd.add_dirs = process.resolved_add_dirs
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.skill_names = list(agents_json.keys())
        if process.visible:
            cmd.json_stream = False
        if process.session_id and self._has_session(process):
            cmd.resume = True
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: WorkerCLIOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    async def headless_prompt(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        try:
            await process.get_project()
        except Exception:
            logger.debug("CopilotDriver.headless_prompt: get_project failed", exc_info=True)
        if not process.workdir:
            return ApiFailResponse(message="copilot prompt: workdir is not set")

        had_session = bool(process.session_id)
        if not process.session_id:
            process.session_id = str(uuid4())
            try:
                await process.save()
            except Exception:
                logger.debug("CopilotDriver.headless_prompt: preassign save failed", exc_info=True)

        full_prompt = self.compose_prompt(instruction, process.get_agents_json())
        cli_cfg = process.cli_config or {}
        context = AgenticContext(
            workdir=process.workdir,
            env_vars=dict(cli_cfg.get("env_vars") or {}),
            model=cli_cfg.get("model"),
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            effort=cli_cfg.get("effort"),
            add_dirs=list(process.resolved_add_dirs or []),
            session_id=process.session_id if not had_session else None,
            resume_session_id=process.session_id if had_session else None,
        )

        worker = CopilotCLIStreamWorker.for_process(process.id)
        from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS
        _PROMPT_WORKERS[process.id] = worker  # type: ignore[assignment]

        try:
            transcript_path = worker.transcript_path
            if transcript_path is not None and not transcript_path.exists():
                transcript_path.parent.mkdir(parents=True, exist_ok=True)
                transcript_path.touch()
        except OSError:
            logger.debug("CopilotDriver.headless_prompt: transcript pre-touch failed", exc_info=True)

        from flow_sdk.builtin.process_lifecycle import ProcessStatus
        if process.status != ProcessStatus.RUNNING.value:
            process.status = ProcessStatus.RUNNING.value
            try:
                await process.save()
            except Exception:
                logger.debug("CopilotDriver.headless_prompt: lifecycle save failed", exc_info=True)

        process_ref = process
        process_id = process.id
        object.__setattr__(process_ref, "_turn_in_flight", True)
        try:
            await process_ref.notify_updated()
        except Exception:
            logger.exception("CopilotDriver.headless_prompt: start notify failed")

        async def _run_turn() -> None:
            session_id_persisted = had_session
            try:
                async for fd in worker.execute(prompt=full_prompt, context=context):
                    sid = worker.get_session_id()
                    if sid and sid != process_ref.session_id:
                        process_ref.session_id = sid
                        session_id_persisted = False
                    if sid and not session_id_persisted:
                        try:
                            await process_ref.save()
                            session_id_persisted = True
                        except Exception:
                            logger.debug("CopilotDriver.headless_prompt: session save failed", exc_info=True)
                    try:
                        await process_ref.emit_flow_data(fd.model_dump())
                    except Exception:
                        logger.debug("CopilotDriver.headless_prompt: emit_flow_data failed", exc_info=True)
            except Exception:
                logger.exception("CopilotDriver.headless_prompt: worker error")
            finally:
                _PROMPT_WORKERS.pop(process_id, None)
                object.__setattr__(process_ref, "_turn_in_flight", False)
                try:
                    await process_ref.notify_updated()
                except Exception:
                    logger.exception("CopilotDriver.headless_prompt: terminal notify failed")

        asyncio.create_task(_run_turn(), name=f"copilot-{process.id[:8]}")
        return ApiSuccessResponse(data={"status": "started", "worker": self.name})

    def stream_worker(self, process: "AgenticProcess") -> CopilotCLIStreamWorker:
        return CopilotCLIStreamWorker.for_process(process.id)

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        local = self._process_local_descriptor(process)
        if local is not None:
            return local
        return self._session_descriptor(process)

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def _process_local_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        path = copilot_transcript_path_for_process(process.id)
        if not path.exists():
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.COPILOT_STREAM,
            source=TranscriptSource.PROCESS_LOCAL,
            session_id=process.session_id or "",
        )

    def _session_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        path: Path | None = None
        if process.session_id:
            path = find_copilot_session_jsonl(process.session_id)
        if path is None:
            path = find_latest_copilot_session_jsonl(
                cwd=process.workdir,
                started_at=self._worker_started_at(process),
            )
        if path is None or not path.exists():
            return None
        meta = read_copilot_session_meta(path)
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.COPILOT_EVENTS,
            source=TranscriptSource.WORKER_SESSION,
            session_id=str(meta.get("id") or process.session_id or ""),
        )

    def _worker_started_at(self, process: "AgenticProcess") -> str | None:
        context = process.context_data or {}
        value = context.get(AgenticProcessContextKey.WORKER_STARTED_AT.value)
        return str(value) if value else None

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        return copilot_tail_status(transcript_path)

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        descriptor = self.transcript_descriptor(process)
        if descriptor is not None:
            return _copilot_load_transcript_history(
                descriptor.path,
                transcript_format=descriptor.format,
            )
        return _copilot_load_session_history(process.session_id or "", process_id=process.id)

    def compose_prompt(self, instruction: str, agents_json: dict | None) -> str:
        agents_json = agents_json or {}
        if not agents_json:
            return instruction
        sections = [
            "# Inline sub-agent definitions",
            (
                "Each ## block below defines a named sub-agent. Do not spawn a "
                "separate agent; follow the relevant agent instructions yourself "
                "inside this Copilot CLI turn."
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

    def external_session_dirs(self) -> set[str]:
        root = copilot_session_state_root()
        if not root.is_dir():
            return set()
        return {p.name for p in root.iterdir() if p.is_dir()}

    def _has_session(self, process: "AgenticProcess") -> bool:
        if not process.session_id:
            return False
        if find_copilot_session_jsonl(process.session_id):
            return True
        local = copilot_transcript_path_for_process(process.id)
        return local.exists() and local.stat().st_size > 0
