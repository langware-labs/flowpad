"""
Mock Worker for replaying recorded agent executions.

Enables deterministic testing by replaying recorded parts without LLM calls.
"""

import logging
import time
from pathlib import Path
from typing import AsyncIterator, Optional, Union

from .worker import BaseWorker, WorkerConfig, WorkerRequest, WorkerResponse, WorkerStreamEvent

logger = logging.getLogger(__name__)


class MockWorker(BaseWorker):
    """Mock worker that replays recorded parts for deterministic testing."""

    def __init__(self, config=None, streamer=None):
        """
        Initialize MockWorker.

        Args:
            config: Worker configuration (optional)
            streamer: MockAgentStreamer with recorded parts (optional)
        """
        from flow_sdk.flowpad_types.enums import WorkerType

        if config is None:
            config = WorkerConfig(worker_type=WorkerType.MOCK)
        super().__init__(config)
        self.streamer = streamer
        self._current_part_index = 0

    @classmethod
    def from_json(cls, recording_path: Union[str, Path], recordings_dir: Optional[Path] = None) -> "MockWorker":
        """
        Create MockWorker from recording JSON file.

        Args:
            recording_path: Path to recording JSON file (absolute or relative to recordings_dir)
            recordings_dir: Optional recordings directory (defaults to tests/recordings)

        Returns:
            MockWorker instance ready to replay
        """
        from tests.utils.mock_agent_streamer import MockAgentStreamer

        recording_path = Path(recording_path)

        # If not absolute, resolve relative to recordings_dir
        if not recording_path.is_absolute():
            if recordings_dir is None:
                # Default to tests/recordings
                recordings_dir = Path(__file__).parent.parent.parent.parent.parent.parent / "tests" / "recordings"
            recording_path = recordings_dir / recording_path

        # Load streamer from JSON
        streamer = MockAgentStreamer.load(recording_path)

        return cls(streamer=streamer)

    async def execute_task(self, request: WorkerRequest) -> AsyncIterator[WorkerStreamEvent]:
        """
        Execute task by replaying recorded parts.

        Yields recorded parts in sequence without calling LLM.
        """
        start_time = time.time()
        if not self.streamer:
            raise ValueError("MockWorker has no streamer - use from_json() or provide streamer in __init__")

        # Reset part index
        self._current_part_index = 0
        parts = self.streamer.get_parts()

        # Replay parts in sequence
        for part_dict in parts:
            part_type = part_dict.get("type")

            if part_type == "ThinkingPart":
                from pydantic_ai.messages import ThinkingPart

                part = ThinkingPart(content=part_dict.get("content", ""))
                yield part

            elif part_type == "TextPart":
                from pydantic_ai.messages import TextPart

                part = TextPart(content=part_dict.get("content", ""))
                yield part

            elif part_type == "ToolCallInvocationPart":
                from flow_sdk.core.flow.tools import ToolCallInvocationPart

                part = ToolCallInvocationPart(
                    tool_name=part_dict.get("tool_name", ""),
                    args=part_dict.get("args", {}),
                    tool_call_id=part_dict.get("tool_call_id", ""),
                )
                yield part

            elif part_type == "ToolReturnPart":
                from pydantic_ai.messages import ToolReturnPart

                part = ToolReturnPart(
                    tool_call_id=part_dict.get("tool_call_id", ""),
                    content=part_dict.get("content", ""),
                )
                yield part

            elif part_type == "WorkerResponse":
                from pydantic_ai.usage import RunUsage

                from flow_sdk.flowpad_types.enums import WorkerTaskStatus

                run_usage_dict = part_dict.get("run_usage", {})
                run_usage = RunUsage(
                    input_tokens=run_usage_dict.get("input_tokens", 0),
                    output_tokens=run_usage_dict.get("output_tokens", 0),
                )

                worker_response = WorkerResponse(
                    new_messages=[],
                    run_usage=run_usage,
                    status=WorkerTaskStatus.COMPLETED,
                )
                yield worker_response

            self._current_part_index += 1

        # Log execution time to verify fast replay
        execution_time_ms = (time.time() - start_time) * 1000
        logger.info(f"MockWorker.execute_task() completed in {execution_time_ms:.2f}ms")

    def get_prompt(self) -> str:
        """Get the recorded prompt."""
        return self.streamer.prompt if self.streamer else ""

    def get_client_stream(self) -> str:
        """Get the recorded client stream."""
        return self.streamer.metadata.get("client_stream", "") if self.streamer else ""
