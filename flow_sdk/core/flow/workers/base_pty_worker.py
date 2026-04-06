"""
BasePTYWorker — generic PTY lifecycle base for CLI workers.

Handles PTY session setup, Shell entity creation, process launch, and SIGINT
cancellation. Subclasses only need to implement _build_cli_options().
"""

import json
import logging
import os
import uuid
from typing import TYPE_CHECKING, AsyncIterator

from pydantic_ai.messages import UserPromptPart
from pydantic_ai.usage import RunUsage

from flow_sdk.core.flow.models.state.flow_state import FlowModelMessage, FlowModelRequest
from flow_sdk.flowpad_types.enums import WorkerTaskStatus
from flow_sdk.builtin.shell import Shell

from .worker import BaseWorker, WorkerRequest, WorkerResponse, WorkerStreamEvent

if TYPE_CHECKING:
    from flow_sdk.builtin.cli_workers.base import WorkerCLIOptions
    from flow_sdk.builtin.process import Flow
    from flow_sdk.core.flow.models.process_deps import ComputeSession


logger = logging.getLogger(__name__)


def _inject_trace_env_vars(deps: "ComputeSession") -> None:
    """Set FLOWPAD_EXECUTION_SCOPE so hooks are routed to the right process."""
    scope_typeids = [str(deps.flow.typeid)]
    os.environ["FLOWPAD_EXECUTION_SCOPE"] = json.dumps(scope_typeids)


class BasePTYWorker(BaseWorker):
    """Base worker that executes a CLI tool via a PTY session.

    Subclasses implement ``_build_cli_options()`` to return a configured
    ``WorkerCLIOptions`` instance. Everything else — PTY setup, Shell entity
    creation, env var injection, PID tracking, SIGINT cancellation — is handled
    here.
    """

    PTY_COLS = 80
    PTY_ROWS = 24

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._process_id: str | None = None
        self._project_dir: str | None = None
        self._machine_session_id: str | None = None
        self._worker_session_id: str | None = None
        self._deps: "ComputeSession | None" = None

    def _build_cli_options(self, session_id: str, workdir: str) -> "WorkerCLIOptions":
        """Return the CLI options for this worker type.

        Subclasses must override this. The returned object is used as-is after
        env vars from ``WorkerConfig.environment`` and ``FLOWPAD_EXECUTION_SCOPE``
        are injected by the base class.
        """
        raise NotImplementedError(f"{type(self).__name__} must implement _build_cli_options()")

    @classmethod
    async def cancel_pty_session(cls, flow: "Flow") -> bool:
        """Send SIGINT to the flow's current PTY session.

        Returns True if the signal was sent successfully.
        """
        terminal_id = flow.current_terminal_id
        if not terminal_id:
            logger.warning("[BasePTYWorker] No terminal ID on flow, cannot cancel")
            return False

        try:
            compute_node = await flow.get_compute_node()
            if not compute_node:
                logger.warning("[BasePTYWorker] Compute node not available")
                return False

            await compute_node.compute_provider.send_pty_input(
                compute_node.verified_node_provider_id,
                terminal_id,
                b"\x03",
                cols=cls.PTY_COLS,
                rows=cls.PTY_ROWS,
            )
            logger.info(f"[BasePTYWorker] Sent SIGINT to PTY session {terminal_id}")
            return True

        except Exception as e:
            logger.error(f"[BasePTYWorker] Failed to cancel PTY session: {e}", exc_info=True)
            return False

    async def cancel_task(self, task_id: str) -> bool:
        if not self._deps:
            logger.warning("[BasePTYWorker] No deps reference, cannot cancel")
            return False
        return await self.cancel_pty_session(self._deps.flow)

    async def execute_task(self, request: WorkerRequest) -> AsyncIterator[WorkerStreamEvent]:
        """PTY lifecycle: start session → launch → yield RUNNING."""
        deps = request.ctx.deps
        self._deps = deps

        prompt_content = "\n".join(request.prompt) if isinstance(request.prompt, list) else request.prompt

        compute_node = deps.mcp_connector.compute_node
        if not compute_node:
            logger.error("[BasePTYWorker] No compute node available")
            yield WorkerResponse(new_messages=[], run_usage=RunUsage(), status=WorkerTaskStatus.FAILED)
            return

        await deps.callback_handler.on_status("Starting CLI worker")

        new_messages: list[FlowModelMessage] = [FlowModelRequest(parts=[UserPromptPart(content=prompt_content)])]

        try:
            logger.info("[BasePTYWorker] ===== Starting task execution =====")

            _inject_trace_env_vars(deps)

            self._machine_session_id = str(uuid.uuid4())
            self._worker_session_id = str(uuid.uuid4())
            logger.info(
                f"[BasePTYWorker] machine_session_id={self._machine_session_id}, "
                f"worker_session_id={self._worker_session_id}"
            )

            self._process_id = deps.flow.id

            assert deps.project and deps.project.vfs_fs_root_path, "project vfs_fs_root_path missing"
            self._project_dir = deps.project.vfs_fs_root_path
            logger.info(f"[BasePTYWorker] project_dir={self._project_dir}")

            session_started = await compute_node.start_machine_pty_session(
                shell_id=self._machine_session_id,
                rows=self.PTY_ROWS,
                cols=self.PTY_COLS,
                name=f"Worker - {self._worker_session_id[:8]}",
            )
            if not session_started:
                raise RuntimeError("Failed to start machine PTY session")

            deps.flow.current_terminal_id = self._machine_session_id
            await deps.flow.update()

            shell = await Shell.get_by_id(self._machine_session_id)
            if not shell:
                raise RuntimeError(f"Shell entity not found after PTY session creation: {self._machine_session_id}")

            cmd = self._build_cli_options(self._worker_session_id, self._project_dir)

            # Inject env vars from WorkerConfig.environment
            if self._config.environment:
                for k, v in self._config.environment.env_vars.items():
                    cmd.add_env(k, v)

            # Inject execution scope for flow tracing
            if scope := os.environ.get("FLOWPAD_EXECUTION_SCOPE"):
                cmd.add_env("FLOWPAD_EXECUTION_SCOPE", scope)

            logger.info(f"[BasePTYWorker] Launching worker via shell {self._machine_session_id}")
            execution_info = await shell.launch(cmd, instruction=prompt_content)
            logger.info(
                f"[BasePTYWorker] Worker launched: pid={execution_info.pid}, name={execution_info.name!r}"
            )

            yield WorkerResponse(
                new_messages=new_messages,
                run_usage=RunUsage(),
                status=WorkerTaskStatus.RUNNING,
            )

        except Exception as e:
            logger.error(f"[BasePTYWorker] Execution error: {e}", exc_info=True)
            yield WorkerResponse(
                new_messages=new_messages,
                run_usage=RunUsage(),
                status=WorkerTaskStatus.FAILED,
            )
