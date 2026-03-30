"""AgenticProcessor entity — manages execution lifecycle and UI flow for agentic processes.

Supports the full AgenticProcessor action surface:
- POST /api/v1/graph/agentic_processor/{id}/controlStart
- POST /api/v1/graph/agentic_processor/{id}/controlAppend
- POST /api/v1/graph/agentic_processor/{id}/controlInput
- POST /api/v1/graph/agentic_processor/{id}/controlAbort
- POST /api/v1/graph/agentic_processor/{id}/controlStep
- POST /api/v1/graph/agentic_processor/{id}/controlContinue
- GET  /api/v1/graph/agentic_processor/{id}/state
- POST /api/v1/graph/agentic_processor/{id}/runFile
- POST /api/v1/graph/agentic_processor/{id}/run
- POST /api/v1/graph/agentic_processor/{id}/execute
- POST /api/v1/graph/agentic_processor/{id}/createProcess

It parses AMD `flow-ui` directives, emits websocket `flow_data_msg` events, and
updates processor state via normal entity update notifications.

Desktop mode: No Flow entity, single @local compute node, simplified execution.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import uuid4

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.fs_records.agentic_process_record import AgenticProcessStatus
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

from flow_sdk.builtin.agentic_process._shared import (
    _default_processor_state,
    _now_iso,
    _parse_flow_ui_items,
    _send_flow_data_message,
)
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)


class AgenticProcessor(Entity):
    _api_visible = True
    type: str = APIField(default="agentic_processor")

    worker_type: str = APIField(default="claude")
    state: dict[str, Any] = APIField(default_factory=_default_processor_state)
    active_agentic_process_id: str | None = APIField(default=None)
    queued_ui: list[dict[str, Any]] = APIField(default_factory=list)
    next_ui_index: int = APIField(default=0)
    process_seq: int = APIField(default=0)

    def _get_state(self) -> dict[str, Any]:
        if not isinstance(self.state, dict):
            self.state = _default_processor_state()
        return dict(self.state)

    def _set_state(self, **updates: Any) -> None:
        state = self._get_state()
        state.update(updates)
        self.state = state

    async def _sync_active_process_state(self) -> None:
        if not self.active_agentic_process_id:
            return
        process = await AgenticProcess.get_by_id(self.active_agentic_process_id)
        if not process:
            return
        process.state = self._get_state()
        await process.save()

    async def _emit_ui_process_data(self, ui_item: dict[str, Any]) -> None:
        ui_payload: dict[str, Any] = {
            "ui_id": ui_item["ui_id"],
            "params": ui_item.get("params", {}),
            "blocking": ui_item.get("blocking", True),
        }
        if ui_item.get("uri"):
            ui_payload["uri"] = ui_item["uri"]
        if ui_item.get("page"):
            ui_payload["page"] = ui_item["page"]
        if ui_item.get("content"):
            ui_payload["content"] = ui_item["content"]

        self.process_seq += 1
        attrs = {
            "element-type": "ui",
            "data-type": "object",
            "ui-id": ui_item["ui_id"],
            "i": str(self.process_seq),
            "t": _now_iso(),
        }
        message_payload = {
            "element_type": "ui",
            "data_type": "object",
            "flow_value": json.dumps(ui_payload),
            "attributes": attrs,
        }

        await _send_flow_data_message(self.get_type(), self.id, message_payload)

    async def _advance_execution(self) -> None:
        total = len(self.queued_ui)
        logger.info(f"AgenticProcessor {self.id}: advancing execution ({self.next_ui_index}/{total} items)")
        while self.next_ui_index < len(self.queued_ui):
            ui_item = self.queued_ui[self.next_ui_index]
            self.next_ui_index += 1
            logger.info(
                f"AgenticProcessor {self.id}: processing item {self.next_ui_index}/{total} "
                f"ui_id={ui_item.get('ui_id')} blocking={ui_item.get('blocking', True)}"
            )

            await self._emit_ui_process_data(ui_item)

            if ui_item.get("blocking", True):
                self._set_state(
                    status=AgenticProcessStatus.PAUSED.value,
                    waiting_for_input=True,
                    input_id=ui_item["ui_id"],
                    index=self.next_ui_index,
                )
                await self.save()
                await self._sync_active_process_state()
                logger.info(f"AgenticProcessor {self.id}: paused, waiting for input on {ui_item['ui_id']}")
                return

        self._set_state(
            status=AgenticProcessStatus.COMPLETE.value,
            waiting_for_input=False,
            input_id=None,
            index=self.next_ui_index,
        )
        await self.save()
        await self._sync_active_process_state()
        logger.info(f"AgenticProcessor {self.id}: execution complete ({total} items processed)")

    @action.post(action_name="controlStart")
    async def control_start(
        self,
        mdo_content: str | None = None,
        source_vfs_path: str | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        request_info = get_current_request_info()
        owner = request_info.someone_typeid if request_info else None

        self.queued_ui = []
        self.next_ui_index = 0
        self.process_seq = 0
        self._set_state(
            status=AgenticProcessStatus.IDLE.value,
            index=0,
            waiting_for_input=False,
            input_id=None,
            error=None,
            mdo_content=mdo_content,
            debug={
                "enabled": bool(debug),
                "breakpoints": breakpoints or [],
                "step_mode": None,
            },
        )

        process = AgenticProcess(
            processor_id=self.id,
            instruction_content=mdo_content,
            source_vfs_path=source_vfs_path,
            state=self._get_state(),
        )
        await process.save(owner)

        self.active_agentic_process_id = process.id
        await self.save(owner)
        return ApiSuccessResponse(data=process)

    @action.post(action_name="controlAppend")
    async def control_append(self, content: str, instruction_id: str | None = None):
        if not content:
            return ApiFailResponse(message="content is required")

        parsed_items = _parse_flow_ui_items(content)
        self.queued_ui = [item.model_dump() for item in parsed_items]
        self.next_ui_index = 0
        self.process_seq = 0

        state = self._get_state()
        total_instructions = int(state.get("total_instructions", 0)) + 1
        resolved_instruction_id = instruction_id or f"instr_{uuid4().hex[:10]}"

        self._set_state(
            status=AgenticProcessStatus.RUNNING.value,
            total_instructions=total_instructions,
            current_instruction_id=resolved_instruction_id,
            waiting_for_input=False,
            input_id=None,
            mdo_content=content,
            index=0,
        )
        await self.save()
        await self._sync_active_process_state()

        await self._advance_execution()

        return ApiSuccessResponse(
            data={
                "instructionId": resolved_instruction_id,
                "totalInstructions": total_instructions,
            }
        )

    @action.post(action_name="controlInput")
    async def control_input(self, input_data: str | None = None, input_id: str | None = None):
        state = self._get_state()
        if not state.get("waiting_for_input", False):
            return ApiFailResponse(message="Processor not waiting for input", status_code=400)

        state_variables = dict(state.get("variables", {}))
        if input_data:
            try:
                state_variables["last_input"] = json.loads(input_data)
            except Exception:
                state_variables["last_input"] = input_data
        if input_id:
            state_variables["last_input_id"] = input_id

        self._set_state(
            status=AgenticProcessStatus.RUNNING.value,
            waiting_for_input=False,
            input_id=None,
            variables=state_variables,
        )
        await self.save()
        await self._sync_active_process_state()

        await self._advance_execution()
        return ApiSuccessResponse(data=True)

    @action.post(action_name="controlAbort")
    async def control_abort(self):
        self.queued_ui = []
        self.next_ui_index = 0
        self.process_seq = 0
        self._set_state(
            status=AgenticProcessStatus.IDLE.value,
            waiting_for_input=False,
            input_id=None,
            error=None,
        )
        await self.save()
        await self._sync_active_process_state()
        return ApiSuccessResponse(data=True)

    @action.all(action_name="controlStep")
    async def control_step(self, step_mode: str = "over"):
        """Step to next instruction in debug mode.

        Args:
            step_mode: Step mode (over, into, out)

        Returns:
            Success response on step, error if not in debug mode
        """
        state = self._get_state()
        debug = state.get("debug", {})
        if not debug.get("enabled", False):
            return ApiFailResponse(message="Debug mode not enabled")

        if state.get("status") != AgenticProcessStatus.STEPPING.value:
            return ApiFailResponse(message="Processor not paused at breakpoint")

        try:
            debug["step_mode"] = step_mode
            self._set_state(
                status=AgenticProcessStatus.RUNNING.value,
                debug=debug,
            )
            await self.save()
            await self._sync_active_process_state()

            # In desktop mode, advance execution if there are queued UI items
            await self._advance_execution()

            return ApiSuccessResponse(data={"status": self._get_state().get("status")})

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} step error: {e}")
            self._set_state(status=AgenticProcessStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="controlContinue")
    async def control_continue(
        self,
        agentic_process_id: str | None = None,
        mdo_content: str | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        """Continue a completed process with new instruction content.

        This action loads an existing completed process, appends the new
        instruction, and continues execution.

        Args:
            agentic_process_id: ID of the completed process to continue
            mdo_content: New instruction content to execute
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess data with updated state
        """
        state = self._get_state()
        if state.get("status") == AgenticProcessStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not agentic_process_id:
            return ApiFailResponse(message="agentic_process_id is required")
        if not mdo_content:
            return ApiFailResponse(message="mdo_content is required")

        try:
            # Load the existing process from DB
            existing_process = await AgenticProcess.get_by_id(agentic_process_id)
            if not existing_process:
                return ApiFailResponse(message=f"Process not found: {agentic_process_id}")

            # Parse UI items from the new content
            parsed_items = _parse_flow_ui_items(mdo_content)
            self.queued_ui = [item.model_dump() for item in parsed_items]
            self.next_ui_index = 0
            self.process_seq = 0

            # Reset state for new execution
            self._set_state(
                status=AgenticProcessStatus.RUNNING.value,
                mdo_content=mdo_content,
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                waiting_for_input=False,
                input_id=None,
            )

            self.active_agentic_process_id = existing_process.id
            await self.save()

            # Sync state to existing process
            existing_process.instruction_content = mdo_content
            existing_process.state = self._get_state()
            await existing_process.save()

            # Advance execution
            await self._advance_execution()

            return ApiSuccessResponse(
                data={
                    "id": existing_process.id,
                    "type": existing_process.type,
                    "processor_id": existing_process.processor_id,
                    "instruction_content": existing_process.instruction_content,
                    "state": existing_process.state
                    if isinstance(existing_process.state, dict)
                    else existing_process.state,
                    "worker_session_id": existing_process.worker_session_id,
                    "resumed": True,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} controlContinue error: {e}")
            self._set_state(status=AgenticProcessStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="state")
    async def get_state(self):
        """Get current processor state."""
        return ApiSuccessResponse(data=self._get_state())

    @action.all(action_name="runFile")
    async def run_file(self, vfs_path: str | None = None, debug: bool = False, breakpoints: list[str] | None = None):
        """Run an instruction file from VFS path.

        This is the primary way to execute skill files. It loads the file
        from the VFS path and executes all instructions.

        Args:
            vfs_path: VFS path to the instruction file
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess entity data
        """
        state = self._get_state()
        if state.get("status") == AgenticProcessStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not vfs_path:
            return ApiFailResponse(message="vfs_path is required")

        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            # Try to load the file content via VFS/FS
            file_content = None
            try:
                from flow_sdk.api.fs_api import VFSPath
                from pathlib import Path

                vfs = VFSPath(vfs_path)
                # Attempt to read the file through the compute provider
                local_path = vfs.local_path if hasattr(vfs, "local_path") else None
                if local_path and Path(local_path).exists():
                    file_content = Path(local_path).read_text()
            except Exception as e:
                logger.warning(f"Could not load file from VFS path {vfs_path}: {e}")

            # Parse UI items if we got file content
            if file_content:
                parsed_items = _parse_flow_ui_items(file_content)
                self.queued_ui = [item.model_dump() for item in parsed_items]
            else:
                self.queued_ui = []

            self.next_ui_index = 0
            self.process_seq = 0

            self._set_state(
                status=AgenticProcessStatus.RUNNING.value,
                mdo_content=file_content or "",
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                index=0,
                waiting_for_input=False,
                input_id=None,
            )

            # Create process entity
            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=file_content or "",
                source_vfs_path=vfs_path,
                state=self._get_state(),
            )
            await process.save(owner)

            self.active_agentic_process_id = process.id
            await self.save(owner)

            # Advance execution
            await self._advance_execution()

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "source_vfs_path": process.source_vfs_path,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except FileNotFoundError:
            logger.error(f"AgenticProcessor {self.id} file not found: {vfs_path}")
            return ApiFailResponse(message=f"File not found: {vfs_path}")

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} runFile error: {e}")
            self._set_state(status=AgenticProcessStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="run")
    async def run(
        self,
        instruction_content: str | None = None,
        context: dict[str, Any] | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        """Run instruction content with context - returns AgenticProcess.

        This is the primary interface for the TypeScript SDK's processor.run() method.
        Creates an AgenticProcess, starts execution, and returns the entity data.

        Args:
            instruction_content: The instruction/AMD content to execute
            context: Context data (workdir, env_vars, model, etc.)
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess data (id, type, state, etc.)
        """
        state = self._get_state()
        if state.get("status") == AgenticProcessStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not instruction_content:
            return ApiFailResponse(message="instruction_content is required")

        logger.info(f"AgenticProcessor {self.id}: run started, content_len={len(instruction_content)}, debug={debug}")
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            context_data = context or {}

            # Parse UI items from instruction content
            parsed_items = _parse_flow_ui_items(instruction_content)
            self.queued_ui = [item.model_dump() for item in parsed_items]
            self.next_ui_index = 0
            self.process_seq = 0

            self._set_state(
                status=AgenticProcessStatus.RUNNING.value,
                mdo_content=instruction_content,
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                index=0,
                waiting_for_input=False,
                input_id=None,
            )

            # Create process entity
            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=instruction_content,
                context_data=context_data,
                state=self._get_state(),
            )
            await process.save(owner)
            logger.info(f"AgenticProcessor {self.id}: created process {process.id}")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            # Advance execution
            await self._advance_execution()

            logger.info(
                f"AgenticProcessor {self.id}: run finished, process={process.id} state={self._get_state().get('status')}"
            )
            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "context": process.context_data,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} run error: {e}")
            self._set_state(status=AgenticProcessStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="execute")
    async def execute(
        self,
        instruction_content: str | None = None,
        context: dict[str, Any] | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        """Execute instruction content directly (no file parsing) - returns AgenticProcess.

        This is a simpler API than run() that takes instruction text directly.

        Args:
            instruction_content: Plain text or AMD instruction content
            context: Context data (workdir, env_vars, model, etc.)
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess data (id, type, state, etc.)
        """
        state = self._get_state()
        if state.get("status") == AgenticProcessStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not instruction_content:
            return ApiFailResponse(message="instruction_content is required")

        logger.info(
            f"AgenticProcessor {self.id}: execute started, content_len={len(instruction_content)}, debug={debug}"
        )
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            context_data = context or {}

            # Parse UI items from instruction content
            parsed_items = _parse_flow_ui_items(instruction_content)
            self.queued_ui = [item.model_dump() for item in parsed_items]
            self.next_ui_index = 0
            self.process_seq = 0

            self._set_state(
                status=AgenticProcessStatus.RUNNING.value,
                mdo_content=instruction_content,
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                index=0,
                waiting_for_input=False,
                input_id=None,
            )

            # Create process entity
            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=instruction_content,
                context_data=context_data,
                state=self._get_state(),
            )
            await process.save(owner)
            logger.info(f"AgenticProcessor {self.id}: created process {process.id}")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            # Advance execution
            await self._advance_execution()

            logger.info(
                f"AgenticProcessor {self.id}: execute finished, process={process.id} state={self._get_state().get('status')}"
            )
            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "context": process.context_data,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} execute error: {e}")
            self._set_state(status=AgenticProcessStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="createProcess")
    async def create_process(
        self,
        context: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        visible: bool = False,
    ):
        """Create a new idle process ready for execute() calls.

        This creates a process in IDLE status that can accept instructions
        via the process.execute() action. The process stays alive until
        explicitly terminated via process.exit().

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

            # Extract CLI-relevant flags into ClaudeCliOptions → cli_config.
            # This makes ClaudeCliOptions the single source of truth: context_data
            # retains only non-CLI fields (project_id, env_vars, instructions, etc.).
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

            # Wire resume / fork into the options.
            # session_id and workdir are injected at open()-time via cli_options.
            if fork_session and resume_session_id:
                # Fork: resume the source session, spawn a new session forked from it.
                cli_opts.resume = True
                cli_opts.fork_session_id = resume_session_id
            elif resume_session_id:
                # Plain resume: session_id == resume_session_id (injected via worker_session_id).
                cli_opts.resume = True

            # Create process in IDLE state
            idle_state = _default_processor_state()
            idle_state["status"] = AgenticProcessStatus.IDLE.value

            process = AgenticProcess(
                processor_id=self.id,
                instruction_content="",
                cli_config=cli_opts.to_json(),
                context_data=context_data,
                workdir=workdir,
                state=idle_state,
                visible=visible,
                additional_dirs=additional_dirs,
            )
            # For plain resume the worker_session_id IS the session being resumed.
            if resume_session_id and not fork_session:
                process.worker_session_id = resume_session_id
            await process.save(owner)

            # Handle ProcessResult creation if requested
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

            logger.info(f"AgenticProcessor {self.id} created process {process.id} in IDLE status")

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} createProcess error: {e}")
            return ApiFailResponse(message=str(e))
