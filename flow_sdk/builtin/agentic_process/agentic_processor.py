"""AgenticProcessor entity — creates and manages AgenticProcess instances.

Supports the AgenticProcessor action surface:
- POST /api/v1/graph/agentic_processor/{id}/runFile
- POST /api/v1/graph/agentic_processor/{id}/run
- POST /api/v1/graph/agentic_processor/{id}/execute
- POST /api/v1/graph/agentic_processor/{id}/createProcess

Status is transcript-derived: call GET /api/v1/graph/agentic_process/{id}/status
to get the current status (and trigger a WS notification if it changed).

Desktop mode: No Flow entity, single @local compute node, simplified execution.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.fs_records.agent_status import is_running as _is_running_status
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)


class AgenticProcessor(Entity):
    _api_visible = True
    type: str = APIField(default="agentic_processor")

    worker_type: str = APIField(default="claude")
    active_agentic_process_id: str | None = APIField(default=None)

    async def _is_running(self) -> bool:
        """True when the active process has a running transcript-derived status."""
        if not self.active_agentic_process_id:
            return False
        proc = await AgenticProcess.get_by_id(self.active_agentic_process_id)
        return bool(proc and _is_running_status(proc.status))

    @action.all(action_name="runFile")
    async def run_file(self, vfs_path: str | None = None):
        """Run an instruction file from VFS path.

        Loads the file content and creates an AgenticProcess for execution.

        Args:
            vfs_path: VFS path to the instruction file

        Returns:
            AgenticProcess entity data
        """
        if await self._is_running():
            return ApiFailResponse(message="Processor is already running")

        if not vfs_path:
            return ApiFailResponse(message="vfs_path is required")

        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            file_content = None
            try:
                from flow_sdk.api.fs_api import VFSPath
                from pathlib import Path

                vfs = VFSPath(vfs_path)
                local_path = vfs.local_path if hasattr(vfs, "local_path") else None
                if local_path and Path(local_path).exists():
                    file_content = Path(local_path).read_text()
            except Exception as e:
                logger.warning(f"Could not load file from VFS path {vfs_path}: {e}")

            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=file_content or "",
                source_vfs_path=vfs_path,
            )
            await process.save(owner)

            self.active_agentic_process_id = process.id
            await self.save(owner)

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "source_vfs_path": process.source_vfs_path,
                }
            )

        except FileNotFoundError:
            logger.error(f"AgenticProcessor {self.id} file not found: {vfs_path}")
            return ApiFailResponse(message=f"File not found: {vfs_path}")

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} runFile error: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="run")
    async def run(
        self,
        instruction_content: str | None = None,
        context: dict[str, Any] | None = None,
    ):
        """Run instruction content with context — returns AgenticProcess.

        Creates an AgenticProcess and returns its entity data. The process
        is then driven via the process.open() / process.prompt() API.

        Args:
            instruction_content: The instruction content to execute
            context: Context data (workdir, env_vars, model, etc.)

        Returns:
            AgenticProcess data (id, type, etc.)
        """
        if await self._is_running():
            return ApiFailResponse(message="Processor is already running")

        if not instruction_content:
            return ApiFailResponse(message="instruction_content is required")

        logger.info(f"AgenticProcessor {self.id}: run started, content_len={len(instruction_content)}")
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=instruction_content,
                context_data=context or {},
            )
            await process.save(owner)
            logger.info(f"AgenticProcessor {self.id}: created process {process.id}")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "context": process.context_data,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} run error: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="execute")
    async def execute(
        self,
        instruction_content: str | None = None,
        context: dict[str, Any] | None = None,
    ):
        """Execute instruction content directly — returns AgenticProcess.

        Simpler API than run(): takes instruction text and context directly.

        Args:
            instruction_content: Plain text instruction content
            context: Context data (workdir, env_vars, model, etc.)

        Returns:
            AgenticProcess data (id, type, etc.)
        """
        if await self._is_running():
            return ApiFailResponse(message="Processor is already running")

        if not instruction_content:
            return ApiFailResponse(message="instruction_content is required")

        logger.info(f"AgenticProcessor {self.id}: execute started, content_len={len(instruction_content)}")
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=instruction_content,
                context_data=context or {},
            )
            await process.save(owner)
            logger.info(f"AgenticProcessor {self.id}: created process {process.id}")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "context": process.context_data,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} execute error: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="createProcess")
    async def create_process(
        self,
        context: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        visible: bool = False,
    ):
        """Create a new idle process ready for open() / prompt() calls.

        Args:
            context: Context data (workdir, env_vars, model, etc.)
            result: Optional ProcessResult metadata

        Returns:
            AgenticProcess entity data in IDLE status
        """
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            from flow_sdk.builtin.cli_workers.claude_cli import ClaudeCliOptions

            context_data = dict(context or {})
            workdir = context_data.pop("workdir", None)

            fork_session = bool(context_data.pop("fork_session", False))
            resume_session_id = context_data.pop("resume_session_id", None)

            additional_dirs: list[str] = list(context_data.pop("additional_dirs", None) or [])

            cli_opts = ClaudeCliOptions(
                model=context_data.pop("model", None) or None,
                permission_mode=context_data.pop("permission_mode", "bypassPermissions"),
                chrome=bool(context_data.pop("chrome", False)),
                debug=bool(context_data.pop("debug", True)),
                worktree=bool(context_data.pop("worktree", False)),
                agents_json=context_data.pop("agents_json", None),
            )

            if fork_session and resume_session_id:
                cli_opts.resume = True
                cli_opts.fork_session_id = resume_session_id
            elif resume_session_id:
                cli_opts.resume = True

            process = AgenticProcess(
                processor_id=self.id,
                instruction_content="",
                cli_config=cli_opts.to_json(),
                context_data=context_data,
                workdir=workdir,
                visible=visible,
                additional_dirs=additional_dirs,
            )
            if resume_session_id and not fork_session:
                process.worker_session_id = resume_session_id
            await process.save(owner)

            if result and isinstance(result, dict):
                try:
                    from flow_sdk.builtin.process_result import ProcessResult

                    result_uname = result.get("uname")
                    existing_result = None
                    if result_uname:
                        existing_result = await ProcessResult.get_by_uname(result_uname)

                    if existing_result:
                        existing_result.agentic_process_id = process.id
                        existing_result.status = "running"
                        existing_result.result_type = result.get("result_type")
                        existing_result.source_session_id = result.get("source_session_id")
                        await existing_result.save(owner)
                    else:
                        process_result = ProcessResult(
                            uname=result_uname,
                            agentic_process_id=process.id,
                            status="running",
                            result_type=result.get("result_type"),
                            source_session_id=result.get("source_session_id"),
                        )
                        await process_result.save(owner)
                except ImportError:
                    logger.debug("ProcessResult entity not available, skipping result creation")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            logger.info(f"AgenticProcessor {self.id} created process {process.id}")

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} createProcess error: {e}")
            return ApiFailResponse(message=str(e))
