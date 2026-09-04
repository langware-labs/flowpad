"""Fast, test-only agentic worker for exercising orchestration data flow.

The harness deliberately is not registered as a Flowpad vendor.  Tests install
``MockDriver`` at the ``AgenticProcess`` driver-resolution seam, so production
schemas, bootstrap payloads, and UI worker lists remain unchanged.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from pathlib import Path

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticWorker,
)
from flow_sdk.builtin.agentic_process.cli_drivers.headless_turn import run_headless_turn
from flow_sdk.builtin.worker_status import WorkerStatus, _tail_status
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
from flow_sdk.transcript_analyzer import (
    TranscriptDescriptor,
    TranscriptFormat,
    TranscriptSource,
)

logger = logging.getLogger(__name__)


class MockWorker(AgenticWorker):
    """One immediate turn that records a normal Claude-shaped transcript."""

    def __init__(
        self,
        transcript_path: Path,
        *,
        response_for: Callable[[str], str],
        received_prompts: list[str],
    ) -> None:
        self.transcript_path = transcript_path
        self._response_for = response_for
        self._received_prompts = received_prompts
        self._session_id: str | None = None

    async def execute(self, prompt: str, context: AgenticContext):
        self._session_id = context.session_id or mint_uuid()
        self._received_prompts.append(prompt)
        reply = self._response_for(prompt)
        entries = (
            {
                "type": "user",
                "sessionId": self._session_id,
                "message": {"role": "user", "content": prompt},
            },
            {
                "type": "assistant",
                "sessionId": self._session_id,
                "message": {
                    "id": mint_uuid(),
                    "role": "assistant",
                    "content": [{"type": "text", "text": reply}],
                    "stop_reason": "end_turn",
                },
            },
        )
        self.transcript_path.parent.mkdir(parents=True, exist_ok=True)
        with self.transcript_path.open("a", encoding="utf-8") as stream:
            for entry in entries:
                stream.write(json.dumps(entry) + "\n")

        # Keep the real AgenticWorker async-iterator contract without emitting
        # synthetic UI frames.  Agent message processing captures the answer from the
        # transcript, exactly as it does for a real harness.
        if False:  # pragma: no cover - marks this method as an async generator
            yield FlowData()

    def get_session_id(self) -> str | None:
        return self._session_id


class MockDriver(ClaudeDriver):
    """Claude-compatible test driver backed by :class:`MockWorker`."""

    name = "mock"

    def __init__(
        self,
        transcript_root: Path,
        *,
        response_for: Callable[[str], str] | None = None,
    ) -> None:
        self.transcript_root = transcript_root
        self.response_for = response_for or (lambda prompt: f"Mock reply: {prompt}")
        self.received_prompts: list[str] = []
        self._transcripts: dict[str, Path] = {}

    async def headless_prompt(self, process, instruction: str):
        if not process.session_id:
            process.session_id = mint_uuid()
        transcript_path = self.transcript_root / f"{process.id}.jsonl"
        self._transcripts[process.id] = transcript_path
        worker = MockWorker(
            transcript_path,
            response_for=self.response_for,
            received_prompts=self.received_prompts,
        )
        context = AgenticContext(
            workdir=process.workdir,
            session_id=process.session_id,
        )
        return await run_headless_turn(
            self,
            process,
            worker,
            prompt=instruction,
            context=context,
            logger=logger,
        )

    def transcript_descriptor(self, process) -> TranscriptDescriptor | None:
        path = self._transcripts.get(process.id)
        if path is None:
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.CLAUDE_JSONL,
            source=TranscriptSource.PROCESS_LOCAL,
            session_id=process.session_id or "",
        )

    def transcript_path(self, process) -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        return _tail_status(transcript_path)

    def has_resumable_session(self, process) -> bool:
        path = self._transcripts.get(process.id)
        return path is not None and path.exists()


__all__ = ["MockDriver", "MockWorker"]
