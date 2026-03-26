"""
Claude Code CLI Worker

Worker that executes Claude CLI via PTY session.
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

from flow_sdk.builtin.cli_workers import ClaudeCliOptions
from flow_sdk.builtin.shell import Shell

from .worker import BaseWorker, WorkerRequest, WorkerResponse, WorkerStreamEvent

if TYPE_CHECKING:
    from flow_sdk.builtin.process import Flow
    from flow_sdk.core.flow.models.process_deps import ComputeSession


def inject_trace_env_vars(deps: "ComputeSession") -> None:
    """Inject environment variables for flow tracing.

    Sets FLOWPAD_EXECUTION_SCOPE so hooks are routed to the right process.
    AGENT_HOOKS_REPORT_URL is intentionally NOT set here — the `flow` CLI
    discovers the server port from ~/.flow/server.json at hook-fire time.
    """
    scope_typeids = [str(deps.flow.typeid)]

    os.environ["FLOWPAD_EXECUTION_SCOPE"] = json.dumps(scope_typeids)


logger = logging.getLogger(__name__)


class ClaudeCodeCLIWorker(BaseWorker):
    """Worker that executes Claude CLI via PTY session."""

    # Configuration constants
    PTY_COLS = 80
    PTY_ROWS = 24

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._process_id: str | None = None
        self._project_dir: str | None = None
        self._machine_session_id: str | None = None
        self._worker_session_id: str | None = None
        self._deps: "ComputeSession | None" = None

    @classmethod
    async def cancel_pty_session(cls, flow: "Flow") -> bool:
        """Cancel PTY session by sending SIGINT using flow's current_terminal_id.

        Args:
            flow: The flow containing the terminal session to cancel

        Returns:
            True if cancel signal was sent successfully, False otherwise
        """
        terminal_id = flow.current_terminal_id
        if not terminal_id:
            logger.warning("[ClaudeCodeCLIWorker] No terminal ID on flow, cannot cancel")
            return False

        try:
            compute_node = await flow.get_compute_node()
            if not compute_node:
                logger.warning("[ClaudeCodeCLIWorker] Compute node not available")
                return False

            sigint_bytes = b"\x03"
            await compute_node.compute_provider.send_pty_input(
                compute_node.verified_node_provider_id,
                terminal_id,
                sigint_bytes,
                cols=cls.PTY_COLS,
                rows=cls.PTY_ROWS,
            )

            logger.info(f"[ClaudeCodeCLIWorker] Sent SIGINT to PTY session {terminal_id}")
            return True

        except Exception as e:
            logger.error(f"[ClaudeCodeCLIWorker] Failed to cancel PTY session: {e}", exc_info=True)
            return False

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task by sending SIGINT (Ctrl+C) to the PTY session.

        Args:
            task_id: The task ID to cancel (not currently used, cancels current session)

        Returns:
            True if cancel signal was sent successfully, False otherwise
        """
        if not self._deps:
            logger.warning("[ClaudeCodeCLIWorker] No deps reference, cannot cancel")
            return False

        return await self.cancel_pty_session(self._deps.flow)

    async def execute_task(self, request: WorkerRequest) -> AsyncIterator[WorkerStreamEvent]:
        """Execute task via Claude CLI with hook event processing."""
        deps = request.ctx.deps

        # Store compute session reference for cancel_task
        self._deps = deps

        # Get prompt content
        prompt_content = "\n".join(request.prompt) if isinstance(request.prompt, list) else request.prompt

        # Get compute node from MCP connector
        compute_node = deps.mcp_connector.compute_node
        if not compute_node:
            logger.error("[ClaudeCodeCLIWorker] No compute node available")
            yield WorkerResponse(
                new_messages=[],
                run_usage=RunUsage(),
                status=WorkerTaskStatus.FAILED,
            )
            return

        await deps.callback_handler.on_status("Starting Claude CLI")

        # Initialize message tracking
        new_messages: list[FlowModelMessage] = [FlowModelRequest(parts=[UserPromptPart(content=prompt_content)])]

        try:
            logger.info("[ClaudeCodeCLIWorker] ===== Starting task execution =====")

            # Inject execution scope for flow tracing
            inject_trace_env_vars(deps)

            # Generate unique session ID for this execution
            self._machine_session_id = str(uuid.uuid4())
            self._worker_session_id = str(uuid.uuid4())  # Claude CLI requires plain UUID
            logger.info(
                f"[ClaudeCodeCLIWorker] Generated machine session ID: {self._machine_session_id}, worker session ID: {self._worker_session_id}"
            )

            self._process_id = deps.flow.id

            assert deps.project and deps.project.vfs_fs_root_path, "project vfs_fs_root_path missing"
            self._project_dir = deps.project.vfs_fs_root_path
            logger.info(f"[ClaudeCodeCLIWorker] Project directory: {self._project_dir}")

            # Start the machine PTY session with proper output routing
            # This creates the PTY session, registers it in session_manager,
            # and sends DataOp notifications to all watchers
            # The client receives notifications via watch mechanism (node.watch() in shellManager)
            session_started = await compute_node.start_machine_pty_session(
                session_id=self._machine_session_id,
                rows=self.PTY_ROWS,
                cols=self.PTY_COLS,
                name=f"Claude - {self._worker_session_id[:8]}",
            )
            if not session_started:
                logger.error("[ClaudeCodeCLIWorker] Failed to start machine PTY session")
                raise RuntimeError("Failed to start machine PTY session")

            logger.info(f"[ClaudeCodeCLIWorker] Started machine PTY session: {self._machine_session_id}")

            # Update flow with the terminal session ID so frontend can navigate to it
            deps.flow.current_terminal_id = self._machine_session_id
            await deps.flow.update()
            logger.info(f"[ClaudeCodeCLIWorker] Updated flow with terminal ID: {self._machine_session_id}")

            # Create Shell entity for this session so worker tracking is recorded
            shell = Shell(
                id=self._machine_session_id,
                name=f"Claude - {self._worker_session_id[:8]}",
                status="running",
                workdir=self._project_dir,
                compute_node_id=compute_node.id,
            )
            await shell.save()

            # Build command and launch via Shell — tracks worker PID automatically
            cmd = ClaudeCliOptions(
                session_id=self._worker_session_id,
                chrome=True,
                workdir=self._project_dir,
                print_mode=True,
            )
            if scope := os.environ.get("FLOWPAD_EXECUTION_SCOPE"):
                cmd.add_env("FLOWPAD_EXECUTION_SCOPE", scope)

            logger.info(
                f"[ClaudeCodeCLIWorker] Launching worker via shell {self._machine_session_id}"
            )
            execution_info = await shell.run_process(cmd, instruction=prompt_content)
            logger.info(
                f"[ClaudeCodeCLIWorker] Worker launched: pid={execution_info.pid}, name={execution_info.name!r}"
            )

            yield WorkerResponse(
                new_messages=new_messages,
                run_usage=RunUsage(),
                status=WorkerTaskStatus.RUNNING,
            )
        except Exception as e:
            logger.error(f"[ClaudeCodeCLIWorker] Execution error: {e}", exc_info=True)
            yield WorkerResponse(
                new_messages=new_messages,
                run_usage=RunUsage(),
                status=WorkerTaskStatus.FAILED,
            )
