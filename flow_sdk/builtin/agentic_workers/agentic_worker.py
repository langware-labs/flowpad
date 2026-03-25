"""
AgenticWorker - Minimal base class for workers.

Clean interface: prompt + context -> FlowData stream
No bloat: no pydantic-ai, no GraphRunContext, no WorkerConfig
"""

from abc import ABC, abstractmethod
from typing import AsyncIterator

from flow_sdk.builtin.agentic_workers.context import AgenticContext
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData


class AgenticWorker(ABC):
    """Minimal worker interface for agentic execution.

    Clean design:
    - Takes prompt + AgenticContext
    - Streams FlowData chunks
    - No config classes, no request/response objects
    - No health checks, task tracking, or cleanup methods

    Streaming Input Mode (optional):
    - Workers can support pause/resume/inject for interactive sessions
    - Default implementations are no-ops for workers that don't support it
    """

    @abstractmethod
    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        """Execute prompt and stream FlowData responses.

        Args:
            prompt: The prompt/instruction to execute
            context: AgenticContext with compute_node, env_vars, etc.

        Yields:
            FlowData chunks (chat, reasoning, error, etc.)
        """
        raise NotImplementedError

    def pause(self) -> None:
        """Pause message processing (streaming input mode).

        When paused, the worker stops processing messages from its input queue
        until resume() is called. Default implementation is a no-op.
        """
        pass

    def resume(self) -> None:
        """Resume message processing after pause (streaming input mode).

        Resumes processing messages from the input queue. Default implementation
        is a no-op.
        """
        pass

    async def inject(self, message: str) -> None:
        """Inject a new message into the worker's input queue (streaming input mode).

        The message will be processed by the worker's active session.
        Default implementation is a no-op.

        Args:
            message: The message to inject
        """
        pass

    async def close_session(self) -> None:
        """Close the worker's active session and clean up resources.

        Called when the process is stopped or completed. Default implementation
        is a no-op.
        """
        pass

    # ============ History Interface ============

    def get_session_id(self) -> str | None:
        """Get the current session ID (for resume).

        Workers that support session persistence should return their
        session ID here. Default: None.

        Returns:
            Session ID string or None if not available
        """
        return None

    def get_history(self) -> list[FlowData] | None:
        """Get worker-managed history, or None to use process storage.

        Workers that manage their own history (e.g., Claude Code with JSONL files)
        should return the history here. Default: None.

        Returns:
            List of FlowData items or None if worker doesn't manage history
        """
        return None

    def set_history(self, history: list[FlowData]) -> None:
        """Restore history when resuming a session.

        Called when process is restored with previous history.
        Default: no-op.

        Args:
            history: List of FlowData items to restore
        """
        pass

    def manages_history(self) -> bool:
        """Return True if worker manages its own history.

        Workers that manage their own history (e.g., via external files)
        should return True. The process will then delegate history
        storage to the worker. Default: False.

        Returns:
            True if worker manages history, False otherwise
        """
        return False
