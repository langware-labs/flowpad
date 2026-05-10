"""Cross-vendor primitives for the CLI driver layer.

Single base module that holds everything ``AgenticProcess`` needs to talk to a
worker without knowing which one — and the ``WorkerDriver`` Protocol that each
vendor (Claude, Codex, …) implements in its sub-package.

Modules layout::

    flow_sdk/builtin/agentic_process/cli_drivers/
        cli_worker_base_driver.py  ← this file
        claude/                    ← ClaudeDriver + Claude CLI specifics
        codex/                     ← CodexDriver + Codex CLI specifics

Bringing all the cross-vendor types into one file (instead of a ``base/``
sub-package) keeps the import graph flat: vendor drivers depend on this
module only, and ``AgenticProcess`` imports the driver factory plus the
``WorkerDriver`` Protocol from here.

Public exports:
- ``AgenticContext`` — per-turn execution context passed to workers.
- ``AgenticWorker`` — minimal ABC for execute()/inject()/close_session().
- ``WorkerCLIOptions`` — base CLI command builder (cd + env + worker_args).
- ``WorkerExecutionInfo`` — Pydantic model returned by Shell.launch().
- ``WorkerDriver`` — Protocol vendors implement; ``AgenticProcess`` calls it.
- ``factory(cli_json, worker_type)`` — legacy CLI-options factory.
- ``get_driver(worker_type)`` — returns the WorkerDriver for the given type.
"""

from __future__ import annotations

import os
import shlex
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from flow_sdk.builtin.compute_node import ComputeNode
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.events import AgenticProcessEventName
    from flow_sdk.fs_records.agent_status import WorkerStatus
    from flow_sdk.responses.response import ApiResponse


# ─────────────────────────────────────────────────────────────────────────────
# WorkerExecutionInfo — small Pydantic record returned by Shell.launch()
# ─────────────────────────────────────────────────────────────────────────────


class WorkerExecutionInfo(BaseModel):
    """Info about a worker process launched via ``Shell.launch()``."""

    pid: int | None          # OS PID of the worker (None if not detected within timeout)
    name: str                # executable name, e.g. "claude"
    cmd: str | None          # first 200 chars of the shell command string
    started_at: str          # ISO timestamp


# ─────────────────────────────────────────────────────────────────────────────
# AgenticContext — execution context handed to workers
# ─────────────────────────────────────────────────────────────────────────────


class AgenticContext(BaseModel):
    """Execution context for a single worker turn."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        arbitrary_types_allowed=True,
    )

    compute_node: ComputeNode | None = None
    compute_node_id: str | None = None

    instructions: str | None = None
    workdir: str | None = None
    env_vars: dict[str, str] = Field(default_factory=dict)

    model: str | None = None
    max_thinking_tokens: int = 1024
    permission_mode: str = "bypassPermissions"

    amd_support: bool = False
    stack_frame: dict[str, Any] | None = None
    tracing: bool = False

    resume_session_id: str | None = None
    fork_session: bool = False

    # Pre-assigned session id — when set, the worker passes ``--session-id``
    # to the CLI for fresh runs (no ``--resume``). Lets callers reserve a
    # session id before the worker starts so transcript discovery doesn't
    # have to wait for the first ``system:init`` event.
    session_id: str | None = None

    # Reasoning-effort override for the parent CLI ("low"/"medium"/"high"/...).
    # Only honoured by workers that map to a CLI flag for it (currently
    # Claude's ``--effort``); ignored elsewhere.
    effort: str | None = None

    # Extra directories to mount via the worker's add-dir mechanism (currently
    # Claude's ``--add-dir``). Drivers populate this from process configuration
    # so print-mode workers see the same skill/agent surface as PTY-mode runs.
    add_dirs: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def set_defaults(self) -> "AgenticContext":
        if self.workdir is None:
            self.workdir = str(Path.cwd())
        if self.compute_node is not None and self.compute_node_id is None:
            self.compute_node_id = self.compute_node.id
        return self

    def to_persistable_dict(self) -> dict[str, Any]:
        data = self.model_dump(exclude={"compute_node", "stack_frame"})
        if self.compute_node is not None:
            data["compute_node_id"] = self.compute_node.id
        return data


# ─────────────────────────────────────────────────────────────────────────────
# AgenticWorker — ABC for the per-turn subprocess wrapper
# ─────────────────────────────────────────────────────────────────────────────


class AgenticWorker(ABC):
    """Minimal worker interface for agentic execution.

    Workers implement ``execute(prompt, context)`` to stream FlowData chunks.
    Optional methods (``pause``, ``resume``, ``inject``, ``close_session``,
    ``get_session_id``, ``manages_history``) are no-ops by default; concrete
    workers override what makes sense for their CLI.
    """

    @abstractmethod
    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        """Execute prompt and stream FlowData responses."""
        raise NotImplementedError

    def pause(self) -> None:
        pass

    def resume(self) -> None:
        pass

    async def inject(self, message: str) -> None:
        pass

    async def close_session(self) -> None:
        pass

    def get_session_id(self) -> str | None:
        return None

    def get_history(self) -> list[FlowData] | None:
        return None

    def set_history(self, history: list[FlowData]) -> None:
        pass

    def manages_history(self) -> bool:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# WorkerCLIOptions — cross-platform shell command builder
# ─────────────────────────────────────────────────────────────────────────────


class WorkerCLIOptions:
    """Base class for worker CLI commands.

    Converts a structured configuration into a shell command string suitable
    for PTY injection. Subclasses override ``_build_worker_args()`` to provide
    the actual executable and its flags.
    """

    def __init__(
        self,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> None:
        self.workdir: str | None = workdir
        self.env_vars: dict[str, str] = dict(env_vars or {})

    def add_env(self, key: str, value: str) -> None:
        self.env_vars[key] = value

    def to_shell_string(self, instruction: str | None = None) -> str:
        args = self._build_worker_args()
        if sys.platform == "win32":
            return self._build_win32(args, instruction)
        return self._build_posix(args, instruction)

    def to_json(self) -> dict[str, Any]:
        return {
            "workdir": self.workdir,
            "env_vars": self.env_vars,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "WorkerCLIOptions":
        return cls(
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, WorkerCLIOptions):
            return NotImplemented
        return self.to_json() == other.to_json()

    def _build_worker_args(self) -> list[str]:
        raise NotImplementedError

    def _build_posix(self, args: list[str], instruction: str | None) -> str:
        workdir = self.workdir or "."
        cd_part = f"cd {shlex.quote(workdir)}"
        env_part = " ".join(
            f"{k}={shlex.quote(v)}" for k, v in self.env_vars.items()
        )
        cmd = f"{cd_part} && {env_part} {' '.join(args)}" if env_part else f"{cd_part} && {' '.join(args)}"
        if instruction:
            escaped = (
                instruction
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\r", "")
                .replace("\n", "\\n")
            )
            cmd += f" -- $'{escaped}'"
        return cmd

    def _build_win32(self, args: list[str], instruction: str | None) -> str:
        import base64 as _b64

        def _ps_quote(s: str) -> str:
            return "'" + s.replace("'", "''") + "'"

        workdir = self.workdir or "."
        cd_part = f"cd {_ps_quote(workdir)}"
        env_commands = [f"$env:{k} = {_ps_quote(v)}" for k, v in self.env_vars.items()]
        env_part = "; ".join(env_commands) + "; " if env_commands else ""
        cmd_part = " ".join(args)
        if instruction:
            prompt_b64 = _b64.b64encode(instruction.encode("utf-8")).decode("ascii")
            decode_cmd = (
                f"[System.Text.Encoding]::UTF8.GetString"
                f"([Convert]::FromBase64String('{prompt_b64}'))"
            )
            cmd_part += f" ({decode_cmd})"
        return f"{cd_part}; {env_part}{cmd_part}"


# ─────────────────────────────────────────────────────────────────────────────
# factory — string-keyed dispatch to vendor CLI option classes
# ─────────────────────────────────────────────────────────────────────────────


def factory(cli_json: dict, worker_type: str) -> WorkerCLIOptions:
    """Return the correct WorkerCLIOptions subclass for the given worker_type.

    String keys (``"claude"``, ``"codex"``) are the wire form used by
    serialised ``AgenticProcess.cli_config`` — kept stable across enum
    renames. Local imports break the cli_drivers/<vendor> → base cycle.
    """
    if worker_type == "claude":
        from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
        return ClaudeCliOptions.from_json(cli_json)
    if worker_type == "codex":
        from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexCliOptions
        return CodexCliOptions.from_json(cli_json)
    raise ValueError(f"Unknown worker_type: {worker_type!r}")


# ─────────────────────────────────────────────────────────────────────────────
# WorkerDriver — Protocol the vendor sub-packages implement
# ─────────────────────────────────────────────────────────────────────────────
#
# AgenticProcess holds one of these (resolved via ``get_driver(worker_type)``)
# and never branches on worker_type itself. New vendors plug in by implementing
# the Protocol — no edits to ``agentic_process.py`` should be necessary.


class WorkerDriver(Protocol):
    """Vendor-specific glue. ``AgenticProcess`` calls these methods instead of
    ``if worker_type == ...`` ladders.

    Methods are split into three groups:
    - **CLI shape**: how the worker is launched (cmd_line, options).
    - **Per-turn execution**: spawn + drain transcript for one user prompt.
    - **Discovery**: where the transcript lives + how to read its tail.
    """

    name: str  # wire id: "claude" | "codex"
    preassign_interactive_session_id: bool

    # ── CLI shape ────────────────────────────────────────────────────────────

    def cli_options(self, process: "AgenticProcess") -> WorkerCLIOptions:
        """Return a fully-configured options object (model, session_id,
        workdir, add_dirs, agents/skills) for this process — used by
        ``AgenticProcess.cmd_line`` and the spawn paths."""
        ...

    # ── Per-turn execution ───────────────────────────────────────────────────

    async def run_print_turn(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        """Headless one-shot turn: spawn the worker, capture session_id onto
        ``process``, manage lifecycle. Returns an ApiResponse the caller can
        send back over HTTP."""
        ...

    async def report_event(
        self,
        process: "AgenticProcess",
        name: "AgenticProcessEventName",
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Handle a client-reported process event.

        Drivers decide which events matter. Unknown or unsupported events
        should return a debug payload rather than raising.
        """
        ...

    # ── Transcript discovery ─────────────────────────────────────────────────

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        """Where this driver's worker writes its JSONL/event log for the
        given process — or None if no session id is yet assigned."""
        ...

    def tail_status(self, transcript_path: Path) -> "WorkerStatus":
        """Map the tail of the transcript to a WorkerStatus."""
        ...

    # ── History materialisation ──────────────────────────────────────────────

    def load_history(self, process: "AgenticProcess") -> list[FlowData]:
        """Replay transcript as FlowData for the ``/get-history`` action."""
        ...

    # ── Prompt composition ───────────────────────────────────────────────────

    def compose_prompt(
        self,
        instruction: str,
        agents_json: dict | None,
    ) -> str:
        """Inline embedded-agent definitions (or pass through unchanged) so
        the parent worker reliably honours their side-effect instructions."""
        ...

    # ── External-session probe (used by test invariant) ──────────────────────

    def external_session_dirs(self) -> set[str]:
        """Snapshot of vendor-managed session storage names (e.g.
        ``~/.claude/projects/`` entry names for Claude). Used by tests to
        assert no session leakage when running in ephemeral mode."""
        ...


# Module-level cache so AgenticProcess.driver doesn't rebuild every call.
_DRIVER_CACHE: dict[str, WorkerDriver] = {}


def get_driver(worker_type: Any) -> WorkerDriver:
    """Resolve a ``WorkerDriver`` from a worker_type value.

    Accepts the ``WorkerType`` enum, its string value, or ``None``. ``None``
    means "use the project default" — controlled by the
    ``FLOWPAD_DEFAULT_WORKER`` env var (``claude`` if unset). The env hook
    lets the UI vitest run the same suite under both backends without any
    test-side change.

    The returned driver is cached per name; constructing one is cheap but
    caching avoids re-importing the vendor module on every property access.
    """
    if worker_type is None:
        worker_type = os.environ.get("FLOWPAD_DEFAULT_WORKER") or "claude"

    # Map enum values → driver registry keys.
    if hasattr(worker_type, "value"):
        worker_type = worker_type.value
    key = str(worker_type).lower()
    aliases = {
        "claude_code": "claude",
        "claude_code_cli": "claude",
        "claude": "claude",
        "codex": "codex",
    }
    name = aliases.get(key, key)

    cached = _DRIVER_CACHE.get(name)
    if cached is not None:
        return cached

    if name == "claude":
        from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
        driver: WorkerDriver = ClaudeDriver()
    elif name == "codex":
        from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
        driver = CodexDriver()
    else:
        raise ValueError(f"No WorkerDriver registered for worker_type={worker_type!r}")

    _DRIVER_CACHE[name] = driver
    return driver


__all__ = [
    "AgenticContext",
    "AgenticWorker",
    "WorkerCLIOptions",
    "WorkerExecutionInfo",
    "WorkerDriver",
    "factory",
    "get_driver",
]
