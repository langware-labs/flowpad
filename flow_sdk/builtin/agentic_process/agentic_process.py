"""AgenticProcess entity — vendor-pure orchestration over a ``WorkerDriver``.

The entity holds a ``WorkerDriver`` (resolved via ``get_driver(worker_type)``)
and never branches on ``worker_type`` itself. Vendor specifics — Claude vs
Codex CLI shape, transcript layout, prompt composition, status interpretation
— live in ``cli_drivers/{claude,codex}/driver.py``. New vendors plug in by
implementing the ``WorkerDriver`` Protocol and registering with ``get_driver``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from enum import Enum
from functools import cached_property
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, ClassVar, List
from uuid import uuid4

from pydantic import SerializationInfo, model_serializer, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.builtin.agentic_process.cli_drivers import (
    AgenticContext as _AgenticContext,
    AgenticProcessContextKey,
    WorkerCLIOptions,
    WorkerDriver,
    get_driver,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude import (
    ClaudeCliOptions,
    ClaudeCLIStreamWorker,
)
from flow_sdk.core import Entity, action
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler
from flow_sdk.flowpad_types.enums import ProcessType, WorkerType
from flow_sdk.builtin.worker_status import WorkerStatus, is_terminal as is_worker_terminal
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input, is_process_startable
from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.prompt_queue import PromptQueue
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.shell import Shell
    from flow_sdk.transcript_analyzer import AgentTranscriptFile
    from flow_sdk.transcript_analyzer.entries.tool_use import ToolUseEntry

logger = logging.getLogger(__name__)

# Detached background tasks that must outlive the request that spawned them
# (e.g. ``self-restart``, which kills the very worker — and therefore the CLI
# child process — that issued the request). ``asyncio`` only holds a weak
# reference to running tasks, so without a strong ref here they could be
# garbage-collected mid-flight. Tasks remove themselves on completion.
_DETACHED_TASKS: set["asyncio.Task"] = set()

# Grace period before a detached self-restart tears down the worker, giving the
# HTTP response time to flush back to the (about-to-die) caller.
_SELF_RESTART_GRACE_S = 0.5


# ── Asset descriptors ──────────────────────────────────────────────────────────
# Read-side surface for ``AgenticProcess.get_asset_descriptors`` — see plan
# "AgenticProcess.get_assets() — unified read-side asset view". The descriptors
# unify the scattered fields (``embedded_asset_refs``, ``embedded_agent_ids``,
# ``cli_config.agents_json``, ``additional_dirs``) plus path-discovered assets
# under user/project/workdir into one list the UI can consume.

class AssetSource(str, Enum):
    EMBEDDED = "embedded"              # materialized via embedded_asset_refs
    INLINE = "inline"                  # cli_config.agents_json / embedded_agent_ids — no file
    PROJECT_DIR = "project_dir"        # under project.fs_storage_mount_path
    USER_DIR = "user_dir"              # under user_home
    WORKDIR = "workdir"                # process workdir if distinct from project/user
    ADDITIONAL_DIR = "additional_dir"  # additional_dirs entries (excl. auto-appended assets dir)


# Sources whose underlying file/state lives outside this AgenticProcess —
# editing the entity propagates elsewhere (other processes, the project,
# the user globally), so the row is "read-only" from this process's
# perspective. Attaching materializes an EMBEDDED writable copy.
READONLY_ASSET_SOURCES: frozenset[AssetSource] = frozenset({
    AssetSource.PROJECT_DIR,
    AssetSource.USER_DIR,
    AssetSource.WORKDIR,
    AssetSource.ADDITIONAL_DIR,
})


class TranscriptSubpath(StrEnum):
    PLAN = "plan"
    PROMPT = "prompt"
    PROMPTS = "prompts"
    FULL = "full"


def is_readonly_source(source: AssetSource) -> bool:
    return source in READONLY_ASSET_SOURCES


@dataclass
class AssetDescriptor:
    """Single asset row visible to an AgenticProcess.

    A given source asset may appear multiple times in the list — once per
    distinct source (e.g. EMBEDDED + USER_DIR for the same skill).
    """
    typeid: str               # serialized TypeId, e.g. "skill-<uuid>"
    source: AssetSource
    posix_path: str | None    # canonical POSIX path; None for INLINE
    source_dir: str | None = None  # matched source dir (path-discovered only); None for EMBEDDED/INLINE


# Types treated as executable agent inputs by the asset-management UI.
# Markdown / spec / plan / claude_rules etc. are intentionally excluded —
# they're documentation, not things the agent runs.
EXECUTABLE_ASSET_TYPES: list[str] = ["skill", "agent"]


# ── prompt-action transient state (per-process locks + live workers) ─────────
# Keyed by agentic_process.id. Lost on hub restart — acceptable, callers retry.
# Drivers register their in-flight worker here so cancel-prompt can find it.
_PROMPT_LOCKS: dict[str, asyncio.Lock] = {}
_PROMPT_WORKERS: dict[str, Any] = {}

# Per-process serialization for the ``open``/``start`` lifecycle so two
# concurrent refresh-driven calls can't both run recovery on the same process.
_OPEN_LOCKS: dict[str, asyncio.Lock] = {}

# Per-process serialization for prompt-queue drains so two ready edges can't
# pop+inject the same head twice.
_QUEUE_LOCKS: dict[str, asyncio.Lock] = {}


# Worker statuses for which an OS-pid liveness reconciliation is meaningful.
# Terminal statuses (COMPLETE, ERROR, INTERRUPTED, INACTIVE) already encode the
# answer; ``None``/``IDLE`` mean "no work in flight" and shouldn't be flipped.
_NON_TERMINAL_WORKER_STATUSES = frozenset({
    WorkerStatus.INITIALIZING,
    WorkerStatus.WAITING,
    WorkerStatus.THINKING,
    WorkerStatus.TOOL_RUNNING,
    WorkerStatus.TOOL_CALL,
    WorkerStatus.UNKNOWN,
})

# Underlying terminal statuses eligible for the PENDING_USER / INACTIVE
# projection in ``_discover_status_from_transcript``. INACTIVE / API_TIMEOUT
# are excluded — they're already terminal-with-cause and don't get the
# user-facing 5-min grace window.
_PROJECTABLE_TERMINAL = frozenset({
    WorkerStatus.COMPLETE,
    WorkerStatus.ERROR,
    WorkerStatus.INTERRUPTED,
})


def _shell_worker_pid_alive(shell_id: str) -> bool:
    """Sync OS-pid liveness check for a shell's last-launched worker process.

    Reads ``<records_root>/shell/shell-@<id>/state.json`` directly so the
    sync ``_discover_status_from_transcript`` path doesn't need to ``await``
    a record fetch. Conservative on error — returns ``True`` (assume alive)
    so transient I/O issues don't flip a healthy worker to ``INACTIVE``.
    """
    try:
        import json as _json

        import psutil as _psutil

        from flow_sdk.fs_store.record_paths import get_default_records_data_root, record_stem

        path = (
            get_default_records_data_root()
            / "shell"
            / record_stem("shell", shell_id)
            / "state.json"
        )
        if not path.exists():
            return True
        meta = (_json.loads(path.read_text()) or {}).get("meta") or {}
        pid_raw = meta.get("worker_pid") or meta.get("process_id")
        if pid_raw is None:
            return True
        try:
            pid = int(pid_raw)
        except (TypeError, ValueError):
            return True
        if not _psutil.pid_exists(pid):
            return False
        try:
            if _psutil.Process(pid).status() == _psutil.STATUS_ZOMBIE:
                return False
        except (_psutil.NoSuchProcess, _psutil.AccessDenied):
            return False
        return True
    except Exception:
        return True


def _get_prompt_lock(process_id: str) -> asyncio.Lock:
    lock = _PROMPT_LOCKS.get(process_id)
    if lock is None:
        lock = asyncio.Lock()
        _PROMPT_LOCKS[process_id] = lock
    return lock


def _get_open_lock(process_id: str) -> asyncio.Lock:
    lock = _OPEN_LOCKS.get(process_id)
    if lock is None:
        lock = asyncio.Lock()
        _OPEN_LOCKS[process_id] = lock
    return lock


def _get_queue_lock(process_id: str) -> asyncio.Lock:
    lock = _QUEUE_LOCKS.get(process_id)
    if lock is None:
        lock = asyncio.Lock()
        _QUEUE_LOCKS[process_id] = lock
    return lock


async def _read_json_body() -> dict | ApiFailResponse:
    """JSON object body of the current request, or an ``ApiFailResponse``
    the action can return as-is."""
    request_info = get_current_request_info()
    if not request_info:
        return ApiFailResponse(message="No request info")
    body = await request_info.get_post_data()
    if not isinstance(body, dict):
        return ApiFailResponse(message="Expected JSON object body")
    return body


def _write_plan_frontmatter(file_path: str, fields: dict) -> None:
    """Upsert YAML frontmatter key/values in a plan .md file."""
    import re
    p = Path(file_path)
    if not p.exists():
        return
    content = p.read_text(encoding="utf-8")
    fm_re = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
    m = fm_re.match(content)
    if m:
        existing = m.group(1)
        for k, v in fields.items():
            val_str = "true" if v is True else ("false" if v is False else str(v))
            line_re = re.compile(rf"^{re.escape(k)}:.*$", re.MULTILINE)
            if line_re.search(existing):
                existing = line_re.sub(f"{k}: {val_str}", existing)
            else:
                existing += f"\n{k}: {val_str}"
        new_content = f"---\n{existing}\n---\n" + content[m.end():]
    else:
        lines = "\n".join(
            f"{k}: {'true' if v is True else ('false' if v is False else str(v))}"
            for k, v in fields.items()
        )
        new_content = f"---\n{lines}\n---\n{content}"
    p.write_text(new_content, encoding="utf-8")


async def _index_additional_dir(path: str) -> None:
    """Run a one-shot indexer scan over ``path`` so its skills/agents become
    discoverable via ``Entity.assets_by_path``.

    Best-effort and silent: if the path doesn't exist or the indexer raises,
    we log and continue — adding the dir to ``additional_dirs`` already
    succeeded.
    """
    try:
        from pathlib import Path as _Path
        from flow_sdk.fs_store.fs_ref import FSRef
        from flow_sdk.fs_store.record_types import RecordType
        from flow_sdk.fs_store.indexer import IndexerOptions, get_shared_indexer

        p = _Path(path)
        if not p.is_dir():
            return
        new_root = FSRef(p, record_type=RecordType.CWD_ROOT, scope="user")
        # include_temp=True so /tmp / /var/folders paths aren't filtered out —
        # the user explicitly added this dir, so honor it regardless of location.
        await get_shared_indexer().index(
            IndexerOptions(roots=(new_root,), verbose=False, include_temp=True)
        )
    except Exception:
        logger.exception("add_dir: indexing failed for %s", path)


async def _index_session_on_close(session_id: str, display_name: str | None = None) -> None:
    """Index the ClaudeSessionRecord after an AgenticProcess closes (fire-and-forget).

    display_name: Current tab display name (sourced from the AgenticProcess
                  entity at close time). Used as the FTS title / entity name
                  when the JSONL has no user-set custom-title.
    """
    try:
        record = get_claude_session(session_id)
        if record:
            if display_name:
                inst = object.__getattribute__(record, "__dict__")
                if not inst.get("custom_title"):
                    # Base search_title reads record.name → FTS title becomes
                    # the truncated display_name.
                    record.name = display_name[:120]
            await record.sync_to_db()
            logger.debug("[AgenticProcess] indexed session %s on close", session_id)
    except Exception:
        logger.debug("[AgenticProcess] failed to index session %s on close", session_id, exc_info=True)


def _build_run_result(proc: "AgenticProcess") -> "RunResult":
    """Build a RunResult from the process state after wait() completes."""
    from flow_sdk.builtin.agentic_process._shared import RunResult

    text = ""
    models_used: list[str] = []
    token_usage: dict | None = None
    if proc.session_id:
        try:
            record = get_claude_session(proc.session_id)
            if record:
                text = getattr(record, "last_assistant_text", None) or ""
                models_used = list(getattr(record, "models_used", []) or [])
                token_usage = getattr(record, "token_usage", None)
        except Exception:
            pass

    status_enum = proc.fetch_worker_status()
    if status_enum is None:
        try:
            lifecycle = ProcessStatus(proc.status)
        except ValueError:
            lifecycle = ProcessStatus.STOPPED
        status_enum = WorkerStatus.ERROR if lifecycle == ProcessStatus.FAILED else WorkerStatus.IDLE

    ok = status_enum not in (WorkerStatus.ERROR, WorkerStatus.INTERRUPTED)
    return RunResult(
        text=text,
        session_id=proc.session_id or "",
        status=status_enum,
        ok=ok,
        duration_ms=None,
        models_used=models_used,
        token_usage=token_usage,
    )


class AgenticProcess(Entity):
    _api_visible = True
    _icon: ClassVar[str | None] = "Workflow"
    type: str = APIField(default="agentic_process")

    instruction_content: str | None = APIField(default=None)
    asset_ref: str | None = APIField(default=None)
    context_data: dict[str, Any] = APIField(default_factory=dict)
    cli_config: dict[str, Any] = APIField(default_factory=dict)
    workdir: str | None = APIField(default=None)
    favorite_index: int | None = APIField(default=None)
    status: str = APIField(default=ProcessStatus.NEW.value)
    session_id: str | None = APIField(default=None)
    use_worker_history: bool = APIField(default=False)
    shell_mode: bool = APIField(default=False, description="False=direct PTY spawn (default), True=legacy zsh intermediary")
    project_id: str | None = APIField(default=None)
    collaboration_room_id: str | None = APIField(
        default=None,
        description="CollaborationRoom this process was spawned in, if any",
    )
    target_typeid_str: str | None = APIField(
        default=None,
        description='VFS path this process is keyed to. Either a serialized TypeId ("type-id") for entity-scoped chats, or "<typeid>/<sub_path>" for surface-scoped chats.',
    )
    exe_folder: FSRef | None = APIField(
        default=None,
        description="FSRef pointing at `<record_dir>/execution/`.",
    )
    input_folder: FSRef | None = APIField(
        default=None,
        description="FSRef for `<exe_folder>/input/` — instruction / queue inputs.",
    )
    output_folder: FSRef | None = APIField(
        default=None,
        description="FSRef for `<exe_folder>/output/` — artifacts the agent writes back.",
    )
    assets_folder: FSRef | None = APIField(
        default=None,
        description="FSRef for `<exe_folder>/assets/` — materialised embedded agents / skills.",
    )
    total_cost_usd: float | None = APIField(
        default=None,
        description=(
            "USD cost of this process's session transcript so far. Derived "
            "server-side from the on-disk JSONL via "
            "transcript_analyzer.pricing.total_cost_usd; not persisted on the "
            "entity. None when no session_id is known yet."
        ),
    )
    shell_id: str | None = APIField(default=None)
    sidecar_shell_id: str | None = APIField(default=None)
    visible: bool = APIField(default=False, description="Whether this process is visible in the tabs view")
    last_active_at: str | None = APIField(
        default=None, description="ISO timestamp of the tab's last activation (resolver recency seed)"
    )
    auto_rename: bool = APIField(
        default=True,
        description=(
            "When True, PTY OSC title escapes are allowed to update `name`. "
            "Cleared the first time the user manually renames this tab in the UI."
        ),
    )
    process_type: ProcessType | None = APIField(
        default=None,
        description=(
            "Discriminator for how this process is used. CHAT = conversational "
            "editor companion; EXECUTION = runs an embedded asset or workflow. "
            "Null for legacy rows pre-dating this field."
        ),
    )
    restart_required: bool = APIField(
        default=False,
        description=(
            "True iff a worker-relevant field changed since the last successful "
            "start_pty() while status==RUNNING. UI surfaces this as a 'Restart' affordance. "
            "Set automatically by the save-hook; can also be set externally via API."
        ),
    )
    last_started_hash: str | None = APIField(
        default=None,
        description=(
            "MD5 of the worker-relevant config fields captured at the last "
            "successful start_pty(). Compared against the current snapshot on each "
            "save() to detect drift."
        ),
    )
    last_started_snapshot: dict[str, Any] | None = APIField(
        default=None,
        description=(
            "Structured {generic, worker} payload captured at the last "
            "successful start_pty(). Surfaced by the 'Command Status' debug "
            "viewer to show the loaded-vs-current diff. None until first start."
        ),
    )
    additional_dirs: list[str] = APIField(default_factory=list, description="Extra directories passed to Claude via --add-dir")
    load_flowpad_assistant: bool | None = APIField(
        default=None,
        description=(
            "Per-process override for mounting the Flowpad Assistant project "
            "(--add-dir → its .claude/skills + agents become discoverable). "
            "None inherits the global ServiceConfig.load_flowpad_assistant. "
            "Resolve via the assistant_enabled property; the driver reads that."
        ),
    )
    embedded_agent_ids: list[str] = APIField(default_factory=list, description="Agent ids injected via --agents at session launch")
    embedded_asset_refs: list[TypeId] = APIField(
        default_factory=list,
        description=(
            "TypeIds of entities whose files have been materialized into the "
            "process's <record_dir>/assets folder. Claude discovers them via --add-dir."
        ),
    )
    worker_type: WorkerType | None = APIField(default=None)
    plan_path: str | None = APIField(
        default=None,
        description=(
            "Absolute path to the latest plan markdown produced by this process, "
            "or null if none yet. Persists across reloads so the 'Open Plan' UI "
            "affordance survives a refresh without re-running the line trigger."
        ),
    )
    terminal_at: datetime | None = APIField(
        default=None,
        description=(
            "Timestamp at which worker_status first entered a terminal state "
            "(COMPLETE/ERROR/INTERRUPTED). Used by the serializer to project to "
            "WorkerStatus.PENDING_USER for the first 5 minutes and INACTIVE after. "
            "Cleared when the worker resumes (next non-terminal underlying status)."
        ),
    )

    def tooltip_summary(self) -> dict[str, str | None]:
        # cli_config.last_prompt is the eventual home for the most recent prompt,
        # but nothing writes it today — fall back to instruction_content (the
        # initial instruction, also what ProcessToolbar renders as the prompt
        # banner). Strip so whitespace-only values don't render an empty line.
        cfg = self.cli_config if isinstance(self.cli_config, dict) else {}
        raw = cfg.get("last_prompt") or self.instruction_content or ""
        if not isinstance(raw, str):
            return {"name": self.name, "subtitle": None}
        subtitle = raw.strip() or None
        return {"name": self.name, "subtitle": subtitle}

    # ── Binding freeze ────────────────────────────────────────────────────────
    # Once an AgenticProcess has a ``session_id``, its ``project_id`` and
    # ``workdir`` are frozen: the Claude/Codex transcript on disk is keyed to
    # those values, and any later rewrite silently drifts the record away from
    # where the jsonl actually lives (see 4c5bd6e4 incident — heal/recover
    # paths re-stamped these fields against the active dock's project, while
    # the session had been started elsewhere).
    #
    # ``_binding_lock_armed`` is flipped True by ``_arm_binding_lock`` after
    # construction. Until armed, all writes pass through — Pydantic
    # construction must be able to set the fields freely. Once armed,
    # ``__setattr__`` refuses writes to ``project_id`` / ``workdir`` when
    # ``session_id`` is set and the new value differs from the current one.
    # The marker lives in ``__dict__`` (not a model field), so it isn't
    # serialised and re-loaded entities re-arm via the same validator.

    _BINDING_FROZEN_FIELDS: ClassVar[frozenset[str]] = frozenset(("project_id", "workdir"))

    @model_validator(mode="after")
    def _arm_binding_lock(self) -> "AgenticProcess":
        # ``object.__setattr__`` bypasses our hook so the marker is set
        # unconditionally even though the field isn't declared on the model.
        object.__setattr__(self, "_binding_lock_armed", True)
        return self

    def __setattr__(self, key: str, value: Any) -> None:
        # The freeze only refuses **rebinds** — writes that change one
        # truthy value to a *different* truthy value — once
        # ``session_id`` is set. Initialization from None (the
        # ``get_project()`` lazy-fill path) and same-value writes are
        # allowed; this prevents the silent re-stamp class of bugs while
        # leaving normal lifecycle fills working.
        #
        # The lock is armed by ``_arm_binding_lock`` after construction,
        # so Pydantic field assignment during ``__init__`` always passes
        # through.
        if (
            key in AgenticProcess._BINDING_FROZEN_FIELDS
            and self.__dict__.get("_binding_lock_armed")
            and self.__dict__.get("session_id")
        ):
            current = self.__dict__.get(key)
            if current and value and current != value:
                logger.info(
                    "[AgenticProcess %s] refused rebind of %s: binding frozen by session_id=%s "
                    "(current=%r attempted=%r)",
                    self.__dict__.get("id", "<no-id>"),
                    key,
                    self.__dict__.get("session_id"),
                    current,
                    value,
                )
                return
        super().__setattr__(key, value)

    @model_validator(mode="after")
    def _bubble_process_type_from_context_data(self) -> "AgenticProcess":
        """Lift `process_type` from `context_data` onto the top-level field.

        The chat panel queries `useProcessesForTarget(target, { processType })`
        which filters on top-level `process_type`. Older entities (and any
        creation path that didn't pop the value out of `context_data`) carry
        the value at `context_data.process_type` instead, leaving the top-level
        field None and the toolbar history dropdown empty. This validator
        bubbles the nested value up on every load + construction so existing
        rows surface correctly without a one-off migration.
        """
        if self.process_type is None and isinstance(self.context_data, dict):
            nested = self.context_data.get("process_type")
            if nested:
                try:
                    self.process_type = ProcessType(nested)
                except (ValueError, TypeError):
                    pass
        return self

    # ── Construction ──────────────────────────────────────────────────────────

    @classmethod
    async def run(
        cls,
        instruction: str,
        workdir: str | None = None,
        **kwargs,
    ) -> "RunResult":
        """One-shot: create → start → send → wait → return RunResult → stop.

        Raises ProcessError if status is error or interrupted.
        """
        from flow_sdk.builtin.agentic_process._shared import ProcessError

        proc = cls(workdir=workdir, **kwargs)
        async with proc:
            await proc.send(instruction)
            await proc.wait()
            result = _build_run_result(proc)
        if not result.ok:
            raise ProcessError(status=result.status, session_id=result.session_id)
        return result

    @classmethod
    def resume(
        cls,
        session_id: str,
        workdir: str | None = None,
        **kwargs,
    ) -> "AgenticProcess":
        """Factory: pre-bake resume cli_config. start_pty() injects --resume <session_id>.

        Fork chain is walked automatically to find the nearest transcript on disk.
        """
        cmd = ClaudeCliOptions(resume=True)
        proc = cls(workdir=workdir, **kwargs)
        proc.session_id = session_id
        proc.cli_config = cmd.to_json()
        return proc

    @classmethod
    def fork(
        cls,
        session_id: str,
        workdir: str | None = None,
        **kwargs,
    ) -> "AgenticProcess":
        """Factory: pre-bake the cli_config that ``start_pty()`` turns into
        ``claude --resume <parent> --fork-session --session-id <new>``.

        Three things must all be set for ``ClaudeCliOptions.to_spawn_args``
        to emit the fork incantation:
          * ``resume=True``
          * ``session_id=<new>``        (the fork's own pre-allocated sid)
          * ``fork_session_id=<parent>`` (passed in as ``session_id`` arg)

        Without all three, the spawn falls through to a plain ``claude``
        invocation — no resume, no fork — and claude starts a completely
        unrelated session whose transcript never lands on disk (because
        nobody ever sends it a prompt). The entity ends up with a session_id
        that resolves to nothing, and any later ``--resume`` fails with
        "No conversation found with session ID: <sid>". Pre-allocating
        ``session_id`` here also lets callers persist it on the entity row
        before the first turn, so transcript discovery doesn't race the
        ``system:init`` event.
        """
        new_session_id = str(uuid4())
        cmd = ClaudeCliOptions(
            resume=True,
            fork_session_id=session_id,
            session_id=new_session_id,
        )
        proc = cls(workdir=workdir, session_id=new_session_id, **kwargs)
        proc.cli_config = cmd.to_json()
        return proc

    async def __aenter__(self) -> "AgenticProcess":
        await self.start_pty()
        return self

    async def __aexit__(self, *_) -> None:
        await self.exit()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def _build_open_payload(self, shell: "Shell", *, is_resume: bool) -> dict[str, Any]:
        """Return the canonical HTTP payload for an open/live process."""
        return {
            "id": self.id,
            "status": self.status,
            "shell_id": self.shell_id,
            "pty_id": shell.pty_pid or shell.id,
            "session_id": self.session_id,
            "shell": shell.model_dump(mode="json"),
            "is_resume": is_resume,
            "worker_pid": shell.worker_pid,
        }

    def _record_worker_started_at(self, started_at: str | None) -> None:
        if not started_at:
            return
        context = dict(self.context_data or {})
        context[AgenticProcessContextKey.WORKER_STARTED_AT.value] = started_at
        self.context_data = context

    async def _get_local_compute_node(self):
        """Return the local compute node used for shell creation and recovery.

        Retry once on None — the @local compute_node is bootstrap-created and
        never deleted, so a None result is always a transient cache/DB-contention
        miss under heavy parallel writes (see Cluster #10 in debug_log.md). The
        retry invalidates any stale uname_cache entry before the second lookup.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        cn = await ComputeNode.get_by_uname("local")
        if cn is None:
            from flow_sdk.core.cache.entity_cache import uname_cache
            uname_cache.invalidate("compute_node", "local")
            cn = await ComputeNode.get_by_uname("local")
        return cn

    async def _drop_stale_shell(
        self,
        shell: "Shell | None",
        *,
        reason: str,
        preserve_shell_id: bool = False,
    ) -> None:
        """Discard a linked shell that can no longer be reattached."""
        stale_shell_id = shell.id if shell is not None else self.shell_id
        if shell is not None:
            logger.warning("AgenticProcess %s: discarding stale shell %s (%s)", self.id, shell.id, reason)
            context = dict(self.context_data or {})
            context["_prev_tab_order"] = shell.tab_order
            self.context_data = context
            try:
                await shell.terminate_worker()
            except Exception as exc:
                logger.warning("AgenticProcess %s: failed terminating stale worker for shell %s: %s", self.id, shell.id, exc)
            try:
                await shell.close()
            except Exception as exc:
                logger.warning("AgenticProcess %s: failed closing stale shell %s: %s", self.id, shell.id, exc)
        self.shell_id = stale_shell_id if preserve_shell_id else None
        self.sidecar_shell_id = None

    async def start_pty(
        self,
        instruction: str | None = None,
        visible: bool | None = None,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Spawn (or reattach to) this AgenticProcess's PTY worker.

        This is the PTY entry point — it always materialises a Shell + spawns
        an interactive ``claude`` PTY process, regardless of ``self.visible``.
        The visibility flag is a routing concern handled by :meth:`prompt`,
        not here. For headless one-shot turns, call ``prompt(instruction)``
        directly so the print-mode driver runs (no PTY).

        Covers all cases:
        - Fresh open (no previous session): spawns Claude with --session-id.
        - Reopen after server restart (stale shell, dead PTY): Shell.start_pty()
          detects the dead PTY, cleans up, and spawns Claude with --resume.
        - Idempotent call on live process: Shell.start_pty() detects alive PTY
          and returns without re-spawning.

        Body runs under a per-process ``_OPEN_LOCKS`` lock so two concurrent
        refresh-driven open calls (e.g. two browser tabs) can't both run
        recovery on the same process and double-spawn Claude.
        """
        # Suppress the restart-required auto-flag while start_pty() mutates fields
        # (status, session_id are tracked, but those mutations are not "drift").
        # Cleared on success after we capture the new snapshot.
        self._set_start_lifecycle(True)
        try:
            async with _get_open_lock(self.id):
                return await self._perform_open(instruction, visible)
        finally:
            self._set_start_lifecycle(False)

    async def start(
        self,
        instruction: str | None = None,
        visible: bool | None = None,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Back-compat alias for :meth:`start_pty`. Prefer ``start_pty`` —
        the bare ``start`` reads as a generic lifecycle word but this method
        only ever spawns a PTY worker (visibility doesn't gate that)."""
        return await self.start_pty(instruction=instruction, visible=visible)

    async def _perform_open(
        self,
        instruction: str | None,
        visible: bool | None,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Body of ``start_pty`` (the legacy ``start``/HTTP ``open`` aliases route
        here) — runs while the per-process open lock
        is held. All lifecycle decisions (reattach vs recover vs fresh) live
        here; the caller is responsible for the lock and the start-lifecycle
        flag."""
        try:
            # If we're stuck in STOPPING with a dead worker (orphan from a
            # crashed close()/exit()), reset to STOPPED before doing anything
            # else. The rest of this function then sees a startable state
            # rather than refusing or spawning under stale assumptions.
            await self.reap_if_orphaned()
            self.session_id = self.session_id or str(uuid4())
            reattach_changed = False
            # Set when this fresh spawn consumes a queued prompt as its launch
            # arg (see the pop below). Tracked here so the except handler can
            # re-queue it if the boot fails — the prompt must survive.
            launched_head: dict | None = None
            if visible is not None and self.visible != visible:
                self.visible = visible
                reattach_changed = True

            shell = await self.shell() if self.shell_id else None
            if shell is not None:
                if not await shell.ensure_live_compute_node_binding():
                    return ApiFailResponse(message=f"Compute node not found for linked shell {shell.id}")

            if self.status in (
                ProcessStatus.STARTING.value,
                ProcessStatus.RUNNING.value,
            ) and self.shell_id:
                # Reattach gate: both the PTY session AND the worker PID must be
                # alive. ``has_attachable_pty()`` only proves the pseudo-terminal
                # is registered on the compute node — it accepts a PTY whose
                # Claude child has already exited. Pairing it with
                # ``worker_alive()`` (psutil-based PID + cmdline match) is what
                # prevents the "empty terminal after refresh" symptom.
                if (
                    shell is not None
                    and await shell.has_attachable_pty()
                    and await shell.worker_alive()
                ):
                    if self.status != ProcessStatus.RUNNING.value:
                        self.status = ProcessStatus.RUNNING.value
                        reattach_changed = True
                    if reattach_changed:
                        await self.save()
                    return ApiSuccessResponse(data=self._build_open_payload(shell, is_resume=False))
                # Gate failed (PTY dead, worker dead, or both). Drop the stale
                # shell so the relaunch path below sees a clean slate — without
                # this, ``_get_or_create_shell`` would hand back the same
                # half-dead shell entity and the new ``claude --resume`` would
                # collide with the old worker's lingering JSONL session lock.
                await self._drop_stale_shell(
                    shell,
                    reason=f"{self.status} process is missing a fully-alive PTY+worker",
                    preserve_shell_id=True,
                )
                shell = None

            await self.get_project()

            cmd = self._finalized_restart_cli_options()

            # Fork & CLAUDE_PROJECT_DIR plumbing are Claude-only — Codex's
            # ``CodexCliOptions`` has no ``fork_session_id`` and uses
            # ``-C <cwd>`` instead of ``CLAUDE_PROJECT_DIR``. Skip for any
            # cli_options shape that doesn't expose ``fork_session_id``.
            if hasattr(cmd, "fork_session_id"):
                if cmd.fork_session_id:
                    cmd.fork_session_id = await self._find_resumable_session(cmd.fork_session_id)
                # When resuming or forking, ensure CLAUDE_PROJECT_DIR points to where
                # the source session's transcript lives. For a fork, self.session_id is
                # the brand-new UUID with no transcript yet; use fork_session_id instead.
                if cmd.fork_session_id or (cmd.resume and self.session_id):
                    lookup_id = cmd.fork_session_id or self.session_id
                    session_rec = self._discover_claude_record_session(lookup_id)
                    if session_rec and session_rec.cwd:
                        cmd.env_vars["CLAUDE_PROJECT_DIR"] = session_rec.cwd
                        cmd.workdir = session_rec.cwd

            # Runtime env injection (process identity for hook routing)
            cmd.add_env(
                "FLOWPAD_EXECUTION_SCOPE",
                json.dumps([{"type": self.get_type(), "id": self.id}]),
            )

            is_resume = cmd.resume

            shell = await self._get_or_create_shell()
            self.shell_id = shell.id
            self.status = ProcessStatus.STARTING.value
            if self.driver.name == WorkerType.CODEX.value:
                self._record_worker_started_at(datetime.now(timezone.utc).isoformat())
            # Save STARTING + shell_id before launching the worker so a
            # concurrent revalidation observes the in-flight start instead
            # of issuing a second open.
            await self.save()
            on_exit = self._make_pty_exit_callback()
            worker_is_alive = False
            execution_info = None

            # Launch-via-queue: a fresh spawn with no explicit instruction takes
            # the queue head as its launch prompt, so the worker boots WITH the
            # first queued prompt (deterministic launch arg — no boot-empty-then-
            # write-stdin race). Pop under the per-process queue lock. For a
            # visible PTY this is the SOLE cold booter — ``_queue_ready`` keeps
            # the enqueue drain from cold-starting visible processes, so nothing
            # competes for the head.
            if instruction is None:
                async with _get_queue_lock(self.id):
                    q = self.queue
                    state = q.read()
                    if state.get("enabled", True) and state.get("entries"):
                        launched_head = q.pop(source="launch")  # persists + logs "pop"
                        if launched_head is not None:
                            instruction = launched_head["prompt"]
                            q.log(
                                "inject", "launch",
                                entry_id=launched_head.get("id"),
                                prompt=str(instruction)[:200],
                            )

            if self.shell_mode:
                # Legacy path — zsh intermediary
                await shell.start_pty(on_exit=on_exit)
                worker_is_alive = await shell.worker_alive()
                if not worker_is_alive:
                    execution_info = await shell.launch(cmd, instruction=instruction)
                    logger.info(
                        "AgenticProcess %s worker launched (shell): pid=%s name=%r",
                        self.id, execution_info.pid, execution_info.name,
                    )
            else:
                # Direct path — Claude IS the PTY process (no zsh intermediary)
                spawn_argv, spawn_env = cmd.to_spawn_args(instruction=instruction)
                spawned = await shell.start_pty(on_exit=on_exit, spawn_args=spawn_argv, extra_env=spawn_env)
                if not spawned:
                    worker_is_alive = await shell.worker_alive()
                if not worker_is_alive:
                    execution_info = await shell.set_worker_pid_direct(cmd)
                    logger.info(
                        "AgenticProcess %s worker launched (direct PTY): pid=%s name=%r",
                        self.id, execution_info.pid, execution_info.name,
                    )

            if execution_info is not None:
                self._record_worker_started_at(execution_info.started_at)

            # Completion detection is now driven by the TranscriptStreamer
            # subscriber (transcript_subscriber.py → on_transcript_change →
            # _flush_transcript_change). Lifecycle flips to STOPPED/FAILED
            # are handled by _on_pty_exit on real worker process death.
            # No 1 Hz polling task needed any more.

            self.status = ProcessStatus.RUNNING.value
            # Capture snapshot of the freshly-launched config and clear the
            # restart-required flag — the live worker now matches saved state.
            # Build the payload once so snapshot and hash can't diverge.
            snapshot_payload = self._restart_snapshot_payload()
            self.last_started_snapshot = snapshot_payload
            self.last_started_hash = self._restart_snapshot(snapshot_payload)
            self.restart_required = False
            await self.save()

            # The worker is live with the queued prompt as its launch arg; the
            # head is already off the queue. Record the completed injection and
            # push the drained queue state to the UI.
            if launched_head is not None:
                self.queue.log("injected", "launch", entry_id=launched_head.get("id"))
                try:
                    await self.notify_updated()
                except Exception:
                    pass

            return ApiSuccessResponse(data=self._build_open_payload(shell, is_resume=is_resume))

        except asyncio.CancelledError:
            logger.warning("AgenticProcess %s start_pty cancelled (status=%s shell_id=%s)", self.id, self.status, self.shell_id)
            self.status = ProcessStatus.FAILED.value
            await self.save()
            self._requeue_failed_launch(launched_head)
            raise
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} start_pty error: {e}")
            self.shell_id = None
            self.status = ProcessStatus.FAILED.value
            await self.save()
            self._requeue_failed_launch(launched_head)
            return ApiFailResponse(message=str(e))

    @action.post(action_name="exit")
    async def exit(self) -> ApiSuccessResponse | ApiFailResponse:
        """Kill worker process but keep shell entity alive (status=stopped). Use before restart."""
        if not self.shell_id:
            return ApiFailResponse(message="No active shell session")

        try:
            from flow_sdk.builtin.shell import Shell

            shell = await Shell.get_by_id(self.shell_id)
            if shell:
                self.context_data = {**self.context_data, "_prev_tab_order": shell.tab_order}

            # Set flag so the PTY exit callback knows to preserve shell_id.
            # Clear sidecar but NOT shell_id — shell entity stays alive for restart.
            self.context_data = {**self.context_data, "_shell_exit_pending": True}
            self.sidecar_shell_id = None
            self.status = ProcessStatus.STOPPING.value
            await self.save()

            if shell:
                await shell.stop()  # terminates worker + kills PTY, status=idle
                logger.info("AgenticProcess %s: exited (shell entity %s preserved)", self.id, self.shell_id)
            else:
                logger.warning("AgenticProcess %s: Shell entity %s not found on exit", self.id, self.shell_id)

            self.status = ProcessStatus.STOPPED.value
            self.context_data = {k: v for k, v in self.context_data.items() if k != "_shell_exit_pending"}
            await self.save()
            logger.info(
                "AgenticProcess %s: exited (session_id preserved: %s)",
                self.id,
                self.session_id,
            )

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": self.status,
                    "shell_id": self.shell_id,
                    "session_id": self.session_id,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} exit error: {e}")
            self.status = ProcessStatus.FAILED.value
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.post(action_name="restart")
    async def http_restart(self) -> ApiSuccessResponse | ApiFailResponse:
        """exit() + start_pty(). Shell entity is preserved and reused."""
        exit_result = await self.exit()
        if isinstance(exit_result, ApiFailResponse) and "No active shell" not in exit_result.message:
            return exit_result
        return await self.start_pty()

    @action.post(action_name="self-restart")
    async def http_self_restart(self) -> ApiSuccessResponse:
        """Detached restart — safe to call from *inside* the running worker.

        The intended caller is the worker itself: ``flow process restart`` run
        from within a session, e.g. to pick up a newly-installed MCP server.
        The catch is that the calling CLI process is a **child** of the worker
        this restart is about to kill (``exit()`` SIGTERMs the worker and all
        its descendants). Doing the exit()+start_pty() inline would therefore
        tear down the HTTP client mid-request, and — depending on the ASGI
        server's disconnect semantics — could even cancel this handler before
        ``start_pty()`` runs, leaving the process stuck STOPPED.

        So we don't restart inline. We schedule the work on the server event
        loop and return immediately: the ``{"scheduled": true}`` response
        reaches the about-to-die caller, and the restart runs to completion
        independently of the dropped client connection.

        Unlike the UI ``restart`` button (whose frontend emits its own local
        ``'restarted'`` event to re-attach the terminal), a server-initiated
        restart has no client-side signal. So once the fresh PTY is up we emit
        the ``worker.restarted`` entity event over the WS watcher channel; the
        frontend bridges it back to the same terminal re-attach path.
        """
        process_id = self.id

        async def _run() -> None:
            try:
                # Let the HTTP response flush before we kill the worker (and,
                # with it, the CLI child that is waiting on that response).
                await asyncio.sleep(_SELF_RESTART_GRACE_S)
                proc = await AgenticProcess.get_by_id(process_id)
                if proc is None:
                    logger.warning("self-restart: process %s vanished before restart", process_id)
                    return
                result = await proc.http_restart()
                if isinstance(result, ApiSuccessResponse):
                    # Tell every WS watcher (the UI terminal) to re-attach to
                    # the freshly-spawned PTY. Payload mirrors the open payload
                    # (pty_id / shell_id / worker_pid) for clients that want it.
                    await proc.emit_entity_event("worker.restarted", result.data or {})
                else:
                    logger.error(
                        "self-restart: restart failed for %s: %s",
                        process_id,
                        getattr(result, "message", "?"),
                    )
            except Exception:
                logger.exception("self-restart: background restart failed for %s", process_id)

        task = asyncio.create_task(_run(), name=f"self-restart-{self.id[:8]}")
        _DETACHED_TASKS.add(task)
        task.add_done_callback(_DETACHED_TASKS.discard)

        return ApiSuccessResponse(
            data={"scheduled": True, "id": self.id, "status": self.status}
        )

    def _bind_project_id(self, project_id: str) -> bool:
        """Polite bind: set ``project_id`` (honouring the freeze) and append
        the matching Project TypeId on success.

        Returns ``True`` if the binding landed, ``False`` if the freeze
        refused the write. Callers that need to write through the freeze
        (e.g. project-recovery, where the new id is known-correct) must
        use ``_force_rebind_project_id`` instead.
        """
        self.project_id = project_id
        if self.project_id != project_id:
            return False  # write was refused by the binding-freeze guard
        self.add_shared_context_entities(
            TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id)
        )
        return True

    def _force_rebind_project_id(self, project_id: str) -> None:
        """Bypass the binding-freeze and set ``project_id`` unconditionally.

        Use only when the caller has confirmed the new id is correct
        (e.g. ``Project.recover_by_path`` resurrected the dangling FK and
        the new Project entity is the canonical replacement). Also appends
        the matching Project TypeId to shared context.
        """
        object.__setattr__(self, "project_id", project_id)
        self.add_shared_context_entities(
            TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id)
        )

    def _force_rebind_workdir(self, workdir: str) -> None:
        """Bypass the binding-freeze and set ``workdir`` unconditionally.

        Use only when the caller has confirmed the new path is correct
        (e.g. the on-disk transcript moved). Most heal/upsert paths must
        leave ``workdir`` alone on session-bound processes — see the freeze
        comment at the top of this class.
        """
        object.__setattr__(self, "workdir", workdir)

    # NOTE: per-subclass project-id projection that used to live here moved
    # to ``Entity.get_implicit_private_context_entities`` in the base. Every
    # entity with ``project_id`` set now gets the project chip in its
    # private context for free — including AgenticProcess. Override
    # ``get_implicit_private_context_entities`` here if AP wants to add
    # more implicit chips (e.g. ``collaboration_room_id`` → room chip).

    @action.post(action_name="recover-project")
    async def recover_project_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Re-attach this process to a Project derived from its ``workdir``.

        Used when ``self.project_id`` points at a deleted project (dangling FK).
        Walks the 3-phase recovery in ``Project.recover_by_path`` and writes the
        resolved id back onto this process. Returns the recovered Project so the
        frontend can drop it into the entity cache without an extra fetch.
        """
        try:
            from flow_sdk.builtin.project import Project
            if not self.workdir:
                return ApiFailResponse(message="Process has no workdir; cannot recover project")
            project = await Project.recover_by_path(self.workdir)
            if not project:
                return ApiFailResponse(message=f"Could not recover a project for {self.workdir}")
            # Recovery legitimately replaces a dangling FK with the canonical
            # Project — bypass the freeze so session-bound processes (the only
            # ones that ever need recovery) actually move.
            self._force_rebind_project_id(project.id)
            await self.save()
            return ApiSuccessResponse(data={"project": project.model_dump(mode="json")})
        except Exception as e:
            logger.exception("AgenticProcess %s recover_project_action error: %s", self.id, e)
            return ApiFailResponse(message=str(e))

    @action.post(action_name="fork")
    async def fork_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Create a sibling process that shares this session's conversation history.

        Equivalent to: claude --resume <this.session_id> --fork-session
        Returns the new AgenticProcess entity data so the caller can open it.
        `visible` (bool, default False) controls whether the new process appears in the tabs view.
        """
        try:
            request_info = get_current_request_info()
            body = await request_info.get_post_data() if request_info else {}
            visible = bool((body or {}).get("visible", False))
            owner = request_info.someone_typeid if request_info else None

            new_proc = AgenticProcess.fork(
                session_id=self.session_id,
                workdir=self.workdir,
                project_id=self.project_id,
                visible=visible,
                shared_context_entities=list(self.shared_context_entities or []),
            )
            await new_proc.save(owner)
            return ApiSuccessResponse(data={"id": new_proc.id, "type": new_proc.type})
        except Exception as e:
            logger.exception("AgenticProcess %s fork_action error: %s", self.id, e)
            return ApiFailResponse(message=str(e))

    async def wait(self, timeout: float | None = None) -> None:
        """Block until worker_status reaches a terminal state (complete / error / interrupted).

        Polling interval: 2s. Raises TimeoutError if timeout elapses first.
        """
        deadline = (time.monotonic() + timeout) if timeout else None
        while True:
            worker_status = self.fetch_worker_status()
            if worker_status and is_worker_terminal(worker_status):
                return
            if self.status == ProcessStatus.FAILED.value:
                return
            if deadline and time.monotonic() > deadline:
                raise TimeoutError(f"Process did not reach terminal state within {timeout}s")
            await asyncio.sleep(2.0)

    async def waitForIdle(self, timeout: float | None = None) -> None:
        """Block until the worker is ready for input (``is_ready_for_input(self)``).

        Polling interval: 2s. Raises TimeoutError if timeout elapses first.
        """
        deadline = (time.monotonic() + timeout) if timeout else None
        while True:
            if is_ready_for_input(self):
                return
            if deadline and time.monotonic() > deadline:
                raise TimeoutError(f"Process did not reach idle state within {timeout}s")
            await asyncio.sleep(2.0)

    # ── Prompt queue ──────────────────────────────────────────────────────────

    def _record_dir(self) -> "Path":
        """This process's record folder (deterministic from type+id)."""
        from flow_sdk.fs_store.fs_record import record_stem
        from flow_sdk.fs_store.record_paths import get_default_records_root

        return get_default_records_root() / "agentic_process" / record_stem("agentic_process", self.id)

    @property
    def queue(self) -> "PromptQueue":
        """The process's file-backed FIFO prompt queue (``prompt_queue.json``)."""
        from flow_sdk.builtin.agentic_process.prompt_queue import PromptQueue

        return PromptQueue(FSRef(self._record_dir() / "prompt_queue.json"))

    def _queue_state(self) -> dict:
        """Queue state for entity payloads — never raises (a serializer
        exception would poison the whole entity dump)."""
        try:
            return self.queue.read()
        except Exception:
            return {"enabled": True, "entries": []}

    def _queue_ready(self, worker_status: "WorkerStatus | None") -> bool:
        """Drain-local readiness — superset of ``is_ready_for_input`` that also
        admits (a) a PENDING_USER worker and (b) a cold (startable) **headless**
        AP for its FIRST prompt.

        ``worker_status`` is the transcript status the caller already resolved
        (``_maybe_drain_queue`` reads the tail once and reuses it here and in
        its not-ready log line — a second tail-read per drain check is waste).

        (a) ``is_ready_for_input`` (truth-tabled, intentionally left untouched)
        only admits IDLE/COMPLETE/INTERRUPTED. ``PENDING_USER`` — a completed
        turn waiting at its prompt for the next user message — is exactly when a
        queued follow-up should be fed: the PTY is alive and idle. Admit it here
        (drain-local) so adding a prompt while the agent sits idle injects it,
        instead of silently parking until some other event fires. ``prompt()``
        relaunches if the PTY has since died, so this is safe either way.

        (b) Cold start via the drain is **headless-only**. A headless first
        prompt boots the worker *with* it through ``headless_prompt`` —
        deterministic, no PTY. A *visible* PTY is booted by its dock loader's
        ``start()`` instead, whose fresh-spawn path pops the queue head as the
        launch arg (see ``_perform_open``). If the drain ALSO cold-started a
        visible process it would race the loader into an empty boot and lose the
        popped head (the original "lost first prompt" bug). So the drain
        withholds cold-start from visible processes.
        """
        if is_ready_for_input(self, worker_status=worker_status):
            return True
        if worker_status == WorkerStatus.PENDING_USER:
            return True
        return (
            not self.visible
            and not getattr(self, "_turn_in_flight", False)
            and is_process_startable(self.status)
        )

    def _schedule_queue_drain(self, source: str) -> None:
        """Fire-and-forget a drain attempt; never block the caller."""
        try:
            task = asyncio.create_task(self._maybe_drain_queue(source))
        except RuntimeError:
            return  # no running loop (sync context) — nothing to drain into
        task.add_done_callback(lambda t: self._log_drain_task_exc(t, source))

    def _log_drain_task_exc(self, task: "asyncio.Task", source: str) -> None:
        exc = None if task.cancelled() else task.exception()
        if exc is not None:
            try:
                self.queue.log("error", source, error=f"drain task: {exc!r}")
            except Exception:
                pass

    def _requeue_failed_launch(self, head: dict | None) -> None:
        """Put a launch-consumed prompt back if its boot failed, so it isn't
        lost. Best-effort — a re-queue failure must not mask the original
        start error."""
        if not head:
            return
        try:
            self.queue.log("error", "launch", entry_id=head.get("id"), error="boot failed; re-queued")
            self.queue.enqueue(str(head.get("prompt", "")), source="launch-requeue")
        except Exception:
            pass

    async def _maybe_drain_queue(self, source: str) -> None:
        """Inject the FIFO head into the worker iff enabled + non-empty + ready.

        One entry per call. Pop-persists the head BEFORE injecting so a re-fired
        ready edge can never re-inject it. Runs under a per-process lock.
        """
        q = self.queue
        async with _get_queue_lock(self.id):
            state = q.read()
            if not state.get("enabled", True) or not state.get("entries"):
                q.log("drain_check", source, reason="empty_or_disabled")
                return
            # One transcript tail-read per drain check, shared by the readiness
            # gate and the not-ready log line.
            resolved = (
                self.fetch_worker_status()
                if self.status == ProcessStatus.RUNNING.value
                else None
            )
            if not self._queue_ready(resolved):
                q.log(
                    "drain_check", source, reason="not_ready",
                    status=self.status,
                    worker_status=str(resolved or ""),
                )
                return
            q.log("drain_check", source, reason="ok")
            head = q.pop(source=source)  # persists removal + logs "pop"
            if head is None:
                return
            q.log("inject", source, entry_id=head.get("id"), prompt=str(head.get("prompt", ""))[:200])
            try:
                await self.notify_updated()
            except Exception:
                pass
        # Release the lock BEFORE prompt() — it may run start_pty (long) and is
        # itself serialized by _PROMPT_LOCKS / _OPEN_LOCKS.
        try:
            await self.prompt(head["prompt"])
            q.log("injected", source, entry_id=head.get("id"))
        except Exception as e:  # noqa: BLE001 — already popped; record the loss
            q.log("error", source, entry_id=head.get("id"), error=str(e))

    @action.post(action_name="enqueue")
    async def _enqueue_action(self) -> ApiSuccessResponse | ApiFailResponse:
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            return ApiFailResponse(message="prompt is required")
        self.queue.enqueue(prompt, source=str(body.get("source") or "ui"))
        await self.notify_updated()
        self._schedule_queue_drain("enqueue")
        return ApiSuccessResponse(data=self.queue.read())

    @action.post(action_name="dequeue")
    async def _dequeue_action(self) -> ApiSuccessResponse | ApiFailResponse:
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        ident = body.get("id", body.get("index"))
        if ident is None:
            return ApiFailResponse(message="id or index is required")
        self.queue.dequeue(ident)
        await self.notify_updated()
        return ApiSuccessResponse(data=self.queue.read())

    @action.post(action_name="clear-queue")
    async def _clear_queue_action(self) -> ApiSuccessResponse | ApiFailResponse:
        self.queue.clear()
        await self.notify_updated()
        return ApiSuccessResponse(data=self.queue.read())

    @action.post(action_name="set-queue-enabled")
    async def _set_queue_enabled_action(self) -> ApiSuccessResponse | ApiFailResponse:
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        enabled = bool(body.get("enabled", True))
        self.queue.set_enabled(enabled)
        await self.notify_updated()
        if enabled:
            self._schedule_queue_drain("enable")
        return ApiSuccessResponse(data=self.queue.read())

    # ── Execution ─────────────────────────────────────────────────────────────

    async def prompt(self, instruction: str) -> ApiSuccessResponse | ApiFailResponse:
        """Schedule a worker run with *instruction* and return immediately.

        Routing:
          ``visible=True`` + worker alive (PTY) → write to PTY stdin (continues session)
          ``visible=True`` + worker dead        → ``start_pty(instruction)`` (PTY relaunch)
          ``visible=False`` (headless)          → ``self.driver.headless_prompt(...)``
                                                  — vendor-specific print-mode that
                                                  handles multi-step tool sequences.

        ``visible=True`` keeps the legacy PTY path so the UI's interactive
        terminal continues to work; the print-mode driver is only used for
        headless invocations (tests, server-side automations).

        Args:
            instruction: The prompt text to send.
        """
        if not self.visible:
            # Headless flow — no PTY/Shell. Driver decides how to spawn
            # its CLI, capture session_id, and manage lifecycle. Inline
            # cli_config + workdir is sufficient; the AP does NOT need
            # to be in DB. This unblocks bootstrap-time uses (e.g.
            # ``flow start`` spawning a migration agent before the
            # substrate is fully initialised).
            return await self.driver.headless_prompt(self, instruction)
        if not self.exist_in_db:
            return ApiFailResponse(message=f"AgenticProcess {self.id} not found in database")
        if await self.is_running():
            await self.send(instruction)
            return ApiSuccessResponse(data={"status": "sent"})
        return await self.start_pty(instruction=instruction)


    async def send(self, data: str | bytes) -> None:
        """Write text or raw bytes to the live PTY stdin.

        - str: sent via shell.write() (bracketed paste + \\r)
        - bytes: sent directly to the PTY without modification (use for control
          sequences like b"\\x1b" where appending \\r would break the intent)

        Requires start_pty() to have been called first.
        """
        shell = await self.shell()
        if not shell:
            raise ValueError("No shell linked — call start_pty() first")
        if isinstance(data, bytes):
            await shell.write_raw(data)
        else:
            await shell.write(data)

    async def stream_transcript(self, timeout: float = 300, poll_interval: float = 0.2):
        """Async-iterate JSONL transcript entries as the worker writes them.

        Yields parsed dicts, one per transcript line. Stops when the worker's
        ``tail_status`` (driver-supplied) reaches a terminal state, with a
        small settling window to avoid racing late writes.

        Vendor specifics — where the transcript lives, how to interpret its
        tail — come from ``self.driver``; this method is otherwise vendor-
        neutral.

        Args:
            timeout: Maximum seconds to wait for the process to reach idle.
            poll_interval: How often (seconds) to check for new transcript data.

        Raises:
            TimeoutError: if the process does not reach idle within ``timeout``.
        """
        from flow_sdk.builtin.worker_status import (
            WorkerStatus as _WS,
            _has_pending_tool_use,
            _last_assistant_stop_reason,
            _last_user_is_tool_result,
        )

        deadline = time.monotonic() + timeout

        # Wait until the driver can locate a transcript (worker has been
        # spawned and produced — or pre-touched — a session JSONL).
        transcript_path: Path | None = None
        while transcript_path is None:
            if time.monotonic() > deadline:
                raise TimeoutError(
                    "stream_transcript: transcript file did not appear within timeout"
                )
            transcript_path = self.driver.transcript_path(self)
            if transcript_path is None or not transcript_path.exists():
                transcript_path = None
                await asyncio.sleep(poll_interval)

        # Settling windows.
        # ``_settle_seconds`` (terminal): the worker emitted a terminal marker
        # (Claude's ``last-prompt`` / Codex's ``turn.completed``) but tool
        # side-effects can lag the marker by ~1-2 s on disk. Wait for the
        # transcript to stop growing before exiting.
        # ``_post_tool_settle_seconds`` (post-tool-idle, Claude only — codex
        # never enters this state): claude can take 5-10 s after the final
        # tool_result before emitting ``last-prompt``. Treat the lull as
        # soft-terminal so heavy multi-tool turns finish within 28 s, but
        # leave enough room for a follow-up ``tool_use`` to grow the file
        # and reset the timer.
        _settle_seconds = 2.0
        _post_tool_settle_seconds = 8.0
        _terminal_states = {_WS.COMPLETE, _WS.INTERRUPTED, _WS.INACTIVE}
        _terminal_since: float | None = None
        _terminal_size: int | None = None
        _post_tool_since: float | None = None
        _post_tool_size: int | None = None

        offset = 0
        while True:
            try:
                with open(transcript_path, "rb") as fh:
                    fh.seek(offset)
                    new_bytes = fh.read()
                    offset += len(new_bytes)
            except OSError:
                new_bytes = b""

            for raw_line in new_bytes.decode("utf-8", errors="replace").splitlines():
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    entry = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                # api_error means the LLM API is overloaded and the worker is
                # retrying. Extend the deadline so the retry can complete.
                if entry.get("type") == "system" and entry.get("subtype") == "api_error":
                    extended = time.monotonic() + 120
                    if extended > deadline:
                        logger.info(
                            "stream_transcript: api_error detected (attempt=%s), extending deadline by %.0fs",
                            entry.get("retryAttempt", "?"),
                            extended - deadline,
                        )
                        deadline = extended
                yield entry

            tail_status = self.driver.tail_status(transcript_path)
            _terminal = tail_status in _terminal_states
            # Post-tool-idle peek: only meaningful for Claude (Codex never
            # writes WAITING followed by tool_result without further events).
            # Only treat as soft-terminal when the last assistant turn ended with
            # ``stop_reason=end_turn``. ``stop_reason=tool_use`` means the model
            # is still planning the next call; sonnet routinely takes 9–17 s
            # between tool calls on multi-step flows, which exceeds the 8-s
            # post-tool settle window. Exiting then would drop the rest of the
            # work — the bug surfaced in test_agentic_process_fix_it_with_agent.
            _post_tool_idle = False
            if tail_status == _WS.WAITING:
                try:
                    with open(transcript_path, "rb") as _fh:
                        _sz = transcript_path.stat().st_size
                        if _sz > 4096:
                            _fh.seek(_sz - 4096)
                        _tail_chunk = _fh.read().decode("utf-8", errors="replace")
                    _post_tool_idle = (
                        _last_user_is_tool_result(_tail_chunk)
                        and not _has_pending_tool_use(_tail_chunk)
                        and _last_assistant_stop_reason(_tail_chunk) == "end_turn"
                    )
                except OSError:
                    pass

            try:
                cur_size = transcript_path.stat().st_size
            except OSError:
                cur_size = offset
            now = time.monotonic()

            if _terminal:
                if _terminal_since is None or _terminal_size != cur_size:
                    _terminal_since = now
                    _terminal_size = cur_size
                elif now - _terminal_since >= _settle_seconds:
                    return
                _post_tool_since = None
                _post_tool_size = None
            elif _post_tool_idle:
                if _post_tool_since is None or _post_tool_size != cur_size:
                    _post_tool_since = now
                    _post_tool_size = cur_size
                elif now - _post_tool_since >= _post_tool_settle_seconds:
                    # Tell ``_discover_status_from_transcript`` to report
                    # COMPLETE — the JSONL still says WAITING (no terminal
                    # marker yet) but all the side effects are flushed.
                    object.__setattr__(self, "_post_tool_idle_complete", True)
                    return
                _terminal_since = None
                _terminal_size = None
            else:
                _terminal_since = None
                _terminal_size = None
                _post_tool_since = None
                _post_tool_size = None

            if time.monotonic() > deadline:
                raise TimeoutError(f"stream_transcript: process did not reach idle within {timeout}s")

            await asyncio.sleep(poll_interval)

    def stream(self, instruction: str):
        """Stream live output as StreamEvent items from the JSONL transcript.

        Not yet implemented — requires async JSONL tailing (L effort).
        """
        raise NotImplementedError(
            "stream() is not yet implemented. "
            "For now: await proc.send(instruction); await proc.wait(); "
            "then read the transcript via ClaudeSessionRecord."
        )

    @action.post(action_name="execute")
    async def _http_execute(
        self,
        instruction: str | None = None,
        session_id: str | None = None,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Execute an instruction on this process.

        Called by the TS SDK's executeInstruction(). Delegates to prompt()
        which handles both fresh-start and send-to-running-process cases.
        """
        if not instruction:
            return ApiFailResponse(message="instruction is required")
        if session_id:
            self.session_id = session_id
        result = await self.prompt(instruction)
        if isinstance(result, ApiFailResponse):
            return result
        return result if isinstance(result, ApiSuccessResponse) else ApiSuccessResponse(data={"status": "ok"})

    # ── Print-mode streaming prompt ──────────────────────────────────────────
    #
    # POST /agentic_process/<id>/prompt
    #   body: { "message": "<text>" }
    # Response: chunked XML stream of FlowData elements (same wire format as
    # the legacy /completion). Admitted only for print-mode (visible=False)
    # processes that are ready-for-input. PTY/interactive processes reject
    # with 409 — they use the terminal tab UX.
    #
    # The worker (ClaudeCLIStreamWorker) runs ``claude -p --output-format
    # stream-json`` per turn; its events map to FlowData via
    # ``claude_event_to_flowdata.convert_event`` and land on the shared
    # StreamingResponseHandler queue for streaming back to the caller.

    @action.post(action_name="prompt")
    async def _http_prompt(self) -> Any:
        from starlette.responses import StreamingResponse  # local import — starlette is an app-layer dep

        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info")
        body = await request_info.get_post_data()
        if not isinstance(body, dict):
            return ApiFailResponse(message="Expected JSON object body")
        message = (body.get("message") or "").strip()
        if not message:
            return ApiFailResponse(message="message is required")

        # Admission gate — print mode only.
        # PTY processes are rejected (visible=true means the interactive terminal
        # owns the session). For print-mode we don't use ``is_ready_for_input``:
        # it requires ProcessStatus.RUNNING + an IDLE worker, which makes sense
        # for PTY but not here — print-mode processes have no persistent worker
        # between turns, so the only contention is whether a turn is already in
        # flight (enforced by the per-process lock below).
        if self.visible:
            return ApiFailResponse(
                message="process is PTY-interactive; prompt action requires visible=false (print mode)",
                status_code=409,
            )
        if self.status in (ProcessStatus.STOPPING.value, ProcessStatus.FAILED.value):
            return ApiFailResponse(
                message=f"process not sendable (status={self.status})",
                status_code=409,
            )

        lock = _get_prompt_lock(self.id)
        if lock.locked():
            return ApiFailResponse(
                message="another prompt turn is already in flight for this process",
                status_code=409,
            )

        # Context for the worker, reconstructed from the AgenticProcess entity.
        context = _AgenticContext(
            workdir=self.workdir,
            env_vars=dict(self.cli_options.env_vars) if hasattr(self, "cli_options") else {},
            model=(self.cli_config or {}).get("model"),
            permission_mode=(self.cli_config or {}).get("permission_mode", "bypassPermissions"),
            resume_session_id=self.session_id,
        )

        # Inline embedded-agent definitions (and persona directive when a single
        # agent is loaded) into the prompt — same path the SDK ``prompt()`` API
        # uses via ``driver.headless_prompt``. Without this, HTTP chat would
        # see the agent only as a delegable Task sub-agent and never adopt
        # the persona for free-form questions.
        composed_prompt = self.driver.compose_prompt(message, self.get_agents_json())

        handler = StreamingResponseHandler()

        async def _run_turn() -> None:
            """Drive the worker → handler pipeline. Runs as a background task."""
            worker = ClaudeCLIStreamWorker()
            _PROMPT_WORKERS[self.id] = worker
            try:
                async with lock:
                    # Kick off lifecycle transition so observers see RUNNING.
                    if self.status != ProcessStatus.RUNNING.value:
                        self.status = ProcessStatus.RUNNING.value
                        try:
                            await self.save()
                        except Exception:
                            # WARNING (not DEBUG) so headless / migration use
                            # cases can observe persistence failure. The catch
                            # is intentional: TestClient shutdown can pop the
                            # DB driver mid-turn (see project_testclient_close
                            # _db_split_brain memo) and we don't want to crash
                            # the turn over a transient race.
                            logger.warning("prompt: lifecycle save failed", exc_info=True)

                    async for fd in worker.execute(prompt=composed_prompt, context=context):
                        await handler.on_flow_data(fd)
                        # Persist session_id on first capture so subsequent turns resume.
                        if worker.get_session_id() and not self.session_id:
                            self.session_id = worker.get_session_id()
                            try:
                                await self.save()
                            except Exception:
                                logger.warning("prompt: session_id save failed", exc_info=True)
            except Exception as e:
                logger.exception("prompt: worker error")
                await handler.add_str_to_queue(Exception(f"prompt error: {e}"))
            finally:
                # Signal end-of-stream to downstream consumers.
                await handler.on_flow_data(None)
                _PROMPT_WORKERS.pop(self.id, None)

        turn_task = asyncio.create_task(_run_turn())

        async def _stream_body():
            try:
                async for xml_chunk in handler:
                    yield xml_chunk
            finally:
                if not turn_task.done():
                    # Client disconnected; let the turn finish to keep JSONL coherent,
                    # but don't block the HTTP handler beyond a short grace.
                    try:
                        await asyncio.wait_for(turn_task, timeout=1.0)
                    except (asyncio.TimeoutError, Exception):
                        pass

        return StreamingResponse(
            _stream_body(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @action.post(action_name="cancel-prompt")
    async def _http_cancel_prompt(self) -> ApiSuccessResponse | ApiFailResponse:
        """Cancel the in-flight prompt turn. Immediate: SIGTERM → 5s → SIGKILL."""
        worker = _PROMPT_WORKERS.get(self.id)
        if worker is None:
            return ApiFailResponse(message="no in-flight prompt turn")
        await worker.close_session()
        return ApiSuccessResponse(data={"cancelled": True})

    # ── Plan mode ─────────────────────────────────────────────────────────────

    @action.post(action_name="execute-plan")
    async def execute_plan(
        self,
        file_path: str,
        clear_context: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Tell Claude to execute the plan.

        If clear_context=True, inject '/clear' first.
        Sets the plan auto-approve flag so that when ExitPlanMode is called,
        the hook handler can auto-approve the PermissionRequest once.
        """
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            if clear_context:
                await self.inject("/clear")
                await asyncio.sleep(1)

            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>, if any, then execute plan"
            await self.inject(prompt)
            await asyncio.sleep(1.5)

            from flow_sdk.app.actions.listen import set_plan_auto_approve

            set_plan_auto_approve(self.id)
            _write_plan_frontmatter(file_path, {"executed": True})

            return ApiSuccessResponse(data={"injected": True})
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} execute-plan error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="update-plan")
    async def update_plan(
        self,
        file_path: str,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Tell Claude to update the plan based on <plan-note> annotations."""
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>"
            await self.inject(prompt)

            return ApiSuccessResponse(data={"ok": True})
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} update-plan error: {e}")
            return ApiFailResponse(message=str(e))

    @property
    def transcript(self):
        """Resolved transcript descriptor for this process, if one exists."""
        try:
            return self.driver.transcript_descriptor(self)
        except Exception:
            logger.debug("AgenticProcess %s transcript: driver lookup failed", self.id, exc_info=True)
            return None

    @property
    def transcript_path(self) -> Path | None:
        descriptor = self.transcript
        return descriptor.path if descriptor else None

    def _load_transcript(self, descriptor=None) -> "AgentTranscriptFile | None":
        """Worker-agnostic transcript loader.

        Resolves the JSONL via the vendor driver and parses it through the
        analyzer using the descriptor's native format. Returns None if no
        session is attached or the file is missing. Per-request load — no
        caching; eager parse is fast enough for current sizes.
        """
        from flow_sdk.transcript_analyzer import AgentTranscriptFile

        descriptor = descriptor or self.transcript
        if descriptor is None or not descriptor.path.exists():
            return None
        try:
            return AgentTranscriptFile(
                self.driver.name,
                descriptor.path,
                session_id=descriptor.session_id,
                transcript_format=descriptor.format,
            )
        except Exception:
            logger.debug("AgenticProcess %s _load_transcript: parse failed", self.id, exc_info=True)
            return None

    async def _persist_transcript_session_id(self, descriptor) -> None:
        if descriptor is None or not descriptor.session_id:
            return
        if self.session_id == descriptor.session_id:
            return
        self.session_id = descriptor.session_id
        try:
            self._set_start_lifecycle(True)
            if self.status == ProcessStatus.RUNNING.value:
                self.last_started_hash = self._restart_snapshot()
            await self.save()
        except Exception:
            # WARNING so resume-from-transcript regressions surface.
            logger.warning(
                "AgenticProcess %s transcript: session_id save failed",
                self.id,
                exc_info=True,
            )
        finally:
            self._set_start_lifecycle(False)

    @action.post(action_name="transcript")
    async def transcript_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Generic transcript surface dispatched by sub-path.

        Loads the JSONL once via the worker-agnostic ``_load_transcript()``
        and routes on the URL sub-path:

          * ``transcript/plan``   → resolve + persist + return latest plan.
          * ``transcript/prompts`` → return the user-prompt list.

        New sub-actions hang off the same loader without re-parsing.
        """
        request_info = get_current_request_info()
        sub_path_raw = (request_info.sub_path or "").strip("/").lower() if request_info else ""
        try:
            sub_path = TranscriptSubpath(sub_path_raw)
        except ValueError:
            sub_path = None

        descriptor = self.transcript
        await self._persist_transcript_session_id(descriptor)
        transcript = self._load_transcript(descriptor)

        if sub_path is TranscriptSubpath.PLAN:
            return await self._transcript_plan(transcript)
        if sub_path in {TranscriptSubpath.PROMPT, TranscriptSubpath.PROMPTS}:
            return self._transcript_prompts(transcript)
        if sub_path is TranscriptSubpath.FULL:
            return self._transcript_full(transcript, descriptor)
        return ApiFailResponse(message=f"unknown transcript sub-path: {sub_path_raw!r}")

    async def _transcript_plan(
        self, transcript: "AgentTranscriptFile | None",
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Resolve the latest plan, persist ``plan_path`` (existence-gated),
        and return the indexed Markdown.

        Resolution order for the path:
          1. ``transcript.latest_plan`` — an ``ExitPlanModeEntry`` emitted by
             either worker's parser (Claude from its ``ExitPlanMode`` tool;
             Codex synthesized from a ``<proposed_plan>`` marker).
             ``plan_file_path`` is the on-disk file the worker wrote — Claude
             writes directly; Codex's stream worker writes when it sees the
             marker on its JSONL stream.
          2. ``self.plan_path`` if already set (cache fallback).
          3. Most recent ``plan_mode`` attachment's ``planFilePath`` (Claude
             interactive PTY plan-mode).

        Existence on disk is the single gate for persisting ``plan_path`` —
        this keeps ``hasPlan = !!plan_path`` honest. Self-heals: clears a
        stale ``plan_path`` if the file is missing.
        """
        from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
        from flow_sdk.transcript_analyzer.entries.meta import MetaEntry

        plan_file_path = ""

        if transcript is not None:
            latest = transcript.latest_plan
            if isinstance(latest, ExitPlanModeEntry):
                plan_file_path = latest.plan_file_path

        if not plan_file_path:
            plan_file_path = self.plan_path or ""

        if not plan_file_path and transcript is not None:
            # plan_mode attachment fallback (Claude interactive PTY).
            for e in reversed(transcript.entries):
                if not isinstance(e, MetaEntry) or e.meta_kind != "attachment":
                    continue
                att = (e.payload or {}).get("attachment") or {}
                if att.get("type") == "plan_mode":
                    plan_file_path = str(att.get("planFilePath") or "")
                    if plan_file_path:
                        break

        if not plan_file_path or not Path(plan_file_path).exists():
            if self.plan_path:
                self.plan_path = None
                try:
                    await self.save()
                except Exception:
                    logger.warning(
                        "AgenticProcess %s transcript/plan: clear stale plan_path failed", self.id, exc_info=True
                    )
            return ApiSuccessResponse(data={"markdown": None, "plan_path": None})

        if self.plan_path != plan_file_path:
            self.plan_path = plan_file_path
            try:
                await self.save()
            except Exception:
                logger.warning(
                    "AgenticProcess %s transcript/plan: save plan_path failed", self.id, exc_info=True
                )

        try:
            from flow_sdk.fs_store.fs_ref import FSRef as _FSRef
            from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown

            records = extract_markdown(_FSRef(Path(plan_file_path)))
            if not records:
                return ApiFailResponse(message=f"could not parse {plan_file_path}")
            rec = records[0]
            await rec.sync_to_db()
            return ApiSuccessResponse(data={"markdown": rec.meta_dict(), "plan_path": plan_file_path})
        except Exception as e:
            logger.exception("AgenticProcess %s transcript/plan error: %s", self.id, e)
            return ApiFailResponse(message=str(e))

    def _transcript_prompts(
        self, transcript: "AgentTranscriptFile | None",
    ) -> ApiSuccessResponse:
        """Return the user-prompt list straight from the transcript.

        Filters applied by ``AgentTranscriptFile.prompts`` (sidechain, empty,
        Claude Code synthetic markers). Output shape mirrors the entry's
        ``to_dict()`` envelope so the TS analyzer mirror's ``fromJson``
        factory can hydrate ``UserMessageEntry`` instances directly.
        """
        if transcript is None:
            return ApiSuccessResponse(data={"prompts": []})
        return ApiSuccessResponse(data={
            "prompts": [e.to_dict() for e in transcript.prompts],
        })

    def _transcript_full(
        self,
        transcript: "AgentTranscriptFile | None",
        descriptor=None,
    ) -> ApiSuccessResponse:
        if transcript is None or descriptor is None:
            return ApiSuccessResponse(data={
                "worker_type": self.driver.name,
                "session_id": self.session_id,
                "path": None,
                "transcript_path": None,
                "transcript_format": None,
                "transcript_source": None,
                "header": {},
                "entries": [],
            })
        path = str(descriptor.path)
        return ApiSuccessResponse(data={
            "worker_type": self.driver.name,
            "session_id": transcript.session_id or descriptor.session_id,
            "path": path,
            "transcript_path": path,
            "transcript_format": descriptor.format.value,
            "transcript_source": descriptor.source.value,
            "header": self._transcript_header(transcript),
            "entries": [e.to_dict() for e in transcript.entries],
        })

    def _transcript_header(self, transcript: "AgentTranscriptFile") -> dict[str, Any]:
        meta = transcript._session_meta_payload()
        if not meta:
            return {}
        out: dict[str, Any] = {}
        for key in ("cwd", "cli_version", "originator", "model_provider"):
            value = meta.get(key)
            if value:
                out[key] = value
        git = meta.get("git")
        if isinstance(git, dict):
            out["git"] = {
                k: v
                for k, v in git.items()
                if k in {"branch", "commit_hash", "repository_url"} and v
            }
        return out

    @action.post(action_name="get-plan")
    async def get_plan(self) -> ApiSuccessResponse | ApiFailResponse:
        """Back-compat alias for ``transcript/plan`` — delegates to the new
        action so existing TS callers (``process.getPlan()``) keep working.
        """
        descriptor = self.transcript
        await self._persist_transcript_session_id(descriptor)
        return await self._transcript_plan(self._load_transcript(descriptor))

    # ── State ─────────────────────────────────────────────────────────────────

    @action.post(action_name="load-embedded-agent")
    async def load_embedded_agent_action(self, asset_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Load an agent from a VFS path and embed it into this process.

        Merges the agent spec into cli_config.agents_json so it survives across
        HTTP requests without relying on in-memory state.
        """
        from flow_sdk.fs_store.operations.agent import extract_agent_from_path, agent_to_cli_json  # noqa: PLC0415
        if not asset_ref:
            return ApiFailResponse(message="asset_ref is required")
        abs_path = Path("/" + asset_ref.lstrip("/"))
        if not abs_path.exists():
            return ApiFailResponse(message=f"Agent file not found: {abs_path}")
        agent = extract_agent_from_path(abs_path)
        agent_entry = agent_to_cli_json(agent)
        # Merge into cli_config so the agent is durably stored on the entity.
        cli_opts = ClaudeCliOptions.from_json(self.cli_config or {})
        cli_opts.agents_json = {**(cli_opts.agents_json or {}), **agent_entry}
        self.cli_config = cli_opts.to_json()
        await self.save()
        return ApiSuccessResponse(data={"ok": True, "name": agent.name})

    @action.post(action_name="load-embedded-skill")
    async def load_embedded_skill_action(self, asset_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Symlink a skill folder into this process's assets dir.

        Skills are directory-discovered by Claude Code at startup, not a CLI
        input. We symlink the live source folder under
        ``<assets_dir>/.claude/skills/<name>/`` so edits to the original SKILL.md
        flow through to the next chat without re-materialization.
        """
        import shutil
        if not asset_ref:
            return ApiFailResponse(message="asset_ref is required")
        skill_dir = Path("/" + asset_ref.lstrip("/")).resolve()
        if not skill_dir.is_dir():
            return ApiFailResponse(message=f"Skill folder not found: {skill_dir}")
        if not (skill_dir / "SKILL.md").exists():
            return ApiFailResponse(message=f"SKILL.md missing in: {skill_dir}")
        try:
            assets_dir = await self._assets_dir_path()
            assets_dir.mkdir(parents=True, exist_ok=True)
            skills_root = assets_dir / ".claude" / "skills"
            skills_root.mkdir(parents=True, exist_ok=True)
            link = skills_root / skill_dir.name
            # Refresh: a stale symlink, prior copy, or regular file all get replaced.
            if link.is_symlink() or link.is_file():
                link.unlink()
            elif link.is_dir():
                shutil.rmtree(link)
            link.symlink_to(skill_dir, target_is_directory=True)
            self._ensure_assets_dir_in_add_dirs(assets_dir)
            await self.save()
            return ApiSuccessResponse(data={"ok": True, "name": skill_dir.name, "link": str(link)})
        except Exception as exc:
            logger.exception("load_embedded_skill failed for %s", asset_ref)
            return ApiFailResponse(message=str(exc))

    def load_embedded_agent(self, agent: "Any") -> None:
        """Embed an agent into this process so it is registered via --agents at launch.

        Accepts an AgentRecord, any object with to_agents_json(), or a name string.
        Adds the agent's name to the persisted embedded_agent_ids list and stores
        the agent object in the in-memory _embedded_agents list.
        """
        from flow_sdk.fs_store.operations.agent import load_agent as _load_agent  # noqa: PLC0415
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
        _agents: list = object.__getattribute__(self, "__dict__").setdefault("_embedded_agents", [])
        if isinstance(agent, str):
            rec = _load_agent(agent) or FSRecord(type=RecordType.AGENT, name=agent, id=agent)
        else:
            # duck-type: Record or anything with name/id
            rec = agent
        _agents.append(rec)
        name = rec.name if hasattr(rec, "name") else str(agent)
        if name and name not in (self.embedded_agent_ids or []):
            self.embedded_agent_ids = list(self.embedded_agent_ids or []) + [name]

    def get_agents_json(self) -> "dict | None":
        """Return merged --agents JSON from all embedded agents, or None if none loaded.

        Falls back to the persisted ``cli_config.agents_json`` when no in-memory
        agents are loaded — required for HTTP-driven chat flows where
        ``load_embedded_agent_action`` persists the agent spec on ``cli_config``
        without rebuilding the in-memory list. Without this fallback,
        ``compose_prompt`` sees ``None`` and skips the persona directive, so
        the embedded agent only ever runs as a delegable Task sub-agent.
        """
        _agents: list = object.__getattribute__(self, "__dict__").get("_embedded_agents", [])
        if _agents:
            result: dict = {}
            for rec in _agents:
                result.update(rec.to_agents_cli_json())
            if result:
                return result
        persisted = (self.cli_config or {}).get("agents_json") or None
        return persisted or None

    # ── Embedded assets ────────────────────────────────────────────────────────
    # Unified attach/detach for agents, skills, and any future file-backed entity.
    # Materializes the entity's files under <record_dir>/assets/.claude/<type>/… so
    # Claude discovers them via `--add-dir <record_dir>/assets`.

    async def _assets_dir_path(self) -> "Path":
        """The filesystem directory where embedded assets are materialized.

        ``<records_root>/agentic_process/agentic_process-@<id>/execution/assets``
        """
        a = self._record_dir() / "execution" / "assets"
        a.mkdir(parents=True, exist_ok=True)
        return a

    def _ensure_assets_dir_in_add_dirs(self, assets_dir: "Path") -> None:
        """Idempotently append the assets dir to additional_dirs."""
        target = str(assets_dir)
        current = list(self.additional_dirs or [])
        if target not in current:
            current.append(target)
            self.additional_dirs = current

    async def _materialize_entity(self, ref: TypeId, assets_dir: "Path") -> str | None:
        """Copy the referenced entity's files under ``assets_dir/.claude/<type>/…``.

        Returns the entity's display name on success, ``None`` if the entity
        type is unsupported for embedding. Raises for resolution / IO failures.
        """
        import shutil
        from flow_sdk.fs_store.operations.agent import get_agent, load_agent as _load_agent  # noqa: PLC0415
        from flow_sdk.fs_store.operations.skill import get_skill, copy_skill_to

        if ref.type == "agent":
            # Resolve by id (uuid5-derived from the .md path) first, then fall back
            # to name-based lookup for agents the UI knows by name only.
            agent = get_agent(ref.id) or _load_agent(ref.id)
            if agent is None:
                raise FileNotFoundError(f"Agent not found: {ref.id}")
            target_dir = assets_dir / ".claude" / "agents"
            target_dir.mkdir(parents=True, exist_ok=True)
            src = agent.asset_ref._path if agent.asset_ref else None
            if src is None or not src.exists():
                raise FileNotFoundError(f"Agent source missing: {ref.id}")
            target = target_dir / f"{agent.name or ref.id}.md"
            shutil.copyfile(src, target)
            return agent.name or ref.id

        if ref.type == "skill":
            skill = get_skill(ref.id)
            if skill is None:
                raise FileNotFoundError(f"Skill not found: {ref.id}")
            target_root = assets_dir / ".claude" / "skills"
            copy_skill_to(skill, target_root)
            return skill.name or ref.id

        return None  # Unsupported type — caller decides to fail loudly.

    async def _unmaterialize_entity(self, ref: TypeId, assets_dir: "Path") -> None:
        """Best-effort removal of the files laid down by _materialize_entity."""
        import shutil
        from flow_sdk.fs_store.operations.agent import get_agent, load_agent as _load_agent  # noqa: PLC0415
        from flow_sdk.fs_store.operations.skill import get_skill

        if ref.type == "agent":
            agent = get_agent(ref.id) or _load_agent(ref.id)
            name = agent.name if agent else ref.id
            target = assets_dir / ".claude" / "agents" / f"{name}.md"
            if target.exists():
                target.unlink()
        elif ref.type == "skill":
            skill = get_skill(ref.id)
            name = skill.name if skill else ref.id
            target = assets_dir / ".claude" / "skills" / name
            if target.exists():
                shutil.rmtree(target)

    @action.post(action_name="attach-embedded-asset")
    async def attach_embedded_asset(self, entity_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Materialize ``entity_ref`` under the process's assets dir + add to --add-dir.

        Wire param is the serialized TypeId string (``agent-<id>`` / ``skill-<id>``);
        it's parsed into a ``TypeId`` at this boundary.
        """
        if not entity_ref:
            return ApiFailResponse(message="entity_ref is required")
        try:
            ref = TypeId(entity_ref)
            assets_dir = await self._assets_dir_path()
            name = await self._materialize_entity(ref, assets_dir)
            if name is None:
                return ApiFailResponse(message=f"Unsupported entity type for embed: {entity_ref}")
            self._ensure_assets_dir_in_add_dirs(assets_dir)
            refs = list(self.embedded_asset_refs or [])
            if not any(r.type == ref.type and r.id == ref.id for r in refs):
                refs.append(ref)
                self.embedded_asset_refs = refs
            await self.save()
            return ApiSuccessResponse(data={"ok": True, "name": name, "ref": entity_ref})
        except Exception as exc:
            logger.exception("attach_embedded_asset failed for %s", entity_ref)
            return ApiFailResponse(message=str(exc))

    @action.post(action_name="detach-embedded-asset")
    async def detach_embedded_asset(self, entity_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Remove materialized files + drop the ref from embedded_asset_refs."""
        if not entity_ref:
            return ApiFailResponse(message="entity_ref is required")
        try:
            ref = TypeId(entity_ref)
            assets_dir = await self._assets_dir_path()
            await self._unmaterialize_entity(ref, assets_dir)
            refs = [r for r in (self.embedded_asset_refs or []) if not (r.type == ref.type and r.id == ref.id)]
            self.embedded_asset_refs = refs
            await self.save()
            return ApiSuccessResponse(data={"ok": True, "ref": entity_ref})
        except Exception as exc:
            logger.exception("detach_embedded_asset failed for %s", entity_ref)
            return ApiFailResponse(message=str(exc))

    @action.get(action_name="list-embedded-assets")
    async def list_embedded_assets(self) -> "ApiSuccessResponse":
        """Return the current embedded_asset_refs as serialized TypeId strings."""
        refs = [str(r) for r in (self.embedded_asset_refs or [])]
        return ApiSuccessResponse(data={"refs": refs})

    # ── Asset descriptors (read-only unified view) ────────────────────────────

    async def get_asset_descriptors(self) -> list[AssetDescriptor]:
        """Return a unified list of assets visible to this process.

        Composed from three sources of truth:
          1. EMBEDDED   — ``self.embedded_asset_refs`` + computed materialized path.
          2. INLINE     — ``cli_config.agents_json`` (or ``embedded_agent_ids``
                           fallback). No file → ``posix_path=None``.
          3. Path-scan  — one ``Entity.assets_by_path()`` over the union of
                           user/project/workdir/additional_dirs, filtered to
                           ``EXECUTABLE_ASSET_TYPES`` and attributed to the
                           longest-prefix source.

        Duplicates across sources are intentional — the same source skill may
        appear as both EMBEDDED (materialized into the process) and USER_DIR
        (still globally available).
        """
        from flow_sdk.core.entity.entity_model import Entity, PathQueryOptions
        from flow_sdk.fs_store.path_utils import canonical_posix_path

        descriptors: list[AssetDescriptor] = []
        seen_embedded: set[str] = set()

        assets_dir = await self._assets_dir_path()

        # 1. EMBEDDED
        for ref in self.embedded_asset_refs or []:
            mat_path = await self._materialized_path_for(ref, assets_dir)
            descriptors.append(AssetDescriptor(
                typeid=str(ref),
                source=AssetSource.EMBEDDED,
                posix_path=canonical_posix_path(mat_path) if mat_path else None,
            ))
            seen_embedded.add(str(ref))

        # 2. INLINE (don't double-count anything already EMBEDDED)
        for tid in self._iter_inline_agent_typeids():
            if tid in seen_embedded:
                continue
            descriptors.append(AssetDescriptor(
                typeid=tid,
                source=AssetSource.INLINE,
                posix_path=None,
            ))

        # 3. Path-discovered
        sources = await self._collect_source_dirs(assets_dir)
        if sources:
            entities = await Entity.assets_by_path(PathQueryOptions(
                search_dirs=[s[0] for s in sources],
                types=list(EXECUTABLE_ASSET_TYPES),
                limit=10000,
            ))
            ranked = sorted(sources, key=lambda s: -len(s[0]))
            for ent in entities:
                ar_raw = getattr(ent, "asset_ref", None) or ""
                if not ar_raw:
                    continue
                ar = canonical_posix_path(ar_raw)
                match = next(
                    ((path, s) for path, s in ranked if ar == path or ar.startswith(path + "/")),
                    None,
                )
                if match is None:
                    continue
                src_dir, src = match
                descriptors.append(AssetDescriptor(
                    typeid=f"{ent.type or ent.get_type()}-{ent.id}",
                    source=src,
                    posix_path=ar,
                    source_dir=src_dir,
                ))

        return descriptors

    async def _collect_source_dirs(
        self, assets_dir: "Path"
    ) -> list[tuple[str, AssetSource]]:
        """Return distinct (canonical_posix_path, source) pairs to scan.

        Smart-scan rules:
          - user_home is always included.
          - project mount path is included if the process has a project_id.
          - workdir is included only when it's outside both user_home and
            project_dir (otherwise it would be a noisy duplicate).
          - additional_dirs are included except the auto-appended assets dir.
          - Final list is deduped on canonical path.
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        from flow_sdk.instance_settings import get_instance_settings

        pairs: list[tuple[str, AssetSource]] = []
        seen: set[str] = set()

        def _add(p: "str | Path | None", source: AssetSource) -> None:
            if not p:
                return
            try:
                key = canonical_posix_path(p)
            except (OSError, ValueError):
                return
            if not key or key in seen:
                return
            seen.add(key)
            pairs.append((key, source))

        _add(get_instance_settings().user_home, AssetSource.USER_DIR)

        project_dir: str | None = None
        if self.project_id:
            try:
                from flow_sdk.builtin.project import Project
                proj = await Project.get_by_id(self.project_id)
                project_dir = getattr(proj, "fs_storage_mount_path", None) if proj else None
            except Exception:
                project_dir = None
        _add(project_dir, AssetSource.PROJECT_DIR)

        # WORKDIR — only if outside the previously-added paths.
        wd = getattr(self, "workdir", None)
        if wd:
            try:
                wd_key = canonical_posix_path(wd)
                if wd_key and wd_key not in seen and not any(
                    wd_key == k or wd_key.startswith(k + "/") for k in seen
                ):
                    pairs.append((wd_key, AssetSource.WORKDIR))
                    seen.add(wd_key)
            except (OSError, ValueError):
                pass

        # ADDITIONAL_DIR — exclude the auto-appended assets dir.
        try:
            assets_key = canonical_posix_path(assets_dir)
        except (OSError, ValueError):
            assets_key = ""
        for d in self.additional_dirs or []:
            try:
                key = canonical_posix_path(d)
            except (OSError, ValueError):
                continue
            if not key or key == assets_key or key in seen:
                continue
            seen.add(key)
            pairs.append((key, AssetSource.ADDITIONAL_DIR))

        return pairs

    async def _materialized_path_for(
        self, ref: TypeId, assets_dir: "Path"
    ) -> "Path | None":
        """Compute the on-disk path of a materialized embedded asset.

        Mirrors the layout written by ``_materialize_entity``:
          - ``agent`` → ``<assets_dir>/.claude/agents/<name>.md``
          - ``skill`` → ``<assets_dir>/.claude/skills/<name>``

        TODO: when ``Record.materialize_into`` (tier 1 alignment) lands, swap
        this for ``record.materialize_into(assets_dir).path`` so the layout is
        owned by the record subclass instead of duplicated here.
        """
        try:
            if ref.type == "agent":
                from flow_sdk.fs_store.operations.agent import get_agent, load_agent as _load_agent  # noqa: PLC0415
                rec = get_agent(ref.id) or _load_agent(ref.id)
                if rec is None:
                    return None
                name = rec.name or ref.id
                return assets_dir / ".claude" / "agents" / f"{name}.md"
            if ref.type == "skill":
                from flow_sdk.fs_store.operations.skill import get_skill
                rec = get_skill(ref.id)
                if rec is None:
                    return None
                name = rec.name or ref.id
                return assets_dir / ".claude" / "skills" / name
        except Exception:
            return None
        return None

    def _iter_inline_agent_typeids(self) -> list[str]:
        """Yield ``agent-<id-or-name>`` strings for inline-attached agents.

        Primary source: keys of ``cli_config.agents_json``. These are agent
        names (or ids) injected via ``--agents`` at session launch.
        Fallback: ``embedded_agent_ids`` when ``cli_config.agents_json`` is
        absent or empty.
        """
        cfg = self.cli_config or {}
        agents_json = cfg.get("agents_json") or {}
        if isinstance(agents_json, dict) and agents_json:
            return [f"agent-{k}" for k in agents_json.keys()]
        return [f"agent-{name}" for name in (self.embedded_agent_ids or [])]

    # ── Restart-required tracking ─────────────────────────────────────────────

    @staticmethod
    def _normalize_restart_value(value: Any) -> Any:
        """Canonicalize values before hashing restart snapshots.

        Entity serialization may prune null optional fields while in-memory
        CLI option objects often include them. Dict-level ``None`` removal
        makes explicit null and missing optional keys equivalent.
        """
        if isinstance(value, Enum):
            return value.value
        if isinstance(value, TypeId):
            return str(value)
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, dict):
            normalized: dict[str, Any] = {}
            for key, item in value.items():
                normalized_item = AgenticProcess._normalize_restart_value(item)
                if normalized_item is not None:
                    normalized[str(key)] = normalized_item
            return normalized
        if isinstance(value, (list, tuple)):
            return [AgenticProcess._normalize_restart_value(item) for item in value]
        if isinstance(value, set):
            return sorted(
                AgenticProcess._normalize_restart_value(item) for item in value
            )
        return value

    def _restart_driver(self) -> WorkerDriver | None:
        """Resolve the driver from the current worker_type value."""
        try:
            return get_driver(self.worker_type)
        except ValueError:
            return None

    def _finalized_restart_cli_options(self) -> WorkerCLIOptions:
        """Launch-options snapshot for restart-comparison hashing. Excludes
        runtime env injection + resume-gated transcript cwd lookup — those are
        derived from transcript state that drifts between start-time and
        save-time, which would light a phantom restart glow. The live launch
        path applies them; the hash strips ``resume`` via ``restart_payload_from_cli_options``.
        """
        driver = self._restart_driver()
        if driver is None:
            raise ValueError(f"No WorkerDriver registered for worker_type={self.worker_type!r}")
        cmd = driver.cli_options(self)

        # Server-restart resume: process had a shell but cli_config didn't
        # encode resume. Effective launch shape; stripped from the hash.
        if not getattr(cmd, "resume", False) and self.session_id:
            cmd.resume = self._is_exist_claude_resume_session(self.session_id)

        return cmd

    def _generic_restart_snapshot_payload(self, driver: WorkerDriver | None) -> dict[str, Any]:
        worker_type: Any = driver.name if driver is not None else self.worker_type
        return {
            "worker_type": worker_type,
            "shell_mode": self.shell_mode,
            "workdir": self.workdir,
            "session_id": self.session_id,
            "additional_dirs": sorted(self.additional_dirs or []),
            "embedded_asset_refs": sorted(
                str(r) for r in (self.embedded_asset_refs or [])
            ),
            "embedded_agent_ids": sorted(self.embedded_agent_ids or []),
        }

    def _restart_snapshot_payload(self) -> dict[str, Any]:
        driver = self._restart_driver()
        if driver is None:
            return {
                "generic": self._generic_restart_snapshot_payload(driver),
                "worker": {"cli_config": self.cli_config or {}},
            }
        options = self._finalized_restart_cli_options()
        return {
            "generic": self._generic_restart_snapshot_payload(driver),
            "worker": driver.restart_snapshot(self, options),
        }

    def _restart_snapshot(self, payload: dict[str, Any] | None = None) -> str:
        """Stable hash over finalized generic + worker launch inputs.

        Mismatch against ``last_started_hash`` (captured at last successful
        ``start_pty()``) means the live worker is running with stale config —
        ``restart_required`` flips True via the ``save()`` hook below.

        Callers that already built the payload (e.g. start_pty's capture site,
        which also persists it as ``last_started_snapshot``) can pass it in so
        snapshot and hash are derived from a single evaluation.
        """
        import hashlib
        import json as _json

        if payload is None:
            payload = self._restart_snapshot_payload()
        normalized = self._normalize_restart_value(payload)
        return hashlib.md5(
            _json.dumps(normalized, sort_keys=True, default=str).encode()
        ).hexdigest()

    def _set_start_lifecycle(self, value: bool) -> None:
        """Mark whether ``start_pty()`` is currently mutating this entity.

        While True the ``save()`` hook skips the auto-flag-flip so intermediate
        saves inside ``start_pty()`` (status, session_id) don't trip the detector.
        """
        object.__getattribute__(self, "__dict__")["_in_start_lifecycle"] = bool(value)

    def _is_in_start_lifecycle(self) -> bool:
        return bool(
            object.__getattribute__(self, "__dict__").get("_in_start_lifecycle", False)
        )

    async def save(self, owner=None, notify: bool = True):
        """Override to maintain ``restart_required`` automatically.

        On every save, if the process is RUNNING and the worker-relevant
        snapshot differs from ``last_started_hash``, flip the flag. Skipped
        during ``start_pty()`` itself (intermediate saves there are bookkeeping,
        not config drift) — see ``_set_start_lifecycle``.

        External callers can still set ``restart_required`` directly; the
        hook only flips it ON, never explicitly clears it (clearing happens
        only on successful ``start_pty()``).
        """
        if (
            not self._is_in_start_lifecycle()
            and self.status == ProcessStatus.RUNNING.value
            and self.last_started_hash
            and self._restart_snapshot() != self.last_started_hash
        ):
            self.restart_required = True
        return await super().save(owner=owner, notify=notify)

    @action.get(action_name="get-assets")
    async def get_assets_action(self) -> "ApiSuccessResponse":
        """HTTP wrapper around ``get_asset_descriptors``."""
        items = await self.get_asset_descriptors()
        return ApiSuccessResponse(data={"assets": [
            {
                "typeid": d.typeid,
                "source": d.source.value,
                "posix_path": d.posix_path,
                "source_dir": d.source_dir,
            }
            for d in items
        ]})

    @action.get(action_name="get-history")
    async def get_history_action(self) -> "ApiSuccessResponse":
        """Return this process's transcript as a list of FlowData dicts.

        Driver-supplied. Stateless — works for processes that have exited
        (no live worker required). Empty result is a success with
        ``history=[]``, not a 404.
        """
        history = self.driver.load_history(self)
        return ApiSuccessResponse(
            data={
                "session_id": self.session_id,
                "use_worker_history": True,
                "count": len(history),
                "history": [fd.model_dump(mode="python") for fd in history],
            }
        )

    @staticmethod
    def _diff_snapshot_fields(
        loaded: dict[str, Any] | None,
        current: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Return per-field differences between two ``{generic, worker}`` payloads.

        Normalizes both sides through ``_normalize_restart_value`` so equality
        matches the hash semantics in ``_restart_snapshot``. Keys present on
        only one side are reported with the missing side as None.
        """
        if not loaded:
            return []
        norm_loaded = AgenticProcess._normalize_restart_value(loaded) or {}
        norm_current = AgenticProcess._normalize_restart_value(current) or {}
        changes: list[dict[str, Any]] = []
        for section in ("generic", "worker"):
            l_section = norm_loaded.get(section) or {}
            c_section = norm_current.get(section) or {}
            for field in sorted(set(l_section) | set(c_section)):
                l_val = l_section.get(field)
                c_val = c_section.get(field)
                if l_val != c_val:
                    changes.append({
                        "section": section,
                        "field": field,
                        "loaded": l_val,
                        "current": c_val,
                    })
        return changes

    @action.get(action_name="restart-info")
    async def restart_info_action(self) -> "ApiSuccessResponse":
        """Read-only diff between the live worker's launch payload and the
        current entity snapshot. Powers the 'Command Status' debug viewer.

        ``loaded`` is the payload captured at last successful ``start_pty()``
        (None before first start). ``current`` is computed live from the
        entity's current fields. ``changed`` lists the field paths that
        differ — empty when nothing has drifted since last start.
        """
        current = self._restart_snapshot_payload()
        loaded = self.last_started_snapshot
        changed = self._diff_snapshot_fields(loaded, current)
        return ApiSuccessResponse(
            data={
                "restart_required": self.restart_required,
                "running": self.status == ProcessStatus.RUNNING.value,
                "worker_type": current.get("generic", {}).get("worker_type"),
                "loaded": loaded,
                "current": current,
                "changed": changed,
            }
        )

    @cached_property
    def driver(self) -> WorkerDriver:
        """The vendor-specific driver for this process's ``worker_type``.

        Resolved via ``get_driver(worker_type)`` — defaults to the value of
        ``FLOWPAD_DEFAULT_WORKER`` (``claude`` if unset) when ``worker_type``
        is ``None``. Cached on the entity instance so we don't re-import
        the driver module on every property access.
        """
        return get_driver(self.worker_type)

    @property
    def cli_options(self) -> "ClaudeCliOptions":
        """Deserialize cli_config into a live ``WorkerCLIOptions`` via the driver.

        Return type is declared as ``ClaudeCliOptions`` for backward-compat
        with callers that accept the legacy Claude shape, but at runtime the
        actual class depends on ``self.worker_type`` and shares the
        ``WorkerCLIOptions`` base contract (``workdir``, ``env_vars``,
        ``add_dirs``, ``to_shell_string``).
        """
        return get_driver(self.worker_type).cli_options(self)  # type: ignore[return-value]

    @property
    def cmd_line(self) -> str:
        """Return the full CLI command string that would be used to launch this process."""
        return self.cli_options.to_shell_string()

    def to_dict(self) -> dict:
        d = super().to_dict()
        computed = self.fetch_worker_status()
        d["worker_status"] = str(computed) if computed else WorkerStatus.IDLE.value
        ready = is_ready_for_input(self, computed)
        d["ready_for_input"] = ready
        d["ready_for_input_since"] = self._ready_for_input_since() if ready else None
        d["queue"] = self._queue_state()
        return d

    @model_serializer(mode="wrap")
    def api_json_serializer(self, nxt, info: SerializationInfo):
        data = super().api_json_serializer(nxt, info)
        if info.context and info.context.get("skip_api_serializer"):
            return data
        if data is None:
            return None
        computed = self.fetch_worker_status()
        data["worker_status"] = str(computed) if computed else WorkerStatus.IDLE.value
        ready = is_ready_for_input(self, computed)
        data["ready_for_input"] = ready
        data["ready_for_input_since"] = self._ready_for_input_since() if ready else None
        data["queue"] = self._queue_state()
        # Surface the live launch command so the UI (run drawer, session info
        # popover, etc.) can show what was actually spawned. Failure-tolerant:
        # if a driver hasn't been wired or the cli_config is malformed, omit
        # the field rather than failing the whole entity serialization.
        try:
            data["cmd_line"] = self.cmd_line
        except Exception:
            data["cmd_line"] = None
        # Derive per-process execution folders when absent from the row.
        # Rows synced before this field existed have no folder dicts; the
        # record's on-disk layout is deterministic from (type, id), so we
        # resolve folders via a bare record + its default_path.
        missing = [a for a in ("exe_folder", "input_folder", "output_folder", "assets_folder") if not data.get(a)]
        if missing and self.id:
            try:
                base = self._record_dir()
                folder_map = {
                    "exe_folder": base / "execution",
                    "input_folder": base / "execution" / "input",
                    "output_folder": base / "execution" / "output",
                    "assets_folder": base / "execution" / "assets",
                }
                for attr in missing:
                    p = folder_map.get(attr)
                    if p is not None:
                        p.mkdir(parents=True, exist_ok=True)
                        data[attr] = FSRef(p).to_dict()
            except Exception:
                pass
        return data

    def fetch_worker_status(self) -> WorkerStatus | None:
        """Public accessor for the live worker status.

        Derives the status from the worker's session transcript tail (via the
        driver) plus liveness reconciliation — see
        :meth:`_discover_status_from_transcript` for the projection rules.
        This is the supported entry point; call it instead of the private
        projection. Each call is a transcript tail-read, so a path that needs
        the value more than once should fetch once and pass it along (e.g.
        ``is_ready_for_input(self, worker_status=...)``).
        """
        return self._discover_status_from_transcript()

    def _discover_status_from_transcript(self) -> WorkerStatus | None:
        """Derive status from the worker's session transcript via the driver.

        Internal projection — do NOT call directly from outside this class;
        use :meth:`fetch_worker_status`. (Tests monkeypatch THIS method as the
        single implementation point; the public accessor delegates here.)

        If ``stream_transcript`` exited via the post-tool-idle settle (worker
        finished its tool work but hasn't emitted its terminal marker yet),
        ``self._post_tool_idle_complete`` is set so subsequent status reads
        agree with the early exit — without that flag, ``is_ready_for_input``
        would still see ``WAITING`` and the test's ``assert is_ready_for_input
        is True`` would fail despite all artifacts being on disk.

        For visible/PTY processes, falls back to a synchronous OS pid liveness
        check when the transcript yields a non-terminal status. Codex's TUI
        doesn't write the standard JSONL transcript, so without this
        reconciliation ``worker_status`` would stay ``initializing`` forever
        after the OS process dies (e.g. user kills the codex tab from outside).
        """
        if getattr(self, "_post_tool_idle_complete", False):
            return WorkerStatus.COMPLETE
        # Headless multi-turn: the JSONL tail keeps reporting the prior
        # turn's ``end_turn`` (→ COMPLETE) until the new turn's worker
        # writes its own ``end_turn``. ``headless_prompt`` sets
        # ``_turn_in_flight`` while the worker spins up so the projection
        # reports INITIALIZING — otherwise the end-of-turn broadcast
        # carries COMPLETE → COMPLETE and the SDK mirror sees no edge.
        # INITIALIZING is semantically correct: worker spawned, transcript
        # not yet materialised.
        if getattr(self, "_turn_in_flight", False):
            return WorkerStatus.INITIALIZING
        path = self.driver.transcript_path(self)
        if path is None:
            if self.status in {
                ProcessStatus.STARTING.value,
                ProcessStatus.RUNNING.value,
                ProcessStatus.STOPPING.value,
            } and (self.session_id or self.shell_id):
                derived: WorkerStatus | None = WorkerStatus.INITIALIZING
            else:
                return None
        else:
            derived = self.driver.tail_status(path)

        if (
            self.visible
            and self.shell_id
            and self.status == ProcessStatus.RUNNING.value
            and derived in _NON_TERMINAL_WORKER_STATUSES
            and not _shell_worker_pid_alive(self.shell_id)
        ):
            return WorkerStatus.INACTIVE

        # Project terminal underlying status to PENDING_USER (recent) or
        # INACTIVE (aged > 5min) based on ``terminal_at``. The 5-minute window
        # used to be FE-derived from ``ready_for_input_since``; this brings
        # the decision backend-side so every consumer (serializer, get_status,
        # is_ready_for_input) sees the same projected value.
        if derived in _PROJECTABLE_TERMINAL and self.terminal_at is not None:
            age = (datetime.now(timezone.utc) - self.terminal_at).total_seconds()
            return WorkerStatus.PENDING_USER if age < 300 else WorkerStatus.INACTIVE
        return derived

    @action.all(action_name="status")
    async def get_status(self):
        """Return current app status and computed worker_status from transcript."""
        worker_status = self.fetch_worker_status()
        ready = is_ready_for_input(self, worker_status)
        return ApiSuccessResponse(data={
            "status": self.status,
            "worker_status": str(worker_status) if worker_status else WorkerStatus.IDLE.value,
            "ready_for_input": ready,
            "ready_for_input_since": self._ready_for_input_since() if ready else None,
        })

    def _ready_for_input_since(self) -> float | None:
        """Epoch-ms timestamp approximating when the worker became ready-for-input.

        Derived from the transcript file's mtime: the worker writes the
        completion / interrupt / idle entry that puts it into a ready state,
        and then stops writing — so mtime is stable at "became ready at" for
        as long as the worker stays ready. None when the transcript is
        unavailable (pre-prompt worker, missing path).

        Used by the UI pending-action store to keep glow state idempotent
        across page refreshes: refresh sees the same timestamp, so already-
        acknowledged transitions don't re-arm.
        """
        try:
            path = self.driver.transcript_path(self)
            if path is None or not path.exists():
                return None
            return path.stat().st_mtime * 1000.0
        except Exception:
            return None

    @property
    def is_idle(self) -> bool:
        """True when not in a running lifecycle state (NEW/STOPPED/FAILED)."""
        return self.status in {
            ProcessStatus.NEW.value,
            ProcessStatus.STOPPED.value,
            ProcessStatus.FAILED.value,
        }

    async def is_running(self) -> bool:
        """True when the Claude CLI worker process is actively running in the PTY."""
        shell = await self.shell()
        if shell is None:
            return False
        return await shell.worker_alive()

    # ── Advanced API ──────────────────────────────────────────────────────────

    async def shell(self) -> "Shell | None":
        """The Shell entity for this process. None until start_pty() is called.

        Async method — requires Shell.get_by_id() DB lookup.
        Use for reading raw PTY output, attaching WS viewers, inspecting worker PID.
        """
        if not self.shell_id:
            return None
        from flow_sdk.builtin.shell import Shell
        return await Shell.get_by_id(self.shell_id)

    async def get_compute_node(self):
        """Return the linked shell's compute node, or None when no shell exists."""
        shell = await self.shell()
        return shell.compute_node if shell else None

    async def set_session_id(self, session_id: str) -> None:
        """Bind this process to an existing Claude session before start_pty()."""
        self.session_id = session_id
        await self.save()

    async def inject(self, message: str) -> None:
        """Inject a message directly into the live PTY, bypassing prompt() routing.

        Sends Escape first (200ms wait) to dismiss any active numeric prompt,
        then sends message as keystrokes.
        Use for: /clear, /rename, custom slash commands, debugging PTY state.
        """
        if not self.shell_id:
            logger.warning("AgenticProcess %s: no active shell, cannot inject message", self.id)
            return

        await self.send(b"\x1b")
        await asyncio.sleep(0.2)

        logger.info("AgenticProcess %s: injecting message: %s", self.id, message[:80])
        await self.send(message)

    @property
    def assistant_enabled(self) -> bool:
        """Whether the Flowpad Assistant project is mounted for this process.

        The per-process ``load_flowpad_assistant`` flag wins when explicitly
        set (True/False); otherwise it inherits the global
        ``ServiceConfig.load_flowpad_assistant`` default. The driver reads
        THIS (not the global) when building the worker's ``--add-dir`` set.
        """
        if self.load_flowpad_assistant is not None:
            return self.load_flowpad_assistant
        from flow_sdk.config import default_service_config  # noqa: PLC0415
        return default_service_config.load_flowpad_assistant

    @property
    def resolved_add_dirs(self) -> list[str]:
        """The ``--add-dir`` set the driver should mount for this process.

        ``additional_dirs`` plus the Flowpad Assistant project root prepended
        when :attr:`assistant_enabled` (de-duped so an explicit copy in
        ``additional_dirs`` doesn't double it). Both the PTY and print-mode
        driver paths read this so they mount the same surface.
        """
        dirs = list(self.additional_dirs or [])
        if not self.assistant_enabled:
            return dirs
        from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415
        core_dir = str(flowpad_assistant_project_root())
        return [core_dir] + [d for d in dirs if d != core_dir]

    def enable_assistant(self) -> "AgenticProcess":
        """Mount the Flowpad Assistant for this process (skills/agents discoverable).

        Currently just flips the per-process ``load_flowpad_assistant`` flag
        on; the driver picks it up via :attr:`assistant_enabled` when building
        the worker command. Returns ``self`` for chaining — the caller persists
        via ``save()``.
        """
        self.load_flowpad_assistant = True
        return self

    @action.post(action_name="add-dir")
    async def add_dir(self, path: str) -> "ApiResponse":
        """Append a directory to additional_dirs (passed to Claude via --add-dir).

        Also kicks off a one-shot indexer scan over the new path so any skills
        / agents living under it become discoverable via ``get_asset_descriptors``
        without requiring a manual ``flow record index``.
        """
        from flow_sdk.responses.response import ApiSuccessResponse
        if path not in (self.additional_dirs or []):
            self.additional_dirs = list(self.additional_dirs or []) + [path]
            await self.save()
            await _index_additional_dir(path)
        return ApiSuccessResponse()

    @action.post(action_name="remove-dir")
    async def remove_dir(self, path: str) -> "ApiResponse":
        """Remove a directory from additional_dirs. No-op if not present."""
        from flow_sdk.responses.response import ApiSuccessResponse
        if path in (self.additional_dirs or []):
            self.additional_dirs = [d for d in (self.additional_dirs or []) if d != path]
            await self.save()
        return ApiSuccessResponse()

    # ── Timeout handling ──────────────────────────────────────────────────────

    async def _on_timeout(self) -> None:
        """Called when API_TIMEOUT is detected (no LLM response for 30s after user prompt).

        Invisible processes: kills the worker (SIGTERM → SIGKILL) so they don't
        linger consuming resources. The JSONL will eventually go stale → INACTIVE.

        Visible processes: worker is left alive (API may recover); the UI shows a
        toast with Terminate / Keep Waiting options.
        """
        if self.visible:
            return
        shell = await self.shell()
        if shell:
            await shell.terminate_worker()

    # ── Close ─────────────────────────────────────────────────────────────────

    async def close(self) -> bool:
        """Terminate this process and close its linked shell.

        Returns True on success, False if already terminated or on error.
        """
        logger.info(f"AgenticProcess {self.id}: close")

        try:
            shell_id = self.shell_id
            self.status = ProcessStatus.STOPPING.value
            self.visible = False
            await self.save()

            if shell_id:
                from flow_sdk.builtin.shell import Shell
                shell: Shell = await Shell.get_by_id(shell_id)
                if shell:
                    await shell.close()

            self.shell_id = None
            self.sidecar_shell_id = None
            self.status = ProcessStatus.STOPPED.value
            await self.save()
            return True

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} close error: {e}")
            self.status = ProcessStatus.FAILED.value
            await self.save()
            return False

    # ── HTTP actions ──────────────────────────────────────────────────────────

    @action.post(action_name="open")
    async def _http_open(self) -> ApiSuccessResponse | ApiFailResponse:
        """HTTP: invoke :meth:`start_pty` and move lifecycle status to starting/running.

        Action name kept as ``open`` for back-compat with existing UI / TS SDK
        clients; the underlying behaviour is PTY spawn (``start_pty``).

        POST body: {instruction?, visible?, session_id?}
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        instruction = body.get("instruction")
        visible = body.get("visible")
        # Support legacy worker_session_id in POST body for older clients
        session_id_override = body.get("session_id") or body.get("worker_session_id")
        if session_id_override:
            self.session_id = session_id_override
        return await self.start_pty(instruction=instruction, visible=visible)

    async def reap_if_orphaned(self, *, grace_seconds: int = 10) -> bool:
        """Force-complete a stuck STOPPING transition when the worker is gone.

        Same liveness predicates ``os_status`` exposes (``has_attachable_pty``
        + ``worker_alive``). Writes ``STOPPED`` only when the row is
        ``STOPPING``, has been in that state for at least ``grace_seconds``
        (don't race live transitioners), and the worker is demonstrably gone.

        Returns True iff the persisted status was advanced. Idempotent —
        calling on a non-STOPPING row is a cheap no-op.
        """
        from datetime import datetime, timedelta, timezone
        if self.status != ProcessStatus.STOPPING.value:
            return False
        updated = self.updated_date
        if updated and isinstance(updated, str):
            try:
                updated = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            except Exception:
                updated = None
        cutoff = datetime.now(tz=timezone.utc) - timedelta(seconds=grace_seconds)
        if updated and updated > cutoff:
            return False
        shell = await self.shell() if self.shell_id else None
        has_pty = False
        alive = False
        if shell is not None:
            try:
                has_pty = bool(await shell.has_attachable_pty())
            except Exception:
                has_pty = False
            try:
                alive = bool(await shell.worker_alive())
            except Exception:
                alive = False
        if has_pty or alive:
            return False
        self.status = ProcessStatus.STOPPED.value
        await self.save()
        return True

    async def _collect_os_status_payload(self) -> dict:
        """Build the os-status payload for this process. Pure data-collection;
        no lifecycle side effects. Shared by the per-process ``os-status``
        action and the compute_node-level ``os-status-batch`` endpoint —
        both surface the exact same wire shape per-process.
        """
        shell = await self.shell() if self.shell_id else None

        pty_alive = False
        worker_is_alive = False
        has_attachable = False
        pty_pid: int | None = None
        worker_pid: int | None = None
        worker_name: str | None = None
        shell_status: str | None = None

        if shell is not None:
            shell_status = shell.status
            worker_pid = shell.worker_pid
            worker_name = shell.worker_name
            try:
                has_attachable = await shell.has_attachable_pty()
            except Exception as exc:
                logger.warning("os_status: has_attachable_pty failed for %s: %s", self.id, exc)
                has_attachable = False
            try:
                pty_alive = bool(shell.is_alive)
            except Exception:
                pty_alive = False
            try:
                worker_is_alive = await shell.worker_alive()
            except RuntimeError:
                # ``worker_alive`` raises when the PTY exists but its session
                # is dead — for a status read we treat that as "not alive".
                worker_is_alive = False
            except Exception as exc:
                logger.warning("os_status: worker_alive failed for %s: %s", self.id, exc)
                worker_is_alive = False
            if shell.compute_node_id:
                try:
                    cn = shell.compute_node
                    pty_pid_val = cn.compute_provider.get_pty_shell_pid(cn.node_provider_id, shell.id)
                    pty_pid = int(pty_pid_val) if pty_pid_val is not None else None
                except Exception:
                    pty_pid = None

        ready = has_attachable and worker_is_alive

        if ready:
            reason = None
        elif not self.shell_id:
            reason = "no shell linked to process"
        elif shell is None:
            reason = f"shell {self.shell_id} not found"
        elif not has_attachable:
            reason = "pty session not attachable"
        elif not worker_is_alive:
            reason = "worker pid not alive or cmdline mismatch"
        else:
            reason = None

        return {
            "process_id": self.id,
            "process_status": self.status,
            "shell_id": self.shell_id,
            "shell_status": shell_status,
            "session_id": self.session_id,
            "pty_pid": pty_pid,
            "worker_pid": worker_pid,
            "worker_name": worker_name,
            "pty_alive": pty_alive,
            "worker_alive": worker_is_alive,
            "has_attachable_pty": has_attachable,
            "ready": ready,
            "reason": reason,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    @action.get(action_name="os-status")
    async def os_status(self) -> ApiSuccessResponse:
        """OS-level status snapshot for this AgenticProcess.

        Single source of truth for "is this thing alive?". Combines:
          - Persisted entity status (process + linked shell records).
          - In-memory PTY-session liveness on the bound compute node.
          - Real PID liveness check on the worker (psutil + cmdline match).

        ``ready`` is the headline: True iff the PTY session is alive AND the
        worker PID matches the recorded ``--session-id``/``--resume`` value.
        It's the answer the frontend ``AgenticProcess.isAlive()`` returns.

        Read-only with respect to lifecycle. ``has_attachable_pty`` /
        ``worker_alive`` may opportunistically rebind a stale compute-node
        link (self-healing), but never spawns or kills anything.

        For multi-process callers (the SDK's auto-recovery sweep) prefer the
        compute_node-level ``os-status-batch`` action — one request, same
        per-process payload, gathered concurrently server-side.
        """
        return ApiSuccessResponse(data=await self._collect_os_status_payload())

    @action.post(action_name="close")
    async def _http_close(self) -> ApiSuccessResponse | ApiFailResponse:
        """HTTP: Permanent teardown — kill worker + delete shell entity.

        Delegates to close(), then returns an ApiResponse for the HTTP layer.
        """
        if not await self.close():
            return ApiFailResponse(message="Process already terminated or close failed")

        return ApiSuccessResponse(
            data={
                "id": self.id,
                "status": ProcessStatus.STOPPED.value,
                "terminated": True,
            }
        )

    # ── Project ───────────────────────────────────────────────────────────────

    async def get_project(self) -> None:
        """Resolve project_id and workdir from DB ancestry."""
        from flow_sdk.builtin.project import Project

        if not self.project_id:
            if self.context_data.get("project_id"):
                self._bind_project_id(self.context_data["project_id"])
            else:
                ancestor = await Project.get_ancestor(self.typeid)
                if ancestor:
                    self._bind_project_id(ancestor.id)

        # Fall back to @local project when no ancestor project is found
        if not self.project_id:
            local_project = await Project.get_by_uname("local")
            if not local_project:
                raise RuntimeError(
                    "No project found for agentic process and no @local project available"
                )
            self._bind_project_id(local_project.id)

        if self.project_id and not self.workdir:
            project = await Project.get_by_id(self.project_id)
            if project and project.fs_storage_mount_path:
                self.workdir = str(project.fs_storage_mount_path)

    @action.get(action_name="input-dir")
    async def get_input_dir(self):
        """Return the absolute path of this process's input directory, creating it if needed."""
        input_dir = self._record_dir() / "input"
        input_dir.mkdir(parents=True, exist_ok=True)

        shell = await self.shell()
        compute_node_id = await shell.resolve_compute_node_typeid_str() if shell else "compute_node-@local"

        return ApiSuccessResponse(
            data={
                "abs_path": str(input_dir),
                "compute_node_id": compute_node_id,
            }
        )
    # ── Internals ─────────────────────────────────────────────────────────────

    def _is_exist_claude_resume_session(self, session_id: str | None) -> bool:
        """Check if there's a resumable Claude session for this agentic process."""
        return self._discover_claude_record_session(session_id) is not None

    def _discover_claude_record_session(self, session_id: str | None) -> "Record | None":
        """Discover the Claude session Record associated with this agentic process's session_id."""
        if not session_id:
            return None
        return get_claude_session(session_id)

    # Bursty turn writes ~10-50 entries in 1s; cap at 1000 so a pathological
    # writer can't grow the buffer without bound.
    _DEBOUNCE_BUFFER_CAP = 1000
    # Coalesce a burst of JSONL writes into one flush so the FE gets at most
    # one entity-update broadcast per second per AP.
    _DEBOUNCE_SECONDS = 1.0

    async def on_transcript_change(self, jsonl_path: "Path", entries: list) -> None:
        """TranscriptStreamer subscriber entry-point on this AP.

        Buffers entries and arms a 1-second debounce timer; the streamer fires
        at filesystem speed but the FE only sees one broadcast per quiescent
        window per AP. The flush (:meth:`_flush_transcript_change`) handles
        plan detection, status transition detection, and notify_updated.

        ``jsonl_path`` is informational only — the canonical path is resolved
        by :meth:`_discover_status_from_transcript` via the driver, which also
        carries the headless ``_turn_in_flight`` short-circuit and visible-PTY
        liveness reconciliation that ``driver.tail_status`` alone misses.
        """
        pending = getattr(self, "_pending_entries", None)
        if pending is None:
            object.__setattr__(self, "_pending_entries", [])
            pending = self._pending_entries
        pending.extend(entries)
        if len(pending) > self._DEBOUNCE_BUFFER_CAP:
            overflow = len(pending) - self._DEBOUNCE_BUFFER_CAP
            del pending[:overflow]
            logger.warning(
                "AgenticProcess %s: on_transcript_change buffer overflow (dropped %d entries)",
                self.id, overflow,
            )

        task = getattr(self, "_debounce_task", None)
        if task is None or task.done():
            object.__setattr__(
                self, "_debounce_task",
                asyncio.create_task(
                    self._flush_transcript_change(),
                    name=f"ap-flush-{self.id[:8]}",
                ),
            )

    async def _process_transcript_entries(self, entries: list) -> None:
        """Per-entry side effects: plan.create + file-op cross-link emission.

        Extracted from :meth:`_flush_transcript_change` so unit tests can drive
        the loop without manipulating the AP's lifecycle ``status`` field.
        FileEditEntry maps to ``file.write`` (semantically: contents changed).
        """
        from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
        from flow_sdk.transcript_analyzer.entries.file_edit import FileEditEntry
        from flow_sdk.transcript_analyzer.entries.file_read import FileReadEntry
        from flow_sdk.transcript_analyzer.entries.file_write import FileWriteEntry
        from flow_sdk.transcript_analyzer.file_cross_link import cross_link_file_to_process

        # Dedup cross-link calls per (path) within one flush — Claude/Codex
        # often write+read the same .md file multiple times in a turn, and the
        # helper hits the DB once per call (5 markdown-subclass lookups each).
        cross_linked: set[str] = set()
        for entry in entries:
            if isinstance(entry, ExitPlanModeEntry) and entry.plan_file_path:
                # Order matters: cross-link save first so the entity-update
                # WS broadcast precedes plan.create. Consumers reading
                # AP.private_context_entities on the event see the link.
                await self.on_plan_created(entry)
                await self.emit_entity_event(
                    "plan.create",
                    {"plan_file_path": entry.plan_file_path, "session_id": self.session_id},
                )
                continue

            if isinstance(entry, (FileReadEntry, FileWriteEntry, FileEditEntry)):
                path = getattr(entry, "path", None)
                if not path or not path.endswith(".md"):
                    continue
                op = "read" if isinstance(entry, FileReadEntry) else "write"
                # Cross-link save before the file.{op} broadcast — WS messages
                # are delivered in send order, so a consumer subscribed to both
                # sees the cross-link applied before acting on file.{op}.
                if path not in cross_linked:
                    await cross_link_file_to_process(path, self)
                    cross_linked.add(path)
                await self.emit_entity_event(
                    f"file.{op}",
                    {"path": path, "tool_name": getattr(entry, "tool_name", "")},
                )

    async def _flush_transcript_change(self) -> None:
        """Run after the debounce window on this AP's transcript.

        Drains the buffer, processes plan detection (per-entry), re-derives
        worker_status via :meth:`_discover_status_from_transcript` (the same
        wrapper the serializer + get_status use, so the broadcast can never
        disagree with what consumers compute on demand), and broadcasts only
        on a status transition. Migrates the API_TIMEOUT → ``_on_timeout``
        invocation from the deleted ``_poll_for_completion``.

        The in-memory ``self.status`` may be ~1s stale after the sleep but
        the only stale path is "AP was stopped externally during the window"
        — covered by the lifecycle guard below. notify_updated broadcasts
        the in-memory state; downstream observers are idempotent.
        """
        try:
            await asyncio.sleep(self._DEBOUNCE_SECONDS)

            if self.status != ProcessStatus.RUNNING.value:
                return

            entries = list(getattr(self, "_pending_entries", []))
            object.__setattr__(self, "_pending_entries", [])
            await self._process_transcript_entries(entries)

            # Single source of truth: same helper the serializer/get_status use.
            current = self.fetch_worker_status()
            previous = getattr(self, "_last_broadcast_status", None)

            # Maintain terminal_at: set on transition INTO a clean terminal
            # (COMPLETE/ERROR/INTERRUPTED), clear on transition OUT. Used by
            # the projection layer to surface PENDING_USER for 5 min before
            # collapsing to INACTIVE. Not set for INACTIVE/API_TIMEOUT — those
            # are stuck / already-aged states, not the "session just finished"
            # case the user-facing PendingUser window is meant for.
            _CLEAN_TERMINAL = {
                WorkerStatus.COMPLETE, WorkerStatus.ERROR, WorkerStatus.INTERRUPTED,
            }
            if current in _CLEAN_TERMINAL and self.terminal_at is None:
                self.terminal_at = datetime.now(timezone.utc)
                try:
                    await self.save()
                except Exception:
                    logger.debug(
                        "AgenticProcess %s: terminal_at save failed", self.id, exc_info=True,
                    )
            elif current not in _CLEAN_TERMINAL and current != WorkerStatus.PENDING_USER \
                    and self.terminal_at is not None:
                self.terminal_at = None
                try:
                    await self.save()
                except Exception:
                    logger.debug(
                        "AgenticProcess %s: terminal_at clear failed", self.id, exc_info=True,
                    )

            if current == previous:
                return
            object.__setattr__(self, "_last_broadcast_status", current)

            if current == WorkerStatus.API_TIMEOUT:
                try:
                    await self._on_timeout()
                except Exception:
                    logger.debug(
                        "AgenticProcess %s: _on_timeout failed", self.id, exc_info=True,
                    )

            await self.notify_updated()

            # Drain the prompt queue on a transition INTO a ready state. This is
            # the single AP-level seam for both PTY *and* headless turns (both
            # write the transcript that lands here), so no driver coupling.
            if current in (WorkerStatus.IDLE, WorkerStatus.COMPLETE, WorkerStatus.INTERRUPTED):
                self._schedule_queue_drain("ready")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug(
                "AgenticProcess %s: _flush_transcript_change failed",
                self.id, exc_info=True,
            )

    async def on_plan_created(self, entry) -> None:
        """T7: Connect a freshly-detected plan to this AgenticProcess.

        Delegates to the shared
        :func:`flow_sdk.transcript_analyzer.plan_cross_link.cross_link_plan_to_process`
        helper — single source of truth shared with PlanHandler (indexer) and
        ``listen.py:_create_plan_annotation`` (hook). Sets ``plan_path`` if
        unset and cross-links via ``private_context_entities`` both directions.
        """
        from flow_sdk.transcript_analyzer.plan_cross_link import cross_link_plan_to_process

        await cross_link_plan_to_process(
            entry.plan_file_path,
            self.session_id or entry.session_id,
            proc=self,
        )

    async def _find_resumable_session(self, session_id: str) -> str | None:
        """Walk up the fork chain to find a session ID with a transcript on disk."""
        candidate: str | None = session_id
        seen: set[str] = set()
        while candidate and candidate not in seen:
            seen.add(candidate)
            if get_claude_session(candidate) is not None:
                return candidate
            procs = await AgenticProcess.get_all()
            parent = next((p for p in procs if p.session_id == candidate), None)
            candidate = parent.context_data.get("resume_session_id") if parent else None
        return None

    async def _get_or_create_shell(self) -> "Shell":
        """Get existing shell by shell_id, or create a new one."""
        from flow_sdk.builtin.shell import Shell

        shell_id = self.shell_id
        if self.shell_id:
            shell = await Shell.get_by_id(self.shell_id)
            if shell:
                if not await shell.ensure_live_compute_node_binding():
                    raise RuntimeError(f"Compute node not found for linked shell {shell.id}")
                return shell

        prev = self.context_data.pop("_prev_tab_order", None)
        tab_order = prev if prev is not None else await Shell.next_tab_order()

        is_resume = self._is_exist_claude_resume_session(self.session_id) if self.session_id else False
        # Fork is Claude-only; CodexCliOptions doesn't expose ``fork_session_id``.
        cli_opts_local = getattr(self, 'cli_options', None)
        is_fork = bool(cli_opts_local and getattr(cli_opts_local, 'fork_session_id', None))
        session_label = 'fork' if is_fork else 'resume' if is_resume else 'new'
        worker_label = (self.driver.name.capitalize() if self.driver else 'Claude')
        session_name = (
            f"{worker_label} - {self.session_id[:8]} ({session_label})"
            if self.session_id else worker_label
        )

        workdir = self.workdir
        if not workdir:
            raise NotADirectoryError(
                f"AgenticProcess {self.id} has no workdir after project resolution"
            )
        cn = await self._get_local_compute_node()
        if cn is None:
            raise RuntimeError("Compute node not found for local shell session (@local)")
        shell_kwargs = {
            "compute_node_id": str(cn.id),
            "compute_node_uname": getattr(cn, "uname", None),
            "name": session_name,
            "workdir": workdir,
            "tab_order": tab_order,
            "project_id": self.project_id,
        }
        if shell_id:
            shell_kwargs["id"] = shell_id
        shell = Shell(**shell_kwargs)
        await shell.save()
        return shell

    def _make_pty_exit_callback(self) -> Callable[[int | None], None]:
        """Return a thread-safe callback that updates process status when the PTY exits."""
        main_loop = asyncio.get_running_loop()
        agentic_process_id = self.id
        session_id = self.session_id
        shell_id = self.shell_id

        def _on_pty_exit(exit_code: int | None) -> None:
            logger.info("AgenticProcess %s: PTY exited with code %s", agentic_process_id, exit_code)

            async def _update_state():
                try:
                    proc = await AgenticProcess.get_by_id(agentic_process_id)
                    if not proc:
                        return
                    if not proc.shell_id:
                        return  # close() already handled it
                    if proc.context_data.get("_shell_exit_pending"):
                        # exit() was called — shell entity stays alive. The callback
                        # may race the final exit() save, so make the terminal state
                        # explicit instead of re-saving a stale STOPPING row.
                        proc.context_data = {k: v for k, v in proc.context_data.items() if k != "_shell_exit_pending"}
                        proc.sidecar_shell_id = None
                        if proc.status == ProcessStatus.STOPPING.value:
                            proc.status = ProcessStatus.STOPPED.value
                        await proc.save()
                        return
                    proc.sidecar_shell_id = None
                    if proc.status == ProcessStatus.STARTING.value:
                        proc.status = ProcessStatus.FAILED.value
                    elif proc.status not in {
                        ProcessStatus.STOPPING.value,
                        ProcessStatus.STOPPED.value,
                        ProcessStatus.FAILED.value,
                    }:
                        proc.status = ProcessStatus.STOPPED.value
                    await proc.save()

                    if session_id:
                        asyncio.create_task(
                            _index_session_on_close(session_id, display_name=proc.name)
                        )
                except Exception as exc:
                    logger.warning("AgenticProcess %s: on_exit update failed: %s", agentic_process_id, exc)
            asyncio.run_coroutine_threadsafe(_update_state(), main_loop)

        return _on_pty_exit
