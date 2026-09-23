"""Fast, test-only agentic worker for exercising orchestration data flow.

The harness deliberately is not registered as a Flowpad vendor.  Tests install
``MockDriver`` at the ``AgenticProcess`` driver-resolution seam, so production
schemas, bootstrap payloads, and UI worker lists remain unchanged.

Two ways to say what the worker does on a turn:

* ``response_for(prompt) -> str`` — the reply text, nothing else (the original shape).
* ``behavior(turn) -> str | Awaitable[str]`` — a :class:`MockTurn` that sees what a real worker
  receives (the prompt, the system instructions exactly as this vendor's driver projected them,
  the loaded skills, the native ``--agents`` roster) and can act the way a real worker acts: run
  the real ``flow`` CLI (``turn.flow(...)``) and call a native subagent (``turn.native_subagent``).
  Both actions are recorded in the transcript as real-shaped tool calls.

**Any vendor.** :func:`mock_driver_for` builds the mock on top of a real vendor driver class
(claude, codex, copilot, opencode, deepagents), so the vendor's own instruction projection and
capability traits run — only the model is replaced.

**Fast.** A mock turn is written whole before its worker unregisters, so nothing can land after
the turn's marker: the driver declares ``transcript_settle_seconds = 0`` and a turn takes a poll or
two instead of the 2 s a real CLI needs for its late tool writes.
"""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticWorker,
)
from flow_sdk.builtin.agentic_process.cli_drivers.headless_turn import run_headless_turn
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
from flow_sdk.transcript_analyzer import (
    TranscriptDescriptor,
    TranscriptFormat,
    TranscriptSource,
)
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus, _tail_status

logger = logging.getLogger(__name__)

#: ``flow(process, args) -> result`` — how a turn runs the real ``flow`` CLI as this process.
FlowRunner = Callable[[Any, list[str]], Awaitable[dict]]
Behavior = Callable[["MockTurn"], Union[str, Awaitable[str]]]


class MockUsageError(AssertionError):
    """A behavior did something a real worker in this position could not do."""


@dataclass
class MockTurn:
    """One turn, as the worker sees it."""

    prompt: str
    process: Any
    vendor: str
    #: The system instructions exactly as this vendor's driver projected them (its CLAUDE.md /
    #: AGENTS.md / instructions file) — what a real worker would read.
    instructions: str = ""
    #: Skills the worker can see (folder names under ``.claude/skills`` of its assets and mounted dirs).
    skills: list[str] = field(default_factory=list)
    #: The native subagent roster (``--agents``) — empty for a vendor that cannot spawn natively.
    agents: dict = field(default_factory=dict)
    spawns_subagents: bool = False
    _flow: Optional[FlowRunner] = None
    #: Tool calls made this turn, as transcript entries (assistant tool_use + user tool_result).
    entries: list[dict] = field(default_factory=list)
    flow_calls: list[list[str]] = field(default_factory=list)

    @property
    def is_chief_of_staff(self) -> bool:
        from flow_sdk.tasks.cos import COS_MARKER  # noqa: PLC0415

        return COS_MARKER in self.instructions

    @property
    def owned_task_id(self) -> str:
        """The task this process was started to own, or ``""``."""
        return str((getattr(self.process, "context_data", None) or {}).get("task_id") or "")

    async def flow(self, *args: str) -> dict:
        """Run ``flow <args>`` as this process — the real CLI, route and backend."""
        if self._flow is None:
            raise MockUsageError("this mock driver was built without a flow runner")
        argv = [str(a) for a in args]
        result = await self._flow(self.process, argv)
        self.flow_calls.append(argv)
        self._tool("Bash", {"command": "flow " + " ".join(argv)}, json.dumps(result))
        return result

    def native_subagent(self, name: str, prompt: str, result: str) -> str:
        """Call a native subagent (Claude's Agent tool) — only one this worker was given."""
        if not self.spawns_subagents:
            raise MockUsageError(f"{self.vendor} cannot spawn native subagents")
        if name not in self.agents:
            raise MockUsageError(f"{name!r} is not in this worker's --agents roster {sorted(self.agents)}")
        self._tool("Agent", {"subagent_type": name, "prompt": prompt}, result)
        return result

    def _tool(self, name: str, tool_input: dict, output: str) -> None:
        tool_id = f"toolu_{mint_uuid().replace('-', '')[:20]}"
        session = getattr(self.process, "session_id", "") or ""
        self.entries.append({
            "type": "assistant", "sessionId": session,
            "message": {"id": mint_uuid(), "role": "assistant", "stop_reason": "tool_use",
                        "content": [{"type": "tool_use", "id": tool_id, "name": name, "input": tool_input}]},
        })
        self.entries.append({
            "type": "user", "sessionId": session,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": output}]},
        })


class MockWorker(AgenticWorker):
    """One immediate turn that records a normal Claude-shaped transcript."""

    def __init__(
        self,
        transcript_path: Path,
        *,
        response_for: Callable[[str], str],
        received_prompts: list[str],
        turn: Optional[MockTurn] = None,
        behavior: Optional[Behavior] = None,
        turns: Optional[list[MockTurn]] = None,
    ) -> None:
        self.transcript_path = transcript_path
        self._response_for = response_for
        self._received_prompts = received_prompts
        self._turn = turn
        self._behavior = behavior
        self._turns = turns
        self._session_id: str | None = None

    async def execute(self, prompt: str, context: AgenticContext):
        self._session_id = context.session_id or mint_uuid()
        self._received_prompts.append(prompt)
        tools: list[dict] = []
        if self._behavior is not None and self._turn is not None:
            self._turn.prompt = prompt
            reply = self._behavior(self._turn)
            if inspect.isawaitable(reply):
                reply = await reply
            tools = self._turn.entries
            if self._turns is not None:
                self._turns.append(self._turn)
        else:
            reply = self._response_for(prompt)
        entries = (
            {
                "type": "user",
                "sessionId": self._session_id,
                "message": {"role": "user", "content": prompt},
            },
            *tools,
            {
                "type": "assistant",
                "sessionId": self._session_id,
                "message": {
                    "id": mint_uuid(),
                    "role": "assistant",
                    "content": [{"type": "text", "text": str(reply)}],
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


class _MockDriverMixin:
    """The mock half of a driver: the worker is :class:`MockWorker`, the transcript is its JSONL."""

    #: The mock writes its turn whole before unregistering — nothing lands after the marker, and
    #: there is nothing to wait for between looks.
    transcript_settle_seconds = 0.0
    transcript_poll_seconds = 0.01

    def _init_mock(self, transcript_root: Path, *, response_for=None, behavior=None, flow=None) -> None:
        self.transcript_root = transcript_root
        self.response_for = response_for or (lambda prompt: f"Mock reply: {prompt}")
        self.behavior = behavior
        self.flow = flow
        self.received_prompts: list[str] = []
        #: Every behavior turn taken, in order (what it saw and what it did).
        self.turns: list[MockTurn] = []
        self._transcripts: dict[str, Path] = {}

    async def _mock_turn(self, process) -> Optional[MockTurn]:
        if self.behavior is None:
            return None
        prepared = await process.asset_workspace._prepare_system_instruction_assets()
        instructions = ""
        if prepared is not None:
            projected = getattr(prepared, "claude_file", None)
            if projected and Path(projected).is_file():
                instructions = Path(projected).read_text(encoding="utf-8")
            else:
                instructions = getattr(prepared, "instructions", "") or ""
        # Every skill the worker can see: its process assets plus each mounted dir (``--add-dir``: the
        # Flowpad assistant when enabled, the project's context folders).
        assets = getattr(prepared, "assets_dir", None) if prepared is not None else None
        mounted = [*([assets] if assets else []), *(getattr(process, "resolved_add_dirs", None) or [])]
        skills = sorted({
            p.name for d in mounted if (Path(d) / ".claude" / "skills").is_dir()
            for p in (Path(d) / ".claude" / "skills").iterdir() if p.is_dir()
        })
        spawns = bool(getattr(self, "spawns_subagents", False))
        agents = (process.get_agents_json() or {}) if spawns else {}
        return MockTurn(
            prompt="", process=process, vendor=str(getattr(self, "vendor_key", "claude")), instructions=instructions,
            skills=skills, agents=dict(agents), spawns_subagents=spawns, _flow=self.flow,
        )

    async def headless_prompt(self, process, instruction: str):
        if not process.session_id:
            process.session_id = mint_uuid()
        transcript_path = self.transcript_root / f"{process.id}.jsonl"
        self._transcripts[process.id] = transcript_path
        worker = MockWorker(
            transcript_path,
            response_for=self.response_for,
            received_prompts=self.received_prompts,
            turn=await self._mock_turn(process),
            behavior=self.behavior,
            turns=self.turns,
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


class MockDriver(_MockDriverMixin, ClaudeDriver):
    """Claude-compatible test driver backed by :class:`MockWorker`."""

    name = "mock"
    vendor_key = "claude"

    def __init__(
        self,
        transcript_root: Path,
        *,
        response_for: Callable[[str], str] | None = None,
        behavior: Behavior | None = None,
        flow: FlowRunner | None = None,
    ) -> None:
        self._init_mock(transcript_root, response_for=response_for, behavior=behavior, flow=flow)


#: The vendors a mock can stand in for — every registered worker vendor.
MOCK_VENDORS = ("claude", "codex", "copilot", "opencode", "deepagents")


def mock_driver_for(
    vendor: str,
    transcript_root: Path,
    *,
    response_for: Callable[[str], str] | None = None,
    behavior: Behavior | None = None,
    flow: FlowRunner | None = None,
):
    """A mock worker on top of ``vendor``'s real driver: its instruction projection and its traits
    (``spawns_subagents`` …) are the vendor's own; only the model is the mock."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver  # noqa: PLC0415

    real = type(get_driver(vendor))
    cls = type(f"Mock{real.__name__}", (_MockDriverMixin, real), {"vendor_key": vendor})
    driver = cls.__new__(cls)
    try:
        real.__init__(driver)
    except TypeError:
        pass
    driver._init_mock(transcript_root, response_for=response_for, behavior=behavior, flow=flow)
    return driver


__all__ = ["MOCK_VENDORS", "MockDriver", "MockTurn", "MockUsageError", "MockWorker", "mock_driver_for"]
