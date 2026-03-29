from __future__ import annotations

import asyncio
import subprocess
import tempfile
import time
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, AsyncGenerator, Callable

from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord, AgenticProcessStatus

if TYPE_CHECKING:
    from flow_sdk.builtin.agent_runner import AgentRunner
    from flow_sdk.fs_records.text_file_record import TextFileRecord


class WorkerType(StrEnum):
    CLAUDE = "claude"


class AgenticProcess:
    """Hydrated agentic process with lifecycle + event API.

    Event model uses polling (discover_status) -- NOT push-based.
    For WS-based events, use TS SDK or server-side Entity.

    kill() delegates to server HTTP API (requires running server).
    """

    def __init__(
        self,
        record: AgenticProcessRecord | None = None,
        *,
        workerType: WorkerType | None = None,
    ) -> None:
        if record is None:
            record = AgenticProcessRecord(workerType=workerType or WorkerType.CLAUDE)
        self._record = record
        self._handlers: dict[str, list[Callable]] = {}
        self._popen: subprocess.Popen | None = None
        self._launched: bool = False
        self._workdir: Path | None = None
        self._start_time: float | None = None

    @property
    def record(self) -> AgenticProcessRecord:
        return self._record

    @property
    def id(self) -> str:
        return self._record.id

    @property
    def name(self) -> str | None:
        return self._record.name

    @classmethod
    def fromRecord(cls, record: AgenticProcessRecord) -> AgenticProcess:
        return cls(record)

    # ------------------------------------------------------------------
    # Lifecycle API
    # ------------------------------------------------------------------

    def start(self, workdir: str | None = None) -> None:
        """Prepare the process: create workdir, persist record. No Claude launched yet."""
        self._workdir = Path(workdir) if workdir else Path(tempfile.mkdtemp(prefix="flow-process-"))
        self._workdir.mkdir(parents=True, exist_ok=True)
        self._start_time = time.time()
        records_dir = self._workdir / ".flow_records"
        records_dir.mkdir(exist_ok=True)
        record_path = records_dir / f"{self.record.id}.json"
        self.record.save_record_json(record_path)

    @property
    def idle(self) -> bool:
        """True when no Claude session is active (not launched yet, or finished)."""
        if not self._launched:
            return True
        s = self.status
        if s in (AgenticProcessStatus.COMPLETE, AgenticProcessStatus.ERROR, AgenticProcessStatus.TERMINATED):
            self._launched = False
            return True
        return False

    def prompt(self, instruction: str, agent: "AgentRunner | None" = None) -> None:
        """Launch Claude with the given instruction. Sets idle=False.

        If ``agent`` is provided, installs it as a sub-agent in the workdir
        before launching (copies .md and passes CLAUDE_AGENTS_JSON env var).
        """
        import json
        import shutil
        from flow_sdk.builtin.process_runner import ProcessConfig, run_process
        if self._workdir is None:
            self.start()

        env_vars: dict[str, str] = {}
        if agent is not None:
            agents_dir = self._workdir / ".claude" / "agents"
            agents_dir.mkdir(parents=True, exist_ok=True)
            if agent.record.record_dir and agent.name:
                src = agent.record.record_dir / f"{agent.name}.md"
                if src.exists():
                    shutil.copy2(src, agents_dir / f"{agent.name}.md")
            env_vars["CLAUDE_AGENTS_JSON"] = json.dumps(agent.record.to_agents_json())

        config = ProcessConfig(
            skill_name="direct_prompt",
            instruction=instruction,
            permission_mode="bypassPermissions",
            env_vars=env_vars,
        )
        updated_record, self._popen = run_process(
            config,
            workdir=str(self._workdir),
            session_id=None,
        )
        object.__setattr__(self.record, "worker_session_id", updated_record.data.get("worker_session_id"))
        self._launched = True

    async def waitForIdle(self, timeout: float | None = None) -> None:
        """Poll until idle (complete/error/terminated or not yet launched).

        Raises TimeoutError if timeout is exceeded.
        """
        deadline = (asyncio.get_event_loop().time() + timeout) if timeout else None
        while True:
            if self.idle:
                return
            if deadline and asyncio.get_event_loop().time() > deadline:
                raise TimeoutError(f"Process did not become idle within {timeout}s")
            await asyncio.sleep(2.0)

    @property
    def output_folder(self) -> Path | None:
        """The working directory where Claude writes output files."""
        return self._workdir

    @property
    def outputs(self) -> list["TextFileRecord"]:
        """Files created in workdir at or after start() was called."""
        from flow_sdk.fs_records.text_file_record import TextFileRecord
        if self._workdir is None or self._start_time is None:
            return []
        results = []
        for path in self._workdir.rglob("*"):
            if not path.is_file():
                continue
            parts = path.parts
            if ".flow_records" in parts or ".claude" in parts:
                continue
            if path.stat().st_mtime >= self._start_time:
                results.append(TextFileRecord(file_path=path))
        return results

    # ------------------------------------------------------------------
    # Status / monitoring
    # ------------------------------------------------------------------

    @property
    def status(self) -> AgenticProcessStatus:
        """Derive status from transcript via discover_status()."""
        return self.record.discover_status()

    @property
    def worker_session_id(self) -> str | None:
        return self.record.data.get("worker_session_id")

    @property
    def pty_pid(self) -> str | None:
        return self.record.data.get("pty_pid")

    @property
    def shell_id(self) -> str | None:
        return self.record.data.get("shell_id")

    async def waitForCompletion(self, timeout: float | None = None) -> None:
        """Poll transcript status until COMPLETE or ERROR.

        Polls every 2 seconds via discover_status().
        Raises TimeoutError if timeout exceeded.
        """
        deadline = (asyncio.get_event_loop().time() + timeout) if timeout else None
        while True:
            s = self.status
            if s in (AgenticProcessStatus.COMPLETE, AgenticProcessStatus.ERROR, AgenticProcessStatus.TERMINATED):
                self._emit(s.value)
                return
            if deadline and asyncio.get_event_loop().time() > deadline:
                raise TimeoutError(f"Process did not complete within {timeout}s")
            await asyncio.sleep(2.0)

    def kill(self) -> None:
        """Kill the PTY via HTTP API call to server's kill-pty action.

        Requires a running server.
        """
        import requests

        from flow_sdk.config import load_server_info

        server = load_server_info()
        url = f"{server.url}/api/v1/graph/agentic_process/{self.id}/kill-pty"
        requests.post(url)

    def on(self, event: str, handler: Callable) -> Callable:
        """Register an event handler. Returns unsubscribe function.

        Supported events: 'complete', 'error', 'terminated'.
        Handlers are invoked by waitForCompletion() or events().
        """
        self._handlers.setdefault(event, []).append(handler)

        def unsub():
            self._handlers[event].remove(handler)

        return unsub

    async def events(self) -> AsyncGenerator[dict, None]:
        """Async generator yielding status change events via polling.

        Polls discover_status() every 2 seconds.
        Terminates on COMPLETE, ERROR, or TERMINATED.
        """
        last_status = self.status
        while True:
            current = self.status
            if current != last_status:
                yield {"status": current.value, "previous": last_status.value}
                self._emit(current.value)
                last_status = current
                if current in (AgenticProcessStatus.COMPLETE, AgenticProcessStatus.ERROR, AgenticProcessStatus.TERMINATED):
                    return
            await asyncio.sleep(2.0)

    def _emit(self, event: str) -> None:
        """Invoke all handlers registered for the given event."""
        for handler in self._handlers.get(event, []):
            handler()
