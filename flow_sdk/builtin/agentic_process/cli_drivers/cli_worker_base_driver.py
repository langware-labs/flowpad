"""Cross-vendor primitives for the CLI driver layer.

Single base module that holds everything ``AgenticProcess`` needs to talk to a
worker without knowing which one — and the ``WorkerDriver`` Protocol that each
vendor (Claude, Codex, …) implements in its sub-package.

Modules layout::

    flow_sdk/builtin/agentic_process/cli_drivers/
        cli_worker_base_driver.py  ← this file
        claude/                    ← ClaudeDriver + Claude CLI specifics
        codex/                     ← CodexDriver + Codex CLI specifics
        copilot/                   ← CopilotDriver + GitHub Copilot specifics

Bringing all the cross-vendor types into one file (instead of a ``base/``
sub-package) keeps the import graph flat: vendor drivers depend on this
module only, and ``AgenticProcess`` imports the driver factory plus the
``WorkerDriver`` Protocol from here.

Public exports:
- ``AgenticContext`` — per-turn execution context passed to workers.
- ``AgenticWorker`` — minimal ABC for execute()/inject()/close_session().
- ``AgentOptions`` — base CLI command builder (cd + env + worker_args).
- ``WorkerExecutionInfo`` — Pydantic model returned by Shell.launch().
- ``WorkerDriver`` — Protocol vendors implement; ``AgenticProcess`` calls it.
- ``factory(cli_json, worker_type)`` — legacy CLI-options factory.
- ``get_driver(worker_type)`` — returns the WorkerDriver for the given type.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import signal
import sys
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Protocol, Sequence

import psutil
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from flow_sdk._compat import StrEnum
from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    DeviceLoginSpec,
    WorkerAuthResult,
    probe_worker_auth,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_serialization import (
    quote_powershell_literal,
    quote_shell_arg,
)
from flow_sdk.builtin.compute_node import ComputeNode
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
from flow_sdk.transcript_analyzer import TranscriptDescriptor

if TYPE_CHECKING:
    from flow_sdk.builtin.agent_hook import HookEventType
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
    from flow_sdk.builtin.agentic_process.events import AgenticProcessEventName
    from flow_sdk.builtin.worker_status import WorkerStatus
    from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
    from flow_sdk.responses.response import ApiResponse


# Per-line StreamReader limit shared by every JSONL CLI transport. Asyncio's
# default 64 KiB limit is too small for events that wrap large tool results in
# one physical line (browser snapshots, fetched HTML, large diffs, ...). 4 MiB
# gives bounded headroom and matches the limit historically used by Claude.
STREAM_JSON_LINE_LIMIT_BYTES = 4 * 1024 * 1024
CLI_RUN_ID_ENV_VAR = "FLOWPAD_CLI_RUN_ID"

logger = logging.getLogger(__name__)

_PROCESS_GONE = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)
_PROCESS_LOOKUP_ERRORS = (*_PROCESS_GONE, OSError)
_FORCE_KILL_WAIT_SECONDS = 2.0


def stamp_cli_run_id(env: dict[str, str]) -> str:
    """Tag one CLI launch so descendants remain identifiable after reparenting."""
    run_id = str(uuid.uuid4())
    env[CLI_RUN_ID_ENV_VAR] = run_id
    return run_id


def _process_descendants(pid: int) -> list[psutil.Process]:
    """Snapshot descendants before their CLI wrapper can be reaped."""
    try:
        return psutil.Process(pid).children(recursive=True)
    except _PROCESS_GONE:
        return []


def _processes_for_cli_run(run_id: str | None, *, exclude: set[int]) -> list[psutil.Process]:
    """Find a launch's descendants even after their direct wrapper has exited."""
    if not run_id:
        return []
    matches: list[psutil.Process] = []
    for process in psutil.process_iter(["pid"]):
        if process.info["pid"] in exclude:
            continue
        try:
            if process.environ().get(CLI_RUN_ID_ENV_VAR) == run_id:
                matches.append(process)
        except _PROCESS_LOOKUP_ERRORS:
            pass
    return matches


async def _processes_for_cli_run_async(
    run_id: str | None,
    *,
    exclude: set[int],
) -> list[psutil.Process]:
    # environ() can block on OS process inspection, especially on Windows.
    return await asyncio.to_thread(_processes_for_cli_run, run_id, exclude=exclude)


def _merge_processes(*groups: list[psutil.Process]) -> list[psutil.Process]:
    merged: list[psutil.Process] = []
    seen: set[psutil.Process] = set()
    for group in groups:
        for process in group:
            if process in seen:
                continue
            seen.add(process)
            merged.append(process)
    return merged


def _signal_processes(processes: list[psutil.Process], *, force: bool) -> None:
    # psutil returns descendants parent-first. Signal leaves first so an
    # intermediate wrapper cannot strand its tool/native child on exit.
    for process in reversed(processes):
        try:
            process.kill() if force else process.terminate()
        except _PROCESS_GONE:
            pass


async def _wait_for_asyncio_process_tree(
    process: asyncio.subprocess.Process,
    descendants: list[psutil.Process],
    deadline: float,
) -> list[psutil.Process]:
    """Wait under one deadline; asyncio owns the root, psutil the descendants."""
    if process.returncode is None:
        remaining = max(0.0, deadline - asyncio.get_running_loop().time())
        try:
            await asyncio.wait_for(process.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            pass

    remaining = max(0.0, deadline - asyncio.get_running_loop().time())
    if descendants:
        _, descendants = await asyncio.to_thread(
            psutil.wait_procs,
            descendants,
            remaining,
        )
    return descendants


async def _refresh_descendants(
    process: asyncio.subprocess.Process,
    descendants: list[psutil.Process],
    run_id: str | None,
    *,
    sweep_run_marker: bool,
) -> list[psutil.Process]:
    refreshed = _process_descendants(process.pid) if process.returncode is None else []
    for descendant in descendants:
        try:
            refreshed.extend(descendant.children(recursive=True))
        except _PROCESS_GONE:
            pass
    if sweep_run_marker or process.returncode not in (None, 0):
        refreshed.extend(
            await _processes_for_cli_run_async(
                run_id,
                exclude={os.getpid(), process.pid},
            )
        )
    return _merge_processes(descendants, refreshed)


async def _kill_asyncio_process_tree(
    process: asyncio.subprocess.Process,
    descendants: list[psutil.Process],
    run_id: str | None,
    *,
    sweep_run_marker: bool,
) -> None:
    descendants = await _refresh_descendants(
        process,
        descendants,
        run_id,
        sweep_run_marker=sweep_run_marker,
    )
    if process.returncode is None or descendants:
        logger.warning(
            "CLI process tree did not exit in grace; force-killing (pid=%s)",
            process.pid,
        )
        _signal_processes(descendants, force=True)
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass

    if process.returncode is None:
        try:
            await asyncio.wait_for(process.wait(), timeout=_FORCE_KILL_WAIT_SECONDS)
        except asyncio.TimeoutError:
            logger.error("CLI wrapper did not exit after force-kill (pid=%s)", process.pid)

    survivors: list[psutil.Process] = []
    if descendants:
        _, survivors = await asyncio.to_thread(
            psutil.wait_procs,
            descendants,
            _FORCE_KILL_WAIT_SECONDS,
        )

    # Close the fork-after-snapshot race for abnormal exits. Clean turns do not
    # sweep the marker: background servers intentionally launched by an agent
    # must survive a successful CLI wrapper exit.
    if sweep_run_marker or process.returncode not in (None, 0):
        late_descendants = await _processes_for_cli_run_async(
            run_id,
            exclude={os.getpid(), process.pid},
        )
        late_targets = _merge_processes(survivors, late_descendants)
        if late_targets:
            _signal_processes(late_targets, force=True)
            _, late_survivors = await asyncio.to_thread(
                psutil.wait_procs,
                late_targets,
                _FORCE_KILL_WAIT_SECONDS,
            )
            survivors = late_survivors

    if survivors:
        logger.error(
            "%d CLI descendant process(es) survived force-kill (pid=%s)",
            len(survivors),
            process.pid,
        )


async def terminate_asyncio_process_tree(
    process: asyncio.subprocess.Process,
    grace_seconds: float,
    *,
    force: bool = False,
    run_id: str | None = None,
) -> None:
    """Terminate an asyncio child and all descendants without racing waitpid.

    npm-installed CLIs are wrappers around native children. Killing only the
    wrapper can orphan the real worker, so descendants are captured before any
    signal. Asyncio exclusively waits on the direct child; psutil waits only on
    descendants. ``force=True`` skips SIGTERM because a passive grace already
    expired at the caller.
    """
    # Never resolve a completed asyncio child's bare PID through psutil: the OS
    # may already have reused it. The per-launch marker is safe to sweep because
    # it is unique and inherited by native/tool descendants.
    descendants = _process_descendants(process.pid) if process.returncode is None else []
    descendants = _merge_processes(
        descendants,
        await _processes_for_cli_run_async(
            run_id,
            exclude={os.getpid(), process.pid},
        ),
    )
    if process.returncode is not None and not descendants:
        return
    if not force:
        _signal_processes(descendants, force=False)
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        deadline = asyncio.get_running_loop().time() + max(grace_seconds, 0.0)
        descendants = await _wait_for_asyncio_process_tree(process, descendants, deadline)

    # Always do the final marker sweep. A wrapper may handle SIGTERM, exit 0,
    # and reparent a native child that was not in the original tree snapshot.
    await _kill_asyncio_process_tree(
        process,
        descendants,
        run_id,
        sweep_run_marker=True,
    )


async def interrupt_then_terminate_asyncio_process_tree(
    process: asyncio.subprocess.Process,
    grace_seconds: float,
    *,
    run_id: str | None = None,
) -> bool:
    """SIGINT the root first, then run the standard tree teardown for survivors.

    SIGINT lets a CLI wind its turn down itself — record its own abort in its
    session store and reap its tool children — which keeps the vendor
    transcript coherent for resume. Descendants are snapshotted BEFORE the
    signal so a child reparented by the root's exit is still reachable even
    without a run-id marker. Anything alive after the grace (root or
    descendants) goes through the existing force-kill path — the same
    ``grace_seconds`` budget the plain teardown uses.

    Returns ``True`` when the root wound down on its own (already exited, or
    exited within the SIGINT grace before any force-kill was needed) — i.e. the
    CLI had the chance to record its own abort. ``False`` means the root ignored
    SIGINT and had to be force-killed, so it recorded nothing.
    """
    # Already exited before we signalled → it wound down on its own.
    wound_down_cleanly = process.returncode is not None
    descendants = _process_descendants(process.pid) if process.returncode is None else []
    if process.returncode is None:
        try:
            process.send_signal(signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=max(grace_seconds, 0.0))
            wound_down_cleanly = True
        except asyncio.TimeoutError:
            logger.warning(
                "CLI root ignored SIGINT within grace; escalating to tree kill (pid=%s)",
                process.pid,
            )
    await _kill_asyncio_process_tree(
        process,
        descendants,
        run_id,
        sweep_run_marker=True,
    )
    return wound_down_cleanly


async def wait_for_asyncio_process_or_kill_tree(
    process: asyncio.subprocess.Process,
    grace_seconds: float,
    *,
    run_id: str | None = None,
) -> None:
    """Await a wrapper; clean exits preserve background tools, failures reap them."""
    if process.returncode == 0:
        return
    descendants = _process_descendants(process.pid) if process.returncode is None else []
    deadline = asyncio.get_running_loop().time() + max(grace_seconds, 0.0)
    if process.returncode is None:
        remaining = max(0.0, deadline - asyncio.get_running_loop().time())
        try:
            await asyncio.wait_for(process.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            pass

    if process.returncode == 0:
        return
    if process.returncode is not None:
        descendants = _merge_processes(
            descendants,
            await _processes_for_cli_run_async(
                run_id,
                exclude={os.getpid(), process.pid},
            ),
        )
    if process.returncode is None or descendants:
        await _kill_asyncio_process_tree(
            process,
            descendants,
            run_id,
            sweep_run_marker=False,
        )


class WorkerSpawnError(RuntimeError):
    """A worker turn cannot spawn its CLI subprocess.

    Raised by the stream workers' ``_build_spawn`` when the vendor CLI is not
    installed (no harness capability discovered) or its executable cannot be
    resolved on the spawn PATH. Turn runners route it into the standard
    failure path — ``status=FAILED`` + the ``start_failure`` latch — via
    :func:`latch_spawn_failure` instead of leaving the process spinning.
    """

    def __init__(self, worker_type: str, message: str) -> None:
        self.worker_type = worker_type
        super().__init__(message)


# ─────────────────────────────────────────────────────────────────────────────
# WorkerExecutionInfo — small Pydantic record returned by Shell.launch()
# ─────────────────────────────────────────────────────────────────────────────


class WorkerExecutionInfo(BaseModel):
    """Info about a worker process launched via ``Shell.launch()``."""

    pid: int | None  # OS PID of the worker (None if not detected within timeout)
    name: str  # executable name, e.g. "claude"
    cmd: str | None  # first 200 chars of the shell command string
    started_at: str  # ISO timestamp


class AgenticProcessContextKey(StrEnum):
    """Internal ``AgenticProcess.context_data`` keys shared by drivers."""

    WORKER_STARTED_AT = "_worker_started_at"


def apply_worker_env(env: dict[str, str], process: "AgenticProcess") -> dict[str, str]:
    """Stamp the standard worker environment — the ONE chokepoint every spawn
    path (PTY, driver headless, inline print-mode turn) calls.

    * ``FLOWPAD_EXECUTION_SCOPE`` — process identity, so worker `flow`
      commands (show/record/context/…) resolve their calling process.
    * ``FLOWPAD_PYTHON`` — the interpreter that can ``import flow_sdk``, named
      outright so a worker never has to resolve one. Skills that run Flowpad's
      own Python (e.g. flow-diagnose's ``report.py``) cannot use ``uv run``:
      uv ignores PATH and resolves an environment by walking up from the
      working directory, which for a worker is a user workspace with no
      Flowpad in it. Nor can they use bare ``python``/``python3`` — the
      capability bin folder is prepended AFTER our PATH pin at spawn time
      (see :meth:`AgenticProcess.start_pty` and
      :func:`build_worker_spawn_env`), so the name can resolve to an unrelated
      interpreter, and a Windows venv ships no ``python3.exe`` at all. An
      absolute path is the only form immune to both.
    * ``PATH`` — pinned to this backend's `flow` CLI (version-skew guard,
      see :func:`flow_cli_env_path`).
    * ``CLAUDE_CONFIG_DIR`` — for explicitly configured Claude roots, pinned
      to the same canonical root Flowpad uses for transcript discovery. The
      native default stays unset because Claude keeps ``~/.claude.json`` beside
      its default ``~/.claude/`` transcript directory.

    ``setdefault`` semantics for the scope (an explicit override wins);
    mutates and returns ``env``.

    The interpreter is assigned rather than ``setdefault``-ed on purpose: it is
    derived machine state, not launch config, and its value moves whenever the
    install does (upgrade, reinstall). A stale one persisted in a process's
    ``cli_config["env_vars"]`` would silently point workers at an interpreter
    that no longer exists — the same failure this var was added to remove. Same
    reasoning as ``FLOW_INSTANCE`` in ``ClaudeCLIWorker.build_env``.
    """
    import json as _json  # noqa: PLC0415

    env.setdefault(
        "FLOWPAD_EXECUTION_SCOPE",
        _json.dumps([{"type": process.get_type(), "id": process.id}]),
    )
    env["FLOWPAD_PYTHON"] = sys.executable
    if process.driver.name == "claude":
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
        from flow_sdk.instance_settings.base_settings import (  # noqa: PLC0415
            ENV_CLAUDE_CONFIG_DIR,
            ENV_FLOWPAD_CLAUDE_HOME,
            _canonical_lexical_path,
        )

        claude_home = get_instance_settings().claude_home
        worker_override = env.get(ENV_CLAUDE_CONFIG_DIR)
        if worker_override is not None:
            worker_home = _canonical_lexical_path(worker_override)
            if worker_home != claude_home:
                raise ValueError(
                    f"Claude worker {ENV_CLAUDE_CONFIG_DIR} must match Flowpad's configured Claude home "
                    f"(got {worker_home} and {claude_home})"
                )
        # Only pin CLAUDE_CONFIG_DIR for a genuinely NON-default Claude root. When
        # the root resolves to the native ~/.claude — even via an explicit
        # FLOWPAD_CLAUDE_HOME/CLAUDE_CONFIG_DIR that points there — it must stay
        # UNSET. Claude keeps its account/config in ``~/.claude.json`` *beside*
        # the default ``~/.claude/`` dir; setting CLAUDE_CONFIG_DIR=~/.claude makes
        # Claude read ``~/.claude/.claude.json`` (a different, usually stale file),
        # lose the OAuth account, and fall back to the "Select login method"
        # picker — which silently breaks every real-Claude worker turn.
        native_home = _canonical_lexical_path(Path.home() / ".claude")
        root_is_explicit = bool(
            os.environ.get(ENV_FLOWPAD_CLAUDE_HOME)
            or os.environ.get(ENV_CLAUDE_CONFIG_DIR)
            or worker_override is not None
        )
        if root_is_explicit and claude_home != native_home:
            env[ENV_CLAUDE_CONFIG_DIR] = str(claude_home)
        else:
            env.pop(ENV_CLAUDE_CONFIG_DIR, None)
    pinned = flow_cli_env_path(env.get("PATH"))
    if pinned:
        env["PATH"] = pinned
    return env


async def apply_worker_secret_env(env: dict[str, str], process: "AgenticProcess") -> dict[str, str]:
    """Resolve project SecretOrigin pointers into this transient worker env.

    This must only be called on spawn-time env dicts. It must not mutate
    AgentOptions.env_vars because those are persisted and rendered.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.secret_origin_resolver import (  # noqa: PLC0415
        attached_env_vars_for,
        resolve_project_secrets,
    )

    project = None
    project_id = getattr(process, "project_id", None)
    if project_id:
        project = await Project.get_by_id(project_id)
    if project is None:
        try:
            project = await Project.get_ancestor(process.typeid)
        except Exception:
            project = None
    if project is None:
        return env

    # Node attachment gates the worker too, not only the connector's commands.
    # None = nothing curated on this node, i.e. every declared secret, so an
    # untouched setup behaves exactly as it did before attachment existed.
    only = await attached_env_vars_for(project)
    resolved = await resolve_project_secrets(project, only=only, process=process)
    for env_var, value in resolved.items():
        # setdefault, not assignment: an explicitly-set env var wins.
        env.setdefault(env_var, value.get_secret_value())

    # API-key auth (harness in "api" mode): inject the provider env block + key.
    # Lazy import avoids a cycle with the driver registry. This wins over device
    # creds by design; the key lands only in this transient spawn env.
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    api_auth = await resolve_worker_api_auth(process)
    if api_auth is not None:
        for key, value in api_auth.env.items():
            env[key] = value
    return env


def flow_cli_env_path(existing_path: str | None = None) -> str | None:
    """PATH value that pins the worker's ``flow`` CLI to THIS backend's install.

    Workers shell out to ``flow`` (navigate/show/record/…). Resolved from the
    inherited PATH, that is typically the globally installed release
    (``~/.local/bin/flow``), which may predate CLI verbs this backend serves —
    version skew that silently breaks worker↔backend contracts. The backend's
    own venv bin dir (``sys.executable``'s directory) carries the matching
    ``flow``; prepend it so the worker always runs the same CLI version as the
    backend that spawned it. Returns None when no ``flow`` sits next to the
    interpreter (e.g. system python) — callers skip the override then.
    """
    bin_dir = Path(sys.executable).parent
    exe = "flow.exe" if sys.platform == "win32" else "flow"
    if not (bin_dir / exe).exists():
        return None
    base = existing_path if existing_path is not None else os.environ.get("PATH", "")
    if str(bin_dir) == (base.split(os.pathsep, 1)[0] if base else ""):
        return base  # already first — idempotent across restarts
    return f"{bin_dir}{os.pathsep}{base}" if base else str(bin_dir)


# ─────────────────────────────────────────────────────────────────────────────
# ProcessHookRuntime / AgenticContext — launch context handed to workers
# ─────────────────────────────────────────────────────────────────────────────


class ProcessHookRuntime(BaseModel):
    """Immutable, launch-only artifacts prepared from persisted hook intent."""

    model_config = ConfigDict(frozen=True)

    plugin_dirs: tuple[str, ...] = ()
    config_overrides: tuple[tuple[str, Any], ...] = ()
    bypass_hook_trust: bool = False


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
    # Prepared process-local plugins. Runtime-only: never persisted or hashed.
    plugin_dirs: list[str] = Field(default_factory=list)
    system_prompt_file: str | None = None
    developer_instructions: str | None = None
    custom_instruction_dirs: list[str] = Field(default_factory=list)

    # Extra `-c key=val` config overrides for API-key auth (currently codex's
    # OpenRouter provider block). Derived per-spawn from the harness Capability,
    # so — like fork/resume — excluded from the restart hash. Same name as
    # CodexAgentOptions.extra_config_overrides so apply_api_model_to_options can
    # stamp either object.
    extra_config_overrides: list[tuple[str, Any]] = Field(default_factory=list)
    # One-launch acknowledgement for CLIs that gate dynamically supplied hooks
    # behind an explicit trust flag (currently Codex). Never persisted.
    bypass_hook_trust: bool = False

    @model_validator(mode="after")
    def set_defaults(self) -> "AgenticContext":
        if self.workdir is None:
            self.workdir = str(Path.cwd())
        if self.compute_node is not None and self.compute_node_id is None:
            self.compute_node_id = self.compute_node.id
        return self

    def to_persistable_dict(self) -> dict[str, Any]:
        data = self.model_dump(
            exclude={
                "compute_node",
                "stack_frame",
                "plugin_dirs",
                "extra_config_overrides",
                "bypass_hook_trust",
            }
        )
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

    @property
    def cancelled_gracefully(self) -> bool:
        """True when ``close_session()`` stopped the turn via the vendor's own
        cancellation channel (so the vendor recorded its own abort in its
        session store). The cancel choke point skips the flowpad abort sidecar
        marker in that case — a marker would replay as a duplicate
        turn-terminated STATUS. Kill-based cancels leave this False."""
        return False


# ─────────────────────────────────────────────────────────────────────────────
# AgentOptions — cross-platform shell command builder
# ─────────────────────────────────────────────────────────────────────────────


class AgentOptions:
    """Base class for worker CLI commands.

    Converts a structured configuration into a shell command string suitable
    for PTY injection. Subclasses declare ``EXECUTABLE`` and override
    ``_emit_flags()`` to provide their raw CLI arguments.

    Model **tier** resolution lives here, once: ``self.model`` keeps the raw
    persisted intent (``sm``/``md``/``lg`` or a concrete model), while
    ``self.resolved_model`` applies this class's ``MODEL_TIERS`` map for the
    worker command. A subclass declares its own ``MODEL_TIERS``. A concrete
    model name is always passed through.
    """

    # Per-worker tier→model map; empty in the base (pass-through). See
    # ``flow_sdk/builtin/agentic_process/model_tiers.py``.
    MODEL_TIERS: dict[str, str] = {}

    # ── Vendor spec (declarative; overridden per worker) ─────────────────────
    # The bare executable name (claude/codex/copilot). ``_resolve_binary`` may
    # refine it (e.g. claude resolves via ``shutil.which``).
    EXECUTABLE: str = ""
    # Where the per-turn prompt is delivered: 'argv' (claude, ``-- <text>``) or
    # 'stdin' (codex/copilot pipe it). Drives both ``cli_cmd`` and ``stdin_text``.
    PROMPT_CHANNEL: str = "argv"
    # How a system-prompt addition reaches the worker: a CLI flag name
    # (claude ``--append-system-prompt``) or None ⇒ prepend into the prompt body.
    SYSTEM_PROMPT_FLAG: str | None = None
    SYSTEM_PROMPT_FILE_FLAG: str | None = None

    def __init__(
        self,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> None:
        self.workdir: str | None = workdir
        self.env_vars: dict[str, str] = dict(env_vars or {})
        # Forking is a claude-only concept, but the attribute lives on the base
        # (default None) so callers can read ``cmd.fork_session_id`` without a
        # ``hasattr`` guard. Only claude's ``to_json`` serializes it, so the wire
        # shape (and restart hash) of codex/copilot is unaffected.
        self.fork_session_id: str | None = None
        # Launch-time system-prompt append (``resolve_system_instructions()``),
        # set by the launcher; derived state — not a ctor param, not serialized,
        # so restart hashing is unaffected.
        self.system_prompt_append: str | None = None
        self.system_prompt_file: str | None = None

    @property
    def model(self) -> str | None:
        return getattr(self, "_model", None)

    @model.setter
    def model(self, value: str | None) -> None:
        self._model = value

    @property
    def resolved_model(self) -> str | None:
        # Resolve only for command emission. ``model`` itself stays the raw
        # AP/cli_config value so the UI can reflect and save portable tiers.
        from flow_sdk.builtin.agentic_process.model_tiers import resolve_model_tier

        return resolve_model_tier(self.MODEL_TIERS, self.model)

    def add_env(self, key: str, value: str) -> None:
        self.env_vars[key] = value

    def _system_prompt(self, override: str | None) -> str | None:
        """Explicit per-call value wins; else the launch-derived field."""
        return override if override is not None else self.system_prompt_append

    # ── Unified arg construction (argv is canonical; shell is derived) ───────

    def _resolve_binary(self) -> list[str]:
        """argv prefix — ``[EXECUTABLE]`` by default. A list so a vendor can wrap
        the binary (e.g. claude on win32 → ``[comspec, "/c", path]``); claude also
        resolves the real path via ``shutil.which``."""
        return [self.EXECUTABLE]

    def _emit_flags(self) -> list[str]:
        """Vendor hook: every argv token AFTER the binary, EXCEPT the per-turn
        instruction (placed by ``cli_cmd`` per ``PROMPT_CHANNEL``) and the
        system-prompt addition (placed per ``SYSTEM_PROMPT_FLAG``). This is the
        ONLY arg builder a vendor writes — the shell string is derived from it."""
        raise NotImplementedError

    def cli_cmd(self, instruction: str | None = None, system_prompt_append: str | None = None) -> list[str]:
        """Canonical argv. The single source of truth; the shell string and the
        spawn tuple both derive from this."""
        argv: list[str] = [*self._resolve_binary(), *self._emit_flags()]
        spa = self._system_prompt(system_prompt_append)
        if self.system_prompt_file and self.SYSTEM_PROMPT_FILE_FLAG:
            argv.extend([self.SYSTEM_PROMPT_FILE_FLAG, self.system_prompt_file])
        if spa and self.SYSTEM_PROMPT_FLAG:
            argv.extend([self.SYSTEM_PROMPT_FLAG, spa])
        if self.PROMPT_CHANNEL == "argv" and instruction:
            argv.extend(["--", instruction])
        return argv

    def stdin_text(self, instruction: str | None = None, system_prompt_append: str | None = None) -> str | None:
        """The text to pipe to the worker's stdin, or None for argv-channel
        vendors. For stdin vendors with no system-prompt flag, the addition is
        prepended into the prompt body (their only sink)."""
        if self.PROMPT_CHANNEL != "stdin":
            return None
        body = instruction or ""
        spa = self._system_prompt(system_prompt_append)
        if spa and not self.SYSTEM_PROMPT_FLAG:
            body = f"{spa}\n\n{body}".strip() if body else spa
        return body

    def to_spawn(
        self, instruction: str | None = None, system_prompt_append: str | None = None
    ) -> tuple[list[str], dict[str, str], str | None]:
        """The one IO contract a worker needs: (argv, env, stdin|None)."""
        return (
            self.cli_cmd(instruction=instruction, system_prompt_append=system_prompt_append),
            dict(self.env_vars),
            self.stdin_text(instruction, system_prompt_append),
        )

    def to_spawn_args(self, instruction: str | None = None) -> tuple[list[str], dict[str, str]]:
        """Back-compat (argv, env) accessor — the prompt rides whichever channel
        ``PROMPT_CHANNEL`` declares."""
        return self.cli_cmd(instruction=instruction), dict(self.env_vars)

    def to_shell_string(self, instruction: str | None = None) -> str:
        return self._render_shell_string(sys.platform, instruction)

    def to_json(self) -> dict[str, Any]:
        return {
            "workdir": self.workdir,
            "env_vars": self.env_vars,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "AgentOptions":
        return cls(
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, AgentOptions):
            return NotImplemented
        return self.to_json() == other.to_json()

    def _build_worker_args(self) -> list[str]:
        """Raw worker argv without the instruction or resolved binary path.

        ``Shell`` reads ``args[0]`` as the worker name. Shell quoting happens
        later in :meth:`_render_shell_string`, exactly once per argv value.
        """
        return [self.EXECUTABLE, *self._emit_flags()]

    def _render_shell_string(self, platform: str, instruction: str | None) -> str:
        """Render raw worker argv for the target shell platform."""
        args = [quote_shell_arg(arg, platform) for arg in self._build_worker_args()]
        for sk in getattr(self, "skill_names", []):
            args.append(f"# skill={quote_shell_arg(sk, platform)}")
        if platform == "win32":
            return self._build_win32(args, instruction)
        return self._build_posix(args, instruction)

    def _build_posix(self, args: list[str], instruction: str | None) -> str:
        workdir = self.workdir or "."
        cd_part = f"cd {quote_shell_arg(workdir, 'linux')}"
        env_part = " ".join(f"{k}={quote_shell_arg(v, 'linux')}" for k, v in self.env_vars.items())
        cmd = f"{cd_part} && {env_part} {' '.join(args)}" if env_part else f"{cd_part} && {' '.join(args)}"
        if instruction:
            escaped = instruction.replace("\\", "\\\\").replace("'", "\\'").replace("\r", "").replace("\n", "\\n")
            cmd += f" -- $'{escaped}'"
        return cmd

    def _build_win32(self, args: list[str], instruction: str | None) -> str:
        import base64 as _b64

        workdir = self.workdir or "."
        cd_part = f"cd {quote_powershell_literal(workdir)}"
        env_commands = [f"$env:{k} = {quote_powershell_literal(v)}" for k, v in self.env_vars.items()]
        env_part = "; ".join(env_commands) + "; " if env_commands else ""
        cmd_part = " ".join(args)
        if instruction:
            prompt_b64 = _b64.b64encode(instruction.encode("utf-8")).decode("ascii")
            decode_cmd = f"[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{prompt_b64}'))"
            cmd_part += f" ({decode_cmd})"
        return f"{cd_part}; {env_part}{cmd_part}"


def restart_payload_from_cli_options(options: AgentOptions) -> dict[str, Any]:
    """Return the worker CLI payload relevant for restart detection.

    Runtime-only env vars are injected after the process identity is known but
    are not user launch config, so they must not force a restart prompt.
    ``FLOWPAD_PYTHON`` is stripped for the same reason and one of its own: it is
    derived from this backend's ``sys.executable``, so it changes on every
    reinstall/upgrade and would light a phantom restart glow on every process.

    ``resume`` is derived from (session_id, transcript-on-disk) by the driver's
    ``cli_options`` and flips False→True as soon as the worker writes its first
    JSONL line. Hashing it would race the snapshot captured at the end of
    ``start_pty()`` against that write and light up a phantom restart glow on
    fresh processes, so it's stripped here.

    ``fork_session_id`` is the same shape of derived/transient input: it points
    at the parent session at fork time, then gets stripped from ``cli_config``
    as soon as the new session materialises on disk (see
    ``ClaudeDriver.headless_prompt``'s fork-strip and ``cli_options``'s
    ``fork_session_id = None`` on resume). Hashing it would flip
    ``restart_required`` purely as a side effect of that strip, so it's
    excluded for the same reason as ``resume``.
    """
    data = dict(options.to_json())
    env_vars = dict(data.get("env_vars") or {})
    env_vars.pop("FLOWPAD_EXECUTION_SCOPE", None)
    env_vars.pop("FLOWPAD_PYTHON", None)
    data["env_vars"] = env_vars
    data.pop("resume", None)
    data.pop("fork_session_id", None)
    return data


# ─────────────────────────────────────────────────────────────────────────────
# capability consumption — workers spawn with the discovered harness folder
# ─────────────────────────────────────────────────────────────────────────────


def worker_capability_kind(worker_type: str) -> str:
    """The capability kind whose discovered value provides this worker's CLI.

    Looked up FIRST, interpolated only as a fallback, because the worker type and
    the kind segment are not always the same token. Claude registers
    ``worker_type="claude_code"`` against kind ``harness.claude.cli``
    (registry.py), so plain interpolation produced ``harness.claude_code.cli`` --
    a kind nothing registers -- and every lookup keyed by the capability's
    worker_type came back "not installed" for a CLI that was installed and
    working. Codex and copilot escaped it only because their two names coincide.

    The fallback still carries the driver names (``claude``/``codex``/``copilot``),
    which are not in the map and for which interpolation is correct.
    """
    from flow_sdk.core.capabilities.mcp import harness_kind_for_worker_type

    return harness_kind_for_worker_type(worker_type) or f"harness.{worker_type}.cli"


def worker_bin_folder(worker_type: str) -> str | None:
    """The discovered bin FOLDER of this worker's CLI, or ``None`` ⇔ not installed.

    The harness capability's value (RecordType.FOLDER, an FSRef dict) is the
    CLI's bin directory as a standard terminal would resolve it — recorded by
    capability discovery even when the backend's own service PATH (e.g. a
    desktop launchd/named-instance environment) does not contain it.
    """
    from flow_sdk.core.capabilities.discovery import get_capability_value

    discovered = get_capability_value(worker_capability_kind(worker_type))
    if discovered is None or not isinstance(discovered.value, dict):
        return None
    folder = discovered.value.get("path")
    return str(folder) if folder else None


def worker_path_env(worker_type: str) -> dict[str, str] | None:
    """PATH override for spawning this worker, from the discovered capability.

    Prepending the discovered bin folder to the spawn PATH makes both argv[0]
    and the CLI's ``#!/usr/bin/env node`` shebang resolve regardless of how
    the backend process was launched.

    Returns ``{"PATH": "<folder>:<current>"}`` when the capability has a
    value; ``None`` ⇔ no value discovered (CLI not installed) — callers fail
    fast with a clear error instead of spawning into FileNotFoundError.
    """
    folder = worker_bin_folder(worker_type)
    if folder is None:
        return None
    return {"PATH": prepend_path_dir(folder, os.environ.get("PATH", ""))}


def prepend_path_dir(folder: str, path: str | None) -> str:
    """*path* with *folder* prepended; idempotent when it is already first."""
    base = path or ""
    if base.split(os.pathsep, 1)[0] == folder:
        return base
    return f"{folder}{os.pathsep}{base}" if base else folder


def resolve_worker_probe_context(worker_type: str) -> tuple[str, dict[str, str]] | None:
    """(abs executable path, probe env) for a short vendor-CLI probe, or
    ``None`` ⇔ not installed. The executable name IS the worker type
    (claude/codex/copilot) -- callers must pass the DRIVER name, which
    ``run_worker_auth_probe`` guarantees.

    Resolution is disk-verified against the DISCOVERED bin folder (same shape
    as ``CliCapabilityRunner.test``): a stale discovered folder — CLI
    uninstalled after discovery — surfaces as not-installed here rather than
    as a spawn error. The env pins the folder first on PATH so the CLI's
    ``#!/usr/bin/env node`` shebang resolves regardless of how the backend
    was launched.
    """
    folder = worker_bin_folder(worker_type)
    if folder is None:
        return None
    path = shutil.which(worker_type, path=folder)
    if path is None:
        return None
    return path, {**os.environ, **(worker_path_env(worker_type) or {})}


async def run_worker_auth_probe(worker_type: str) -> WorkerAuthResult:
    """Shared body for the drivers' ``auth_probe`` implementations.

    Resolves the executable against the discovered bin folder (None ⇒
    NOT_INSTALLED — the install gate also applies to copilot, whose probe is
    a pure heuristic that must not claim logged-in for an uninstalled CLI),
    then runs the vendor probe off-loop.

    Canonicalizes the worker type FIRST, and that is the whole fix for a bug that
    made Claude device login report "claude_code CLI is not installed" for a working
    CLI. Every other caller arrives via ``get_driver(...).auth_probe()`` and so passes
    the driver name (``claude``); device login alone keys off the CAPABILITY's
    worker_type (``claude_code``) and reached here un-normalized, where both the
    binary lookup and the vendor dispatch then missed. ``get_driver``'s alias table is
    the one canonicalizer in the tree — use it rather than teaching this layer, or the
    import-free ``auth_probe``, a fourth set of aliases.
    """
    try:
        worker_type = get_driver(worker_type).name
    except ValueError:
        pass  # unregistered worker: fall through and report NOT_INSTALLED as before
    ctx = resolve_worker_probe_context(worker_type)
    path, env = ctx if ctx is not None else (None, {})  # env unread on the NOT_INSTALLED path
    # Copilot's heuristic reads its instance-redirectable config dir. Avoid
    # resolving unrelated settings for the executable probes used by the other
    # vendors.
    copilot_home = None
    if worker_type == "copilot":
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        copilot_home = get_instance_settings().copilot_home
    return await asyncio.to_thread(probe_worker_auth, worker_type, path, env, Path.home(), copilot_home)


def build_worker_spawn_env(
    worker_type: str,
    env_from_opts: dict[str, str],
    base_env: dict[str, str] | None = None,
) -> dict[str, str]:
    """Spawn env for a per-turn worker subprocess: base ⊕ options env, with the
    discovered CLI bin folder pinned FIRST on PATH.

    ``env_from_opts`` (the options' env_vars) wins over the base for every
    key — including PATH, which ``apply_worker_env`` routinely pins to the
    backend venv. That pinned PATH is built from the backend's own (possibly
    stripped) service PATH, so the capability folder is re-prepended AFTER the
    overlay — otherwise a service PATH that never contained the nvm bin dir
    resurfaces as "codex not found" despite discovery having recorded it.

    Raises :class:`WorkerSpawnError` when no capability value was discovered
    (CLI not installed).
    """
    folder = worker_bin_folder(worker_type)
    if folder is None:
        raise WorkerSpawnError(
            worker_type,
            f"{worker_type} CLI not found — no {worker_capability_kind(worker_type)} installation discovered",
        )
    env = dict(os.environ if base_env is None else base_env)
    env.update(env_from_opts)
    env["PATH"] = prepend_path_dir(folder, env.get("PATH"))
    return env


def resolve_worker_argv0(worker_type: str, argv: list[str], env: dict[str, str]) -> list[str]:
    """Pin ``argv[0]`` to the absolute executable resolved against the SPAWN
    env's PATH (not the parent process PATH).

    subprocess/libuv resolve a bare argv[0] against the parent process PATH
    before the child's env applies on some platforms, so a backend started
    with a stripped service PATH would fail to exec a CLI that capability
    discovery found through nvm. Resolving against ``env["PATH"]`` — which
    :func:`build_worker_spawn_env` guarantees starts with the discovered bin
    folder — makes the spawn independent of how the backend was launched.

    Mutates and returns *argv*. Raises :class:`WorkerSpawnError` when the
    executable is missing even on the discovery-augmented PATH (e.g. the CLI
    was uninstalled after discovery).
    """
    resolved = shutil.which(argv[0], path=env.get("PATH"))
    if resolved is None:
        raise WorkerSpawnError(
            worker_type,
            f"{worker_type} executable {argv[0]!r} not found on worker PATH ({env.get('PATH')})",
        )
    argv[0] = resolved
    return argv


async def latch_spawn_failure(process: "AgenticProcess", error: WorkerSpawnError) -> None:
    """Route a :class:`WorkerSpawnError` into the standard start-failure path.

    Mirrors what ``start_pty``'s except-clause and ``_on_pty_exit``'s
    instant-exit classification do for PTY launches: ``status=FAILED`` plus the
    ``start_failure`` latch, so the UI surfaces the message and auto-recovery
    stops relaunching until an explicit user retry (``open(retry=True)``).
    """
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    logger.error("AgenticProcess %s: worker spawn failed — %s", process.id, error)
    process.status = ProcessStatus.FAILED.value
    process.start_failure = str(error)
    try:
        await process.save()
    except Exception:
        logger.exception("AgenticProcess %s: failed to persist spawn-failure latch", process.id)


# ─────────────────────────────────────────────────────────────────────────────
# factory — string-keyed dispatch to vendor CLI option classes
# ─────────────────────────────────────────────────────────────────────────────


def factory(cli_json: dict, worker_type: str) -> AgentOptions:
    """Return the correct AgentOptions subclass for the given worker_type.

    String keys (``"claude"``, ``"codex"``, ``"copilot"``) are the wire form used by
    serialised ``AgenticProcess.cli_config`` — kept stable across enum
    renames. Local imports break the cli_drivers/<vendor> → base cycle.
    """
    if worker_type == "claude":
        from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions

        return ClaudeAgentOptions.from_json(cli_json)
    if worker_type == "codex":
        from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions

        return CodexAgentOptions.from_json(cli_json)
    if worker_type == "copilot":
        from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions

        return CopilotAgentOptions.from_json(cli_json)
    raise ValueError(f"Unknown worker_type: {worker_type!r}")


# ─────────────────────────────────────────────────────────────────────────────
# Composer-ready gate — vendor-marker detection over the raw PTY stream
# ─────────────────────────────────────────────────────────────────────────────
#
# A cold interactive TUI can boot into a *blocking interstitial* (directory
# trust prompt, login, migration notice) whose screen is quiet — so "output
# went idle" is NOT a composer-ready signal, and typing the first prompt on
# quiescence alone gets it eaten by the interstitial (QA C09b). Vendors that
# need a typed first delivery declare a ``pty_composer_ready_pattern``; the
# submit path defers typing until the pattern appears in the ANSI-stripped
# PTY output. Detection is event-driven — each PTY paint wakes the scanner;
# there are no sleeps and no poll budgets here.

# TUIs paint with cursor positioning, so scan a bounded tail of the
# accumulated output rather than growing without bound. Markers are a few
# dozen bytes; 64 KiB of tail is orders of magnitude more than one frame.
_COMPOSER_SCAN_WINDOW = 65536

# Order matters: OSC first (its payload may contain '[' etc.), then CSI
# (parameter + intermediate + final byte), then bare two-byte ESC sequences,
# then residual C0 controls (keep \t\n\r as separators is unnecessary — the
# markers are single-line, so drop them all except nothing).
_OSC_RE = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_CSI_RE = re.compile(rb"\x1b\[[0-9;:?<>=!]*[ -/]*[@-~]")
_ESC_RE = re.compile(rb"\x1b[@-_=>]?")
_CTRL_RE = re.compile(rb"[\x00-\x08\x0b-\x1f\x7f]")


def strip_pty_controls(data: bytes) -> str:
    """Reduce raw PTY output to its printable text (best-effort).

    Removes OSC/CSI/ESC escape sequences and C0 controls, then decodes as
    UTF-8 with replacement. Good enough for marker *search* — it does not
    reconstruct screen layout (a TUI that paints word-by-word yields the words
    concatenated in paint order), so patterns must match text the TUI paints
    contiguously (e.g. the codex ``>_ OpenAI Codex`` banner).
    """
    data = _OSC_RE.sub(b"", data)
    data = _CSI_RE.sub(b"", data)
    data = _ESC_RE.sub(b"", data)
    data = _CTRL_RE.sub(b"", data)
    return data.decode("utf-8", "replace")


async def pump_composer_ready(
    pattern: re.Pattern[str],
    initial: bytes,
    next_chunk,
) -> bool:
    """Block until ``pattern`` appears in the (ANSI-stripped) PTY output.

    ``initial`` is the already-accumulated output (checked first — a warm PTY
    whose composer painted long ago passes instantly); ``next_chunk`` is an
    awaitable callable yielding subsequent raw output chunks, with ``None`` as
    the close sentinel (PTY died / stream ended → returns False: the caller
    must NOT type). Purely event-driven: it only ever waits on the next paint.
    """
    buf = initial[-_COMPOSER_SCAN_WINDOW:]
    while True:
        text = strip_pty_controls(buf)
        if pattern.search(text):
            return True
        chunk = await next_chunk()
        if chunk is None:
            return False
        buf = (buf + chunk)[-_COMPOSER_SCAN_WINDOW:]


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

    name: str  # wire id: "claude" | "codex" | "copilot"
    supports_process_hooks: bool
    process_hooks_use_assets: bool
    preassign_interactive_session_id: bool
    # True iff this vendor's interactive TUI submits a pasted prompt that ends
    # in ``\r`` (claude). False for TUIs that treat the trailing ``\r`` as
    # literal text and need a discrete Enter after the paste settles (copilot,
    # codex) — see ``Shell.write_then_submit`` and the ``prompt-pty`` action.
    pty_submits_on_paste: bool
    # Composer-ready marker for the vendor's interactive TUI, or None. When a
    # first prompt must be TYPED into the PTY (``pty_submits_on_paste`` False
    # cold start / hot submit), the delivery is deferred until this pattern
    # appears in the ANSI-stripped PTY output — so a blocking boot interstitial
    # (directory trust / login / migration screen) can never eat the prompt
    # (QA C09b). None → no grounded marker; delivery keeps the legacy
    # settle-then-type behaviour. Matched via ``pump_composer_ready``.
    pty_composer_ready_pattern: "re.Pattern[str] | None"
    # True iff, on resume/fork, this vendor pins the worker's launch cwd
    # (``CLAUDE_PROJECT_DIR`` + ``workdir``) to the recorded cwd of the source
    # session's transcript (claude). Codex/copilot don't rewrite the launch cwd
    # from a transcript record, and have no fork. Replaces a ``hasattr(cmd,
    # "fork_session_id")`` proxy that meant "is this the claude options shape".
    pins_resume_cwd: bool

    # ── CLI shape ────────────────────────────────────────────────────────────

    def cli_options(self, process: "AgenticProcess") -> AgentOptions:
        """Return a fully-configured options object (model, session_id,
        workdir, add_dirs, agents/skills) for this process — used by
        ``AgenticProcess.cmd_line`` and the spawn paths."""
        ...

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: AgentOptions,
    ) -> dict[str, Any]:
        """Return this worker's canonical launch payload for restart hashing."""
        ...

    def process_hook_snapshot(self, events: Sequence["HookEventType"]) -> dict[str, Any]:
        """Return a pure semantic snapshot for persisted process-hook intent."""
        ...

    def prepare_process_hooks(
        self,
        assets: "AssetDir",
        process_id: str,
        events: Sequence["HookEventType"],
    ) -> ProcessHookRuntime:
        """Materialize launch artifacts once and return their runtime inputs."""
        ...

    def normalize_process_hook_data(
        self,
        process_id: str,
        raw_hook_data: dict[str, Any],
    ) -> "AgentHookData":
        """Normalize one vendor-native report into canonical hook data."""
        ...

    # ── Per-turn execution ───────────────────────────────────────────────────

    async def headless_prompt(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        """Headless one-shot turn: spawn the worker, capture session_id onto
        ``process``, manage lifecycle. Returns an ApiResponse the caller can
        send back over HTTP."""
        ...

    def stream_worker(self, process: "AgenticProcess") -> AgenticWorker:
        """Return a worker instance for HTTP print-mode streaming.

        This is separate from ``headless_prompt`` because the HTTP ``prompt``
        action streams FlowData directly to the response while still needing
        the vendor-specific subprocess wrapper and transcript path.
        """
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

    # ── Auth ─────────────────────────────────────────────────────────────────

    async def auth_probe(self) -> WorkerAuthResult:
        """Probe this vendor CLI's login state (≤5s, never raises).

        NOT_INSTALLED when discovery has no bin folder (or it went stale);
        UNKNOWN when the probe couldn't decide (timeout, exec error,
        unparseable output) — implementations must never conflate that with
        LOGGED_OUT. ``verified`` is True only when the vendor CLI itself
        confirmed the state (copilot's heuristic never is).
        """
        ...

    # How this vendor's CLI runs its link(+code) login flow — consumed by the
    # generic engine in ``device_login.py``; no orchestration code branches
    # on vendor (same trait style as ``pty_submits_on_paste``).
    device_login_spec: DeviceLoginSpec

    # ── Transcript discovery ─────────────────────────────────────────────────

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Resolved transcript path plus the native JSONL format metadata."""
        ...

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        """Where this driver's worker writes its JSONL/event log for the
        given process — or None if no session id is yet assigned."""
        ...

    def skills_root(self, process: "AgenticProcess", assets_dir: Path) -> Path:
        """Directory a skill folder is laid into so this worker discovers it.

        Claude/Copilot mount the process ``assets_dir`` (``--add-dir``) and read
        ``.claude/skills`` from it; Codex reads only ``$CODEX_HOME/skills``. The
        orchestrator routes skill materialization through this seam so it never
        branches on the vendor."""
        ...

    def tail_status(self, transcript_path: Path) -> "WorkerStatus":
        """Map the tail of the transcript to a WorkerStatus."""
        ...

    def has_resumable_session(self, process: "AgenticProcess") -> bool:
        """True iff this vendor has a transcript to ``--resume`` for the
        process's ``session_id``. Probes the vendor's own session store —
        used by restart recovery to decide whether to relaunch with resume."""
        ...

    def supports_plan_mode(self, process: "AgenticProcess") -> bool:
        """True iff this vendor supports CLI plan mode in headless turns
        (``--permission-mode plan`` + the ExitPlanMode/AskUserQuestion tools).
        Surfaced on the entity as ``supports_plan_mode`` so the chat UI can
        offer the plan toggle only for capable workers. Defaults False."""
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
        """Return the user prompt, optionally transformed by a vendor driver.

        Current drivers keep this as a passthrough; embedded-agent instructions
        are delivered via generated process instruction assets.
        """
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
        "copilot": "copilot",
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
    elif name == "copilot":
        from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver

        driver = CopilotDriver()
    else:
        raise ValueError(f"No WorkerDriver registered for worker_type={worker_type!r}")

    _DRIVER_CACHE[name] = driver
    return driver


__all__ = [
    "CLI_RUN_ID_ENV_VAR",
    "STREAM_JSON_LINE_LIMIT_BYTES",
    "AgenticContext",
    "AgenticProcessContextKey",
    "AgenticWorker",
    "AgentOptions",
    "ProcessHookRuntime",
    "WorkerExecutionInfo",
    "WorkerDriver",
    "WorkerSpawnError",
    "build_worker_spawn_env",
    "factory",
    "get_driver",
    "latch_spawn_failure",
    "prepend_path_dir",
    "resolve_worker_argv0",
    "restart_payload_from_cli_options",
    "stamp_cli_run_id",
    "terminate_asyncio_process_tree",
    "wait_for_asyncio_process_or_kill_tree",
    "worker_bin_folder",
    "worker_path_env",
]
