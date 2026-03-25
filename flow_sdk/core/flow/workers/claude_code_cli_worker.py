"""
Claude Code CLI Worker

Worker that executes Claude CLI via PTY session.
"""

import json
import logging
import os
import shlex
import sys
import uuid
from typing import TYPE_CHECKING, AsyncIterator

from pydantic_ai.messages import UserPromptPart
from pydantic_ai.usage import RunUsage

from flow_sdk.core.flow.models.state.flow_state import FlowModelMessage, FlowModelRequest
from flow_sdk.flowpad_types.enums import WorkerTaskStatus

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

            # Build and send Claude CLI command to PTY session
            command = self._build_claude_command(prompt_content)
            command_bytes = (command + os.linesep).encode("utf-8")

            pty_key = (compute_node.node_provider_id, self._machine_session_id)
            logger.info(
                f"[ClaudeCodeCLIWorker] Sending command to PTY session: {self._machine_session_id} (key: {pty_key})"
            )

            await compute_node.compute_provider.send_pty_input(
                provider_node_id=compute_node.verified_node_provider_id,
                session_id=self._machine_session_id,
                data=command_bytes,
                cols=self.PTY_COLS,
                rows=self.PTY_ROWS,
            )
            logger.info(f"[ClaudeCodeCLIWorker] Successfully sent command to PTY: {command[:100]}...")
            logger.info(
                f"[ClaudeCodeCLIWorker] Claude is now running in terminal. "
                f"Output should appear in the '{self._machine_session_id}' terminal session."
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

    def _build_claude_command(self, prompt: str) -> str:
        """Build Claude CLI command with worker session ID and prompt.

        Args:
            prompt: The prompt to send to Claude CLI

        Returns:
            Shell command string to execute Claude CLI with worker session ID and prompt
        """
        assert self._project_dir is not None, "project_dir must be set before building command"

        # Collect environment variables to set
        env_vars = {"CLAUDE_PROJECT_DIR": self._project_dir}
        process_env_var_names = ["FLOWPAD_EXECUTION_SCOPE"]
        for var in process_env_var_names:
            value = os.environ.get(var)
            if value:
                env_vars[var] = value

        if sys.platform == "win32":
            # PowerShell command with Base64-encoded prompt to handle multi-line and special chars
            # This avoids issues with here-strings not being parsed correctly in PTY
            import base64

            def ps_quote(s: str) -> str:
                return "'" + s.replace("'", "''") + "'"

            # Use $env:VAR = 'value' syntax for environment variables
            env_commands = [f"$env:{k} = {ps_quote(v)}" for k, v in env_vars.items()]
            env_prefix = "; ".join(env_commands) + "; " if env_commands else ""

            # Base64 encode the prompt, then decode in PowerShell
            prompt_bytes = prompt.encode("utf-8")
            prompt_b64 = base64.b64encode(prompt_bytes).decode("ascii")

            # PowerShell command to decode Base64 and pass to claude
            decode_cmd = f"[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{prompt_b64}'))"
            return f"cd {ps_quote(self._project_dir)}; {env_prefix}claude --dangerously-skip-permissions --chrome --debug --session-id {self._worker_session_id} -p ({decode_cmd})"
        else:
            # POSIX shell command with heredoc for multi-line prompt
            # Using cat with heredoc and command substitution to pass as argument
            # The 'EOF' (quoted) makes it a literal heredoc (no variable expansion)
            env_prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in env_vars.items())

            return f"cd {shlex.quote(self._project_dir)} && {env_prefix} claude --dangerously-skip-permissions --chrome --debug --session-id {self._worker_session_id} -p \"$(cat <<'EOF'\n{prompt}\nEOF\n)\""
