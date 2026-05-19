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
from typing import TYPE_CHECKING, Any, Callable
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
from flow_sdk.fs_records.agent_status import WorkerStatus, is_terminal as is_worker_terminal
from flow_sdk.fs_records.agentic_process_lifecycle import ProcessStatus
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.shell import Shell
    from flow_sdk.transcript_analyzer import AgentTranscript
    from flow_sdk.transcript_analyzer.entries.tool_use import ToolUseEntry

logger = logging.getLogger(__name__)


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

        from flow_sdk.fs_store.record import get_default_records_data_root, record_stem

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


def _render_codex_plan_markdown(tool_input: dict) -> str:
    """Render a codex ``update_plan`` tool_input dict to a markdown checklist.

    Codex's plan-mode emits plans as ``{explanation, plan: [{step, status}]}``
    where ``status`` ∈ ``pending``/``in_progress``/``completed``. We render
    completed steps as ticked, in-progress with an explicit marker, and
    pending as unticked.
    """
    explanation = str(tool_input.get("explanation") or "").strip()
    steps = tool_input.get("plan") or []
    lines: list[str] = ["# Plan", ""]
    if explanation:
        lines.append(explanation)
        lines.append("")
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            text = str(step.get("step") or "").strip()
            status = str(step.get("status") or "").strip().lower()
            if not text:
                continue
            if status == "completed":
                lines.append(f"- [x] {text}")
            elif status == "in_progress":
                lines.append(f"- [ ] **(in progress)** {text}")
            else:
                lines.append(f"- [ ] {text}")
    return "\n".join(lines) + "\n"


def _materialize_codex_update_plan(entry: "ToolUseEntry", session_key: str) -> str:
    """Write a codex ``update_plan`` tool_use to ``<flow_home>/plans/codex/<key>.md``.

    Codex's plan is structured JSON in the ``function_call`` args, not a
    file claude-style. The flowpad UI's "Open last plan" button still
    expects a file path, so we render and write each plan update into a
    flowpad-managed location keyed on the session id (or the agentic
    process id when the session id is missing). The file is overwritten
    on every call so step-status updates are visible immediately.

    Returns the absolute path written, or "" if rendering failed.
    """
    from flow_sdk.instance_settings import get_instance_settings

    try:
        plan_dir = get_instance_settings().flow_home / "plans" / "codex"
        plan_dir.mkdir(parents=True, exist_ok=True)
        safe_key = (session_key or "session").replace("/", "_").replace("\\", "_")
        plan_path = plan_dir / f"{safe_key}.md"
        plan_path.write_text(_render_codex_plan_markdown(entry.tool_input or {}), encoding="utf-8")
        return str(plan_path)
    except Exception:
        logger.exception("AgenticProcess: failed to materialize codex update_plan to disk")
        return ""


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


async def _index_session_on_close(session_id: str, pty_title: str | None = None) -> None:
    """Index the ClaudeSessionRecord after an AgenticProcess closes (fire-and-forget).

    pty_title: Claude-generated tab title captured from ANSI OSC escapes in PTY
               output. Used as the FTS title / entity name when the JSONL has no
               user-set custom-title (i.e. the user never ran /rename).
    """
    try:
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
        record = ClaudeSessionRecord.get(session_id)
        if record:
            if pty_title:
                inst = object.__getattribute__(record, "__dict__")
                if not inst.get("custom_title"):
                    record.name = pty_title
                    _ = record.search_content  # populate _fts_cache
                    cache = inst.get("_fts_cache")
                    object.__setattr__(
                        record, "_fts_cache",
                        (pty_title[:120], cache[1] if cache else None),
                    )
            await record.sync_to_db()
            logger.debug("[AgenticProcess] indexed session %s on close", session_id)
    except Exception:
        logger.debug("[AgenticProcess] failed to index session %s on close", session_id, exc_info=True)


async def _poll_for_completion(agentic_process_id: str, _session_id: str | None) -> None:
    """Background task: poll the transcript until terminal worker_status, then save.

    Called from AgenticProcess.start_pty() after launching the worker. The
    transcript path and tail-status calculation are driver-owned so Claude and
    Codex visible processes follow the same status flow.
    """
    TERMINAL = {WorkerStatus.COMPLETE, WorkerStatus.ERROR, WorkerStatus.INTERRUPTED}

    await asyncio.sleep(1)  # give the worker time to start and write the first JSONL entry
    for _ in range(1800):  # poll up to 30 min (1800 * 1 s)
        await asyncio.sleep(1)
        try:
            # Fetch entity fresh from DB — use module-level AgenticProcess via
            # globals() to avoid forward-reference issues (class defined below).
            _AgenticProcess = globals().get("AgenticProcess")
            if _AgenticProcess is None:
                return
            proc = await _AgenticProcess.get_by_id(agentic_process_id)
            if proc is None:
                return  # entity deleted

            new_status = proc._discover_status_from_transcript()
            if new_status is None:
                continue  # transcript not written yet
            try:
                status_enum = WorkerStatus(str(new_status))
            except ValueError:
                continue

            if status_enum == WorkerStatus.API_TIMEOUT:
                await proc._on_timeout()
                continue  # keep polling — visible may recover; invisible will go INACTIVE

            if status_enum not in TERMINAL:
                continue  # still running or unknown

            if proc.status in {
                ProcessStatus.STOPPING.value,
                ProcessStatus.STOPPED.value,
                ProcessStatus.FAILED.value,
            }:
                return  # already up to date — WS was already sent

            if await proc.is_running():
                await proc.notify_updated()
                logger.info(
                    "AgenticProcess %s: completion monitor broadcast worker_status=%s with lifecycle=%s",
                    agentic_process_id,
                    new_status,
                    proc.status,
                )
                return

            proc.status = ProcessStatus.STOPPED.value
            await proc.save()
            logger.info(
                "AgenticProcess %s: completion monitor set lifecycle=%s worker_status=%s",
                agentic_process_id,
                proc.status,
                new_status,
            )
            return
        except Exception:
            logger.debug("_poll_for_completion error for %s", agentic_process_id, exc_info=True)


def _build_run_result(proc: "AgenticProcess") -> "RunResult":
    """Build a RunResult from the process state after wait() completes."""
    from flow_sdk.builtin.agentic_process._shared import RunResult

    text = ""
    models_used: list[str] = []
    token_usage: dict | None = None
    if proc.session_id:
        try:
            record = ClaudeSessionRecord.get(proc.session_id)
            if record:
                text = record.last_assistant_text or ""
                models_used = list(record.models_used) if hasattr(record, "models_used") else []
                token_usage = record.token_usage if hasattr(record, "token_usage") else None
        except Exception:
            pass

    status_enum = proc._discover_status_from_transcript()
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
    type: str = APIField(default="agentic_process")

    instruction_content: str | None = APIField(default=None)
    asset_ref: str | None = APIField(default=None)
    context_data: dict[str, Any] = APIField(default_factory=dict)
    context_entities: list[TypeId] = APIField(
        default_factory=list,
        description=(
            "TypeIds of entities this process is contextually about — task, "
            "conversation, spec, project, etc. Populated when the process is "
            "invoked from a conversation (FlowMessage TYPE_ID attachments) and "
            "copied across on fork. Project_id, when resolved later, is "
            "appended in place. Surfaced by the UI to show what the process "
            "is working on."
        ),
    )
    cli_config: dict[str, Any] = APIField(default_factory=dict)
    workdir: str | None = APIField(default=None)
    favorite_index: int | None = APIField(default=None)
    status: str = APIField(default=ProcessStatus.NEW.value)
    session_id: str | None = APIField(default=None)
    use_worker_history: bool = APIField(default=False)
    shell_mode: bool = APIField(default=False, description="False=direct PTY spawn (default), True=legacy zsh intermediary")
    project_id: str | None = APIField(default=None)
    project_encoded_name: str | None = APIField(default=None)
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
    process_type: ProcessType | None = APIField(
        default=None,
        description=(
            "Discriminator for how this process is used. CHAT = conversational "
            "editor companion; EXECUTION = runs an embedded asset or workflow. "
            "Null for legacy rows pre-dating this field."
        ),
    )
    queue: dict | None = APIField(default=None)
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
        """Return the local compute node used for shell creation and recovery."""
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        return await ComputeNode.get_by_uname("local")

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

            # Server-restart resume: process had a shell but cli_config didn't encode resume
            if not cmd.resume and self.session_id:
                cmd.resume = self._is_exist_claude_resume_session(self.session_id)

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

            if not worker_is_alive:
                # Start background task to detect completion via transcript polling.
                asyncio.create_task(
                    _poll_for_completion(self.id, self.session_id),
                    name=f"completion-monitor-{self.id[:8]}",
                )

            self.status = ProcessStatus.RUNNING.value
            # Capture snapshot of the freshly-launched config and clear the
            # restart-required flag — the live worker now matches saved state.
            self.last_started_snapshot = self._restart_snapshot_payload()
            self.last_started_hash = self._restart_snapshot()
            self.restart_required = False
            await self.save()

            return ApiSuccessResponse(data=self._build_open_payload(shell, is_resume=is_resume))

        except asyncio.CancelledError:
            logger.warning("AgenticProcess %s start_pty cancelled (status=%s shell_id=%s)", self.id, self.status, self.shell_id)
            self.status = ProcessStatus.FAILED.value
            await self.save()
            raise
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} start_pty error: {e}")
            self.shell_id = None
            self.status = ProcessStatus.FAILED.value
            await self.save()
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

    def add_context_entities(self, *type_ids: "TypeId | None") -> bool:
        """Append TypeIds to ``context_entities``, deduped by (type, id). In-place.

        Returns True iff at least one new ref was added — the caller can use
        this to decide whether a save is warranted.
        """
        refs = list(self.context_entities or [])
        seen = {(r.type, r.id) for r in refs}
        added = False
        for tid in type_ids:
            if tid is None:
                continue
            key = (tid.type, tid.id)
            if key in seen:
                continue
            refs.append(tid)
            seen.add(key)
            added = True
        if added:
            self.context_entities = refs
        return added

    def _bind_project_id(self, project_id: str) -> None:
        """Set ``project_id`` and append the matching Project TypeId to ``context_entities``."""
        self.project_id = project_id
        self.add_context_entities(TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id))

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
            self._bind_project_id(project.id)
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
                visible=visible,
                context_entities=list(self.context_entities or []),
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
            worker_status = self._discover_status_from_transcript()
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

    # ── Execution ─────────────────────────────────────────────────────────────

    async def prompt(self, instruction: str) -> ApiSuccessResponse | ApiFailResponse:
        """Schedule a worker run with *instruction* and return immediately.

        Routing:
          ``visible=True`` + worker alive (PTY) → write to PTY stdin (continues session)
          ``visible=True`` + worker dead        → ``start_pty(instruction)`` (PTY relaunch)
          ``visible=False`` (headless)          → ``self.driver.run_print_turn(...)``
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
            return await self.driver.run_print_turn(self, instruction)
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
        from flow_sdk.fs_records.agent_status import (
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
        # uses via ``driver.run_print_turn``. Without this, HTTP chat would
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

    def _load_transcript(self, descriptor=None) -> "AgentTranscript | None":
        """Worker-agnostic transcript loader.

        Resolves the JSONL via the vendor driver and parses it through the
        analyzer using the descriptor's native format. Returns None if no
        session is attached or the file is missing. Per-request load — no
        caching; eager parse is fast enough for current sizes.
        """
        from flow_sdk.transcript_analyzer import AgentTranscript

        descriptor = descriptor or self.transcript
        if descriptor is None or not descriptor.path.exists():
            return None
        try:
            return AgentTranscript(
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
        self, transcript: "AgentTranscript | None",
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Resolve the latest plan, persist ``plan_path`` (existence-gated),
        and return the indexed Markdown.

        Resolution order for the path:
          1. ``transcript.latest_plan`` — re-resolved every call so codex
             ``update_plan`` step-status updates are reflected immediately.
             - Claude (``ExitPlanModeEntry``): use the on-disk
               ``plan_file_path`` claude already wrote.
             - Codex (``update_plan`` ``ToolUseEntry``): render the inline
               structured plan to ``<flow_home>/plans/codex/<session>.md``
               and use that path.
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
            elif latest is not None and latest.tool_name == "update_plan":
                # Codex's plan lives inline in the function_call args; the
                # UI's plan button expects a file path, so we materialize
                # the rendered markdown into a flowpad-managed location.
                plan_file_path = _materialize_codex_update_plan(latest, transcript.session_id or self.id)

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
            from flow_sdk.fs_records.markdown_record import MarkdownRecord

            rec = MarkdownRecord.from_file(Path(plan_file_path))
            await rec.sync_to_db()
            return ApiSuccessResponse(data={"markdown": rec.meta_dict(), "plan_path": plan_file_path})
        except Exception as e:
            logger.exception("AgenticProcess %s transcript/plan error: %s", self.id, e)
            return ApiFailResponse(message=str(e))

    def _transcript_prompts(
        self, transcript: "AgentTranscript | None",
    ) -> ApiSuccessResponse:
        """Return the user-prompt list straight from the transcript.

        Filters applied by ``AgentTranscript.prompts`` (sidechain, empty,
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
        transcript: "AgentTranscript | None",
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

    def _transcript_header(self, transcript: "AgentTranscript") -> dict[str, Any]:
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
        from flow_sdk.fs_records.agent_record import AgentRecord
        if not asset_ref:
            return ApiFailResponse(message="asset_ref is required")
        abs_path = Path("/" + asset_ref.lstrip("/"))
        if not abs_path.exists():
            return ApiFailResponse(message=f"Agent file not found: {abs_path}")
        agent = AgentRecord.from_file(abs_path)
        agent_entry = agent.to_agents_cli_json()
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
        from flow_sdk.fs_records.agent_record import AgentRecord
        _agents: list = object.__getattribute__(self, "__dict__").setdefault("_embedded_agents", [])
        if isinstance(agent, str):
            rec = AgentRecord.load_agent(agent) or AgentRecord(name=agent, id=agent)
        elif isinstance(agent, AgentRecord):
            rec = agent
        else:
            # duck-type: anything with to_agents_json
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
        """The filesystem directory where embedded assets are materialized."""
        from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
        from flow_sdk.fs_store.record import get_default_records_root, record_stem

        record = None
        try:
            record = await self.get_record()
        except Exception:
            pass

        if record and record.record_dir:
            return record.assets_dir

        # Fallback: synthesize the path from the process id if the record can't
        # be resolved (e.g. the process was saved moments ago and the store
        # hasn't reindexed). Must match ``AgenticProcessRecord.assets_dir``
        # (``<record_dir>/execution/assets``) or attach + read paths diverge.
        root = get_default_records_root()
        d = root / AgenticProcessRecord._record_type / record_stem(
            AgenticProcessRecord._record_type, self.id
        )
        a = d / "execution" / "assets"
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
        from flow_sdk.fs_records.agent_record import AgentRecord
        from flow_sdk.fs_records.skill_record import SkillRecord

        if ref.type == "agent":
            # Resolve by id (uuid5-derived from the .md path) first, then fall back
            # to name-based lookup for agents the UI knows by name only.
            agent = AgentRecord.get(ref.id) or AgentRecord.load_agent(ref.id)
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
            skill = SkillRecord.get(ref.id)
            if skill is None:
                raise FileNotFoundError(f"Skill not found: {ref.id}")
            target_root = assets_dir / ".claude" / "skills"
            skill.copy_to(target_root)
            return skill.name or ref.id

        return None  # Unsupported type — caller decides to fail loudly.

    async def _unmaterialize_entity(self, ref: TypeId, assets_dir: "Path") -> None:
        """Best-effort removal of the files laid down by _materialize_entity."""
        import shutil
        from flow_sdk.fs_records.agent_record import AgentRecord
        from flow_sdk.fs_records.skill_record import SkillRecord

        if ref.type == "agent":
            agent = AgentRecord.get(ref.id) or AgentRecord.load_agent(ref.id)
            name = agent.name if agent else ref.id
            target = assets_dir / ".claude" / "agents" / f"{name}.md"
            if target.exists():
                target.unlink()
        elif ref.type == "skill":
            skill = SkillRecord.get(ref.id)
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
                from flow_sdk.fs_records.agent_record import AgentRecord
                rec = AgentRecord.get(ref.id) or AgentRecord.load_agent(ref.id)
                if rec is None:
                    return None
                name = rec.name or ref.id
                return assets_dir / ".claude" / "agents" / f"{name}.md"
            if ref.type == "skill":
                from flow_sdk.fs_records.skill_record import SkillRecord
                rec = SkillRecord.get(ref.id)
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
        """Build the launch options used for worker restart comparison.

        This mirrors the persisted/process-derived CLI inputs used by
        ``start_pty()`` but intentionally excludes runtime-only env injection.
        """
        driver = self._restart_driver()
        if driver is None:
            raise ValueError(f"No WorkerDriver registered for worker_type={self.worker_type!r}")
        cmd = driver.cli_options(self)

        # Server-restart resume: process had a shell but cli_config didn't
        # encode resume. This is part of the effective launch shape.
        if not getattr(cmd, "resume", False) and self.session_id:
            cmd.resume = self._is_exist_claude_resume_session(self.session_id)

        # Claude-only transcript cwd plumbing. Keep this sync and reproducible
        # so start-time and save-time snapshots use the same persisted inputs.
        if hasattr(cmd, "fork_session_id"):
            fork_session_id = getattr(cmd, "fork_session_id", None)
            if fork_session_id or (getattr(cmd, "resume", False) and self.session_id):
                lookup_id = fork_session_id or self.session_id
                session_rec = self._discover_claude_record_session(lookup_id)
                if session_rec and session_rec.cwd:
                    cmd.env_vars["CLAUDE_PROJECT_DIR"] = session_rec.cwd
                    cmd.workdir = session_rec.cwd

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

    def _restart_snapshot(self) -> str:
        """Stable hash over finalized generic + worker launch inputs.

        Mismatch against ``last_started_hash`` (captured at last successful
        ``start_pty()``) means the live worker is running with stale config —
        ``restart_required`` flips True via the ``save()`` hook below.
        """
        import hashlib
        import json as _json

        payload = self._normalize_restart_value(self._restart_snapshot_payload())
        return hashlib.md5(
            _json.dumps(payload, sort_keys=True, default=str).encode()
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
        computed = self._discover_status_from_transcript()
        d["worker_status"] = str(computed) if computed else WorkerStatus.IDLE.value
        d["ready_for_input"] = is_ready_for_input(self, computed)
        return d

    @model_serializer(mode="wrap")
    def api_json_serializer(self, nxt, info: SerializationInfo):
        data = super().api_json_serializer(nxt, info)
        if info.context and info.context.get("skip_api_serializer"):
            return data
        if data is None:
            return None
        computed = self._discover_status_from_transcript()
        data["worker_status"] = str(computed) if computed else WorkerStatus.IDLE.value
        data["ready_for_input"] = is_ready_for_input(self, computed)
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
                from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
                rec = AgenticProcessRecord(id=self.id)
                default = rec.default_path
                if default is not None:
                    rec.path = str(default)
                    for attr in missing:
                        ref = getattr(rec, attr, None)
                        if ref is not None:
                            data[attr] = ref.to_dict()
            except Exception:
                pass
        return data

    def _discover_status_from_transcript(self) -> WorkerStatus | None:
        """Derive status from the worker's session transcript via the driver.

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
        return derived

    @action.all(action_name="status")
    async def get_status(self):
        """Return current app status and computed worker_status from transcript."""
        worker_status = self._discover_status_from_transcript()
        return ApiSuccessResponse(data={
            "status": self.status,
            "worker_status": str(worker_status) if worker_status else WorkerStatus.IDLE.value,
            "ready_for_input": is_ready_for_input(self, worker_status),
        })

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

        return ApiSuccessResponse(data={
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
        })

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
        """Resolve project_id, workdir, and project_encoded_name from DB ancestry."""
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

        if self.project_id and (not self.workdir or not self.project_encoded_name):
            project = await Project.get_by_id(self.project_id)
            if project and project.fs_storage_mount_path:
                if not self.workdir:
                    self.workdir = str(project.fs_storage_mount_path)
                if not self.project_encoded_name:
                    self.project_encoded_name = project.project_encoded_name

    @action.get(action_name="input-dir")
    async def get_input_dir(self):
        """Return the absolute path of this process's input directory, creating it if needed."""
        from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
        from flow_sdk.fs_store.record import get_default_records_root, record_stem

        record = None
        try:
            record = await self.get_record()
        except Exception:
            pass

        if record and record.record_dir:
            input_dir = record.input_dir
        else:
            uid = self.id
            root = get_default_records_root()
            record_dir = root / AgenticProcessRecord._record_type / record_stem(AgenticProcessRecord._record_type, uid)
            input_dir = record_dir / "input"
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

    def _discover_claude_record_session(self, session_id: str | None) -> ClaudeSessionRecord | None:
        """Discover the ClaudeSessionRecord associated with this agentic process's session_id."""
        if not session_id:
            return None
        return ClaudeSessionRecord.get(session_id)

    async def _find_resumable_session(self, session_id: str) -> str | None:
        """Walk up the fork chain to find a session ID with a transcript on disk."""
        candidate: str | None = session_id
        seen: set[str] = set()
        while candidate and candidate not in seen:
            seen.add(candidate)
            if ClaudeSessionRecord.get(candidate) is not None:
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
                        _pty_title: str | None = None
                        if shell_id:
                            try:
                                from flow_sdk.builtin.faas.pty_actions import get_pty_session_title
                                _pty_title = get_pty_session_title(shell_id)
                            except Exception:
                                pass
                        asyncio.create_task(_index_session_on_close(session_id, pty_title=_pty_title))
                except Exception as exc:
                    logger.warning("AgenticProcess %s: on_exit update failed: %s", agentic_process_id, exc)
            asyncio.run_coroutine_threadsafe(_update_state(), main_loop)

        return _on_pty_exit
# bench-marker 1777146382
# bench-trigger-1777146659
