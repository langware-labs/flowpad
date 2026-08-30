"""AgenticProcess entity — vendor-pure orchestration over a ``WorkerDriver``.

The entity holds a ``WorkerDriver`` (resolved via ``get_driver(worker_type)``)
and never branches on ``worker_type`` itself. Vendor specifics — Claude vs
Codex CLI shape, transcript layout, prompt composition, status interpretation
— live in ``cli_drivers/{claude,codex}/driver.py``. New vendors plug in by
implementing the ``WorkerDriver`` Protocol and registering with ``get_driver``.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from functools import cached_property, lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, ClassVar, List, NamedTuple
from urllib.parse import urlparse
from uuid import uuid4

from pydantic import SerializationInfo, model_serializer, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers import (
    AgenticContext as _AgenticContext,
)
from flow_sdk.builtin.agentic_process.cli_drivers import (
    AgenticProcessContextKey,
    AgentOptions,
    WorkerDriver,
    WorkerSpawnError,
    apply_worker_env,
    apply_worker_secret_env,
    get_driver,
    latch_spawn_failure,
    resolve_worker_language,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import ProcessHookRuntime
from flow_sdk.builtin.agentic_process.process_hooks import clear_process_hook_callbacks
from flow_sdk.builtin.agentic_process.status_predicates import (
    WorkerMode,
    is_process_startable,
    is_ready_for_input,
    is_ready_from_busy,
    is_turn_busy,
)
from flow_sdk.builtin.process_lifecycle import (
    ProcessStatus,
    backend_restart_requested,
    is_recoverable_worker_interruption,
)
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.builtin.worker_status import is_terminal as is_worker_terminal
from flow_sdk.compute.providers.compute_provider import (
    LOOPBACK_HOSTNAMES,
    sandbox_public_url,
)
from flow_sdk.core import Entity, action
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.enums import ProcessKind, WorkerType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session
from flow_sdk.instance_settings.runtime import own_sandbox_id
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process._shared import RunResult
    from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import WorkerAuthResult
    from flow_sdk.builtin.agentic_process.prompt_queue import PromptQueue
    from flow_sdk.builtin.hooks.process_manager import ProcessHooksManager
    from flow_sdk.builtin.shell import Shell
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.responses.response import ApiResponse
    from flow_sdk.transcript_analyzer import AgentTranscriptFile
    from flow_sdk.transcript_analyzer.counters import FocusedAsset

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
# Gap between typing and Enter for TUIs that don't submit on paste (codex/copilot);
# mirrors Shell.write_then_submit's submit_delay. claude submits on paste → no gap.
_PTY_SUBMIT_SETTLE_S = 0.4

# Classification threshold (nothing waits on this): a worker that exits less
# than this many seconds after its launch never really started — its exit is
# recorded as ``start_failure`` (status FAILED) instead of a normal STOPPED.
# A latched process is excluded from auto-recovery relaunch until the user
# explicitly retries. A worker that outlives the window and then dies is a
# normal stop and stays recoverable (e.g. crash-healing after a backend
# restart).
INSTANT_EXIT_WINDOW_SECONDS = 5.0

# The exact ``start_failure`` message latched when the @local compute_node
# singleton is missing at launch. Single source of truth: it is both RAISED at
# the launch site and SUBSTRING-MATCHED by ``_latched_failure_recovered`` to
# decide a refresh can self-heal. Keep them sharing this constant — a reword
# would otherwise silently break recovery.
LOCAL_COMPUTE_NODE_MISSING_FAILURE = "Compute node not found for local shell session (@local)"


@lru_cache(maxsize=1)
def live_stream_noise_kinds() -> frozenset:
    """Transcript kinds that are session bookkeeping, not conversation.

    Shared by the two live-streaming paths — the ``prompt`` response stream and
    the ``observe-turn`` stream — so a row can never be noise on one and content
    on the other. Cached rather than a module constant because ``EntryKind`` is
    imported lazily here, as everywhere else in this module.
    """
    from flow_sdk.transcript_analyzer.entry import EntryKind

    return frozenset(
        {
            EntryKind.META,
            EntryKind.SYSTEM,
            EntryKind.SUMMARY,
            EntryKind.TOKEN_USAGE,
        }
    )


def _iter_touched_paths(entries: "Iterable") -> "Iterator[str]":
    """Paths of files a turn wrote/edited, from its transcript entries.

    The single place the "a file's content changed" entry-set is encoded; the
    turn-end reindex collector consumes it. Reads/plan entries are excluded."""
    from flow_sdk.transcript_analyzer.entries.file_edit import FileEditEntry  # noqa: PLC0415
    from flow_sdk.transcript_analyzer.entries.file_write import FileWriteEntry  # noqa: PLC0415

    for e in entries:
        if isinstance(e, (FileWriteEntry, FileEditEntry)):
            p = getattr(e, "path", None)
            if p:
                yield p


def _shell_compute_is_local(shell: "Shell") -> bool:
    from flow_sdk.config import ComputeProviderType  # noqa: PLC0415

    node = getattr(shell, "compute_node", None)
    provider = getattr(node, "node_provider_type", None)
    return str(provider or "") in {
        ComputeProviderType.LOCAL.value,
        ComputeProviderType.LOCAL_MACHINE.value,
    }


# ── Asset descriptors ──────────────────────────────────────────────────────────
# Read-side surface for ``AgenticProcess.get_asset_descriptors`` — see plan
# "AgenticProcess.get_assets() — unified read-side asset view". The descriptors
# unify the scattered fields (``embedded_asset_refs``, ``embedded_subagent_ids``,
# ``cli_config.agents_json``, ``additional_dirs``) plus path-discovered assets
# under user/project/workdir into one list the UI can consume.


class AssetSource(str, Enum):
    EMBEDDED = "embedded"  # materialized via embedded_asset_refs
    INLINE = "inline"  # cli_config.agents_json / embedded_subagent_ids — no file
    PROJECT_DIR = "project_dir"  # under project.fs_storage_mount_path
    USER_DIR = "user_dir"  # under user_home
    WORKDIR = "workdir"  # process workdir if distinct from project/user
    ADDITIONAL_DIR = "additional_dir"  # additional_dirs entries (excl. auto-appended assets dir)
    CONTEXT_DIR = "context_dir"  # project.include_dirs (context folders)
    SYSTEM = "system"  # bundled flowpad_assistant assets (entity scope="system")
    # Not attributable to any of this process's source dirs. Deliberately NOT
    # "outside every source dir" — a foreign project's asset under $HOME is
    # rejected by the cross-project rule in ``_source_match_for_asset`` and
    # lands here despite living inside one. The fact that it was seen in the
    # transcript is carried by ``AssetUsageKind.TRANSCRIPT_FILE_READ``, on the
    # usage axis; this enum only ever answers "where does it live".
    EXTERNAL = "external"


class AssetUsageKind(str, Enum):
    EMBEDDED_ASSET = "embedded_asset"
    INLINE_PERSONA = "inline_persona"
    TRANSCRIPT_FILE_READ = "transcript_file_read"
    # Skill invoked through the native ``Skill`` tool (Claude ``/rca``), which
    # yields a ``SkillCallEntry`` and NO ``SKILL.md`` file read — so file-read
    # attribution alone would leave the skill unmarked in the asset view.
    SKILL_INVOKED = "skill_invoked"


# Sources whose underlying file/state lives outside this AgenticProcess —
# editing the entity propagates elsewhere (other processes, the project,
# the user globally), so the row is "read-only" from this process's
# perspective. Attaching materializes an EMBEDDED writable copy.
READONLY_ASSET_SOURCES: frozenset[AssetSource] = frozenset(
    {
        AssetSource.PROJECT_DIR,
        AssetSource.USER_DIR,
        AssetSource.WORKDIR,
        AssetSource.ADDITIONAL_DIR,
        AssetSource.CONTEXT_DIR,
        AssetSource.SYSTEM,
        AssetSource.EXTERNAL,
    }
)


class TranscriptSubpath(StrEnum):
    PLAN = "plan"
    PROMPT = "prompt"
    PROMPTS = "prompts"
    FULL = "full"


def is_readonly_source(source: AssetSource) -> bool:
    return source in READONLY_ASSET_SOURCES


@dataclass
class AssetUsage:
    """Lightweight evidence that an asset is active or was used in this run."""

    kind: AssetUsageKind
    path: str | None = None
    entry_id: str | None = None
    timestamp: str | None = None
    label: str | None = None


@dataclass
class AssetDescriptor:
    """Single asset row visible to an AgenticProcess.

    A given source asset may appear multiple times in the list — once per
    distinct source (e.g. EMBEDDED + USER_DIR for the same skill).
    """

    typeid: str  # serialized TypeId, e.g. "skill-<uuid>"
    source: AssetSource
    posix_path: str | None  # canonical POSIX path; None for INLINE
    source_dir: str | None = None  # matched source dir (path-discovered only); None for EMBEDDED/INLINE
    project_id: str | None = None  # owning project (path-discovered / spec rows); None for EMBEDDED/INLINE
    usage: list[AssetUsage] = field(default_factory=list)
    remote: bool | None = None  # None until a reference-only descriptor is hydrated

    def to_row(self) -> dict:
        """Single owner of the get-assets wire row — used by BOTH the process
        and project actions so the response shapes cannot drift."""
        return {
            "typeid": self.typeid,
            "source": self.source.value,
            "posix_path": self.posix_path,
            "source_dir": self.source_dir,
            "project_id": self.project_id,
            "remote": bool(self.remote),
            "usage": [
                {
                    "kind": u.kind.value,
                    "path": u.path,
                    "entry_id": u.entry_id,
                    "timestamp": u.timestamp,
                    "label": u.label,
                }
                for u in self.usage
            ],
        }


async def hydrate_asset_descriptor_remote(
    descriptors: list[AssetDescriptor],
) -> None:
    """Batch-fill cloud state for reference-only descriptors.

    Producers that already hold an entity stamp ``remote`` directly. Remaining
    real TypeIds are grouped by registered entity class and loaded once per
    type; invalid, named, unregistered, or missing references fail closed to
    local-only.
    """
    from flow_sdk.api.api_types.identifier import is_valid_entity_id
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    pending: dict[tuple[str, str], list[AssetDescriptor]] = {}
    for descriptor in descriptors:
        if descriptor.remote is not None:
            continue
        try:
            typeid = TypeId(descriptor.typeid)
        except (TypeError, ValueError):
            descriptor.remote = False
            continue
        if not typeid.id or not is_valid_entity_id(str(typeid.id)):
            descriptor.remote = False
            continue
        pending.setdefault((typeid.type, str(typeid.id)), []).append(descriptor)

    ids_by_type: dict[str, set[str]] = {}
    for entity_type, entity_id in pending:
        ids_by_type.setdefault(entity_type, set()).add(entity_id)

    for entity_type, ids in ids_by_type.items():
        entity_cls = SchemaRegistry.get_entity_cls(entity_type)
        rows = []
        if entity_cls is not None:
            try:
                rows = await entity_cls.get_all(
                    QueryFilter(
                        match=ExpressionNode(
                            op=QueryOp.IN,
                            operands=["id", sorted(ids)],
                        )
                    )
                )
            except Exception:
                logger.debug(
                    "asset descriptor remote batch load failed for %s",
                    entity_type,
                    exc_info=True,
                )
        loaded = {str(row.id): bool(getattr(row, "remote", False)) for row in rows}
        for entity_id in ids:
            for descriptor in pending[(entity_type, entity_id)]:
                descriptor.remote = loaded.get(entity_id, False)


@dataclass
class SystemInstructionAssets:
    assets_dir: Path
    instructions: str
    claude_file: Path
    # The owning process. Every vendor but opencode reaches these assets through
    # a directory flag and needs nothing else; opencode reaches them ONLY through
    # a generated per-process config, which is keyed on this id.
    process_id: str = ""


@dataclass
class PreparedProcessAssets:
    """Derived launch assets prepared once for one worker spawn."""

    instruction_assets: SystemInstructionAssets | None = None
    hook_runtime: ProcessHookRuntime = field(default_factory=ProcessHookRuntime)


# Types treated as executable agent inputs by the asset-management UI.
# Markdown / spec / plan / claude_rules etc. are intentionally excluded —
# they're documentation, not things the agent runs.
EXECUTABLE_ASSET_TYPES: list[str] = ["skill", "subagent"]


def add_source_dir(
    pairs: list[tuple[str, AssetSource]],
    seen: set[str],
    path: "str | Path | None",
    source: AssetSource,
) -> None:
    """Canonicalize + dedup one candidate scan dir into ``pairs``/``seen``."""
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    if not path:
        return
    try:
        key = canonical_posix_path(path)
    except (OSError, ValueError):
        return
    if not key or key in seen:
        return
    seen.add(key)
    pairs.append((key, source))


def collect_base_source_dirs(project) -> tuple[list[tuple[str, AssetSource]], set[str]]:
    """The user/project/context portion of the scan-dir policy, shared by
    ``AgenticProcess._collect_source_dirs`` and ``Project.get_assets_action``
    so the staging view cannot drift from what a new process would see.
    ``project`` may be None (user-home only)."""
    from flow_sdk.instance_settings import get_instance_settings

    pairs: list[tuple[str, AssetSource]] = []
    seen: set[str] = set()
    add_source_dir(pairs, seen, get_instance_settings().user_home, AssetSource.USER_DIR)
    if project is not None:
        add_source_dir(
            pairs,
            seen,
            getattr(project, "fs_storage_mount_path", None),
            AssetSource.PROJECT_DIR,
        )
        # CONTEXT_DIR — the project's context folders (include_dirs). Deduped on
        # canonical path, so a folder that is also the project/user root won't
        # double-count.
        for context_dir in getattr(project, "include_dirs", None) or []:
            add_source_dir(pairs, seen, context_dir, AssetSource.CONTEXT_DIR)
    return pairs, seen


async def scan_path_asset_descriptors(
    sources: list[tuple[str, AssetSource]],
    own_project_id: str,
    types: list[str],
    limit: int = 10000,
    offset: int = 0,
) -> list[AssetDescriptor]:
    """Build the *listable* path-discovered assets, for process and project views.

    One ``Entity.assets_by_path()`` over ``sources`` (SQL prefix pushdown), each
    hit attributed to the longest-prefix source dir via
    ``AgenticProcess._source_match_for_asset`` — including its rule that a
    project-scoped entity from another project is not claimed by the USER_DIR
    home catchall.

    Deliberately non-total: this is a listing, not the full attribution. It never
    returns ``SYSTEM`` even though the enum admits it — see the skip below.
    """
    from flow_sdk.core.entity.entity_model import Entity, PathQueryOptions
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    if not sources:
        return []
    entities = await Entity.assets_by_path(
        PathQueryOptions(
            search_dirs=[s[0] for s in sources],
            types=types,
            limit=limit,
            offset=offset,
        )
    )
    ranked = sorted(sources, key=lambda s: -len(s[0]))
    descriptors: list[AssetDescriptor] = []
    for ent in entities:
        ar_raw = getattr(ent, "asset_ref", None) or ""
        if not ar_raw:
            continue
        ar = canonical_posix_path(ar_raw)
        match = AgenticProcess._source_match_for_asset(ar, ranked, ent, own_project_id)
        if match is None:
            continue
        src_dir, src = match
        # The bundled assistant's catalog is represented by a single "mounted"
        # marker in the asset UI, not one row per shipped skill — listing it here
        # would flood the available list. Its assets still surface individually
        # when a run actually used one (see _append_transcript_asset_descriptors).
        # Note this does NOT hide the assistant project's own assets when you're
        # looking at it: that view's mount IS the assistant root, so it wins the
        # longest-prefix match as PROJECT_DIR and never reaches SYSTEM.
        if src == AssetSource.SYSTEM:
            continue
        ent_project_id = getattr(ent, "project_id", None)
        descriptors.append(
            AssetDescriptor(
                typeid=f"{ent.type or ent.get_type()}-{ent.id}",
                source=src,
                posix_path=ar,
                source_dir=src_dir,
                project_id=str(ent_project_id) if ent_project_id else None,
                remote=bool(getattr(ent, "remote", False)),
            )
        )
    return descriptors


# ── prompt-action transient state (per-process locks + live workers) ─────────
# Keyed by agentic_process.id. Lost on hub restart — acceptable, callers retry.
# A headless turn first owns an admission token, then atomically hands that slot
# to its worker.  Keeping setup in the same process-global registry projection is
# important: transcript watchers hydrate a different AgenticProcess object than
# the request object, so an object-local flag cannot serialize those callers.
_PROMPT_LOCKS: dict[str, asyncio.Lock] = collections.defaultdict(asyncio.Lock)
_PROMPT_ADMISSIONS: dict[str, object] = {}
_PROMPT_WORKERS: dict[str, Any] = {}


def prompt_lock_locked(process_id: str) -> bool:
    """True when a prompt turn holds the per-process lock.

    The runtime source of truth for "a headless / chat-over-PTY turn is in
    flight". Exposed as a module function so ``status_predicates.is_turn_busy``
    can consult it without importing this module at load time (which would
    cycle — ``agentic_process`` imports ``status_predicates``).
    """
    return _PROMPT_LOCKS[process_id].locked()


def prompt_worker_active(process_id: str) -> bool:
    """True while a print-mode turn owns admission or has a live worker.

    Unlike ``_turn_in_flight``, this registry is process-global: transcript
    watchers often hydrate a different AgenticProcess object than the action
    instance that launched the turn. Admission covers accepted setup before the
    worker exists; worker registration then keeps every serializer's ``busy``
    projection true until the driver has emitted its final FlowData.
    """
    return process_id in _PROMPT_ADMISSIONS or process_id in _PROMPT_WORKERS


def try_admit_prompt(process_id: str) -> object | None:
    """Atomically claim the one headless-turn slot for ``process_id``.

    This function deliberately contains no await: within the asyncio event-loop
    thread the check-and-insert is one indivisible admission decision.  The
    opaque token makes release owner-safe when an older setup unwinds after a
    newer admission has already been installed.
    """
    if process_id in _PROMPT_ADMISSIONS or process_id in _PROMPT_WORKERS or _PROMPT_LOCKS[process_id].locked():
        return None
    token = object()
    _PROMPT_ADMISSIONS[process_id] = token
    return token


def release_prompt_admission(process_id: str, token: object) -> bool:
    """Release only the admission owned by ``token``."""
    if _PROMPT_ADMISSIONS.get(process_id) is not token:
        return False
    del _PROMPT_ADMISSIONS[process_id]
    return True


def register_prompt_worker(process_id: str, worker: Any) -> None:
    """Hand the process slot from setup to ``worker`` without overwriting.

    Drivers are allowed to call this without an admission when invoked directly
    by narrow tests, but an existing *different* worker is never replaceable.
    """
    current = _PROMPT_WORKERS.get(process_id)
    if current is not None and current is not worker:
        raise RuntimeError(f"prompt worker already registered for process {process_id}")
    _PROMPT_WORKERS[process_id] = worker
    _PROMPT_ADMISSIONS.pop(process_id, None)


def unregister_prompt_worker(process_id: str, worker: Any) -> bool:
    """Remove ``worker`` only when it still owns ``process_id``'s slot."""
    if _PROMPT_WORKERS.get(process_id) is not worker:
        return False
    del _PROMPT_WORKERS[process_id]
    return True


# Accepted per-turn ``permission_mode`` overrides (e.g. chat plan mode). Mirrors
# the values ``ClaudeAgentOptions`` knows how to translate to a CLI flag; gates
# client input so an arbitrary string can't reach the spawn args.
_VALID_PERMISSION_MODES = frozenset({"plan", "default", "acceptEdits", "bypassPermissions", "askUser"})

# Per-process serialization for the ``open``/``start`` lifecycle so two
# concurrent refresh-driven calls can't both run recovery on the same process.
_OPEN_LOCKS: dict[str, asyncio.Lock] = collections.defaultdict(asyncio.Lock)

# Per-process serialization for prompt-queue drains so two ready edges can't
# pop+inject the same head twice.
_QUEUE_LOCKS: dict[str, asyncio.Lock] = collections.defaultdict(asyncio.Lock)

#: Broadcast dedup key — private, reached only via ``AgenticProcess._last_broadcast_key``, so its shape can change freely.
_BroadcastKey = NamedTuple(
    "_BroadcastKey",
    [("status", str), ("busy", bool), ("worker_status", str | None)],
)

# Last key broadcast per AP id — module-level because every streamer event hydrates a FRESH AP, killing instance state.
_LAST_BROADCAST_KEYS: dict[str, _BroadcastKey] = {}


#: Where a process remembers the terminal it opened for the user, so
#: `flow terminal open` is idempotent (a re-show, not a second terminal) and
#: `flow terminal run` needs no --shell. Deliberately NOT the Shell's
#: ``agentic_process_id``: that marks the process's OWN transport shell and is
#: driven by the worker lifecycle, which would tear the user's terminal down
#: with it on every restart.
TERMINAL_SHELL_KEY = "terminal_shell_id"


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
        new_content = f"---\n{existing}\n---\n" + content[m.end() :]
    else:
        lines = "\n".join(
            f"{k}: {'true' if v is True else ('false' if v is False else str(v))}" for k, v in fields.items()
        )
        new_content = f"---\n{lines}\n---\n{content}"
    p.write_text(new_content, encoding="utf-8")


async def _index_additional_dir(
    path: str,
    *,
    read_only: bool = False,
    strict: bool = False,
) -> None:
    """Run a one-shot indexer scan over ``path`` so its skills/agents become
    discoverable via ``Entity.assets_by_path``.

    ``strict`` is reserved for declarative installation: a failed scan must be
    observable there, because reporting a content project as installed without
    its Journey/Helpdesk/Skill is a false success. Interactive best-effort
    callers retain the historical non-raising behavior.

    Best-effort and silent: if the path doesn't exist or the indexer raises,
    we log and continue — adding the dir to ``additional_dirs`` already
    succeeded.

    ``read_only=True`` for a directory we do not own — a checkout cloned from
    someone else's repo. Identity backends normally COMMIT the id they mint
    back into the source (markdown gets a ``flowpad:capsule`` comment appended,
    for instance), which dirties every indexed file; the next ``git pull`` then
    fails with "local changes would be overwritten". ``FSRef.read_only``
    propagates to children, so setting it on the root suppresses that write for
    the whole tree and ``mint_id`` falls back to its deterministic key.
    """
    try:
        from pathlib import Path as _Path

        from flow_sdk.fs_store.fs_ref import FSRef
        from flow_sdk.fs_store.indexer import IndexerOptions, get_shared_indexer
        from flow_sdk.fs_store.record_types import RecordType

        p = _Path(path)
        if not p.is_dir():
            if strict:
                raise FileNotFoundError(f"Context directory is not available: {path}")
            return
        new_root = FSRef(p, record_type=RecordType.CWD_ROOT, scope="user", read_only=read_only)
        # include_temp=True so /tmp / /var/folders paths aren't filtered out —
        # the user explicitly added this dir, so honor it regardless of location.
        result = await get_shared_indexer().index(IndexerOptions(roots=(new_root,), verbose=False, include_temp=True))
        if strict and result.total_errors:
            raise RuntimeError(f"Context indexing reported {result.total_errors} error(s)")
    except Exception:
        logger.exception("add_dir: indexing failed for %s", path)
        if strict:
            raise


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


# ── Display stack (the `flow show` history) ──────────────────────────────────
# The agent's `flow show` targets accumulate on ``context_data["display_stack"]``
# (each entry = a resolve_display_target payload + a server ``shown_at`` ISO
# stamp), newest last. ``last_shown`` stays = the newest TARGET (no shown_at) for
# back-compat readers (standard-mode viewer). Capped; consecutive identical
# targets refresh the timestamp instead of duplicating.
DISPLAY_STACK_CAP = 50
# Every field that can distinguish one display target from another. A kind that
# adds its own address fields MUST list them here: the keys a payload does not
# carry are ``None`` on both sides and compare equal, so an omission silently
# collapses that whole kind into a single "same target" — the DOCK kind (whose
# address is view_type/pointer/page/options and none of typeid/type/id/path/port)
# was doing exactly that, refreshing one stack entry instead of appending each
# screen the agent showed.
_DISPLAY_TARGET_KEYS = (
    "kind",
    "typeid",
    "type",
    "id",
    "path",
    "port",
    "view_type",
    "pointer",
    "page",
    "options",
)


def _same_display_target(a: dict, b: dict) -> bool:
    """Two display payloads point at the same thing (ignoring ``shown_at``)."""
    return all(a.get(k) == b.get(k) for k in _DISPLAY_TARGET_KEYS)


def _append_display_entry(stack: list[dict], payload: dict, shown_at: str) -> list[dict]:
    """Append ``payload`` (stamped ``shown_at``) to ``stack``; a consecutive
    identical target just refreshes its timestamp. Capped to the newest N."""
    entry = {**payload, "shown_at": shown_at}
    if stack and isinstance(stack[-1], dict) and _same_display_target(stack[-1], payload):
        stack = [*stack[:-1], entry]
    else:
        stack = [*stack, entry]
    return stack[-DISPLAY_STACK_CAP:]


def _union_display_stacks(a: list, b: list) -> list[dict]:
    """Superset of two stacks keyed by ``shown_at`` (ISO strings sort
    chronologically), so a stale whole-row save never shrinks the persisted
    history. Newest last, capped."""
    by_key: dict[str, dict] = {}
    for entry in (*(a or []), *(b or [])):
        if isinstance(entry, dict) and entry.get("shown_at"):
            by_key[entry["shown_at"]] = entry
    merged = sorted(by_key.values(), key=lambda e: e.get("shown_at") or "")
    return merged[-DISPLAY_STACK_CAP:]


class AgenticProcess(Entity):
    _api_visible = True
    _icon: ClassVar[str | None] = "Workflow"
    type: str = APIField(default="agentic_process")

    instruction_content: str | None = APIField(default=None)
    #: The AgentDeployment this run came from, when it was launched through one.
    #: Provenance, NOT launch config — deliberately absent from
    #: ``_generic_restart_snapshot_payload`` so it can never move the restart hash.
    deployment_id: str | None = APIField(default=None)
    asset_ref: str | None = APIField(default=None, sharing=Sharing.PRIVATE)
    context_data: dict[str, Any] = APIField(default_factory=dict)
    cli_config: dict[str, Any] = APIField(default_factory=dict)
    workdir: str | None = APIField(default=None)
    favorite_index: int | None = APIField(default=None)
    status: str = APIField(default=ProcessStatus.NEW.value)
    session_id: str | None = APIField(default=None)
    use_worker_history: bool = APIField(default=False)
    shell_mode: bool = APIField(
        default=False, description="False=direct PTY spawn (default), True=legacy zsh intermediary"
    )
    project_id: str | None = APIField(default=None, sharing=Sharing.PRIVATE)
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
        description="FSRef for `<exe_folder>/assets/` — materialised embedded sub-agents / skills.",
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
    connection_id: str | None = APIField(
        default=None,
        persist=Persist.FALSE,
        description="WebSocket connection ID of the browser tab that opened this process (runtime field, not persisted)",
    )
    terminal_theme: str | None = APIField(
        default=None,
        persist=Persist.TRUE,
        description=(
            "Palette of the terminal this worker paints into: 'light' | 'dark'. "
            "Sent by the client on open. Workers emit truecolor SGR chosen at "
            "launch from their own theme setting, so the host's xterm palette "
            "cannot recolor them — the theme has to travel with the launch or a "
            "light terminal gets the worker's dark-theme (pale) foregrounds. "
            "Persisted so a server-side recovery relaunch keeps the same palette. "
            "Read at startup by the CLI: toggling mid-session does not recolor a "
            "running worker, only the next launch."
        ),
    )
    visible: bool = APIField(
        default=False,
        description=(
            "Whether this process is shown as a terminal tab. Set on open "
            "(True) / close (False). No longer a membership flag — the strip's "
            "membership is the ``Tab`` entity (docs/tab-management.md)."
        ),
    )
    pty_mode: bool = APIField(
        default=True,
        persist=Persist.TRUE,
        description=(
            "Transport intent for this session and the SOLE routing key. True → "
            "interactive PTY (live xterm terminal). False → headless JSON-stream "
            "(``-p``/stream-json, no PTY, no xterm); the loader skips the PTY "
            "attach so the choice is durable across reload. Every execution router "
            "keys on ``pty_mode``, never on ``visible`` (which is tab chrome only). "
            "``pty_mode`` seeds ``visible`` at launch and the chat⇄terminal toggle "
            "keeps the two in lock-step."
        ),
    )
    # last_active_at moved to base Entity (epoch-ms, tab-management.md Part 3).
    auto_rename: bool = APIField(
        default=True,
        description=(
            "When True, PTY OSC title escapes are allowed to update `name`. "
            "Cleared the first time the user manually renames this tab in the UI."
        ),
    )
    process_type: ProcessKind | None = APIField(
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
    start_failure: str | None = APIField(
        default=None,
        description=(
            "Human-readable reason the worker failed to start or terminated "
            "with a crash signal. Non-None LATCHES the "
            "process: auto-recovery sweeps and plain open() calls refuse to "
            "respawn until an explicit user retry (open with retry=true) "
            "clears it. This is what breaks the spawn → instant-death → "
            "auto-reopen loop. Cleared on explicit retry and on any spawn "
            "that survives past the window."
        ),
    )
    exit_code: int | None = APIField(
        default=None,
        description=(
            "Terminal exit code of a driverless EXECUTION process (a flow "
            "function subprocess) — stamped by the GraphWorkflowManager when the "
            "subprocess finishes. None for worker-driven processes."
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
    additional_dirs: list[str] = APIField(
        default_factory=list, description="Extra directories passed to Claude via --add-dir"
    )
    load_flowpad_assistant: bool | None = APIField(
        default=None,
        description=(
            "Per-process override for mounting the Flowpad Assistant project "
            "(--add-dir → its .claude/skills + agents become discoverable). "
            "None inherits the global ServiceConfig.load_flowpad_assistant. "
            "Resolve via the assistant_enabled property; the driver reads that."
        ),
    )
    embedded_subagent_ids: list[str] = APIField(
        default_factory=list, description="Embedded sub-agent names materialized into process instruction assets"
    )
    embedded_asset_refs: list[TypeId] = APIField(
        default_factory=list,
        description=(
            "TypeIds of entities whose files have been materialized into the "
            "process's <record_dir>/assets folder. Claude discovers them via --add-dir."
        ),
    )
    process_hook_events: list[str] = APIField(
        default_factory=list,
        description="Process-local worker hook events enabled for this process.",
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
    markdown_docs: list[dict] = APIField(
        default_factory=list,
        description=(
            "User-facing markdown docs this process authored, oldest-first. Each "
            "entry is {path, name, change} where change is 'create' (Write) or "
            "'update' (Edit). The tail is the latest doc — what the ribbon's docs "
            "chip shows by default. Plan files and agent-internal docs are excluded. "
            "Persists across reloads so the 'Open Doc' affordance survives a refresh."
        ),
    )
    status_report: dict | None = APIField(
        default=None,
        description=(
            "Latest ProcessStatusReport snapshot (transcript_analyzer.counters): "
            "running token/message/tool counters + focused-asset pointer + "
            "worker/process status. Backend-computed projection, recomputed from "
            "the transcript each debounce flush and pushed live on the "
            "'progress_report' flow_data envelope. Persisted so the counters "
            "one-liner survives a reload."
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

    @model_validator(mode="before")
    @classmethod
    def _adopt_legacy_embedded_agent_ids(cls, data: Any) -> Any:
        """Read rows persisted before ``embedded_agent_ids`` was renamed.

        The field is a legacy name list for embedded sub-agents; nothing writes
        it any more, but old rows (and old wire payloads) still carry the old
        key. Map it onto the new key only when the new one is absent, so a
        payload that carries both wins on the new name.
        """
        if isinstance(data, dict) and "embedded_agent_ids" in data and "embedded_subagent_ids" not in data:
            data = dict(data)
            data["embedded_subagent_ids"] = data.pop("embedded_agent_ids")
        return data

    @model_validator(mode="after")
    def _arm_binding_lock(self) -> "AgenticProcess":
        # ``object.__setattr__`` bypasses our hook so the marker is set
        # unconditionally even though the field isn't declared on the model.
        object.__setattr__(self, "_binding_lock_armed", True)
        return self

    @model_validator(mode="after")
    def _migrate_legacy_process_assets_mount(self) -> "AgenticProcess":
        if self.id:
            self.additional_dirs = [
                path for path in (self.additional_dirs or []) if not self._is_process_assets_path(path)
            ]
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
                    self.process_type = ProcessKind(nested)
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

    @staticmethod
    async def _await_capability_discovery() -> None:
        """Wait for the startup capability sweep when it's still in flight; a
        failed sweep degrades to "not discovered" rather than raising."""
        from flow_sdk.core.capabilities.discovery import ensure_discovered  # noqa: PLC0415

        try:
            await ensure_discovered()
        except Exception:
            logger.debug("capability discovery failed", exc_info=True)

    @classmethod
    async def is_installed(cls, worker_type: "WorkerType | str | None" = None) -> bool:
        """Whether this worker's CLI was found by capability discovery.

        Reads the discovery dict (the same SSOT actual spawns use) — never a
        second ``which``.
        """
        from flow_sdk.builtin.agentic_process.cli_drivers import worker_bin_folder  # noqa: PLC0415

        await cls._await_capability_discovery()
        return worker_bin_folder(get_driver(worker_type).name) is not None

    @classmethod
    async def is_logged_in(cls, worker_type: "WorkerType | str | None" = None) -> "WorkerAuthResult":
        """Login state of this worker's CLI (NOT_INSTALLED / LOGGED_IN /
        LOGGED_OUT / UNKNOWN). The driver's ``auth_probe`` owns the install
        gate; this facade only adds the discovery wait. Never raises;
        "couldn't check" is UNKNOWN, not LOGGED_OUT."""
        await cls._await_capability_discovery()
        return await get_driver(worker_type).auth_probe()

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
        from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeAgentOptions  # noqa: PLC0415

        cmd = ClaudeAgentOptions(resume=True)
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

        Three things must all be set for ``ClaudeAgentOptions.to_spawn_args``
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
        from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeAgentOptions  # noqa: PLC0415

        new_session_id = str(uuid4())
        cmd = ClaudeAgentOptions(
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

        Resolve, then RECOVER. First retry on None invalidates any stale
        uname_cache entry (covers a transient cache/DB-contention miss under
        heavy parallel writes — see Cluster #10 in debug_log.md). If the row is
        still absent it is genuinely gone: the @local compute_node is a fileless
        singleton that a compute-node sweep can delete out from under a running
        session, and (unlike the @local user/project) it is only otherwise
        re-seeded by the app-boot ``bootstrap()``. So recreate it on demand via
        the same idempotent seed ``bootstrap()`` uses, rather than returning None
        and letting the launch strand the session with a permanent
        ``start_failure`` latch.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        # The whole resolve→retry→recreate sequence now lives in get_local():
        # it resolves by stable id, invalidates a stale uname_cache and retries,
        # falls back to the legacy uname row, and self-heals by minting the
        # singleton when it is genuinely gone. Never returns None by default.
        return await ComputeNode.get_local()

    async def _latched_failure_recovered(self) -> bool:
        """True iff the current ``start_failure`` latch names a cause we can
        PROVE is now satisfiable, so a non-retry (refresh-driven) open may
        self-heal the latch instead of refusing.

        Conservative by design: only the @local-compute-node-missing cause is
        recognised. That node is a fileless singleton a sweep can delete out
        from under a session and bootstrap re-seeds; once it is resolvable
        again the launch that latched this can succeed. Every other latch —
        notably the instant-exit ``"Worker exited Ns after launch"`` — returns
        False and stays paused, preserving the spawn→die→respawn loop breaker.
        """
        latch = (self.start_failure or "").lower()
        if LOCAL_COMPUTE_NODE_MISSING_FAILURE.lower() in latch:
            try:
                return await self._get_local_compute_node() is not None
            except Exception:
                return False
        return False

    def _adopt_shell_tab_order(self, shell: "Shell | None") -> None:
        """One-time adoption: the AP owns its tab_order (base Entity) across
        shell-transport swaps / worker restarts — no context_data carry-over.
        No-op once the AP holds a slot or when the shell has none."""
        if shell is not None and not self.tab_order and shell.tab_order:
            self.tab_order = shell.tab_order

    async def _drop_stale_shell(
        self,
        shell: "Shell | None",
        *,
        reason: str,
        preserve_shell_id: bool = False,
    ) -> None:
        """Discard a linked shell that can no longer be reattached.

        ``preserve_shell_id`` is the recovery case (after-restart respawn into
        the SAME shell id): we must KEEP the shell record + its ``.pty`` stream
        file so the relaunch appends to it and the client replays the
        pre-restart scrollback. ``shell.close()`` is permanent teardown — it
        deletes the record (and the ``.pty``), wiping that history — so the
        recovery path takes a SOFT drop instead: terminate the worker (which is
        the actual reason for dropping — it releases the JSONL session lock so
        ``--resume`` won't collide) and evict the dead PTY handle, nothing more.
        The ``.pty`` is keyed by the preserved shell id, so the relaunch's
        ``PtyStreamFile`` reopens the same file and continues its seq epoch.
        """
        stale_shell_id = shell.id if shell is not None else self.shell_id
        if shell is not None:
            logger.warning("AgenticProcess %s: discarding stale shell %s (%s)", self.id, shell.id, reason)
            self._adopt_shell_tab_order(shell)
            try:
                await shell.terminate_worker()
            except Exception as exc:
                logger.warning(
                    "AgenticProcess %s: failed terminating stale worker for shell %s: %s", self.id, shell.id, exc
                )
            if preserve_shell_id:
                # Soft drop — keep record + .pty for the same-id relaunch; just
                # evict the dead in-memory PTY handle so a fresh one can spawn.
                try:
                    await shell.evict_pty_handle()
                except Exception as exc:
                    logger.warning(
                        "AgenticProcess %s: failed evicting stale PTY for shell %s: %s", self.id, shell.id, exc
                    )
            else:
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
        retry: bool = False,
        session_id_override: str | None = None,
        terminal_theme: str | None = None,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Spawn (or reattach to) this AgenticProcess's PTY worker.

        ``retry=True`` marks an explicit user retry: it clears a
        ``start_failure`` latch before launching. Without it, a latched
        process (worker exited instantly on its last launch) refuses to
        spawn — that refusal is what stops the auto-recovery sweep from
        relaunching a worker that dies on arrival, every 5 seconds, forever.

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

        Body runs under a per-process ``_OPEN_LOCKS`` lock and reloads the
        process after acquiring it, so two concurrent refresh-driven open calls
        (e.g. two browser tabs) can't both run recovery from stale process
        snapshots and double-spawn Claude.
        """
        async with _OPEN_LOCKS[self.id]:
            fresh = await AgenticProcess.get_by_id(self.id)
            if fresh is None and not self.exist_in_db:
                await self.save()
                fresh = await AgenticProcess.get_by_id(self.id)
            if fresh is None:
                return ApiFailResponse(message=f"Process not found: {self.id}")
            if session_id_override:
                fresh.session_id = session_id_override
            # Same reason as ``session_id_override``: this arrived on the request,
            # so it exists only on the caller's copy. The launch below runs on
            # ``fresh``, so a value left on ``self`` never reaches the worker.
            if terminal_theme:
                fresh.terminal_theme = terminal_theme

            # Suppress the restart-required auto-flag while start_pty() mutates
            # fields (status, session_id are tracked, but those mutations are
            # not "drift"). Cleared on success after we capture the new snapshot.
            fresh._set_start_lifecycle(True)
            try:
                result = await fresh._perform_open(instruction, visible, retry=retry)
                return result
            finally:
                fresh._set_start_lifecycle(False)

    async def start(
        self,
        instruction: str | None = None,
        visible: bool | None = None,
        retry: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Back-compat alias for :meth:`start_pty`. Prefer ``start_pty`` —
        the bare ``start`` reads as a generic lifecycle word but this method
        only ever spawns a PTY worker (visibility doesn't gate that)."""
        return await self.start_pty(instruction=instruction, visible=visible, retry=retry)

    async def _perform_open(
        self,
        instruction: str | None,
        visible: bool | None,
        retry: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Body of ``start_pty`` (the legacy ``start``/HTTP ``open`` aliases route
        here) — runs while the per-process open lock
        is held. All lifecycle decisions (reattach vs recover vs fresh) live
        here; the caller is responsible for the lock and the start-lifecycle
        flag."""
        previous_visible = self.visible
        previous_pty_mode = self.pty_mode
        previous_shell_id = self.shell_id
        previous_sidecar_shell_id = self.sidecar_shell_id
        cleared_start_failure = False
        shell = None
        # The shell this attempt bound for a fresh launch (via
        # ``_get_or_create_shell``). Tracked separately from ``shell`` so the
        # failure cleanup only ever stops a transport THIS open partially
        # created — never a pre-existing live shell observed during the
        # reattach phase (stopping that would kill a healthy worker on an
        # unrelated error, e.g. a transient save failure).
        launch_shell = None
        # Set when a fresh spawn consumes a queued prompt as its launch arg
        # (see the pop below). Defined OUTSIDE the try so the except handlers'
        # ``_requeue_failed_launch(launched_head)`` can't NameError (masking
        # the real failure) when the exception fires before the pop section.
        launched_head: dict | None = None
        try:
            # If we're stuck in STOPPING with a dead worker (orphan from a
            # crashed close()/exit()), reset to STOPPED before doing anything
            # else. The rest of this function then sees a startable state
            # rather than refusing or spawning under stale assumptions.
            await self.reap_if_orphaned()

            # Failed-to-start latch: the last launch died within the
            # instant-exit window. Refuse to respawn — the auto-recovery
            # sweep and route loaders call open() unconditionally, and
            # honoring them here is what produced the spawn→die→respawn
            # loop. Only an explicit user retry (retry=True) re-arms — UNLESS
            # the latched cause is one we can prove is now satisfiable again
            # (e.g. the @local compute_node was swept out and has since been
            # re-seeded). Such a latch must self-heal on an ordinary
            # refresh-driven open, or a transient environmental fault strands
            # the session forever behind a manual Retry. Genuine instant-exit
            # latches stay paused — that's the loop breaker.
            if self.start_failure:
                if not retry and not await self._latched_failure_recovered():
                    return ApiFailResponse(
                        message=(
                            f"Process failed to start: {self.start_failure} "
                            "Auto-relaunch is paused — use Retry to relaunch."
                        ),
                    )
                logger.info(
                    "AgenticProcess %s: clearing start_failure latch (%s) — %s",
                    self.id,
                    self.start_failure,
                    "user retry" if retry else "latched cause auto-recovered on refresh",
                )
                self.start_failure = None
                cleared_start_failure = True
            # Mint a provisional id ONLY for a vendor that can actually be
            # handed one at launch. Codex and opencode mint their own
            # (``rollout-…`` / ``ses_…``) and reject a foreign id, so stamping a
            # FlowPad uuid here gave them a phantom session id that no vendor
            # store has ever heard of — it is later replaced by the adopted real
            # one, but until then every lookup keyed on it misses. ``prompt()``
            # already honours this trait (see ``preassign_interactive_session_id``
            # at the prompt admission); this is the same gate on the open path.
            if not self.session_id and bool(getattr(self.driver, "preassign_interactive_session_id", False)):
                self.session_id = str(uuid4())
            reattach_changed = False
            # True iff this open is respawning a dead worker (after-restart
            # recovery), set in the stale-shell-drop branch below. Drives the
            # ``recovered`` event emission in the success tail.
            is_recovery = False
            if visible is not None and self.visible != visible:
                self.visible = visible
                reattach_changed = True
            # Lock-step the durable transport intent: opening a PTY (visible=True)
            # is a terminal session, so persist ``pty_mode=True`` (saved in the
            # open tail) — a reload then stays in terminal mode instead of falling
            # back to headless. Headless never reaches here (the loader skips
            # ``start`` when ``pty_mode is False``).
            if visible is True:
                self.pty_mode = True

            shell = await self.shell() if self.shell_id else None
            if shell is not None and not await shell.ensure_live_compute_node_binding():
                return ApiFailResponse(message=f"Compute node not found for linked shell {shell.id}")

            if (
                self.status
                in (
                    ProcessStatus.STARTING.value,
                    ProcessStatus.RUNNING.value,
                )
                and self.shell_id
            ):
                # Reattach gate: both the PTY session AND the worker PID must be
                # alive. ``has_attachable_pty()`` only proves the pseudo-terminal
                # is registered on the compute node — it accepts a PTY whose
                # Claude child has already exited. Pairing it with
                # ``worker_alive()`` (psutil-based PID + cmdline match) is what
                # prevents the "empty terminal after refresh" symptom.
                if shell is not None and await shell.has_attachable_pty() and await shell.worker_alive():
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
                # This open is RECOVERING a dead worker (running/starting status
                # but PTY+worker gone — the after-restart case). Flag it so the
                # success tail emits the ``recovered`` event, regardless of
                # whether the watchdog or a client-driven open won the respawn.
                is_recovery = True

            await self.get_project()

            process_assets = await self.prepare_process_assets()
            cmd = self._finalized_restart_cli_options()
            self._apply_process_assets(cmd, process_assets)

            # Fork & CLAUDE_PROJECT_DIR resume-cwd pinning are Claude-only —
            # Codex/Copilot mint their own session and use ``-C <cwd>``, not
            # ``CLAUDE_PROJECT_DIR``. Gated on the driver trait, not the options
            # shape (``fork_session_id`` is now a base attr).
            if self.driver.pins_resume_cwd:
                if cmd.fork_session_id:
                    requested_fork_session_id = cmd.fork_session_id
                    cmd.fork_session_id = await self._find_resumable_session(requested_fork_session_id)
                    if cmd.fork_session_id is None:
                        # A fork has different semantics from a fresh resume: the
                        # requested parent is the source of the child's context.
                        # Never degrade a vanished parent into ``--resume`` of the
                        # brand-new child id, which has no transcript and produces
                        # a misleading worker start failure after spawning a PTY.
                        return ApiFailResponse(
                            message=f"Fork source session not found: {requested_fork_session_id}",
                            status_code=404,
                        )
                # When resuming or forking, ensure CLAUDE_PROJECT_DIR points to where
                # the source session's transcript lives. For a fork, self.session_id is
                # the brand-new UUID with no transcript yet; use fork_session_id instead.
                if cmd.fork_session_id or (cmd.resume and self.session_id):
                    lookup_id = cmd.fork_session_id or self.session_id
                    session_rec = self._discover_claude_record_session(lookup_id)
                    if session_rec and session_rec.cwd:
                        cmd.env_vars["CLAUDE_PROJECT_DIR"] = session_rec.cwd
                        cmd.workdir = session_rec.cwd

            # Runtime env injection: process identity + backend-pinned `flow`
            # CLI — the shared chokepoint all spawn paths use.
            apply_worker_env(cmd.env_vars, self)
            # API-key auth: stamp the OpenRouter model slug (+ codex -c overrides)
            # onto the options before argv is frozen (env/token ride
            # apply_worker_secret_env at spawn time). No-op in device mode.
            from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import (
                apply_api_model_to_options,
            )

            await apply_api_model_to_options(cmd, self)
            # Inject the WebSocket connection ID so the worker can navigate its own tab explicitly
            if self.connection_id:
                cmd.add_env("FLOWPAD_CONNECTION_ID", self.connection_id)

            is_resume = cmd.resume

            shell = await self._get_or_create_shell()
            launch_shell = shell
            self.shell_id = shell.id
            self.status = ProcessStatus.STARTING.value
            if self.driver.name in (WorkerType.CODEX.value, WorkerType.COPILOT.value):
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
                async with _QUEUE_LOCKS[self.id]:
                    q = self.queue
                    state = q.read()
                    if state.get("enabled", True) and state.get("entries"):
                        launched_head = q.pop(source="launch")  # persists + logs "pop"
                        if launched_head is not None:
                            instruction = launched_head["prompt"]
                            q.log(
                                "inject",
                                "launch",
                                entry_id=launched_head.get("id"),
                                prompt=str(instruction)[:200],
                            )

            if self.shell_mode:
                # Legacy path — zsh intermediary
                secret_extra_env = None
                if _shell_compute_is_local(shell):
                    secret_env = dict(cmd.env_vars)
                    explicit_keys = set(secret_env)
                    await apply_worker_secret_env(secret_env, self)
                    secret_extra_env = {key: value for key, value in secret_env.items() if key not in explicit_keys}
                await shell.start_pty(on_exit=on_exit, extra_env=secret_extra_env or None)
                worker_is_alive = await shell.worker_alive()
                if not worker_is_alive:
                    execution_info = await shell.launch(cmd, instruction=instruction)
                    logger.info(
                        "AgenticProcess %s worker launched (shell): pid=%s name=%r",
                        self.id,
                        execution_info.pid,
                        execution_info.name,
                    )
            else:
                # Direct path — Claude IS the PTY process (no zsh intermediary)
                spawn_argv, spawn_env = cmd.to_spawn_args(instruction=instruction)
                # Spawn with the discovered harness capability: its value is
                # the CLI's bin FOLDER (terminal-PATH resolution), prepended
                # to PATH so argv[0] and `#!/usr/bin/env node` both resolve
                # regardless of how this backend was launched. On a miss,
                # re-discover once (covers the boot race and retry-after-
                # install), then fail fast into the start_failure latch.
                from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
                    prepend_path_dir,
                    worker_bin_folder,
                    worker_capability_kind,
                    worker_path_env,
                )

                capability_kind = worker_capability_kind(self.driver.name)
                path_env = worker_path_env(self.driver.name)
                if path_env is None:
                    from flow_sdk.core.capabilities.discovery import run_discovery

                    await run_discovery([capability_kind])
                    path_env = worker_path_env(self.driver.name)
                if path_env is None:
                    raise RuntimeError(
                        f"Command not found: '{spawn_argv[0]}' — no {capability_kind} installation discovered"
                    )
                spawn_env = {**path_env, **spawn_env}  # explicit worker env wins
                # …except the discovered bin folder stays first on PATH: the
                # worker env's own PATH (apply_worker_env's venv pin) is built
                # from this backend's possibly-stripped service PATH, and
                # letting it clobber the capability prepend re-breaks spawn
                # (the D02 "codex not found despite discovery" failure).
                folder = worker_bin_folder(self.driver.name)
                if folder and "PATH" in spawn_env:
                    spawn_env["PATH"] = prepend_path_dir(folder, spawn_env["PATH"])
                if _shell_compute_is_local(shell):
                    await apply_worker_secret_env(spawn_env, self)
                spawned = await shell.start_pty(on_exit=on_exit, spawn_args=spawn_argv, extra_env=spawn_env)
                if not spawned:
                    worker_is_alive = await shell.worker_alive()
                if not worker_is_alive:
                    execution_info = await shell.set_worker_pid_direct(cmd)
                    logger.info(
                        "AgenticProcess %s worker launched (direct PTY): pid=%s name=%r",
                        self.id,
                        execution_info.pid,
                        execution_info.name,
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

            # Respawned a dead worker (after-restart recovery) — emit the
            # distinct ``recovered`` event so watching clients re-attach. Fires
            # from the shared open path, so it's emitted whether recovery was
            # driven by the startup watchdog or a client-driven open (the SDK
            # auto-recovery sweep), not just one of them.
            if is_recovery:
                try:
                    from flow_sdk.server.pty_recovery import mark_recovered, notify_watchers_recovered

                    worker_pid = shell.worker_pid if shell is not None else None
                    mark_recovered(self.id)
                    await notify_watchers_recovered(self.id, self.shell_id, worker_pid)
                except Exception:
                    logger.debug("recovered-event emit skipped", exc_info=True)

            return ApiSuccessResponse(data=self._build_open_payload(shell, is_resume=is_resume))

        except asyncio.CancelledError:
            logger.warning(
                "AgenticProcess %s start_pty cancelled (status=%s shell_id=%s)", self.id, self.status, self.shell_id
            )
            self.status = ProcessStatus.FAILED.value
            await self.save()
            self._requeue_failed_launch(launched_head)
            raise
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} start_pty error: {e}")
            # A failed terminal open must not strand the entity in its
            # optimistic PTY intent. Best-effort stop any partially created
            # transport, then restore the prior shell/transport so an existing
            # headless chat remains renderable and an explicit Retry can make
            # one clean launch attempt. Only ``launch_shell`` (bound by THIS
            # attempt's fresh-launch section) is stopped — a pre-existing shell
            # seen during the reattach phase may host a live healthy worker.
            if launch_shell is not None:
                try:
                    await launch_shell.stop()
                except Exception:
                    logger.warning(
                        "AgenticProcess %s: failed to clean partial shell %s",
                        self.id,
                        getattr(launch_shell, "id", None),
                        exc_info=True,
                    )
            self.shell_id = previous_shell_id
            self.sidecar_shell_id = previous_sidecar_shell_id
            self.visible = previous_visible
            self.pty_mode = previous_pty_mode
            self.status = ProcessStatus.FAILED.value
            # Latch normal launch failures: the UI surfaces them and
            # open()/auto-recovery stops retrying a spawn that can't succeed.
            # For an explicit Retry that fails before launch after clearing an
            # existing latch, leave the latch cleared so the refused-open gate
            # does not immediately block subsequent attempts.
            if retry and cleared_start_failure:
                self.start_failure = None
            else:
                self.start_failure = str(e)
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
            self._adopt_shell_tab_order(shell)

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

    async def _enter_cli_mode(self) -> ApiSuccessResponse | ApiFailResponse:
        """Switch to CLI (headless) transport: kill the PTY worker, keep the session.

        PTY and CLI are mutually-exclusive transports of ONE logical session (one
        ``session_id``, one transcript). This kills the interactive worker via
        :meth:`exit` (which preserves ``shell_id`` + ``session_id`` + transcript)
        and flips ``visible=False`` + ``pty_mode=False`` so the next :meth:`prompt`
        runs headless and resumes the very same session, and a reload stays
        headless. ``exit()`` alone can't reset ``visible`` — a plain ``restart``
        (exit+start) must keep it True — so the reset lives here, the explicit
        mode-switch. The mid-turn guard is enforced by the caller
        (:meth:`switch_mode`) so two workers never share the transcript.
        """
        if self.shell_id and await self.is_running():
            try:
                exit_result = await self.exit()
            except Exception as e:
                # Switching to chat: a PTY that's already dead IS the desired end
                # state. exit() can raise (e.g. "PTY session is not alive") when the
                # worker died mid-session (a Ctrl-C, a crashed TUI) — that must not
                # 500 the switch. Treat it as already-exited and continue headless.
                logger.info("switch→cli: exit() ignored, PTY already gone: %s", e)
                exit_result = None
            if isinstance(exit_result, ApiFailResponse) and "No active shell" not in exit_result.message:
                return exit_result
        # Reload so the visible reset rides on the row exit() just saved (status,
        # context_data) rather than overwriting it from a stale snapshot.
        fresh = await AgenticProcess.get_by_id(self.id) or self
        fresh.visible = False
        # Persist the durable transport intent so a reload keeps this session
        # headless (the loader reads ``pty_mode`` to decide whether to attach a PTY).
        fresh.pty_mode = False
        await fresh.save()
        return ApiSuccessResponse(
            data={
                "id": fresh.id,
                "status": fresh.status,
                "visible": fresh.visible,
                "pty_mode": fresh.pty_mode,
                "session_id": fresh.session_id,
            }
        )

    def _reject_if_turn_in_flight(self) -> ApiFailResponse | None:
        """409 when a turn is in flight (``is_turn_busy``), else ``None``.

        Spawning or tearing down a worker mid-turn would put two workers on one
        transcript (or drop the in-flight turn), so ``switch-mode`` (both
        directions) and ``restart`` reject while busy. Keys on the SAME
        :func:`is_turn_busy` predicate the frontend toggle gate and the wire
        ``busy`` status derive from — so the 409 and the toggle can never
        disagree (the old lock-only check missed a native-xterm turn, which
        holds no lock, letting a mid-turn switch through).
        """
        if is_turn_busy(self):
            return ApiFailResponse(
                message="a turn is in flight",
                status_code=409,
            )
        return None

    @action.post(action_name="switch-mode")
    async def switch_mode(self) -> ApiSuccessResponse | ApiFailResponse:
        """Standardized transport switch — the single backend seam the frontend
        ``AgenticProcess.switchMode(mode)`` (and the ribbon chat⇄terminal toggle)
        calls. POST body: ``{"mode": "interactive" | "cli"[, cols, rows]}`` —
        ``WorkerMode`` values (``interactive`` is the PTY worker).

          - ``cli``         → headless JSON-stream (kill PTY, visible=False, pty_mode=False)
          - ``interactive`` → PTY terminal (spawn PTY, visible=True, pty_mode=True)

        Both are the SAME logical session (one ``session_id``/transcript); routing
        keys on the transport intent ``pty_mode`` (``interactive`` ⇒ ``pty_mode=True``,
        ``cli`` ⇒ ``pty_mode=False``), independent of tab ``visible``. Rejected
        mid-turn in BOTH directions (409) so two workers never share the transcript.
        """
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        raw = str(body.get("mode", "")).lower()
        try:
            mode = WorkerMode(raw)
        except ValueError:
            return ApiFailResponse(
                message=f"unknown mode {raw!r} (expected {WorkerMode.INTERACTIVE!r} or {WorkerMode.CLI!r})"
            )
        # Mid-turn guard for BOTH directions (hoisted from _enter_cli_mode): a
        # switch that spawns/kills a worker while a prompt turn is in flight would
        # put two workers on one transcript.
        if (resp := self._reject_if_turn_in_flight()) is not None:
            return resp
        if mode is WorkerMode.CLI:
            return await self._enter_cli_mode()
        # INTERACTIVE (PTY): the canonical open path — spawns the PTY and sets
        # ``visible=True`` (which persists ``pty_mode=True`` in the open tail).
        # Route through start_pty rather than its unlocked implementation so a
        # watchdog/client race cannot launch two workers for the same process.
        return await self.start_pty(instruction=None, visible=True, retry=True)

    @action.post(action_name="restart")
    async def http_restart(self) -> ApiSuccessResponse | ApiFailResponse:
        """exit() + start_pty(). Shell entity is preserved and reused.

        Restart is always an explicit user/worker request, so it carries
        ``retry=True`` — a ``start_failure`` latch never blocks it. Rejected
        mid-turn (409): tearing the worker down while a prompt turn is in flight
        would drop the in-flight turn.
        """
        if (resp := self._reject_if_turn_in_flight()) is not None:
            return resp
        exit_result = await self.exit()
        if isinstance(exit_result, ApiFailResponse) and "No active shell" not in exit_result.message:
            return exit_result
        return await self.start_pty(retry=True)

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

        return ApiSuccessResponse(data={"scheduled": True, "id": self.id, "status": self.status})

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
        self.add_shared_context_entities(TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id))
        return True

    def _force_rebind_project_id(self, project_id: str) -> None:
        """Bypass the binding-freeze and set ``project_id`` unconditionally.

        Use only when the caller has confirmed the new id is correct
        (e.g. ``Project.recover_by_path`` resurrected the dangling FK and
        the new Project entity is the canonical replacement). Also appends
        the matching Project TypeId to shared context.
        """
        object.__setattr__(self, "project_id", project_id)
        self.add_shared_context_entities(TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id))

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

    def get_implicit_private_context_entities(self) -> List[TypeId]:
        """Project the owned shell into private context (the reverse of
        Shell projecting its ``process_id``). Derived from the ``shell_id``
        field so the process and its shell carry each other as lineage chips,
        both directions."""
        from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415

        refs = super().get_implicit_private_context_entities()
        # Guard the id (see Shell.get_implicit_private_context_entities): a
        # malformed shell_id must skip the chip during serialization, not raise.
        if is_valid_entity_id(self.shell_id):
            refs.append(TypeId(type=BuiltinEntityType.SHELL.value, id=self.shell_id))
        # collaboration_room_id → room chip: a process executed in a shared
        # collaboration room carries the room as a lineage chip, so an executed
        # prompt surfaces an openable "room" chip on its run.
        if is_valid_entity_id(self.collaboration_room_id):
            refs.append(TypeId(type=BuiltinEntityType.COLLABORATION_ROOM.value, id=self.collaboration_room_id))
        return refs

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

    async def pair_analysis_context(self, owner=None) -> bool:
        """Pair an ANALYSIS-kind process with the entity it analyzes.

        The analyzed entity is whatever ``target_typeid_str`` points at
        (normally the analyzed AgenticProcess). Pairing means: this process
        becomes the target's child (``parent_type_id``) and each carries the
        other in its private context. No-op (False) when the target is not an
        entity-form typeid (surface-scoped targets like
        ``claude_session/<sid>``) or cannot be loaded — a missing target must
        never block a launch.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.fs_store.type_id import TypeId as _TypeId  # noqa: PLC0415

        if not self.target_typeid_str:
            return False
        try:
            tid = _TypeId(self.target_typeid_str)
        except Exception:
            return False
        cls = SchemaRegistry.get_entity_cls(tid.type)
        if cls is None or not tid.id:
            return False
        target = await cls.get_by_id(tid.id)
        if target is None:
            return False
        self.parent_type_id = str(tid)
        self.add_private_context_entities(tid)
        await self.save(owner)
        target.add_private_context_entities(self.typeid)
        await target.save(owner)
        return True

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

            # Inherit the parent's name (+ " (fork)") when it has a real one, so the
            # fork reads meaningfully immediately; otherwise leave it null (name
            # defaults to None) and let the fork's own transcript subject stamp it.
            parent_name = (self.name or "").strip()
            new_proc = AgenticProcess.fork(
                session_id=self.session_id,
                workdir=self.workdir,
                project_id=self.project_id,
                visible=visible,
                shared_context_entities=list(self.shared_context_entities or []),
                name=f"{parent_name} (fork)" if parent_name else None,
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
        from flow_sdk.fs_store.record_paths import shadow_dir_for

        return shadow_dir_for("agentic_process", self.id)

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

        (b) Cold start via the drain is **headless-only** — gated on the
        transport (``pty_mode``), NOT on tab-visibility. A headless first prompt
        (``pty_mode=False``) boots the worker *with* it through
        ``headless_prompt`` — deterministic, no PTY. A PTY session
        (``pty_mode=True``) is booted by its dock loader's ``start()`` instead,
        whose fresh-spawn path pops the queue head as the launch arg (see
        ``_perform_open``). If the drain ALSO cold-started a PTY process it would
        race the loader into an empty boot and lose the popped head (the original
        "lost first prompt" bug). So the drain withholds cold-start from PTY
        (``pty_mode``) processes.
        """
        if is_ready_for_input(self, worker_status=worker_status):
            return True
        if worker_status == WorkerStatus.PENDING_USER:
            return True
        return not self.pty_mode and not getattr(self, "_turn_in_flight", False) and is_process_startable(self.status)

    def _schedule_queue_drain(self, source: str) -> None:
        """Fire-and-forget a drain attempt; never block the caller."""
        try:
            # Common-case skip: a process that never enqueued has no queue
            # file — don't pay the drain's lock + JSON read + drain_check log
            # append on every turn end.
            if not self.queue.exists():
                return
        except Exception:
            pass
        try:
            task = asyncio.create_task(self._maybe_drain_queue(source))
        except RuntimeError:
            return  # no running loop (sync context) — nothing to drain into
        task.add_done_callback(lambda t: self._log_drain_task_exc(t, source))

    async def end_headless_turn(self, log_prefix: str) -> None:
        """Shared tail of every headless turn's ``_run_turn`` finally — both the
        driver background turns and the ``_http_prompt`` streaming (UI chat)
        turn end here.

        Clears the ``_turn_in_flight`` override BEFORE the terminal
        ``notify_updated`` so the broadcast carries the real JSONL-derived
        ``worker_status=COMPLETE`` projection (``save()`` alone short-circuits
        because no real entity field changed) — that's what flips
        ``proc.output()`` consumers out of their wait loop. Then schedules a
        queue drain on this completion edge: headless ``prompt()`` returns at
        SCHEDULING time, so the chain drain in ``_maybe_drain_queue`` fires
        while the turn is still in flight and bails ``not_ready``; this edge is
        what actually advances a multi-entry queue (VIBE-005).
        """
        object.__setattr__(self, "_turn_in_flight", False)
        try:
            await self.notify_updated()
        except Exception:
            logger.exception("%s: terminal notify_updated failed", log_prefix)
        # Push-reindex the files this headless turn wrote/edited (see
        # _schedule_turn_end_reindex — transcript-tail sourced, fire-and-forget).
        self._schedule_turn_end_reindex("headless")
        # Turn-end default-name stamp — a headless turn never reaches the PTY
        # flush seam, so this tail is its only chance to name itself.
        try:
            await self.stamp_default_name()
        except Exception:
            logger.debug("%s: default-name stamp failed", log_prefix, exc_info=True)
        try:
            self._schedule_queue_drain("complete")
        except Exception:
            logger.debug("%s: completion drain schedule failed", log_prefix, exc_info=True)

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
        async with _QUEUE_LOCKS[self.id]:
            state = q.read()
            if not state.get("enabled", True) or not state.get("entries"):
                q.log("drain_check", source, reason="empty_or_disabled")
                return
            # One transcript tail-read per drain check, shared by the readiness
            # gate and the not-ready log line.
            resolved = self.fetch_worker_status() if self.status == ProcessStatus.RUNNING.value else None
            if not self._queue_ready(resolved):
                q.log(
                    "drain_check",
                    source,
                    reason="not_ready",
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
        finally:
            # Chain the drain: this turn just completed and freed the worker, so
            # run the next queued item NOW. Without this, a prompt enqueued WHILE
            # this turn was in flight (the drain skipped it as not-ready) stalls
            # until some later external submit — turns submitted faster than they
            # run (slow codex/copilot) pile up undrained. One drain per completed
            # turn keeps the queue aligned with output/turn completion.
            try:
                if not self.queue.is_empty:
                    self._schedule_queue_drain("chain")
            except Exception:
                pass

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

    @action.post(action_name="set-visible")
    async def _set_visible_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Set ONLY tab-visibility (``visible``) — decoupled from transport.

        ``visible`` answers "is this process shown as a terminal tab"; it does
        NOT select the execution transport. The transport is ``pty_mode``
        (PTY ⇄ headless), which ``_http_prompt`` routes on. This setter lets the
        UI show/hide the tab without touching ``pty_mode``, killing the worker,
        or flipping the session between PTY and headless. Idempotent; broadcasts
        the entity update so watchers (SDK ``watch()``) observe the new value.
        """
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        visible = bool(body.get("visible", False))
        if self.visible != visible:
            self.visible = visible
            await self.save()
            await self.notify_updated()
        return ApiSuccessResponse(data={"id": self.id, "visible": self.visible})

    @action.post(action_name="rename")
    async def _rename_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """POST /graph/agentic_process/<id>/rename {name} — user rename from outside
        the tab strip (the footer process list). The reverse leg of ``Tab.rename`` →
        ``AgenticProcess.rename``: pins ``auto_rename`` and mirrors onto the chip
        (see :meth:`_mirror_name_to_tabs`)."""
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        name = (body.get("name") or "").strip()
        if not name:
            return ApiFailResponse(message="rename: name is required")
        await self.rename(name)  # sets self.name + pins auto_rename=False
        if await self._mirror_name_to_tabs(name):
            from flow_sdk.builtin.tab import broadcast_tabs_changed  # noqa: PLC0415

            await broadcast_tabs_changed()
        await self.notify_updated()
        return ApiSuccessResponse(data={"id": self.id, "name": self.name})

    # ── Web app artifacts + Show (display focus) ─────────────────────────────

    async def _resolve_webapp_project(self):
        """Best-effort project for app artifacts owned by this process."""
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(self.project_id) if self.project_id else None
        if project is None:
            project = await Project.get_ancestor(self.typeid)
        if project is None and self.workdir:
            project = await Project.recover_by_path(self.workdir)
        if project is not None and self.project_id != project.id:
            self._force_rebind_project_id(project.id)
            await self.save()
        return project

    async def _get_project_webapp_artifacts(self) -> list:
        from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
        from flow_sdk.core import QueryFilter  # noqa: PLC0415
        from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

        project = await self._resolve_webapp_project()
        source = project.typeid if project is not None else None
        artifacts = await Artifact.get_all(QueryFilter.by_type(Artifact.get_type()), source_entity=source)
        webapps = [artifact for artifact in artifacts if kind_matches("application.web", artifact.kind)]
        return sorted(webapps, key=lambda artifact: str(getattr(artifact, "created_date", "") or ""), reverse=True)

    async def _get_project_webapp_deployments(self) -> list:
        from flow_sdk.builtin.deployment import KIND_WEB, Deployment  # noqa: PLC0415
        from flow_sdk.core import QueryFilter  # noqa: PLC0415
        from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

        project = await self._resolve_webapp_project()
        source = project.typeid if project is not None else None
        deployments = await Deployment.get_all(QueryFilter.by_type(Deployment.get_type()), source_entity=source)
        return [deployment for deployment in deployments if kind_matches(KIND_WEB, deployment.kind)]

    async def _artifact_reference(self, payload: dict) -> tuple[str, str]:
        """What a resolved display target points at: ``(asset_ref, entity_kind)``.

        An artifact REFERENCES an asset, so it records the same ``asset_ref`` the
        owning entity has — resolution back the other way is
        ``Entity.get_by_asset_ref``. A target with no file behind it (a bare port,
        or a row that was never a file) has no ref; ``target_type_id`` addresses
        those instead.

        The entity's own ontology ``kind`` rides back on the same lookup because
        it is the better answer than anything this action can infer: a
        ``source_item`` already knows it is ``content.message.email``, and
        re-deriving that from a path — which it does not have — is impossible.
        Returned rather than fetched separately so the entity is loaded once.
        """
        from flow_sdk.api.api_types.type_id import TypeId  # noqa: PLC0415
        from flow_sdk.core import Entity  # noqa: PLC0415
        from flow_sdk.core.display_target import DisplayTargetKind  # noqa: PLC0415

        kind = str(payload.get("kind") or "")
        if kind == DisplayTargetKind.VFS:
            return str(payload.get("path") or ""), ""
        if kind == DisplayTargetKind.ENTITY:
            raw = str(payload.get("typeid") or "")
            if not raw:
                return "", ""
            try:
                entity = await Entity.get_by_typeid(TypeId(raw))
            except (ValueError, IndexError):
                return "", ""
            return (
                str(getattr(entity, "asset_ref", "") or ""),
                str(getattr(entity, "kind", "") or ""),
            )
        return "", ""

    @action.post(action_name="register-artifact")
    async def _http_register_artifact(self) -> ApiSuccessResponse | ApiFailResponse:
        """Register a produced deliverable, then show it.

        The consolidation of ``flow show``: same address grammar
        (``typeid`` | ``path`` | ``port``), but the result is a durable,
        queryable Artifact carrying ``generated_by`` — not just a transient
        display pin that vanished with the run.

        Provenance is derived from the URL scope, never read from the body: an
        artifact records who actually ran, not who the payload claims.
        """
        from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
        from flow_sdk.core.display_target import (  # noqa: PLC0415
            DisplayTargetKind,
            DisplayTargetNotFound,
            InvalidDisplayTarget,
            resolve_display_target,
        )
        from flow_sdk.worldview.ontology import normalize_kind  # noqa: PLC0415

        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body

        typeid = str(body.get("typeid") or "").strip() or None
        path = str(body.get("path") or "").strip() or None
        port = body.get("port")
        if not (typeid or path or port):
            return ApiFailResponse(
                message="register-artifact needs one of: typeid, path, port",
                status_code=400,
            )

        try:
            # `discover=True` — a display verb: showing a just-written file has
            # to recover it so the bespoke editor renders, not a raw file view.
            payload = await resolve_display_target(typeid=typeid, path=path, port=port, discover=True)
        except InvalidDisplayTarget as e:
            return ApiFailResponse(message=str(e), status_code=400)
        except DisplayTargetNotFound as e:
            return ApiFailResponse(message=str(e), status_code=404)

        asset_ref, entity_kind = await self._artifact_reference(payload)
        if payload.get("kind") in (DisplayTargetKind.WEBAPP, DisplayTargetKind.APP):
            kind = "application.web"
        else:
            # An entity that declares its own ontology kind is the authority:
            # `content.message.email` is what lets a consumer tell "this run sent
            # a message" from "this run wrote a file". `content.file` stays the
            # fallback for targets that declare nothing — and for a malformed
            # kind, since a bad string here would fail the whole registration
            # over a label.
            kind = "content.file"
            if entity_kind:
                try:
                    kind = normalize_kind(entity_kind)
                except ValueError:
                    logger.debug("register-artifact: unusable kind %r", entity_kind)
        name = (
            str(body.get("name") or "").strip()
            or str(payload.get("name") or "").strip()
            or (Path(asset_ref).name if asset_ref else "")
            or "Artifact"
        )

        artifact = Artifact(
            name=name,
            kind=kind,
            description=str(body.get("description") or "").strip() or None,
            asset_ref=asset_ref,
            # Address the row as well as the path. For a file-less entity this
            # is the ONLY pointer the artifact has; for a file-backed one it is
            # the exact identity, where `asset_ref` is a path that has to be
            # resolved back through `get_by_asset_ref`.
            target_type_id=(
                str(payload.get("typeid") or "") or None if payload.get("kind") == DisplayTargetKind.ENTITY else None
            ),
            generated_by=str(self.typeid),
            project_id=await self.effective_project_id(),
        )
        await artifact.save()

        shown = None
        if bool(body.get("show", True)):
            await self.on_show(payload)
            shown = payload

        return ApiSuccessResponse(data={"artifact": artifact.model_dump(mode="json"), "shown": shown})

    @action.get(action_name="artifacts")
    async def _http_artifacts(self) -> ApiSuccessResponse | ApiFailResponse:
        """Everything this run produced.

        A query over ``generated_by``, not a list field on the process — so two
        registrations landing at once cannot clobber each other's append.

        GET, like its sibling ``get-assets``: this is a pure read with no body,
        and modelling it as a POST would make it indistinguishable from the
        mutating ``register-artifact`` next door.
        """
        from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

        rows = await Artifact.get_all({"generated_by": str(self.typeid)})
        return ApiSuccessResponse(data={"artifacts": [row.model_dump(mode="json") for row in rows]})

    @action.post(action_name="webapp-artifacts")
    async def _http_webapp_artifacts(self) -> ApiSuccessResponse | ApiFailResponse:
        """Return project-scoped web artifacts with their local placement."""
        try:
            artifacts = await self._get_project_webapp_artifacts()
            deployments = await self._get_project_webapp_deployments()
            by_artifact = {deployment.artifact_id: deployment for deployment in deployments if deployment.artifact_id}
            rows = []
            for artifact in artifacts:
                payload = artifact.model_dump(mode="json")
                deployment = by_artifact.get(artifact.id)
                if deployment is not None:
                    payload["deployment"] = deployment.model_dump(mode="json")
                rows.append(payload)
            return ApiSuccessResponse(data={"artifacts": rows})
        except Exception as e:
            logger.exception("AgenticProcess %s webapp-artifacts error: %s", self.id, e)
            return ApiFailResponse(message=str(e))

    @action.post(action_name="register-webapp-artifact")
    async def _http_register_webapp_artifact(self) -> ApiSuccessResponse | ApiFailResponse:
        """Create/update a web Artifact and its local Deployment."""

        from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415
        from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
        from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415
        from flow_sdk.builtin.local_origin import LocalOrigin  # noqa: PLC0415
        from flow_sdk.core.display_target import InvalidDisplayTarget, resolve_display_target  # noqa: PLC0415
        from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body

        # Port is OPTIONAL: an app that we serve has no dev server to point at.
        # Absent → no Deployment at all, and the display derives `served`. The
        # continuum has always said both companions are independent; requiring a
        # port here was the one thing making a served-only app unregistrable.
        raw_port = str(body.get("port") or "").strip()
        port: int | None = None
        if raw_port:
            try:
                port = int(raw_port)
            except ValueError:
                port = None
            if port is None or not 0 < port <= 65535:
                return ApiFailResponse(message=f"Invalid port: {raw_port}", status_code=400)

        raw_path = str(body.get("path") or "").strip()
        if not raw_path:
            return ApiFailResponse(message="path is required", status_code=400)
        try:
            artifact_path = canonical_posix_path(str(Path(raw_path).expanduser().resolve()))
        except Exception:
            artifact_path = raw_path

        name = str(body.get("name") or "").strip() or Path(artifact_path).name or "Web App"
        start_cmd = str(body.get("start_cmd") or "").strip()
        health = str(body.get("health") or "/").strip() or "/"
        description = str(body.get("description") or "").strip() or f"Web app at {artifact_path}"
        git_origin = None
        try:
            git_origin = await asyncio.to_thread(GitOrigin.for_asset_path, artifact_path)
        except Exception:
            logger.debug("register-webapp-artifact: could not derive git origin for %s", artifact_path, exc_info=True)
        path_obj = Path(artifact_path)
        local_origin = LocalOrigin(base=str(path_obj.parent), rel_path=path_obj.name or ".")

        project = await self._resolve_webapp_project()
        artifacts = await self._get_project_webapp_artifacts()
        deployments = await self._get_project_webapp_deployments()
        artifact_id = adopt_entity_id(body.get("artifact_id"))
        artifact = None
        if artifact_id:
            artifact = await Artifact.get_by_id(artifact_id)
        if artifact is None:
            for candidate in artifacts:
                origin = candidate.origin
                same_path = bool(
                    getattr(origin, "kind", None) == "local"
                    and canonical_posix_path(str(Path(origin.base) / origin.rel_path)) == artifact_path
                )
                candidate_deployment = next((d for d in deployments if d.artifact_id == candidate.id), None)
                same_port = bool(
                    candidate_deployment
                    and str((candidate_deployment.provider_labels or {}).get("flowpad.runtime.port") or "") == str(port)
                )
                if same_path or same_port:
                    artifact = candidate
                    break

        if artifact is None:
            artifact = Artifact(
                name=name,
                kind="application.web",
                description=description,
                project_id=project.id if project is not None else self.project_id,
                origin=git_origin or local_origin,
            )
        else:
            artifact.name = name
            artifact.kind = "application.web"
            artifact.description = description
            artifact.origin = git_origin or local_origin
            if project is not None:
                artifact.project_id = project.id

        if project is not None:
            artifact.parent_type_id = str(project.typeid)
        await artifact.save()
        if project is not None:
            await project.attach_child(artifact)
            if artifact.id not in (project.artifacts or []):
                project.artifacts = list(project.artifacts or []) + [artifact.id]
                await project.save()

        # No port → no runtime plane. A served-only app is complete without one,
        # and inventing a Deployment for a dev server that does not exist would
        # make `_app_payload` derive `dev` and point the display at nothing.
        deployment = (
            await self._upsert_webapp_deployment(
                artifact,
                port=port,
                name=name,
                start_cmd=start_cmd,
                health=health,
                git_origin=git_origin,
                project=project,
            )
            if port is not None
            else None
        )

        micro_app = await self._upsert_webapp_micro_app(
            artifact,
            artifact_path=artifact_path,
            name=name,
            dist=body.get("dist"),
            project=project,
        )

        shown = None
        if bool(body.get("show", True)):
            try:
                # Pin the APP, not the port. The port is one of two ways this
                # app can be reached and it changes between runs; the artifact
                # id is the thing that stays true, and the display picks the
                # live runtime from the companions.
                shown = await resolve_display_target(artifact_id=artifact.id)
            except InvalidDisplayTarget as e:
                return ApiFailResponse(message=str(e), status_code=400)
            await self.on_show(shown)

        return ApiSuccessResponse(
            data={
                "artifact": artifact.model_dump(mode="json"),
                "deployment": deployment.model_dump(mode="json") if deployment is not None else None,
                "micro_app": micro_app.model_dump(mode="json") if micro_app is not None else None,
                "shown": shown,
            }
        )

    # Conventional build-output directory names, in the order a toolchain is
    # most likely to have produced one. Explicit ``dist`` in the request always
    # wins; this is only the fallback for an agent that registered without one.
    _BUILD_OUTPUT_DIRS = ("dist", "build", "out", ".output/public")

    async def _upsert_webapp_deployment(
        self,
        artifact,
        *,
        port: int,
        name: str,
        start_cmd: str,
        health: str,
        git_origin,
        project,
    ):
        """Create/update the app's runtime placement — a local dev server.

        Sibling of ``_upsert_webapp_micro_app``: one companion per plane. The row
        converges through ``Deployment.find_existing`` on (parent, provider) —
        re-registering the same app updates it rather than forking a second one,
        without baking the artifact id into an id that could then never change.

        Parented to the PROJECT, not the Artifact: an Artifact records how the
        app was generated and lives under its own parent, while the placement
        belongs to the project that owns the running thing. ``artifact_id`` keeps
        the reference.
        """
        from flow_sdk.builtin.deployment import KIND_WEB, Deployment  # noqa: PLC0415
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        if project is None:
            # Nothing to parent to, and a placement with no owner is not a
            # placement — the caller's project resolution already tried three
            # ways to find one.
            return None
        deployment = await Deployment.upsert(
            parent_type_id=str(project.typeid),
            provider="local",
            kind=KIND_WEB,
            element=project,
            payload={
                "name": f"{name} (local)",
                "artifact_id": artifact.id,
                "artifact_link_source": "manual",
                "target": {
                    "provider": "local",
                    "scope": project.id,
                    "location": f"http://localhost:{port}",
                },
                "origin": {
                    "kind": "local",
                    "provider": "local",
                    "external_id": ComputeNode._local_id(),
                    "url": f"http://localhost:{port}",
                },
                "status": {"sync_state": "current", "provider_state": "configured"},
                "provider_labels": {
                    "flowpad.runtime.port": str(port),
                    "flowpad.runtime.start_cmd": start_cmd,
                    "flowpad.runtime.health": health,
                },
                "source_revision": getattr(git_origin, "head_commit", None),
                "project_id": project.id,
            },
        )
        await project.attach_child(deployment)
        return deployment

    async def _upsert_webapp_micro_app(
        self,
        artifact,
        *,
        artifact_path: str,
        name: str,
        dist: object,
        project,
    ):
        """Create/update the Artifact's delivery companion when built output exists.

        Returns ``None`` when the app has no build output yet — a dev-server-only
        app is a complete, valid app, so absence is the normal early state and
        not an error.
        """
        from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
        from flow_sdk.builtin.faas.micro_app import AppLocationType, MicroApp  # noqa: PLC0415

        app_root = Path(artifact_path)
        dist_rel = str(dist or "").strip()
        if dist_rel:
            dist_path = app_root / dist_rel
        else:
            dist_path = next((app_root / c for c in self._BUILD_OUTPUT_DIRS if (app_root / c).is_dir()), None)
            # A static app has no build step — the registered folder IS the
            # deliverable, and discovery points at whichever directory holds
            # index.html. Without this, exactly the apps that are ready to serve
            # with no work at all would be the ones that never get a delivery
            # companion.
            if dist_path is None and (app_root / "index.html").is_file():
                dist_path = app_root
        if dist_path is None:
            return None

        # Deterministic, mirroring the Deployment id above: re-registering the
        # same artifact must update its delivery row, never fork a second one.
        micro_app_id = mint_uuid(f"micro_app:artifact:{artifact.id}")
        micro_app = await MicroApp.get_by_id(micro_app_id)
        payload = {
            "name": name,
            "location_type": AppLocationType.Artifact,
            "location_root": str(dist_path),
            "artifact_id": artifact.id,
            "project_id": project.id if project is not None else self.project_id,
            "parent_type_id": str(project.typeid) if project is not None else None,
        }
        if micro_app is None:
            micro_app = MicroApp(id=micro_app_id, **payload)
        else:
            micro_app.apply_field_updates(payload)
        await micro_app.save()
        if project is not None:
            await project.attach_child(micro_app)
        return micro_app

    async def on_show(self, payload: dict) -> None:
        """Present *payload* to this process's watchers — the ``flow show`` verb.

        Unlike ``flow navigate`` (which steers the browser tab's URL via a
        ``ui_command``), show is declarative display focus: an ``on_show``
        entity event to whoever watches this process. Nothing watching → a
        silent context change; that is the intended semantics, not a failure.

        The payload says WHAT to present, never HOW — so the same verb adapts to
        the surface the user is on, and the choice is the frontend's (only it
        knows the live view mode). Vibe pins the target in its display pane;
        every other mode mints it as a tab beside this process's own tab,
        WITHOUT navigating (``ui/src/hooks/use-show-target-listener.ts``).

        The payload is appended to ``context_data.display_stack`` (the show
        HISTORY, newest last) and mirrored to ``context_data.last_shown`` (the
        newest target) so a display that mounts LATER (page reload, late-opened
        tab) restores the pin AND its history — the entity event has no replay.
        Consumers of the durable copy must gate on ``shown_at``: a tab is
        durable, so replaying a show older than the client would resurrect a tab
        the user deliberately closed.
        """
        shown_at = datetime.now(timezone.utc).isoformat()
        context = self.context_data if isinstance(self.context_data, dict) else {}
        # Read-modify-write against the freshest stack so concurrent shows don't
        # lose each other (self.context_data may predate another show's append).
        base = list(context.get("display_stack") or [])
        if getattr(self, "exist_in_db", False):
            latest = await AgenticProcess.get_by_id(self.id)
            if latest is not None and latest is not self:
                latest_ctx = latest.context_data if isinstance(latest.context_data, dict) else {}
                base = _union_display_stacks(base, latest_ctx.get("display_stack") or [])
        stack = _append_display_entry(base, payload, shown_at)
        self.context_data = {**context, "display_stack": stack, "last_shown": payload}
        # This is the authoritative display write — the save() guard must trust
        # this in-memory stack, not mirror the (older) DB over it.
        self._set_display_authoritative(True)
        try:
            await self.save()
        except Exception:
            logger.warning("on_show: display persist failed", exc_info=True)
        finally:
            self._set_display_authoritative(False)
        await self.emit_entity_event("on_show", payload)
        # Auto-file the shown target into the Auto/<type>/item favorites tree.
        # Best-effort: a bookmark failure must never break `flow show`.
        try:
            await self._auto_bookmark_show(payload)
        except Exception:
            logger.warning("on_show: auto-bookmark failed", exc_info=True)

    async def _auto_bookmark_show(self, payload: dict) -> None:
        """Drop the shown target into the nested ``Auto / <type> / item`` favorites
        tree (idempotent). Owned by the local user and scoped to this process's
        project. Every leaf create broadcasts, so the folder counters tick live."""
        from flow_sdk.builtin.bookmark import mint_auto_favorite  # noqa: PLC0415
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

        owner = await get_or_create_local_user()
        if owner is None:
            return
        # `effective_project_id`, not the raw field: a child process (received
        # session, sub-run) inherits its parent's project rather than filing the
        # show unscoped. It tests self before walking, so a project-bound process
        # costs no extra lookup. `on_show` already wraps this call best-effort.
        await mint_auto_favorite(owner=owner, payload=payload, project_id=await self.effective_project_id())

    @action.post(action_name="show")
    async def _http_show(self) -> ApiSuccessResponse | ApiFailResponse:
        """Resolve a show target — ``{typeid}`` | ``{path}`` | ``{port}`` | ``{view}`` — and emit it.

        Resolution is the shared ``resolve_display_target`` policy (same as
        ``flow navigate file``): indexed asset → its entity; unknown path →
        raw vfs pointer; port → webapp preview; view → a dock address (a SCREEN,
        the one form that reaches a view with no entity behind it).
        """
        from flow_sdk.core.display_target import (  # noqa: PLC0415
            DisplayTargetNotFound,
            InvalidDisplayTarget,
            resolve_display_target,
        )

        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body

        try:
            payload = await resolve_display_target(
                typeid=str(body.get("typeid") or "").strip() or None,
                path=str(body.get("path") or "").strip() or None,
                port=body.get("port"),
                dock=str(body.get("view") or "").strip() or None,
                discover=True,  # a display verb — see `flow show file`
            )
        except InvalidDisplayTarget as e:
            return ApiFailResponse(message=str(e), status_code=400)
        except DisplayTargetNotFound as e:
            return ApiFailResponse(message=str(e), status_code=404)

        await self.on_show(payload)
        return ApiSuccessResponse(data=payload)

    # ── Agent-facing terminal ───────────────────────────────────────────────
    #
    # A worker's own Bash tool runs in a subprocess nobody can see. These two
    # actions are how an agent uses the terminal the USER is looking at: one
    # PTY, owned by the backend, that the browser only attaches to. Writes here
    # land on the same file descriptor as a guided journey's `sendInput`, so
    # agent-typed and journey-typed commands are indistinguishable on screen.

    async def _current_terminal(self) -> "Shell | None":
        """The live terminal this process already opened, or None."""
        from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

        shell_id = (self.context_data or {}).get(TERMINAL_SHELL_KEY)
        if not shell_id:
            return None
        shell = await Shell.get_one({"id": str(shell_id)})
        if shell is None:
            return None
        # The row can outlive its PTY (backend restart, user closed the tab).
        # A dead shell is not reusable — fall through and open a fresh one.
        return shell if shell.is_alive else None

    @action.post(action_name="terminal")
    async def _http_open_terminal(self) -> ApiSuccessResponse | ApiFailResponse:
        """Open (or re-show) the user-visible terminal — ``{cwd?, command?}``.

        Idempotent by design: an agent that says "run it in the terminal" three
        times must not litter the workspace with three terminals. An existing
        live terminal is re-shown and reused; only its absence creates one.
        """
        from flow_sdk.builtin.shell import Shell  # noqa: PLC0415
        from flow_sdk.core.display_target import shell_target  # noqa: PLC0415

        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body

        shell = await self._current_terminal()
        reused = shell is not None
        if shell is None:
            cwd = str(body.get("cwd") or "").strip() or self.workdir
            if not cwd:
                return ApiFailResponse(message="No cwd and the process has no workdir", status_code=400)
            cn = await self._get_local_compute_node()
            if cn is None:
                return ApiFailResponse(message=LOCAL_COMPUTE_NODE_MISSING_FAILURE, status_code=500)
            shell = Shell(
                compute_node_id=str(cn.id),
                compute_node_uname=getattr(cn, "uname", None),
                name="Terminal",
                workdir=cwd,
                tab_order=await Shell.next_tab_order(),
                project_id=self.project_id,
            )
            await shell.save()
            await shell.start_pty()
            self.context_data = {**(self.context_data or {}), TERMINAL_SHELL_KEY: str(shell.id)}
            await self.save()

        payload = shell_target(shell)
        await self.on_show(payload)

        command = str(body.get("command") or "").strip()
        if command:
            await shell.write(command)
        return ApiSuccessResponse(data={**payload, "reused": reused, "command_sent": bool(command)})

    @action.post(action_name="terminal-input")
    async def _http_terminal_input(self) -> ApiSuccessResponse | ApiFailResponse:
        """Run a command in the user-visible terminal and RETURN ITS OUTPUT —
        ``{command, shell_id?, timeout?}``.

        Writes straight to the PTY, so the command appears and runs exactly as
        if the user had typed it — and reads the result back, so the caller
        learns what happened. An agent that can type but not read has to guess
        at its own effects; both halves go through the one PTY the user is
        watching. This is deliberately NOT ``Shell.run``, which is a detached
        subprocess whose output never reaches the screen.
        """
        from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body

        command = str(body.get("command") or "").strip()
        if not command:
            return ApiFailResponse(message="command is required", status_code=400)

        shell_id = str(body.get("shell_id") or "").strip()
        shell = await Shell.get_one({"id": shell_id}) if shell_id else await self._current_terminal()
        if shell is None:
            return ApiFailResponse(
                message="No open terminal — run `flow terminal open` first",
                status_code=404,
            )

        try:
            timeout = float(body.get("timeout") or 120.0)
        except (TypeError, ValueError):
            return ApiFailResponse(message="timeout must be a number", status_code=400)

        result = await shell.run_and_capture(command, timeout=timeout)
        return ApiSuccessResponse(data={"shell_id": str(shell.id), "command": command, **result})

    # ── Wizard completion ───────────────────────────────────────────────────

    async def on_wizard_close(self, payload: dict) -> dict:
        """Close a wizard process by emitting the typed frontend result event.

        Inbound path is the generic ``entity-event`` action, used by both the
        UI footer buttons and the agent-facing ``flow wizard <id> close`` CLI.
        The event is re-emitted as ``wizard.closed`` so the frontend promise
        registered by ``launchWizard`` can resolve through the same entity-event
        channel as other AgenticProcess control events.
        """
        status = str(payload.get("status") or "").strip().lower()
        if status not in {"done", "cancel", "error"}:
            status = "error"
            payload = {**payload, "status": status, "errorStr": payload.get("errorStr") or "Invalid wizard status"}
        result = {
            "status": status,
            "data": payload.get("data"),
            "errorStr": payload.get("errorStr"),
            "wizardId": payload.get("wizardId") or (self.context_data or {}).get("wizard", {}).get("id") or self.id,
        }
        await self.emit_entity_event("wizard.closed", result)
        return result

    # ── Execution ─────────────────────────────────────────────────────────────

    async def prompt(self, instruction: str) -> ApiSuccessResponse | ApiFailResponse:
        """Schedule a worker run with *instruction* and return immediately.

        Routing is on the transport intent ``pty_mode`` (NOT tab-visibility —
        ``visible`` only decides whether a tab is shown; see ``set-visible``):
          ``pty_mode=True`` + worker alive (PTY) → write to PTY stdin (continues session)
          ``pty_mode=True`` + worker dead        → ``start_pty(instruction)`` (PTY relaunch)
          ``pty_mode=False`` (headless)          → ``self.driver.headless_prompt(...)``
                                                  — vendor-specific print-mode that
                                                  handles multi-step tool sequences.

        ``pty_mode=True`` keeps the PTY path so the UI's interactive terminal
        continues to work; the print-mode driver is only used for headless
        invocations (tests, server-side automations).

        Args:
            instruction: The prompt text to send.
        """
        if not self.pty_mode:
            admission = try_admit_prompt(self.id)
            if admission is None:
                return ApiFailResponse(
                    message="another prompt turn is already in flight for this process",
                    status_code=409,
                )
            # Headless flow — no PTY/Shell. Driver decides how to spawn
            # its CLI, capture session_id, and manage lifecycle. Inline
            # cli_config + workdir is sufficient; the AP does NOT need
            # to be in DB. This unblocks bootstrap-time uses (e.g.
            # ``flow start`` spawning a migration agent before the
            # substrate is fully initialised).
            try:
                return await self.driver.headless_prompt(self, instruction)
            finally:
                # A successful driver call has already handed the slot to its
                # registered worker; this then becomes an owner-safe no-op.
                # Setup failures release the admission for a later turn.
                release_prompt_admission(self.id, admission)
        if not self.exist_in_db:
            return ApiFailResponse(message=f"AgenticProcess {self.id} not found in database")
        if await self.is_running():
            await self.send(instruction)
            return ApiSuccessResponse(data={"status": "sent"})
        return await self.start_pty(instruction=instruction)

    async def _is_live_pty(self) -> bool:
        """True iff this is a PTY transport with a worker currently alive — the
        single seam ``input``/``submit`` route on (write to the live PTY vs the
        headless queue), so the two can't drift."""
        return self.pty_mode and await self.is_running()

    async def input(self, text: str, options: dict[str, Any] | None = None) -> ApiSuccessResponse | ApiFailResponse:
        """Stage input WITHOUT submitting — "type" *text* into the input, no Enter.

        The submit-half of the pair is :meth:`submit`; ``input(x)`` then
        ``submit()`` is equivalent to ``submit(x)``. Separating the two mirrors
        how a PTY actually works (paste, then a discrete Enter) and is the seam
        the interactive submit path turns on.

          - PTY + running → writes the raw keystrokes to the live PTY with NO
            trailing ``\\r`` (``send(bytes)`` is raw; ``send(str)`` would append one).
          - headless / cold → enqueues onto the process's PERSISTED prompt queue,
            so the staged turn survives a reload / a separate ``submit`` request
            (a transient in-memory buffer would not). ``submit`` drains it.

        *options* is a generic per-call bag; ``options["queueOptions"]`` is passed
        through to the queue (e.g. ``{"source": "..."}``) for the headless path.
        """
        options = options or {}
        if await self._is_live_pty():
            # A raw PTY write bypasses shell.write()'s readiness gate, so a
            # freshly-(re)booted TUI (e.g. right after switch→Interactive resumes
            # the session) would DROP these keystrokes. Wait for the prompt to be
            # ready HERE so callers — and submit(instruction), which types via
            # input() — never have to settle the PTY themselves.
            shell = await self.shell()
            if shell:
                await shell.wait_for_input_ready()
            await self.send(text.encode())  # raw bytes ⇒ no submit
            return ApiSuccessResponse(data={"status": "typed", "staged": False})
        # ``queue.enqueue`` persists the entry to its own file — durable without a
        # row save (the queue is not an entity field).
        qopts = dict(options.get("queueOptions") or {})
        entry = self.queue.enqueue(text, source=qopts.get("source", "input"))
        return ApiSuccessResponse(data={"status": "queued", "staged": True, "entry_id": entry.get("id")})

    async def submit(
        self, instruction: str | None = None, options: dict[str, Any] | None = None
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Commit the current input as one turn. ``submit(x)`` == ``input(x)`` + ``submit()``.

        If *instruction* is given it is :meth:`input` first. Then:
          - PTY + running → a discrete Enter (``\\r``) submits the typed line.
          - headless / cold → drains the persisted prompt queue, running the
            staged head as one print-mode turn (the same path ``createProcess``'s
            seeded launch prompt uses, so it actually boots + runs the worker).

        Fire-and-forget by design: the turn's output is observed on the usual
        stream (``output()`` / ``flowDataStream``), not returned here. *options*
        is reserved for per-turn flags (e.g. permission_mode) — accepted now so
        the signature is stable.
        """
        if instruction is not None:
            staged = await self.input(instruction, options=options)
            if isinstance(staged, ApiFailResponse):
                return staged
        if await self._is_live_pty():
            # Rich TUIs (codex/copilot, ``pty_submits_on_paste=False``) treat an
            # Enter glued to the just-typed text as literal input and never
            # submit — the input box must settle first. claude submits on paste,
            # so it needs no gap. Same per-vendor trait ``write_then_submit`` uses.
            if not self.driver.pty_submits_on_paste:
                await asyncio.sleep(_PTY_SUBMIT_SETTLE_S)
            await self.send(b"\r")  # discrete Enter — submit the typed line
            return ApiSuccessResponse(data={"status": "submitted"})
        # Headless: run the staged queue head via the proven drain path.
        if self.queue.is_empty:
            return ApiFailResponse(message="nothing to submit (no input staged)")
        self._schedule_queue_drain("submit")
        return ApiSuccessResponse(data={"status": "submitted"})

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
        small settling window to avoid racing late writes — BUT never while this
        process's turn worker is still live (``prompt_worker_active``). On a
        resumed multi-turn session the JSONL already ends with the PRIOR turn's
        terminal marker, so honoring it would exit before the new turn is
        written and the caller would capture the prior turn's reply (the
        multi-turn off-by-one). Gating on the live worker waits for THIS turn.

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
        )
        from flow_sdk.builtin.worker_status import (
            _has_pending_tool_use,
            _last_user_is_tool_result,
            _scan_reversed,
        )

        deadline = time.monotonic() + timeout

        # Wait until the driver can locate a transcript (worker has been
        # spawned and produced — or pre-touched — a session JSONL).
        transcript_path: Path | None = None
        while transcript_path is None:
            if time.monotonic() > deadline:
                raise TimeoutError("stream_transcript: transcript file did not appear within timeout")
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
            # Resume-aware guard: while THIS process's turn worker is still live,
            # any terminal/soft-terminal marker in the JSONL is the PRIOR turn's
            # (a resumed session appends the new turn only after the worker has
            # run) — don't exit on it, or the caller captures the prior turn's
            # reply (the multi-turn off-by-one). The worker registry is
            # process-global, so this holds even when the watcher hydrated a
            # different AgenticProcess object than the one that launched the turn.
            # CONTRACT: this relies on the driver flushing the new turn's terminal
            # region to the JSONL BEFORE ``unregister_prompt_worker`` (which every
            # driver does in ``_run_turn``'s ``finally``, after the execute loop
            # drains). A driver that unregistered before the flush would let this
            # release while the tail still shows the prior marker — re-opening the
            # off-by-one.
            _worker_active = prompt_worker_active(self.id)
            _terminal = tail_status in _terminal_states and not _worker_active
            # Post-tool-idle peek: only meaningful for Claude (Codex never
            # writes WORKING followed by tool_result without further events).
            # Only treat as soft-terminal when the last assistant turn ended with
            # ``stop_reason=end_turn``. ``stop_reason=tool_use`` means the model
            # is still planning the next call; sonnet routinely takes 9–17 s
            # between tool calls on multi-step flows, which exceeds the 8-s
            # post-tool settle window. Exiting then would drop the rest of the
            # work — the bug surfaced in test_agentic_process_fix_it_with_agent.
            # Skipped entirely while the worker is live (the guard suppresses it
            # anyway) — avoids a per-poll 4KB tail read for the turn's duration.
            _post_tool_idle = False
            if not _worker_active and tail_status == _WS.WORKING:
                try:
                    with open(transcript_path, "rb") as _fh:
                        _sz = transcript_path.stat().st_size
                        if _sz > 4096:
                            _fh.seek(_sz - 4096)
                        _tail_chunk = _fh.read().decode("utf-8", errors="replace")
                    _last_stop_reason = _scan_reversed(_tail_chunk)[2]
                    _post_tool_idle = (
                        _last_user_is_tool_result(_tail_chunk)
                        and not _has_pending_tool_use(_tail_chunk)
                        and _last_stop_reason == "end_turn"
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
                    # COMPLETE — the JSONL still says WORKING (no terminal
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

    @action.post(action_name="input")
    async def _http_input(self) -> ApiSuccessResponse | ApiFailResponse:
        """POST body ``{"text": "...", "options"?: {"queueOptions"?: {...}}}`` —
        stage input, no submit. See :meth:`input`."""
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        return await self.input(str(body.get("text", "")), options=body.get("options"))

    @action.post(action_name="submit")
    async def _http_submit(self) -> ApiSuccessResponse | ApiFailResponse:
        """POST body ``{"instruction"?: "...", "options"?: {...}}`` — commit a turn.

        ``submit("hi")`` == ``input("hi")`` + ``submit()``. See :meth:`submit`.
        """
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        instruction = body.get("instruction")
        return await self.submit(
            instruction if instruction is None else str(instruction),
            options=body.get("options"),
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
    # the legacy /completion). One endpoint, two transports keyed off
    # ``visible`` (the tabs/chat unification): ``visible=False`` streams a
    # print-mode worker's stdout; ``visible=True`` streams the PTY session
    # transcript (``_run_pty_prompt``) so the same chat surface drives the
    # interactive terminal tab. Both return 200.
    #
    # The driver-specific stream worker runs one print-mode turn; its events
    # map to FlowData and land on the shared
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

        # Per-turn permission-mode override (e.g. chat "plan mode"): the UI sends
        # ``permission_mode`` to make THIS turn read-only ("plan") or to run the
        # approved plan in the process's normal mode (no override). Whitelisted so
        # a client can't pass an arbitrary CLI flag value; ``None`` ⇒ fall back to
        # the persisted ``cli_config`` default below.
        _turn_permission_mode = body.get("permission_mode")
        if _turn_permission_mode is not None and _turn_permission_mode not in _VALID_PERMISSION_MODES:
            return ApiFailResponse(message=f"invalid permission_mode: {_turn_permission_mode!r}")

        if self.status in (ProcessStatus.STOPPING.value, ProcessStatus.FAILED.value):
            return ApiFailResponse(
                message=f"process not sendable (status={self.status})",
                status_code=409,
            )

        lock = _PROMPT_LOCKS[self.id]
        if lock.locked():
            return ApiFailResponse(
                message="another prompt turn is already in flight for this process",
                status_code=409,
            )

        # Two transports behind one action — the frontend always calls the same
        # ``prompt()``; the process's ``pty_mode`` (transport intent) picks the
        # path. NOT ``visible``: that flag only controls whether a tab is shown
        # (see ``set-visible``) and must never reroute a turn.
        #   pty_mode=True  → PTY-interactive worker; FlowData derived by polling
        #                    the session transcript (``_run_pty_prompt``).
        #   pty_mode=False → print-mode worker; FlowData from its stream-json
        #                    stdout (the body below).
        # For print mode we don't use ``is_ready_for_input``: it requires
        # ProcessStatus.RUNNING + an IDLE worker, which makes sense for PTY but
        # not here — print-mode processes have no persistent worker between
        # turns, so the only contention is the per-process lock above.
        if self.pty_mode:
            return self._run_pty_prompt(message)

        admission = try_admit_prompt(self.id)
        if admission is None:
            return ApiFailResponse(
                message="another prompt turn is already in flight for this process",
                status_code=409,
            )

        # Admission intentionally precedes every awaited setup step. A second
        # HTTP request (or a direct ``prompt`` call on another hydrated object)
        # therefore cannot pass a check-before-register gap while this request
        # resolves project context, instruction assets, or secret environment.
        try:
            # Resume ONLY when the worker actually has a resumable session on
            # disk for this id — NOT merely "session_id is set".
            resumable = self.driver.has_resumable_session(self)
            if not self.session_id and bool(getattr(self.driver, "preassign_interactive_session_id", False)):
                self.session_id = str(uuid4())
                try:
                    await self.save()
                except Exception:
                    logger.warning("prompt: preassigned session_id save failed", exc_info=True)

            # Resolve the owning project and stamp its context folders onto the
            # transient cache so ``resolved_add_dirs`` mounts them this turn.
            try:
                await self.get_project()
            except Exception:
                logger.debug("prompt: get_project failed", exc_info=True)

            process_assets = await self.prepare_process_assets()

            try:
                env_vars = dict(self.driver.cli_options(self).env_vars)
            except Exception:
                env_vars = dict((self.cli_config or {}).get("env_vars") or {})
            apply_worker_env(env_vars, self)
            await apply_worker_secret_env(env_vars, self)

            context = _AgenticContext(
                workdir=self.workdir,
                env_vars=env_vars,
                model=(self.cli_config or {}).get("model"),
                permission_mode=_turn_permission_mode
                or (self.cli_config or {}).get("permission_mode", "bypassPermissions"),
                effort=(self.cli_config or {}).get("effort"),
                add_dirs=list(self.resolved_add_dirs or []),
                session_id=self.session_id if (self.session_id and not resumable) else None,
                resume_session_id=self.session_id if resumable else None,
                language=await resolve_worker_language(self),
                **self._process_asset_context_kwargs(process_assets),
            )

            # API-key auth (harness in "api" mode): override the model with the
            # provider slug and carry codex's -c overrides onto the context. The
            # env/token already landed via apply_worker_secret_env above. Same
            # helper as the visible-PTY path; no-op in device mode.
            from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import (
                apply_api_model_to_options,
            )

            await apply_api_model_to_options(context, self)

            # Vendor hook retained for compatibility; embedded-agent/persona
            # instructions are materialized into process instruction assets.
            composed_prompt = self.driver.compose_prompt(message, self.get_agents_json())
            handler = StreamingResponseHandler()
            # Block on the startup capability sweep if it's still in flight: the
            # headless spawn env (build_worker_spawn_env) consumes the discovered
            # harness bin folder and raises "CLI not found" on a miss WITHOUT the
            # re-discover fallback the PTY-direct path has. A prompt arriving
            # within the sweep window (env-probe's `zsh -ilc` can take seconds)
            # would otherwise fail spuriously on a fresh backend.
            await self._await_capability_discovery()
            worker = self.driver.stream_worker(self)
            register_prompt_worker(self.id, worker)
        except BaseException:
            release_prompt_admission(self.id, admission)
            raise

        async def _run_turn() -> None:
            """Drive the worker → handler pipeline. Runs as a background task."""
            adopt_session = self.make_turn_session_adopter("prompt")
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
                        # Persist session_id on first capture so subsequent turns
                        # resume. Do this BEFORE forwarding the frame: the worker
                        # captures the id up-front (e.g. codex's leading
                        # ``thread.started``), but a client that breaks on the
                        # first flow frame closes the stream and cancels this turn
                        # — saving after ``on_flow_data`` races that disconnect and
                        # loses the id, breaking headless multi-turn resume.
                        # Adopt-on-change (not only when unset): workers report the id
                        # from structured CLI events, and the worker's actual id must
                        # win when a preassigned id failed to stick or the CLI rotates
                        # ids across resumed turns — a stale id points at a session
                        # that doesn't exist. Adoption (and the paired restart-
                        # snapshot re-pointing) is owned by ``adopt_worker_session``
                        # via the turn-scoped adopter, which trusts only the
                        # turn-INITIAL report (spurious-rotation guard).
                        await adopt_session(worker.get_session_id())
                        await handler.on_flow_data(fd)
            except WorkerSpawnError as e:
                # No subprocess ever started — end the process FAILED with the
                # start_failure latch. The worker already yielded the ERROR
                # frame onto the stream, so the client sees the message.
                await latch_spawn_failure(self, e)
            except Exception as e:
                logger.exception("prompt: worker error")
                await handler.add_str_to_queue(Exception(f"prompt error: {e}"))
            finally:
                # Signal end-of-stream to downstream consumers.
                await handler.on_flow_data(None)
                unregister_prompt_worker(self.id, worker)
                # Shared turn-end tail (broadcast, reindex, default-name stamp,
                # queue drain) — every exit lands here: complete, crash, AND
                # cancel-prompt kill, so the UI flips Stop→Send without polling
                # and mid-turn enqueued prompts don't park until the next edge.
                await self.end_headless_turn("prompt")

        try:
            turn_task = asyncio.create_task(_run_turn())
        except BaseException:
            unregister_prompt_worker(self.id, worker)
            raise

        async def _stream_body():
            try:
                async for xml_chunk in handler:
                    yield xml_chunk
            finally:
                if not turn_task.done():
                    # Client disconnected; let the turn finish to keep JSONL coherent,
                    # but don't block the HTTP handler beyond a short grace.
                    try:
                        # wait_for cancels its awaitable on timeout AND on outer
                        # cancellation (a hard reload closes this generator with
                        # CancelledError). Shield the background turn so a
                        # disconnect only stops the response stream — never the
                        # worker producing the durable transcript. The turn task
                        # owns its own teardown (_run_turn's finally deregisters
                        # the worker and notifies watchers) and Stop still works:
                        # cancel-prompt kills the subprocess, which ends the
                        # shielded turn naturally via stream EOF.
                        await asyncio.wait_for(asyncio.shield(turn_task), timeout=1.0)
                    except asyncio.TimeoutError:
                        pass  # expected: turn outlives the grace, keeps running shielded
                    except Exception:
                        # _run_turn traps its own errors; anything landing here is
                        # a harness-level anomaly worth a trace, not a crash.
                        logger.debug("prompt: post-disconnect turn wait failed", exc_info=True)

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
        """Cancel the in-flight turn — ONE stop interface for every transport.

        Print-mode (CLI) turn: kill the registered stream worker (SIGTERM → 5s
        → SIGKILL). PTY-transport turn (native xterm or chat-over-PTY, which
        never registers in ``_PROMPT_WORKERS``): route Ctrl-C into the live PTY
        — same effect as the frontend's xterm interrupt, so ``interruptTurn()``
        behaves identically for every agentic-process flavour.
        """
        worker = _PROMPT_WORKERS.get(self.id)
        if worker is not None:
            await worker.close_session()
            # Durable abort record (issue D09): a KILLED CLI writes nothing to
            # its own transcript, so a history replay after reload would show
            # the interrupted tool call as still running. Persist a flowpad-owned
            # marker that ``get_history_action`` merges back in. Skipped when the
            # worker reports a graceful cancel (claude honoured the
            # ``control_request/interrupt`` and recorded the interrupted tool
            # calls in its own session JSONL — a marker would duplicate the
            # abort). The PTY branch below deliberately never writes one — the
            # vendor TUI records its own abort (codex ``event_msg.turn_aborted``;
            # claude interrupt result).
            if not worker.cancelled_gracefully:
                from flow_sdk.builtin.agentic_process.turn_abort import record_turn_abort  # noqa: PLC0415

                record_turn_abort(self._record_dir(), session_id=self.session_id)
            return ApiSuccessResponse(data={"cancelled": True, "transport": "cli"})
        if self.pty_mode and self.shell_id:
            # The interrupt key is a VENDOR trait, not a constant: opencode quits
            # on Ctrl-C, so sending it here destroyed the session instead of
            # stopping the turn. Default stays Ctrl-C for every vendor that
            # doesn't declare otherwise.
            interrupt = getattr(self.driver, "pty_interrupt_sequence", b"\x03")
            try:
                await self.send(interrupt)
            except ValueError:
                # No shell actually linked — fall through to the no-turn reply.
                pass
            except Exception as e:
                return ApiFailResponse(message=f"PTY interrupt failed: {e}")
            else:
                return ApiSuccessResponse(data={"cancelled": True, "transport": "pty"})
        return ApiFailResponse(message="no in-flight prompt turn")

    async def _typed_pty_delivery(self, message: str, *, landed: "asyncio.Event") -> bool:
        """Type ``message`` into the live PTY once it can actually receive it.

        The typed-delivery half of a PTY prompt turn for a vendor whose TUI
        reads prompts from the composer. When the driver declares a
        ``pty_composer_ready_pattern``, delivery is
        DEFERRED until that marker appears in the PTY output — a cold TUI can
        boot into a quiet blocking interstitial (codex directory-trust prompt,
        login screen), and typing on quiescence alone gets the prompt eaten or
        truncated while the process still reports ready (QA C09b). Warm PTYs
        pass the gate instantly (the marker is already in the accumulated
        output). Without a pattern, the legacy settle-then-type behaviour is
        kept for that vendor.

        ``landed`` is the turn's transcript-confirmation event — if the user
        turn landed while we waited (e.g. the launch-arg path already injected
        it), nothing is typed (no duplicate). Returns False when the gate could
        not confirm composer-readiness (no shell, or the PTY closed before the
        marker appeared) — the caller then falls back to a blind, last-resort
        delivery rather than dead-ending the turn with the prompt undelivered.
        """
        shell = await self.shell()
        if shell is None:
            return False
        pattern = getattr(self.driver, "pty_composer_ready_pattern", None)
        if pattern is not None:
            if not await shell.wait_for_composer_ready(pattern):
                logger.warning(
                    "prompt-pty: composer never became ready for %s — gated delivery "
                    "skipped; caller will fall back to blind delivery",
                    self.id,
                )
                return False
        else:
            # No grounded marker for this vendor — legacy boot-settle delay.
            await asyncio.sleep(2.0)
        if landed.is_set():
            return True
        try:
            if self.driver.pty_submits_on_paste:
                await shell.write(message)
            else:
                await shell.write_then_submit(message)
        except Exception:
            logger.debug("prompt-pty: typed delivery failed", exc_info=True)
        return True

    @staticmethod
    def _cold_pty_delivery_plan(driver, message: str) -> tuple[str | None, bool]:
        """Return ``(launch_instruction, needs_typed_delivery)`` for cold PTY.

        A vendor with a grounded composer marker must start with a blank input
        and receive the prompt through the same marker-gated delivery as a hot
        PTY. Passing the prompt as a launch argument and later nudging Enter
        would leave that Enter blind to a startup interstitial. Pattern-less
        legacy vendors retain their existing launch-argument behavior.
        """
        composer_gated = getattr(driver, "pty_composer_ready_pattern", None) is not None
        if composer_gated:
            return None, True
        return message, not driver.pty_submits_on_paste

    # ── EXPERIMENT: PTY-transcript streaming prompt ─────────────────────────
    #
    # The PTY-interactive (visible=true) branch of the ``prompt`` action. The
    # FlowData is NOT produced by a print-mode stream worker — it is derived by
    # polling the session's JSONL transcript for new entries
    # (``AgentTranscriptFile``) and converting each one through the same
    # transcript-entry→FlowData mapper the history replay uses. The message is
    # routed into the live PTY (stdin, or worker relaunch); the stream closes
    # once the transcript shows no new entries for ``inactivity_timeout``
    # seconds. Admission (message non-empty, not STOPPING/FAILED, lock free) is
    # already enforced by ``_http_prompt`` before this is called.

    @staticmethod
    def _pty_turn_complete(
        entry: "Any",
        *,
        worker_type: str,
        active_turn_id: str | None,
        user_turn_landed: bool,
    ) -> bool:
        """Recognize a provider-owned terminal event for this PTY turn.

        Every candidate entry is newer than this prompt's transcript watermark
        and is accepted only after its user row landed. Claude records a
        ``turn_duration`` system row after its assistant/stop hooks; Copilot
        records ``assistant.turn_end``. Codex records ``task_complete``: when it
        carries a ``turn_id`` we require exact correlation with the turn we saw
        start, but a bare ``task_complete`` (no ``turn_id`` — codex often omits
        it) still completes the active turn. Inactivity remains the fallback if a
        provider marker is absent or incomplete.
        """
        from flow_sdk.transcript_analyzer.entry import EntryKind

        if not user_turn_landed or entry.kind is not EntryKind.SYSTEM:
            return False
        if getattr(entry, "is_sidechain", False):
            return False
        subtype = getattr(entry, "subtype", "")
        if worker_type == "claude":
            return subtype == "turn_duration"
        if worker_type == "copilot":
            return subtype == "assistant.turn_end"
        if worker_type != "codex":
            return False
        if subtype != "event_msg.task_complete":
            return False
        payload = getattr(entry, "payload", None)
        completed_turn_id = ""
        if isinstance(payload, dict):
            completed_turn_id = str(payload.get("turn_id") or "")
        # No turn_id in the payload → this task_complete refers to the active
        # turn (don't wait out the inactivity fallback). A present turn_id must
        # match exactly; a mismatch does NOT complete this turn.
        if not completed_turn_id:
            return True
        return completed_turn_id == active_turn_id

    @staticmethod
    def _pty_inactivity_result(user_turn_landed: bool) -> "FlowData":
        """Classify a quiet PTY turn without manufacturing a false success.

        Transcript inactivity is a successful turn boundary only after the
        submitted user message has appeared in the provider transcript. If no
        user row landed, the quiet period means delivery failed (for example,
        because a startup interstitial still owns the terminal).
        """
        from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
            FlowData as _FD,
        )
        from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
            FlowDataType as _FDT,
        )
        from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
            FlowElementType as _FET,
        )

        outcome = "success" if user_turn_landed else "error"
        subtype = "success" if user_turn_landed else "submission-error"
        reason = "transcript-inactivity" if user_turn_landed else "user-turn-not-landed"
        return _FD(
            flow_value={"subtype": subtype, "reason": reason},
            attributes={
                "element-type": _FET.RESULT,
                "data-type": _FDT.OBJECT,
                "outcome": outcome,
                "subtype": subtype,
                "observation-kind": "live",
            },
        )

    def _run_pty_prompt(self, message: str, inactivity_timeout: float = 15.0) -> Any:
        from starlette.responses import StreamingResponse  # local import — starlette is an app-layer dep

        from flow_sdk.builtin.agentic_process.cli_drivers.claude.session_history import (
            entry_to_flowdata,
        )
        from flow_sdk.transcript_analyzer import AgentTranscriptFile
        from flow_sdk.transcript_analyzer.entry import EntryKind
        from flow_sdk.transcript_analyzer.resolver import transcript_change_signature

        poll_interval = 0.3
        lock = _PROMPT_LOCKS[self.id]
        worker_type = self.driver.name

        # ── Transcript resolution + parsing strategy ────────────────────────
        # Resolve (path, format, descriptor) via the driver so the right vendor
        # parser is used (claude=jsonl, codex=rollout/stream,
        # copilot=events/stream — a missing format hint silently picks the
        # wrong parser for the dual-format vendors). Preserve the descriptor:
        # its provider session id is also the authoritative identity that a
        # PTY worker may mint after Flowpad's provisional launch id.
        def _resolve_transcript() -> "tuple[Path | None, Any, Any]":
            try:
                desc = self.driver.transcript_descriptor(self)
            except Exception:
                desc = None
            if desc is not None:
                return desc.path, desc.format, desc
            try:
                return self.driver.transcript_path(self), None, None
            except Exception:
                return None, None, None

        # Read the FULL transcript and return its folded entries. We do NOT use
        # the incremental ``parse_delta`` byte-offset path here: copilot (and
        # any vendor that rewrites its session file rather than pure-appending)
        # invalidates a cached byte offset, silently dropping the turn. Full
        # reparse keyed off entry COUNT is immune to rewrites; we gate it on a
        # (size, mtime) change so idle polls stay cheap.
        # The vendor writes an assistant message to its transcript only once that
        # message is COMPLETE, so the file is untouched for the whole time the
        # model is thinking, generating, or running a tool. Transcript silence is
        # therefore the normal state of a WORKING agent, not a turn boundary —
        # keying the inactivity fallback on it alone cut long turns off mid-flight
        # and reported them as successful (FLOWPAD-2034). The PTY is the missing
        # liveness signal: the vendor TUI paints continuously while it works, so a
        # change to its stream file means the worker is still busy.
        #
        # Named so the two fields can never be read positionally by mistake; it
        # still compares as a plain tuple, which is all the poller does with it.
        PtySignature = NamedTuple("PtySignature", [("size", int), ("mtime_ns", int)])

        def _pty_change_signature() -> "PtySignature | None":
            try:
                from flow_sdk.builtin.shell import get_shell_record, shell_pty_stream_path

                record = get_shell_record(self.shell_id) if self.shell_id else None
                if record is None:
                    return None
                st = shell_pty_stream_path(record.id, record.__dict__.get("pty_pid")).stat()
                return PtySignature(st.st_size, st.st_mtime_ns)
            except Exception:
                # No shell, no stream file yet, or an unreadable stat — fall back
                # to transcript-only liveness rather than holding the turn open.
                return None

        def _read_entries(path: "Path", fmt: "Any") -> list:
            try:
                tf = AgentTranscriptFile(
                    worker_type,
                    path,
                    session_id=self.session_id or "",
                    transcript_format=fmt,
                )
                return list(tf.entries)
            except Exception:
                logger.exception("prompt-pty: transcript parse failed for %s", path)
                return []

        # Session bookkeeping that is not part of the conversation. Skipped from
        # the live stream so the chat + dense chips show only "what the agent
        # did", not the system prompt / session-start markers (which otherwise
        # render as noise chips like "system · system").
        _NOISE_KINDS = live_stream_noise_kinds()

        # Watermark BEFORE routing the message: a resumed/booted session already
        # has entries on disk (history, session.start). Count them now so the
        # loop streams only entries appended for THIS turn.
        emitted = 0
        wm_path, wm_fmt, wm_descriptor = _resolve_transcript()
        wm_derived = bool(getattr(wm_descriptor, "derived", False))
        if wm_path is not None and wm_path.exists():
            emitted = len(_read_entries(wm_path, wm_fmt))
        else:
            wm_descriptor = None

        handler = StreamingResponseHandler()

        async def _run_turn() -> None:
            nonlocal emitted
            # Set when the turn's user message shows up in the transcript —
            # the submission signal the cold-boot nudge loop waits for.
            user_turn_landed = asyncio.Event()
            nudge_task: asyncio.Task | None = None
            resolved_path: "Path | None" = wm_path if (wm_path and wm_path.exists()) else None
            resolved_fmt = wm_fmt
            resolved_derived = wm_derived
            last_sig: "tuple | None" = None
            last_pty_sig: "PtySignature | None" = None
            active_codex_turn_id: str | None = None
            try:
                async with lock:
                    # A PTY vendor can mint its own durable session id (Codex
                    # does). Adopt it as soon as the canonical descriptor is
                    # available, before a client can observe a completed turn
                    # paired with Flowpad's provisional launch UUID.
                    if wm_descriptor is not None:
                        await self._persist_transcript_session_id(wm_descriptor)

                    # Route the message into the PTY worker. claude submits a
                    # paste with a trailing \r fine; copilot / codex TUIs treat
                    # it as literal text and need the discrete paste-settle-Enter
                    # path — a per-vendor trait owned by the driver.
                    submits_on_paste = self.driver.pty_submits_on_paste
                    # ``needs_initial_type``: the nudge loop must TYPE the message
                    # before pressing Enter (copilot/codex cold start, whose CLI
                    # ignores the launch-arg instruction and reads from stdin).
                    # Otherwise the text is already delivered and retries are
                    # Enter-ONLY (never re-paste → no concatenation).
                    needs_initial_type = False
                    if await self.is_running():
                        # HOT path: the PTY is already live. Deliver the text once;
                        # the nudge loop below confirms submission. claude's
                        # ``--resume`` TUI (and any redraw-busy TUI) can swallow a
                        # single paste+\r, leaving the turn UNSUBMITTED — no user
                        # turn, no output, worker stuck PENDING_USER. The nudge
                        # guard (previously cold-start-only) closes that hole.
                        if getattr(self.driver, "pty_composer_ready_pattern", None) is not None:
                            # Composer-gated vendor: defer typing to the
                            # nudge task so a boot interstitial still on screen
                            # (RUNNING is not composer-ready — QA C09b) can never
                            # eat the prompt, and so the transcript poll loop
                            # below starts streaming while we wait. A warm
                            # composer passes the gate instantly.
                            needs_initial_type = True
                        elif submits_on_paste:
                            await self.send(message)
                        else:
                            shell = await self.shell()
                            if shell is None:
                                raise RuntimeError("No shell linked for PTY submit")
                            await shell.write_then_submit(message)
                    else:
                        launch_instruction, needs_initial_type = self._cold_pty_delivery_plan(
                            self.driver,
                            message,
                        )
                        res = await self.start_pty(instruction=launch_instruction)
                        if isinstance(res, ApiFailResponse):
                            raise RuntimeError(f"start_pty failed: {res.message}")
                        # Cold-boot delivery is vendor-specific:
                        # every grounded vendor launches blank and waits for its
                        # real composer before typing; only a pattern-less legacy
                        # argv vendor may keep a pre-filled launch instruction.

                    # Submission guard for BOTH paths: wait for the user turn to
                    # land in the transcript; if it doesn't, type-once (only when
                    # needed) then press Enter on a bounded retry. ``user_turn_
                    # landed`` is set by the poll loop below when the USER_MESSAGE
                    # entry appears.
                    # Set once the prompt has been typed WITHOUT the composer gate
                    # (the last-resort path). Guards against a double type: the
                    # poll-loop trigger and the inline gate-failed trigger share it.
                    blind_delivered = asyncio.Event()

                    async def _blind_deliver() -> None:
                        """Last-resort: type the prompt WITHOUT the composer gate.

                        Fires when the composer-ready marker never matched — the
                        gate returned False (PTY closed), or it is still pending
                        while the turn is about to fail as ``user-turn-not-landed``
                        (regex drift, or an unrecognized interstitial owns the
                        screen). Typing it once blindly is strictly better than
                        dead-ending the turn with the prompt never delivered.
                        """
                        blind_delivered.set()
                        if user_turn_landed.is_set():
                            return
                        shell = await self.shell()
                        if shell is None:
                            return
                        try:
                            if submits_on_paste:
                                await shell.write(message)
                            else:
                                await shell.write_then_submit(message)
                        except Exception:
                            logger.debug("prompt-pty: blind delivery write failed", exc_info=True)

                    async def _nudge_enter_only() -> None:
                        # Preserve the established per-TUI nudge cadence even
                        # now that Claude's initial text also goes through the
                        # composer gate: paste-with-Enter vendors use the short
                        # cadence; discrete-Enter vendors use the long one.
                        delay = 1.5 if submits_on_paste else 3.0
                        for _ in range(8):
                            await asyncio.sleep(delay)
                            if user_turn_landed.is_set():
                                return
                            try:
                                # Retry: discrete Enter only — never re-paste
                                # (would concatenate). A \r on an empty/submitted
                                # input box is a harmless no-op.
                                await self.send(b"\r")
                            except Exception:
                                return

                    async def _nudge_submit() -> None:
                        if needs_initial_type:
                            # Composer-gated typed delivery (QA C09b): waits for
                            # the vendor's composer-ready marker before typing
                            # (legacy settle-sleep for pattern-less vendors).
                            if not await self._typed_pty_delivery(message, landed=user_turn_landed):
                                # The gate could not confirm readiness (PTY closed,
                                # or marker never matched). Do NOT dead-end the
                                # turn: type the prompt once blindly so a booted-
                                # but-unrecognized composer still receives it,
                                # then fall through to the Enter-nudge cadence.
                                logger.warning(
                                    "prompt-pty: composer gate did not confirm readiness for %s "
                                    "(%s) — typing the prompt blindly as a last resort (process %s)",
                                    self.id,
                                    worker_type,
                                    self.id,
                                )
                                await _blind_deliver()
                        await _nudge_enter_only()

                    nudge_task = asyncio.create_task(_nudge_submit())

                    last_activity = time.monotonic()
                    while True:
                        # Resolve the transcript lazily — it may not exist until
                        # the worker writes its first line of this turn. A
                        # DERIVED transcript is re-resolved every tick: the
                        # projection only grows when the driver rebuilds it, so
                        # watching its mtime alone would never advance.
                        if resolved_path is None or not resolved_path.exists() or resolved_derived:
                            p, f, descriptor = _resolve_transcript()
                            resolved_derived = bool(getattr(descriptor, "derived", False))
                            if p is not None and p.exists():
                                resolved_path, resolved_fmt = p, f
                                last_sig = None  # force a read
                                if descriptor is not None:
                                    await self._persist_transcript_session_id(descriptor)

                        if resolved_path is not None and resolved_path.exists():
                            sig = transcript_change_signature(resolved_path)
                            # Only reparse when the file actually changed.
                            if sig is not None and sig != last_sig:
                                last_sig = sig
                                entries = _read_entries(resolved_path, resolved_fmt)
                                if len(entries) > emitted:
                                    last_activity = time.monotonic()
                                    provider_turn_complete = False
                                    for entry in entries[emitted:]:
                                        # Codex rollouts expose a durable,
                                        # per-turn completion pair. Capture the
                                        # new turn id before SYSTEM entries are
                                        # filtered as timeline noise, then close
                                        # only on its matching terminal event.
                                        if (
                                            worker_type == "codex"
                                            and entry.kind is EntryKind.SYSTEM
                                            and getattr(entry, "subtype", "") == "event_msg.task_started"
                                        ):
                                            payload = getattr(entry, "payload", None)
                                            turn_id = (
                                                str(payload.get("turn_id") or "") if isinstance(payload, dict) else ""
                                            )
                                            active_codex_turn_id = turn_id or None
                                        # The client echoes the user turn
                                        # optimistically; skip the transcript's
                                        # copy. Its arrival also confirms
                                        # submission to the nudge loop.
                                        if entry.kind is EntryKind.USER_MESSAGE:
                                            user_turn_landed.set()
                                            # Framework-injected (isMeta) user lines — skill
                                            # bodies, command expansions — are not the client's
                                            # optimistic echo; fall through so the live chat
                                            # renders the same meta chips a reload does (the
                                            # prompt envelope is itself isMeta, but the client
                                            # filters it).
                                            if not getattr(entry, "is_meta", False):
                                                continue
                                        if self._pty_turn_complete(
                                            entry,
                                            worker_type=worker_type,
                                            active_turn_id=active_codex_turn_id,
                                            user_turn_landed=user_turn_landed.is_set(),
                                        ):
                                            provider_turn_complete = True
                                            continue
                                        if entry.kind in _NOISE_KINDS:
                                            continue
                                        await handler.on_flow_data(entry_to_flowdata(entry, observation_kind="live"))
                                    emitted = len(entries)
                                    if provider_turn_complete:
                                        logger.info(
                                            "prompt-pty: closing stream on %s terminal marker for turn %s (process %s)",
                                            worker_type,
                                            active_codex_turn_id or "current",
                                            self.id,
                                        )
                                        # Preserve the existing PTY success
                                        # frame contract; inactivity remains
                                        # the fallback when turn correlation is
                                        # absent or incomplete.
                                        await handler.on_flow_data(self._pty_inactivity_result(True))
                                        return

                        # A PTY paint is turn activity. Without this the fallback
                        # measures a busy worker as idle (see _pty_change_signature).
                        # NOTE this does not widen any budget: inactivity_timeout is
                        # unchanged, it now just starts from the last sign of life
                        # rather than the last transcript write.
                        pty_sig = _pty_change_signature()
                        if pty_sig is not None and pty_sig != last_pty_sig:
                            last_pty_sig = pty_sig
                            last_activity = time.monotonic()

                        if time.monotonic() - last_activity >= inactivity_timeout:
                            landed = user_turn_landed.is_set()
                            # LAST-RESORT delivery (no new timeout — the existing
                            # inactivity signal is the trigger): a composer-gated
                            # turn reached the inactivity boundary with the user
                            # row still absent AND the prompt was never typed
                            # blindly. The gated delivery is stuck (the composer
                            # marker never matched — regex drift, or an
                            # unrecognized interstitial owns the screen). Cancel
                            # the stuck gated delivery, type the prompt ONCE
                            # blindly, and give the poll loop one more inactivity
                            # window to observe the result before failing.
                            if not landed and needs_initial_type and not blind_delivered.is_set():
                                logger.warning(
                                    "prompt-pty: user turn never landed for %s (%s) — typing the "
                                    "prompt blindly as a last resort before submission-error. "
                                    "Either the prompt was never delivered (composer marker drift, "
                                    "or an unrecognized interstitial owns the screen) or it WAS "
                                    "delivered and the transcript never showed it — check the "
                                    "vendor's transcript resolution before blaming the regex "
                                    "(process %s)",
                                    self.id,
                                    worker_type,
                                    self.id,
                                )
                                if nudge_task is not None and not nudge_task.done():
                                    nudge_task.cancel()
                                    try:
                                        await nudge_task
                                    except BaseException:
                                        pass
                                await _blind_deliver()
                                nudge_task = asyncio.create_task(_nudge_enter_only())
                                last_activity = time.monotonic()
                                await asyncio.sleep(poll_interval)
                                continue
                            logger.info(
                                "prompt-pty: closing stream after %.1fs of transcript inactivity (process %s)",
                                inactivity_timeout,
                                self.id,
                            )
                            # Synthetic end-of-turn marker — wire-format parity
                            # with print mode, whose stream worker emits a real
                            # `result` event at turn end. The PTY transcript has
                            # no such event. Inactivity is a successful turn-end
                            # signal only after the provider transcript contains
                            # this turn's user row; otherwise surface delivery as
                            # an error instead of manufacturing a false success.
                            if not landed:
                                logger.warning(
                                    "prompt-pty: transcript went inactive before the user turn landed (process %s)",
                                    self.id,
                                )
                            await handler.on_flow_data(self._pty_inactivity_result(landed))
                            return
                        await asyncio.sleep(poll_interval)
            except Exception as e:
                logger.exception("prompt-pty: turn error")
                await handler.add_str_to_queue(Exception(f"prompt-pty error: {e}"))
            finally:
                if nudge_task is not None and not nudge_task.done():
                    nudge_task.cancel()
                # Signal end-of-stream to downstream consumers.
                await handler.on_flow_data(None)
                # Broadcast the entity's now-idle state. The lock released when
                # the ``async with lock`` block exited above, so ``is_turn_busy``
                # computes False now — but the readiness/toggle UIs read the AP
                # ENTITY (useEntity), NOT this content stream. Without an explicit
                # entity update the chat⇄terminal toggle stays disabled after a
                # PTY-prompt turn even though the turn is done (the switch_stress
                # "toggle never re-enabled" wedge at running/complete). Best-effort
                # so a client-disconnect cancellation can't mask the teardown.
                try:
                    await self.notify_updated()
                except Exception:
                    logger.debug("prompt-pty: post-turn notify_updated failed", exc_info=True)

        turn_task = asyncio.create_task(_run_turn())

        async def _stream_body():
            try:
                async for xml_chunk in handler:
                    yield xml_chunk
            finally:
                if not turn_task.done():
                    # Client disconnected — the PTY worker keeps running on its
                    # own; just stop the poller.
                    turn_task.cancel()

        return StreamingResponse(
            _stream_body(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @action.post(action_name="observe-turn")
    async def observe_turn(self, after_entry_id: str | None = None) -> Any:
        """Stream an IN-FLIGHT turn's transcript entries to a client that did
        NOT start it.

        *after_entry_id* is the client's own position: "I already hold this
        transcript entry; send me what follows it". Omit it and the stream
        watermarks at open, which is the historical behaviour — see the
        watermark block below for why that default is wrong for a client that
        learns about a turn late.

        A turn's content reaches the client that sent it through that client's
        own ``prompt`` response stream. Nobody else has a source: a turn typed
        into the xterm, watched from a second tab, or driven by a background
        worker leaves every other surface on a stale list until something
        force-reloads history at turn end. This is that missing source, and it
        is deliberately a PULL: it exists only while a surface is actually
        looking, so a session nobody is watching costs nothing at all.

        Read-only by construction. It takes no prompt lock, registers no worker,
        and mutates no state — so it can never 409, never delays the turn it is
        watching, and two observers cannot conflict.

        Ends on whichever signal is AUTHORITATIVE for this transport, plus the
        client hanging up (Starlette cancels the generator on disconnect,
        exactly as an aborted ``prompt`` is torn down). There is no duration
        argument — the turn's end is the signal:

        * **PTY** → a provider message-end marker (:meth:`_pty_turn_complete`)
          AND ``is_turn_busy`` false. Neither alone is sufficient: the marker
          fires per assistant message (a multi-step turn emits several), and the
          predicate falls through to the transcript tail for an interactive
          worker, which reads idle for a beat between a tool result and the next
          model output. Closing early is not merely cosmetic — the client
          re-opens, re-watermarks, and skips whatever landed in the gap.
        * **headless** → ``is_turn_busy`` alone, exact by construction for CLI
          mode: the prompt lock, the registered worker, or ``_turn_in_flight``
          spans the whole turn (see the predicate's own note on the tail signal
          being PTY-only). A headless turn writes no provider marker.
        """
        from starlette.responses import StreamingResponse  # local import — starlette is an app-layer dep

        from flow_sdk.builtin.agentic_process.cli_drivers.claude.session_history import (
            entry_to_flowdata,
        )
        from flow_sdk.transcript_analyzer import AgentTranscriptFile
        from flow_sdk.transcript_analyzer.resolver import transcript_change_signature

        poll_interval = 0.3
        worker_type = self.driver.name
        noise = live_stream_noise_kinds()
        handler = StreamingResponseHandler()

        def _transcript_path() -> "tuple[Path | None, bool]":
            """Return ``(path, derived)`` — see ``TranscriptDescriptor.derived``."""
            try:
                desc = self.driver.transcript_descriptor(self)
            except Exception:
                desc = None
            if desc is not None:
                return desc.path, desc.derived
            try:
                return self.driver.transcript_path(self), False
            except Exception:
                return None, False

        def _read_entries(path: "Path") -> list:
            """Full reparse keyed off entry COUNT — same choice the prompt
            stream makes, because a vendor that rewrites its session file
            (copilot) invalidates a cached byte offset and silently drops the
            turn. Gated on a (size, mtime) change so idle polls stay cheap."""
            try:
                desc = self.driver.transcript_descriptor(self)
            except Exception:
                desc = None
            try:
                tf = AgentTranscriptFile(
                    worker_type,
                    path,
                    session_id=self.session_id or "",
                    transcript_format=desc.format if desc is not None else None,
                )
                return list(tf.entries)
            except Exception:
                logger.debug("observe-turn: transcript parse failed for %s", path, exc_info=True)
                return []

        path, derived = _transcript_path()
        # Where this stream starts.
        #
        # DEFAULT (no ``after_entry_id``) — watermark at open: the caller's pane
        # loads history on mount, so everything up to now is already on screen.
        # Stream only what the turn appends from here. That assumption holds
        # exactly when mount and open coincide (a second tab opening mid-turn).
        # It is FALSE for a client that learns about a turn late — a prompt
        # drained from the queue, say — where the pane mounted long before the
        # turn existed, so "everything up to now" silently includes content
        # nobody has ever seen. Measured: the drained prompt and the turn's
        # first output are always already on disk by the time ``busy`` reaches
        # the client (it is broadcast from the DEBOUNCED transcript flush), so
        # this watermark classifies the turn's own head as history (FLOWPAD-1981).
        #
        # ``after_entry_id`` fixes that by asking instead of guessing: the client
        # states the last entry it holds and the stream resumes after it. The
        # server has no way to know this on its own — only the client knows what
        # is on its screen.
        #
        # An UNKNOWN id degrades to the watermark-at-open default rather than
        # replaying from zero: a stale, rotated, or foreign id should behave like
        # today, never flood a pane with the whole session.
        entries_at_open = _read_entries(path) if path is not None and path.exists() else []
        emitted = len(entries_at_open)
        if after_entry_id:
            # Scan from the tail: the client's position is far likelier to be
            # recent, and the last match wins if an id somehow repeats.
            for index in range(len(entries_at_open) - 1, -1, -1):
                entry = entries_at_open[index]
                if after_entry_id in (getattr(entry, "id", None), getattr(entry, "entry_id", None)):
                    emitted = index + 1
                    break

        async def _observe(*, live: bool) -> None:
            """Pump the transcript into the stream.

            ``live`` False means the stream was opened AFTER the turn ended and
            exists only to hand over the backlog the client is behind: flush one
            pass and close, never poll for a turn that is not coming.
            """
            nonlocal emitted
            try:
                last_sig: "tuple | None" = None
                saw_marker = False
                while True:
                    # A derived transcript is rebuilt by the driver, so it must
                    # be re-resolved every tick (see ``TranscriptDescriptor``).
                    if derived or path is None or not path.exists():
                        p, _ = _transcript_path()
                    else:
                        p = path
                    if p is not None and p.exists():
                        sig = transcript_change_signature(p)
                        if sig is not None and sig != last_sig:
                            last_sig = sig
                            entries = _read_entries(p)
                            fresh, emitted = entries[emitted:], max(emitted, len(entries))
                            for entry in fresh:
                                if entry.kind in noise:
                                    continue
                                if self._pty_turn_complete(
                                    entry,
                                    worker_type=worker_type,
                                    active_turn_id=None,
                                    user_turn_landed=True,
                                ):
                                    # A marker means "a message completed", not
                                    # "the turn is over" — claude writes one per
                                    # assistant segment, so a multi-step turn
                                    # emits several. Remember it and let the
                                    # liveness check below decide; returning here
                                    # ends the stream mid-turn and the client's
                                    # re-open re-watermarks past whatever lands
                                    # in the gap.
                                    saw_marker = True
                                    continue
                                await handler.on_flow_data(entry_to_flowdata(entry, observation_kind="live"))
                    if not live:
                        # Backlog-only stream (see ``live``): the pass above just
                        # flushed everything after the client's stated position
                        # and there is no turn to follow. Closing here is what
                        # makes the short-turn case terminate — the liveness
                        # check below needs a provider marker, which a stream
                        # opened after the marker was already on disk never sees.
                        return
                    # Neither signal is sufficient alone for a PTY: the provider
                    # marker fires per message, and ``is_turn_busy`` falls through
                    # to the transcript tail, which reads idle for a beat between
                    # a tool result and the next model output. Together they are
                    # exact — a completed message AND nothing running. Headless
                    # writes no marker, but there ``is_turn_busy`` is exact on its
                    # own (lock / registered worker / ``_turn_in_flight`` span the
                    # whole turn; see the predicate's note on the tail being
                    # PTY-only).
                    if (saw_marker or not self.pty_mode) and not is_turn_busy(self):
                        return
                    await asyncio.sleep(poll_interval)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("AgenticProcess %s: observe-turn poller failed", self.id, exc_info=True)
            finally:
                await handler.on_flow_data(None)

        # ``busy`` gates whether there is a turn to FOLLOW — not whether there is
        # anything to SEND. A client that states ``after_entry_id`` can be behind
        # entries that are already on disk, and a SHORT turn is routinely over
        # before that client ever opens the stream: ``busy`` reaches it from the
        # DEBOUNCED transcript flush, so the open loses the race by construction.
        # Gating the whole stream on liveness threw the stated position away and
        # closed empty — the drained prompt and its answer then appeared only on
        # a manual refresh (PR #354 review). Serve the backlog first; only then
        # is "nothing running" also "nothing to say".
        busy_at_open = is_turn_busy(self)
        backlog = len(entries_at_open) - emitted
        if busy_at_open or backlog > 0:
            observe_task = asyncio.create_task(_observe(live=busy_at_open))
        else:
            # Nothing running and nothing unseen: hand back an empty,
            # already-closed stream rather than an error — a caller racing the
            # end of a turn is normal, not a fault.
            observe_task = None
            await handler.on_flow_data(None)

        async def _stream_body():
            try:
                async for xml_chunk in handler:
                    yield xml_chunk
            finally:
                if observe_task is not None and not observe_task.done():
                    # Client went away (unmounted / navigated). The worker keeps
                    # running; just stop watching it.
                    observe_task.cancel()

        return StreamingResponse(
            _stream_body(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # ── Plan mode ─────────────────────────────────────────────────────────────

    @action.post(action_name="execute-plan")
    async def execute_plan(
        self,
        file_path: str,
        clear_context: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Tell Claude to execute the plan.

        If clear_context=True, inject '/clear' first. The ExitPlanMode
        permission prompt is answered by the user in the terminal — Flowpad does
        not pre-approve it.
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
        """Adopt a session id discovered in the on-disk transcript (PTY resume
        rotation). Routed through ``adopt_worker_session`` — the single owner
        of session-rotation restart bookkeeping — which patches only the
        session-derived snapshot fields. The previous inline version refreshed
        ``last_started_hash`` from the FULL live payload, silently blessing
        any genuine config drift (and leaving ``last_started_snapshot`` stale,
        so restart-info diffs contradicted the flag)."""
        if descriptor is None or not descriptor.session_id:
            return
        if not self.adopt_worker_session(descriptor.session_id):
            return
        try:
            await self.save()
        except Exception:
            # WARNING so resume-from-transcript regressions surface.
            logger.warning(
                "AgenticProcess %s transcript: session_id save failed",
                self.id,
                exc_info=True,
            )

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
        self,
        transcript: "AgentTranscriptFile | None",
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
                logger.warning("AgenticProcess %s transcript/plan: save plan_path failed", self.id, exc_info=True)

        try:
            from flow_sdk.fs_store.fs_ref import FSRef as _FSRef
            from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown, markdown_id

            # extract_markdown requires a resolved id (capsule refactor 4f94fb92
            # made it a positional arg). Resolve it READ-ONLY via markdown_id
            # (adopted frontmatter id, else the stable uuid5(path)) — the plan
            # file is a transient Claude transcript artifact we must not mutate
            # with an identity-capsule write.
            _ref = _FSRef(Path(plan_file_path))
            records = extract_markdown(_ref, markdown_id(_ref))
            if not records:
                return ApiFailResponse(message=f"could not parse {plan_file_path}")
            rec = records[0]
            await rec.sync_to_db()
            return ApiSuccessResponse(data={"markdown": rec.meta_dict(), "plan_path": plan_file_path})
        except Exception as e:
            logger.exception("AgenticProcess %s transcript/plan error: %s", self.id, e)
            return ApiFailResponse(message=str(e))

    def _transcript_prompts(
        self,
        transcript: "AgentTranscriptFile | None",
    ) -> ApiSuccessResponse:
        """Return the user-prompt list straight from the transcript.

        Filters applied by ``AgentTranscriptFile.prompts`` (sidechain, empty,
        Claude Code synthetic markers). Output shape mirrors the entry's
        ``to_dict()`` envelope so the TS analyzer mirror's ``fromJson``
        factory can hydrate ``UserMessageEntry`` instances directly.
        """
        if transcript is None:
            return ApiSuccessResponse(data={"prompts": []})
        return ApiSuccessResponse(
            data={
                "prompts": [e.to_dict() for e in transcript.prompts],
            }
        )

    def _transcript_full(
        self,
        transcript: "AgentTranscriptFile | None",
        descriptor=None,
    ) -> ApiSuccessResponse:
        if transcript is None or descriptor is None:
            return ApiSuccessResponse(
                data={
                    "worker_type": self.driver.name,
                    "session_id": self.session_id,
                    "path": None,
                    "transcript_path": None,
                    "transcript_format": None,
                    "transcript_source": None,
                    "header": {},
                    "entries": [],
                }
            )
        path = str(descriptor.path)
        return ApiSuccessResponse(
            data={
                "worker_type": self.driver.name,
                "session_id": transcript.session_id or descriptor.session_id,
                "path": path,
                "transcript_path": path,
                "transcript_format": descriptor.format.value,
                "transcript_source": descriptor.source.value,
                "header": self._transcript_header(transcript),
                "entries": [e.to_dict() for e in transcript.entries],
            }
        )

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
            out["git"] = {k: v for k, v in git.items() if k in {"branch", "commit_hash", "repository_url"} and v}
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

    @action.post(action_name="load-embedded-subagent")
    async def load_embedded_subagent_action(self, asset_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Load a sub-agent from its ``asset_ref`` and embed it into this process.

        ``asset_ref`` is the sub-agent record's own OS filesystem path (an ``FSRef``
        path), NOT a VFS path — it was renamed from ``source_vfs_path`` and the
        contract changed with it, which is what stranded the old VFS-style
        re-rooting below.

        Materializes the sub-agent markdown into the process asset directory so the
        generated system-instruction files can include it on every launch.

        Identity is persisted as the sub-agent's entity ref (``embedded_asset_refs``,
        same as ``attach_embedded_asset``) — the name is only the projection used
        for the materialized filename / CLI payload. ``embedded_subagent_ids`` is a
        legacy name list; we no longer write it, and migrate-on-touch any entry
        for this sub-agent so attach/detach stays symmetric on old processes.
        """
        from flow_sdk.fs_store.operations.subagent import (  # noqa: PLC0415
            extract_subagent_from_path,
            render_subagent_markdown,
        )

        if not asset_ref:
            return ApiFailResponse(message="asset_ref is required")
        # `Path(ref).resolve()` — the same construction FSRef itself uses, and
        # which `_agent_entity_ref` re-applies to this value downstream. Rooting
        # it with `Path("/" + ref)` instead corrupted every Windows ref
        # (`C:\...` → `\C:\...`), so the file never existed and the embed failed.
        abs_path = Path(asset_ref).resolve()
        if not abs_path.exists():
            return ApiFailResponse(message=f"Agent file not found: {abs_path}")
        agent = extract_subagent_from_path(abs_path)
        if agent is None:
            return ApiFailResponse(message=f"Could not parse agent file: {abs_path}")
        assets = self.ensure_embedded_assets()
        name = agent.name or abs_path.stem
        assets.load_asset(
            Path(".claude") / "agents" / f"{name}.md",
            content=render_subagent_markdown(agent),
        )
        self._normalize_process_asset_mount()
        ref = self._agent_entity_ref(abs_path)
        refs = list(self.embedded_asset_refs or [])
        if ref not in refs:
            self.embedded_asset_refs = refs + [ref]
        self._drop_legacy_agent_name(name)
        await self.save()
        return ApiSuccessResponse(data={"ok": True, "name": name, "ref": str(ref)})

    @staticmethod
    def _agent_entity_ref(path: "Path") -> TypeId:
        """Entity ref for an agent .md path — the single ``agent path → TypeId``
        seam (read-only; same uuid the indexer mints for the file)."""
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
        from flow_sdk.fs_store.indexer.functions.subagent import subagent_peek_entity_id  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        return TypeId(
            type=RecordType.SUBAGENT.value,
            id=subagent_peek_entity_id(FSRef(path, record_type=RecordType.SUBAGENT)),
        )

    def _drop_legacy_agent_name(self, name: str | None) -> None:
        """Migrate-on-touch: strip a legacy ``embedded_subagent_ids`` name entry."""
        if name and name in (self.embedded_subagent_ids or []):
            self.embedded_subagent_ids = [n for n in self.embedded_subagent_ids if n != name]

    @action.post(action_name="load-embedded-skill")
    async def load_embedded_skill_action(self, asset_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Make a skill folder discoverable to this process's worker.

        Skills are directory-discovered by the worker at startup, not a CLI
        input. We symlink the live source folder into the worker's skills root
        (``_skills_root``) — ``<assets_dir>/.claude/skills/<name>/`` for
        Claude/Copilot, ``$CODEX_HOME/skills/<name>/`` for Codex — so edits to
        the original SKILL.md flow through to the next chat without
        re-materialization. Backs the TS ``AgenticProcess.loadEmbeddedSkill``.
        """
        import shutil

        if not asset_ref:
            return ApiFailResponse(message="asset_ref is required")
        # Absolute already (see load_embedded_subagent_action) — do not re-root.
        skill_dir = Path(asset_ref).resolve()
        if not skill_dir.is_dir():
            return ApiFailResponse(message=f"Skill folder not found: {skill_dir}")
        if not (skill_dir / "SKILL.md").exists():
            return ApiFailResponse(message=f"SKILL.md missing in: {skill_dir}")
        try:
            assets = self.ensure_embedded_assets()
            assets_dir = assets.os_path
            skills_root = self._skills_root(assets_dir)
            skills_root.mkdir(parents=True, exist_ok=True)
            link = skills_root / skill_dir.name
            # Refresh: a stale symlink, prior copy, or regular file all get replaced.
            if link.is_symlink() or link.is_file():
                link.unlink()
            elif link.is_dir():
                shutil.rmtree(link)
            link.symlink_to(skill_dir, target_is_directory=True)
            self._normalize_process_asset_mount()
            await self.save()
            return ApiSuccessResponse(data={"ok": True, "name": skill_dir.name, "link": str(link)})
        except Exception as exc:
            logger.exception("load_embedded_skill failed for %s", asset_ref)
            return ApiFailResponse(message=str(exc))

    @staticmethod
    def _skill_source_folder(skill: "Any") -> str | None:
        """Resolve a skill's source folder from a path, FSRef, or entity/record."""
        if isinstance(skill, str):
            return skill or None
        asset_ref = getattr(skill, "asset_ref", None)
        if isinstance(asset_ref, str):
            return asset_ref or None
        inner = getattr(asset_ref, "_path", None) or getattr(asset_ref, "path", None)
        return str(inner) if inner else (str(skill.record_dir) if getattr(skill, "record_dir", None) else None)

    async def load_skill(self, skill: "Any") -> "ApiSuccessResponse | ApiFailResponse":
        """Load a skill so this process's worker discovers it — worker-aware.

        ``skill`` may be a ``Skill`` entity (``Skill.from_fs_ref(folder)``), an
        FSRecord, or the skill folder path. Resolves it to its source folder and
        materializes it into the right location for the process's worker (see
        ``_skills_root``). The Python counterpart of TS ``loadEmbeddedSkill``.
        """
        source = self._skill_source_folder(skill)
        if not source:
            return ApiFailResponse(message="Could not resolve skill source folder")
        return await self.load_embedded_skill_action(asset_ref=source)

    def load_embedded_subagent(self, agent: "Any") -> None:
        """Embed a sub-agent into this process so it is registered via --agents at launch.

        Accepts a SubAgent record, any object with to_agents_json(), or a name string.
        Adds the sub-agent's name to the persisted embedded_subagent_ids list and
        stores the record in the in-memory _embedded_agents list.
        """
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
        from flow_sdk.fs_store.operations.subagent import load_subagent as _load_subagent  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        _agents: list = object.__getattribute__(self, "__dict__").setdefault("_embedded_agents", [])
        if isinstance(agent, str):
            rec = _load_subagent(agent) or FSRecord(type=RecordType.SUBAGENT, name=agent, id=agent)
        else:
            # duck-type: Record or anything with name/id
            rec = agent
        _agents.append(rec)
        name = rec.name if hasattr(rec, "name") else str(agent)
        if name and name not in (self.embedded_subagent_ids or []):
            self.embedded_subagent_ids = list(self.embedded_subagent_ids or []) + [name]

    def get_agents_json(self) -> "dict | None":
        """Return merged --agents JSON from all embedded sub-agents, or None if none loaded.

        Falls back to the persisted ``cli_config.agents_json`` for legacy
        processes created before embedded sub-agents were materialized as assets.
        """
        _agents: list = object.__getattribute__(self, "__dict__").get("_embedded_agents", [])
        if _agents:
            from flow_sdk.fs_store.operations.subagent import subagent_to_cli_json  # noqa: PLC0415

            result: dict = {}
            for rec in _agents:
                if hasattr(rec, "to_agents_cli_json"):
                    result.update(rec.to_agents_cli_json())
                else:
                    result.update(subagent_to_cli_json(rec))
            if result:
                return result
        persisted = (self.cli_config or {}).get("agents_json") or None
        return persisted or None

    # ── Embedded assets ────────────────────────────────────────────────────────
    # Unified attach/detach for agents, skills, and any future file-backed entity.
    # Materializes the entity's files under <record_dir>/assets/.claude/<type>/… so
    # Claude discovers them via `--add-dir <record_dir>/assets`.

    @property
    def embedded_assets(self) -> AssetDir | None:
        return object.__getattribute__(self, "__dict__").get("_embedded_assets")

    @property
    def process_assets(self) -> AssetDir | None:
        """Canonical process-owned asset workspace (lazy)."""
        return self.embedded_assets

    def ensure_embedded_assets(self) -> AssetDir:
        return self.ensure_process_assets()

    def ensure_process_assets(self) -> AssetDir:
        asset_dir = self.process_assets
        if asset_dir is None:
            asset_dir = AssetDir(self._record_dir() / "execution" / "assets")
            object.__getattribute__(self, "__dict__")["_embedded_assets"] = asset_dir
        asset_dir.os_path.mkdir(parents=True, exist_ok=True)
        return asset_dir

    def _process_assets_path(self) -> Path:
        return self._record_dir() / "execution" / "assets"

    def _is_process_assets_path(self, path: str | Path) -> bool:
        try:
            return Path(path).expanduser().resolve(strict=False) == self._process_assets_path().resolve(strict=False)
        except (OSError, RuntimeError, TypeError, ValueError):
            return False

    @property
    def instructions(self) -> str | None:
        value = (self.context_data or {}).get("instructions")
        return str(value) if value is not None else None

    @instructions.setter
    def instructions(self, value: str | None) -> None:
        context = dict(self.context_data or {})
        if value is None:
            context.pop("instructions", None)
        else:
            context["instructions"] = value
        self.context_data = context

    async def _assets_dir_path(self) -> "Path":
        """The filesystem directory where embedded assets are materialized.

        ``<records_root>/agentic_process/agentic_process-@<id>/execution/assets``
        """
        return self.ensure_embedded_assets().os_path

    def _normalize_process_asset_mount(self) -> None:
        """Migrate the former internal mount out of the user-owned field."""
        self.additional_dirs = [d for d in (self.additional_dirs or []) if not self._is_process_assets_path(d)]

    def _skills_root(self, assets_dir: "Path") -> "Path":
        """Directory a skill folder is laid into so THIS process's worker finds it.

        The vendor difference (Claude/Copilot read a mounted ``.claude/skills``;
        Codex reads ``$CODEX_HOME/skills``) lives behind ``WorkerDriver.skills_root``
        — the orchestrator never branches on the worker.
        """
        return self.driver.skills_root(self, assets_dir)

    @staticmethod
    def _render_agents_instruction_block(agents_json: dict | None) -> str:
        agents_json = agents_json or {}
        if not agents_json:
            return ""

        if len(agents_json) == 1:
            name, entry = next(iter(agents_json.items()))
            body = (entry or {}).get("prompt") or ""
            desc = (entry or {}).get("description") or ""
            sections: list[str] = [
                f"# You are the '{name}' agent",
                (
                    "The user is chatting with you (this agent) directly. "
                    "Adopt the persona and follow the instructions below for "
                    "every reply, even when the user does not name the agent. "
                    "Execute side-effect instructions literally (file writes, "
                    "command outputs); do not paraphrase or summarise away "
                    "required artifacts."
                ),
            ]
            if desc:
                sections.append(f"\n## Description\n{desc}")
            if body:
                sections.append(f"\n## Instructions\n{body}")
            return "\n".join(sections)

        sections = [
            "# Embedded agent specs",
            (
                "Each ## block below is the canonical instruction body for a "
                "named agent. When the user instruction names one of these "
                "agents, do not delegate to a separate sub-agent. Execute the "
                "agent instructions yourself in this same turn and follow "
                "side-effect instructions literally."
            ),
        ]
        for name, entry in agents_json.items():
            body = (entry or {}).get("prompt") or ""
            desc = (entry or {}).get("description") or ""
            sections.append(f"\n## {name}")
            if desc:
                sections.append(desc)
            if body:
                sections.append(body)
        return "\n".join(sections)

    def _load_materialized_agents_json(self, assets_dir: "Path") -> dict:
        agents: dict = {}
        agents_dir = assets_dir / ".claude" / "agents"
        if not agents_dir.is_dir():
            return agents
        from flow_sdk.fs_store.operations.subagent import (  # noqa: PLC0415
            extract_subagent_from_path,
            subagent_to_cli_json,
        )

        # Emit sub-agents in EMBED order, not filename order. Each sub-agent
        # is materialized by a sequential `load_asset` write, so file mtime
        # tracks embed order: the standard vibe sub-agent is embedded first
        # (earliest mtime), then the kind==vibe sub-agents in the created-date
        # order the frontend embedded them. Insertion order into `agents` is the
        # render order (see _render_agents_instruction_block), so mtime-sort
        # pins the vibe sub-agent first and lays the vibe sub-agents after it.
        # (name is the tiebreaker for same-tick writes.)
        def _sort_key(p: "Path") -> tuple:
            try:
                return (p.stat().st_mtime_ns, p.name)
            except OSError:
                return (0, p.name)

        for md in sorted(agents_dir.glob("*.md"), key=_sort_key):
            try:
                rec = extract_subagent_from_path(md)
                if rec is None:
                    continue
                agents.update(subagent_to_cli_json(rec))
            except Exception:
                logger.debug("failed to parse embedded sub-agent %s", md, exc_info=True)
        return agents

    async def _prepare_system_instruction_assets(self) -> SystemInstructionAssets | None:
        """Materialize process instructions into the process asset directory."""
        explicit = await self.resolve_system_instructions()
        legacy_agents = self.get_agents_json() or {}
        # Embedded assets must be detected from PERSISTED state, not just the
        # in-memory AssetDir handle: load-embedded-subagent runs on one entity
        # instance and save() invalidates the cache, so the prompt/launch
        # request gets a fresh instance whose _embedded_assets is None. Without
        # this, a materialized persona (e.g. vibe) silently never reaches the
        # worker's system instructions.
        has_existing_assets = self.embedded_assets is not None or bool(self.embedded_asset_refs)
        if not explicit and not legacy_agents and not has_existing_assets:
            return None

        asset_dir = self.ensure_embedded_assets()
        agents = {**legacy_agents, **self._load_materialized_agents_json(asset_dir.os_path)}
        agent_block = self._render_agents_instruction_block(agents)
        instructions = "\n\n".join(p for p in (explicit, agent_block) if p).strip()

        self._normalize_process_asset_mount()
        if not instructions:
            return None

        claude_file = asset_dir.load_asset("CLAUDE.md", content=instructions + "\n")
        # AGENTS.md / .agents / copilot-instructions must exist on disk (agents discover
        # them via --add-dir), but their paths aren't consumed — write without capturing.
        asset_dir.load_asset("AGENTS.md", content=instructions + "\n")
        asset_dir.load_asset(".agents", content=instructions + "\n")
        copilot_body = f'---\napplyTo: "**"\ndescription: Flowpad process system instructions\n---\n\n{instructions}\n'
        asset_dir.load_asset(
            ".github/instructions/flowpad.instructions.md",
            content=copilot_body,
        )
        return SystemInstructionAssets(
            assets_dir=asset_dir.os_path,
            instructions=instructions,
            claude_file=claude_file,
            process_id=self.id,
        )

    async def prepare_process_assets(self) -> PreparedProcessAssets:
        """Prepare every derived asset contribution once for a launch.

        Hook projection is a driver concern. Drivers predating this contract
        are harmless while no process hook is configured.
        """
        instructions = await self._prepare_system_instruction_assets()
        hook_runtime = ProcessHookRuntime()
        supports_hooks = bool(getattr(self.driver, "supports_process_hooks", False))
        if self.process_hook_events or supports_hooks:
            prepare = getattr(self.driver, "prepare_process_hooks", None)
            if prepare is None:
                raise ValueError("process hooks are unsupported by this worker")
            # The driver decides whether its projection needs files. Passing a
            # lazy handle keeps inline-only integrations (Codex) write-free.
            assets = AssetDir(self._process_assets_path())
            hook_runtime = prepare(
                assets,
                str(self.id),
                tuple(self.process_hook_events),
            )
        return PreparedProcessAssets(instruction_assets=instructions, hook_runtime=hook_runtime)

    async def prepare_system_instruction_assets(self) -> SystemInstructionAssets | None:
        """Compatibility instruction-only preparation entry point."""
        return await self._prepare_system_instruction_assets()

    @cached_property
    def hooks(self) -> "ProcessHooksManager":
        """This process's hooks — the ``HooksManager`` for Process scope.

        Its global counterpart is ``get_hook_manager(worker_type)``. Same
        interface; the difference is only the target and which cells the harness
        declares.
        """
        from flow_sdk.builtin.hooks.process_manager import ProcessHooksManager

        return ProcessHooksManager(self)

    async def set_hook(self, event: HookEventType | str) -> bool:
        """Persist one process-local hook intent; return whether it changed."""
        return await self.hooks._set(event, enabled=True, scope=None)

    async def remove_hook(self, event: HookEventType | str) -> bool:
        """Remove one process-local hook intent; return whether it changed."""
        return await self.hooks.remove(event)

    def register_callback(self, callback) -> Callable[[], None]:
        """Subscribe to every hook delivered to this process."""
        return self.hooks.set_callback(callback)

    async def on_hook(self, data: AgentHookData):
        """Emit and dispatch one canonical, process-targeted hook event.

        Returns whatever a callback answered (``None`` when nobody has an
        opinion, which is the common observer case).
        """
        from flow_sdk.builtin.hooks.manager import normalize_event

        if data.agentic_process_id != str(self.id):
            raise ValueError("agent hook target does not match process")
        event = normalize_event(data.hook_data.get("hook_event_name"))
        self.hooks.require(event)
        if event.value not in (self.process_hook_events or []):
            raise ValueError(f"process hook event is not configured: {event.value}")

        payload = data.model_dump(mode="python")
        try:
            from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
                FlowData,
                FlowDataSource,
                FlowDataType,
                FlowElementType,
            )

            flow_data = FlowData(
                flow_value=payload,
                attributes={
                    "element-type": FlowElementType.STATUS,
                    "data-type": FlowDataType.OBJECT,
                    "source": FlowDataSource.WEBSOCKET,
                    "kind": "process_hook",
                    "subtype": event.value,
                },
            )
            await self.emit_flow_data(flow_data.model_dump(mode="python"))
        except Exception:
            logger.exception("process hook FlowData emission failed for %s", self.id)
        return await self.hooks.deliver(data)

    @action.post(action_name="set-hook")
    async def _http_set_hook(self) -> ApiSuccessResponse | ApiFailResponse:
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        try:
            changed = await self.set_hook(body.get("event"))
        except NotImplementedError as exc:
            # An unsupported (harness, scope, event) cell. 501 rather than 400:
            # the request is well-formed, this harness simply cannot serve it.
            return ApiFailResponse(message=str(exc), status_code=501)
        except (TypeError, ValueError) as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data={"changed": changed})

    @action.post(action_name="remove-hook")
    async def _http_remove_hook(self) -> ApiSuccessResponse | ApiFailResponse:
        body = await _read_json_body()
        if isinstance(body, ApiFailResponse):
            return body
        try:
            changed = await self.remove_hook(body.get("event"))
        except NotImplementedError as exc:
            # An unsupported (harness, scope, event) cell. 501 rather than 400:
            # the request is well-formed, this harness simply cannot serve it.
            return ApiFailResponse(message=str(exc), status_code=501)
        except (TypeError, ValueError) as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data={"changed": changed})

    @staticmethod
    def _apply_system_instruction_assets(
        cmd: AgentOptions,
        assets: SystemInstructionAssets | None,
    ) -> None:
        if assets is None:
            return
        # One seam, owned by the argv class — see ``AgentOptions``.
        cmd.apply_instruction_assets(assets)

    @classmethod
    def _apply_process_assets(cls, cmd: AgentOptions, prepared: PreparedProcessAssets) -> None:
        cls._apply_system_instruction_assets(cmd, prepared.instruction_assets)
        runtime = prepared.hook_runtime
        if runtime.plugin_dirs:
            cmd.plugin_dirs = [
                *list(getattr(cmd, "plugin_dirs", []) or []),
                *runtime.plugin_dirs,
            ]
        if runtime.config_overrides:
            cmd.extra_config_overrides = [
                *list(getattr(cmd, "extra_config_overrides", []) or []),
                *runtime.config_overrides,
            ]
        if runtime.bypass_hook_trust:
            cmd.bypass_hook_trust = True

    @staticmethod
    def _instruction_context_kwargs(
        assets: SystemInstructionAssets | None,
    ) -> dict[str, Any]:
        if assets is None:
            return {}
        return {
            "instructions": None,
            "system_prompt_file": str(assets.claude_file),
            "developer_instructions": assets.instructions,
            "custom_instruction_dirs": [str(assets.assets_dir)],
        }

    @classmethod
    def _process_asset_context_kwargs(cls, prepared: PreparedProcessAssets) -> dict[str, Any]:
        return {
            **cls._instruction_context_kwargs(prepared.instruction_assets),
            "plugin_dirs": list(prepared.hook_runtime.plugin_dirs),
            "extra_config_overrides": list(prepared.hook_runtime.config_overrides),
            "bypass_hook_trust": prepared.hook_runtime.bypass_hook_trust,
        }

    async def _materialize_entity(self, ref: TypeId, assets_dir: "Path") -> str | None:
        """Copy the referenced entity's files under ``assets_dir/.claude/<type>/…``.

        Returns the entity's display name on success, ``None`` if the entity
        type is unsupported for embedding. Raises for resolution / IO failures.
        """
        from flow_sdk.fs_store.operations.skill import copy_skill_to, get_skill
        from flow_sdk.fs_store.operations.subagent import get_subagent  # noqa: PLC0415
        from flow_sdk.fs_store.operations.subagent import load_subagent as _load_subagent

        if ref.type == "subagent":
            # Resolve by id (uuid5-derived from the .md path) first, then fall back
            # to name-based lookup for agents the UI knows by name only.
            agent = get_subagent(ref.id) or _load_subagent(ref.id)
            if agent is None:
                raise FileNotFoundError(f"Agent not found: {ref.id}")
            target_dir = assets_dir / ".claude" / "agents"
            target_dir.mkdir(parents=True, exist_ok=True)
            src = agent.asset_ref._path if agent.asset_ref else None
            if src is None or not src.exists():
                raise FileNotFoundError(f"Agent source missing: {ref.id}")
            AssetDir(assets_dir).load_asset(
                Path(".claude") / "agents" / f"{agent.name or ref.id}.md",
                source=src,
            )
            return agent.name or ref.id

        if ref.type == "skill":
            skill = get_skill(ref.id)
            if skill is None:
                raise FileNotFoundError(f"Skill not found: {ref.id}")
            target_root = self._skills_root(assets_dir)
            copy_skill_to(skill, target_root)
            return skill.name or ref.id

        return None  # Unsupported type — caller decides to fail loudly.

    async def _unmaterialize_entity(self, ref: TypeId, assets_dir: "Path") -> None:
        """Best-effort removal of the files laid down by _materialize_entity."""
        import shutil

        from flow_sdk.fs_store.operations.skill import get_skill
        from flow_sdk.fs_store.operations.subagent import get_subagent  # noqa: PLC0415
        from flow_sdk.fs_store.operations.subagent import load_subagent as _load_subagent

        if ref.type == "subagent":
            agent = get_subagent(ref.id) or _load_subagent(ref.id)
            name = agent.name if agent else ref.id
            target = assets_dir / ".claude" / "agents" / f"{name}.md"
            if target.exists():
                target.unlink()
        elif ref.type == "skill":
            skill = get_skill(ref.id)
            name = skill.name if skill else ref.id
            target = self._skills_root(assets_dir) / name
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
            self._normalize_process_asset_mount()
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
            if ref.type == "subagent" and self.embedded_subagent_ids:
                # Legacy processes may still carry the agent by NAME — drop it
                # too, or the persona file is gone while an INLINE row lingers.
                from flow_sdk.fs_store.operations.subagent import get_subagent  # noqa: PLC0415

                agent = get_subagent(ref.id)
                self._drop_legacy_agent_name(agent.name if agent else None)
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

    @staticmethod
    def _transcript_file_reads(transcript) -> list[tuple[object, str]]:
        """``(entry, canonical_path)`` for each file read in ``transcript``."""
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        from flow_sdk.transcript_analyzer.entry import EntryKind

        if transcript is None:
            return []
        reads: list[tuple[object, str]] = []
        for entry in transcript.filter(kind=EntryKind.FILE_READ):
            if not getattr(entry, "path", None):
                continue
            try:
                reads.append((entry, canonical_posix_path(entry.path)))
            except Exception:
                continue
        return reads

    @staticmethod
    def _transcript_skill_calls(transcript) -> list:
        """Native ``Skill``-tool invocations (Claude ``/rca``) in ``transcript``.

        These carry a ``skill_name`` but produce no ``SKILL.md`` file read, so
        they are the only signal that a skill run via the Skill tool was used.
        """
        from flow_sdk.transcript_analyzer.entry import EntryKind

        if transcript is None:
            return []
        return [e for e in transcript.filter(kind=EntryKind.SKILL_CALL) if (getattr(e, "skill_name", "") or "").strip()]

    @staticmethod
    def _usage_from_file_read(entry: object, read_path: str) -> AssetUsage:
        return AssetUsage(
            kind=AssetUsageKind.TRANSCRIPT_FILE_READ,
            path=read_path,
            entry_id=getattr(entry, "entry_id", None) or getattr(entry, "id", None),
            timestamp=getattr(entry, "timestamp", None),
            label="Read in transcript",
        )

    @staticmethod
    def _source_match_for_asset(
        asset_path: str,
        ranked_sources: list[tuple[str, AssetSource]],
        entity: object,
        own_project_id: str,
    ) -> tuple[str, AssetSource] | None:
        match = next(
            (
                (path, source)
                for path, source in ranked_sources
                if asset_path == path or asset_path.startswith(path + "/")
            ),
            None,
        )
        if match is None:
            return None

        src_dir, src = match
        # USER_DIR is the real $HOME, so its prefix swallows every indexed asset
        # on the machine, including other project checkouts under ~/. Keep the
        # normal path-scan and transcript-only attribution rules aligned: a
        # project-scoped entity from another project should not be mislabeled as
        # a user asset just because it lives under the home catchall.
        entity_scope = getattr(entity, "scope", None)
        # System-scoped assets (the bundled flowpad_assistant skills/agents) are
        # pip-installed under $HOME (~/.local/share/.../flowpad_assistant/.claude),
        # so the USER_DIR prefix would otherwise claim them as personal user
        # assets. They belong to the mounted assistant, never the user — attribute
        # them to SYSTEM instead.
        #
        # Deliberately USER_DIR-only, and deliberately NOT hoisted above the
        # prefix match: the assistant is itself a Project whose mount is the
        # assistant root, so a deeper source dir (PROJECT_DIR for the assistant
        # project, or an editable install nested in a project tree) legitimately
        # wins the longest-prefix match and must keep winning. Claiming those for
        # SYSTEM would empty the assistant project's own asset list.
        #
        # ``scope`` is a persisted column and ``_stamp_scope`` never clobbers an
        # explicit value, so trust it only when the path agrees — otherwise the
        # returned source_dir would not be a prefix of posix_path, breaking the
        # invariant every other descriptor upholds. A disagreement falls back to
        # the previous behaviour: no match at all.
        if src == AssetSource.USER_DIR and entity_scope == "system":
            from flow_sdk.config import flowpad_assistant_canonical_root  # noqa: PLC0415

            sys_root = flowpad_assistant_canonical_root()
            if sys_root and (asset_path == sys_root or asset_path.startswith(sys_root + "/")):
                return sys_root, AssetSource.SYSTEM
            return None
        if (
            src == AssetSource.USER_DIR
            and entity_scope == "project"
            and str(getattr(entity, "project_id", None) or "") != own_project_id
        ):
            return None
        return src_dir, src

    def _annotate_asset_usage(
        self,
        descriptors: list[AssetDescriptor],
        reads: list[tuple[object, str]],
    ) -> None:
        """Attach transcript-file-read usage to descriptors in-place.

        EMBEDDED/INLINE process-active usage is added at descriptor creation.
        Transcript usage is derived here so the frontend consumes one unified
        ``usage`` surface and does not need to fetch or parse transcripts.
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        if not reads:
            return

        for descriptor in descriptors:
            if not descriptor.posix_path:
                continue
            try:
                asset_path = canonical_posix_path(descriptor.posix_path)
            except Exception:
                continue
            type_name = descriptor.typeid.split("-", 1)[0]
            type_info = SchemaRegistry.get(type_name)
            folder_backed = bool(getattr(type_info, "folder_backed", False))
            for entry, read_path in reads:
                if read_path != asset_path and not (
                    folder_backed and read_path.startswith(asset_path.rstrip("/") + "/")
                ):
                    continue
                descriptor.usage.append(self._usage_from_file_read(entry, read_path))

    @staticmethod
    def _annotate_skill_invocations(
        descriptors: list[AssetDescriptor],
        skill_calls: list,
    ) -> None:
        """Attach native Skill-tool invocations to skill descriptors in-place.

        A skill run via the ``Skill`` tool (Claude ``/rca``) leaves a
        ``SkillCallEntry`` but NO ``SKILL.md`` read, so ``_annotate_asset_usage``
        (file-read only) misses it. Match the invocation's ``skill_name`` to each
        skill descriptor's folder slug — the runtime's ``input.skill`` and the
        folder name are the same literal — and mark it used. Descriptors that
        share a slug (same skill under USER_DIR + PROJECT_DIR) are both marked,
        matching the "duplicates are intentional" contract.
        """
        from pathlib import Path

        if not skill_calls:
            return
        # One representative entry per slug (skill_calls already have non-empty
        # skill_name) so a skill invoked N times yields a single usage badge.
        first_by_slug: dict[str, object] = {}
        for entry in skill_calls:
            first_by_slug.setdefault((entry.skill_name or "").strip(), entry)

        for descriptor in descriptors:
            if not descriptor.posix_path or not descriptor.typeid.startswith("skill-"):
                continue
            slug = Path(descriptor.posix_path.rstrip("/")).name
            entry = first_by_slug.get(slug)
            if entry is None:
                continue
            descriptor.usage.append(
                AssetUsage(
                    kind=AssetUsageKind.SKILL_INVOKED,
                    entry_id=getattr(entry, "entry_id", None) or getattr(entry, "id", None),
                    timestamp=getattr(entry, "timestamp", None),
                    label=f"Invoked via /{slug}",
                )
            )

    async def _entity_for_transcript_read(self, read_path: str):
        """Resolve a read path to the owning file-backed entity, if any."""
        from pathlib import Path

        from flow_sdk.core.entity.entity_model import Entity
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        cur = Path(read_path)
        for path in [cur, *cur.parents]:
            try:
                entity = await Entity.get_by_asset_ref(canonical_posix_path(path))
            except Exception:
                entity = None
            if entity is None:
                continue
            asset_ref = getattr(entity, "asset_ref", None)
            if not asset_ref:
                continue
            asset_path = canonical_posix_path(asset_ref)
            type_info = SchemaRegistry.get(entity.type or entity.get_type())
            folder_backed = bool(getattr(type_info, "folder_backed", False))
            if read_path == asset_path or (folder_backed and read_path.startswith(asset_path.rstrip("/") + "/")):
                return entity
        return None

    async def _append_transcript_asset_descriptors(
        self,
        descriptors: list[AssetDescriptor],
        reads: list[tuple[object, str]],
        sources: list[tuple[str, AssetSource]],
    ) -> None:
        """Append read assets that were not visible through process sources."""
        from flow_sdk.fs_store.path_utils import canonical_posix_path

        if not reads:
            return

        ranked_sources = sorted(sources, key=lambda s: -len(s[0]))
        own_project_id = str(self.project_id or "")
        existing_read_paths = {
            u.path
            for descriptor in descriptors
            for u in descriptor.usage
            if u.kind == AssetUsageKind.TRANSCRIPT_FILE_READ and u.path
        }
        descriptor_by_key = {(d.typeid, d.source): d for d in descriptors}

        for entry, read_path in reads:
            if read_path in existing_read_paths:
                continue
            entity = await self._entity_for_transcript_read(read_path)
            if entity is None:
                continue
            asset_ref = getattr(entity, "asset_ref", None)
            if not asset_ref:
                continue
            asset_path = canonical_posix_path(asset_ref)
            match = self._source_match_for_asset(
                asset_path,
                ranked_sources,
                entity,
                own_project_id,
            )
            source_dir, source = match if match is not None else (None, AssetSource.EXTERNAL)
            typeid = f"{entity.type or entity.get_type()}-{entity.id}"
            key = (typeid, source)
            if key in descriptor_by_key:
                descriptor_by_key[key].usage.append(self._usage_from_file_read(entry, read_path))
                existing_read_paths.add(read_path)
                continue
            descriptor = AssetDescriptor(
                typeid=typeid,
                source=source,
                posix_path=asset_path,
                source_dir=source_dir,
                usage=[self._usage_from_file_read(entry, read_path)],
                remote=bool(getattr(entity, "remote", False)),
            )
            descriptors.append(descriptor)
            descriptor_by_key[key] = descriptor
            existing_read_paths.add(read_path)

    async def get_asset_descriptors(self) -> list[AssetDescriptor]:
        """Return a unified list of assets visible to this process.

        Composed from four sources of truth:
          1. EMBEDDED   — ``self.embedded_asset_refs`` + computed materialized path.
          2. INLINE     — ``cli_config.agents_json`` (or ``embedded_subagent_ids``
                           fallback). No file → ``posix_path=None``.
          3. Path-scan  — one ``Entity.assets_by_path()`` over the union of
                           user/project/workdir/additional_dirs, filtered to
                           ``EXECUTABLE_ASSET_TYPES`` and attributed to the
                           longest-prefix source.
          4. Transcript — file-backed entities read in the transcript but not
                           otherwise visible in the process asset sources.

        Duplicates across sources are intentional — the same source skill may
        appear as both EMBEDDED (materialized into the process) and USER_DIR
        (still globally available).
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path

        descriptors: list[AssetDescriptor] = []
        seen_embedded: set[str] = set()

        assets_dir = await self._assets_dir_path()

        # 1. EMBEDDED
        for ref in self.embedded_asset_refs or []:
            mat_path = await self._materialized_path_for(ref, assets_dir)
            mat_path_posix = canonical_posix_path(mat_path) if mat_path else None
            descriptors.append(
                AssetDescriptor(
                    typeid=str(ref),
                    source=AssetSource.EMBEDDED,
                    posix_path=mat_path_posix,
                    usage=[
                        AssetUsage(
                            kind=AssetUsageKind.EMBEDDED_ASSET,
                            path=mat_path_posix,
                            label="Embedded in this process",
                        )
                    ],
                )
            )
            seen_embedded.add(str(ref))

        # 2. INLINE (don't double-count anything already EMBEDDED)
        for tid, inline_path in self._iter_inline_agent_descriptors(assets_dir):
            if tid in seen_embedded:
                continue
            descriptors.append(
                AssetDescriptor(
                    typeid=tid,
                    source=AssetSource.INLINE,
                    posix_path=inline_path,
                    usage=[
                        AssetUsage(
                            kind=AssetUsageKind.INLINE_PERSONA,
                            path=inline_path,
                            label="Loaded as inline persona",
                        )
                    ],
                )
            )

        # 3. Path-discovered
        sources = await self._collect_source_dirs(assets_dir)
        descriptors.extend(
            await scan_path_asset_descriptors(
                sources,
                own_project_id=str(self.project_id or ""),
                types=list(EXECUTABLE_ASSET_TYPES),
                limit=10000,
            )
        )

        # Parse the transcript once; derive file-read and skill-invocation usage
        # from the same in-memory entries via the first-class ``filter`` selector.
        transcript = self._load_transcript()
        reads = self._transcript_file_reads(transcript)
        skill_calls = self._transcript_skill_calls(transcript)
        self._annotate_asset_usage(descriptors, reads)
        self._annotate_skill_invocations(descriptors, skill_calls)
        await self._append_transcript_asset_descriptors(descriptors, reads, sources)
        await hydrate_asset_descriptor_remote(descriptors)
        return descriptors

    async def _collect_source_dirs(self, assets_dir: "Path") -> list[tuple[str, AssetSource]]:
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

        proj = None
        if self.project_id:
            try:
                from flow_sdk.builtin.project import Project

                proj = await Project.get_by_id(self.project_id)
            except Exception:
                proj = None
        # USER_DIR / PROJECT_DIR / CONTEXT_DIR — shared policy with the
        # project-level staging view (Project.get_assets_action).
        pairs, seen = collect_base_source_dirs(proj)

        # WORKDIR — only if outside the previously-added paths.
        wd = getattr(self, "workdir", None)
        if wd:
            try:
                wd_key = canonical_posix_path(wd)
                if wd_key and wd_key not in seen and not any(wd_key == k or wd_key.startswith(k + "/") for k in seen):
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

    async def _materialized_path_for(self, ref: TypeId, assets_dir: "Path") -> "Path | None":
        """Compute the on-disk path of a materialized embedded asset.

        Mirrors the layout written by ``_materialize_entity``:
          - ``agent`` → ``<assets_dir>/.claude/agents/<name>.md``
          - ``skill`` → ``<assets_dir>/.claude/skills/<name>``

        TODO: when ``Record.materialize_into`` (tier 1 alignment) lands, swap
        this for ``record.materialize_into(assets_dir).path`` so the layout is
        owned by the record subclass instead of duplicated here.
        """
        try:
            if ref.type == "subagent":
                from flow_sdk.fs_store.operations.subagent import get_subagent  # noqa: PLC0415
                from flow_sdk.fs_store.operations.subagent import load_subagent as _load_subagent

                rec = get_subagent(ref.id) or _load_subagent(ref.id)
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
                return self._skills_root(assets_dir) / name
        except Exception:
            return None
        return None

    def _iter_inline_agent_descriptors(self, assets_dir: "Path") -> list[tuple[str, str | None]]:
        """Return ``(typeid, posix_path)`` pairs for inline-attached agents.

        Primary source: keys of ``cli_config.agents_json`` (agent names injected
        via ``--agents`` at session launch). Fallback: ``embedded_subagent_ids``
        (legacy name list written by old ``load_embedded_subagent`` calls).

        Each name is resolved to its agent ENTITY id (the same uuid the indexer
        mints) so the UI can open the row — the materialized copy under
        ``<assets_dir>/.claude/agents/<name>.md`` first, else
        ``load_subagent(name)`` (project > user > system). A name that resolves
        nowhere is an entity-less persona: it keeps the legacy
        ``subagent-<name>`` form with no path, and renders non-openable.
        """
        from flow_sdk.fs_store.operations.subagent import load_subagent as _load_subagent  # noqa: PLC0415
        from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        cfg = self.cli_config or {}
        agents_json = cfg.get("agents_json") or {}
        if isinstance(agents_json, dict) and agents_json:
            names = list(agents_json.keys())
        else:
            names = list(self.embedded_subagent_ids or [])

        pairs: list[tuple[str, str | None]] = []
        for name in names:
            src_path: "Path | None" = None
            materialized = assets_dir / ".claude" / "agents" / f"{name}.md"
            if materialized.is_file():
                src_path = materialized
            else:
                try:
                    rec = _load_subagent(name, project_dir=self.workdir or None)
                except Exception:
                    rec = None
                rec_ref = getattr(rec, "asset_ref", None) if rec else None
                if rec_ref is not None and rec_ref._path.is_file():
                    src_path = rec_ref._path
            if src_path is None:
                pairs.append((f"{RecordType.SUBAGENT.value}-{name}", None))
                continue
            pairs.append((str(self._agent_entity_ref(src_path)), canonical_posix_path(src_path)))
        return pairs

    # ── Restart-required tracking ─────────────────────────────────────────────

    #: Worker-section snapshot fields that describe the ACTIVE TRANSPORT, not
    #: user launch config. PTY⇄CLI switches intentionally change them without
    #: requiring a restart (codex: interactive TUI runs without ``--json`` /
    #: ``--ephemeral``), so BOTH restart comparators — the ``_restart_snapshot``
    #: hash behind ``restart_required`` and the ``_diff_snapshot_fields`` diff
    #: behind ``restart-info`` — must ignore them, or a transport switch lights
    #: a phantom restart glow (QA issue R03). Kept beside the snapshot builders
    #: so a new transport-derived field is added here, not inside a comparator.
    TRANSPORT_DERIVED_WORKER_FIELDS: ClassVar[frozenset[str]] = frozenset({"ephemeral", "json_stream"})

    @classmethod
    def _comparable_restart_payload(cls, payload: dict[str, Any] | None) -> dict[str, Any]:
        """Normalize a ``{generic, worker}`` snapshot payload into the form the
        restart comparators agree on: values canonicalized via
        ``_normalize_restart_value`` and transport-derived worker fields
        stripped. Single choke point shared by the hash and the diff so they
        can never disagree about which fields count as launch config."""
        normalized = cls._normalize_restart_value(payload) or {}
        worker = normalized.get("worker")
        if isinstance(worker, dict):
            normalized["worker"] = {k: v for k, v in worker.items() if k not in cls.TRANSPORT_DERIVED_WORKER_FIELDS}
        return normalized

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
            return sorted(AgenticProcess._normalize_restart_value(item) for item in value)
        return value

    def _restart_driver(self) -> WorkerDriver | None:
        """Resolve the driver from the current worker_type value."""
        try:
            return get_driver(self.worker_type)
        except ValueError:
            return None

    def _finalized_restart_cli_options(self) -> AgentOptions:
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
        # Worker-aware — claude/codex have separate transcript stores, so a
        # codex restart must check codex sessions (not claude's), else a
        # recovered codex relaunches fresh and silently drops its context.
        if not getattr(cmd, "resume", False) and self.session_id:
            cmd.resume = self._is_exist_resume_session(self.session_id)

        return cmd

    def adopt_worker_session(self, session_id: str) -> bool:
        """Adopt the durable session identity a live worker reported.

        SINGLE OWNER of the restart-FSM bookkeeping for session rotation —
        every path that learns a new session id from a running worker (the
        headless turn stream in ``_run_turn``, the PTY transcript watcher in
        ``_persist_transcript_session_id``) routes through here instead of
        touching ``last_started_snapshot`` / ``last_started_hash`` itself.

        A legitimate rotation (first adoption on a fresh process, or the CLI
        minting a new id when resuming — ``claude -p --resume`` rotates the
        session id every resumed turn) must not light the restart glow: the
        running worker WAS launched from the current config, only its session
        identity moved. So the captured launch snapshot is re-pointed at the
        new id — and ONLY the session-derived fields are patched. Re-capturing
        the whole live payload here (the previous behavior) would silently
        bless any genuine config drift the user made mid-turn, clearing a
        ``restart_required`` that should stay on.

        ``restart_required`` itself is deliberately NOT written here: the
        ``save()`` hook is its single author and recomputes it from the
        patched hash on the very next save.

        Returns True when the id changed (callers persist), False on no-op.
        The mid-turn spurious-rotation guard (a misbehaving extractor flapping
        ids WITHIN one turn) lives at the turn scope — turn loops route
        through :meth:`make_turn_session_adopter`, which trusts only the
        turn-INITIAL report. This method itself assumes the rotation is
        legitimate.
        """
        if not session_id or session_id == self.session_id:
            return False
        if self.session_id:
            logger.warning(
                "adopt_worker_session: worker rotated session_id %s -> %s (process %s)",
                self.session_id,
                session_id,
                self.id,
            )
        self.session_id = session_id
        if self.last_started_snapshot:
            # Shallow per-section copies (deepcopy would choke on immutable
            # TypeId values inside the payload); only the section dicts we
            # patch are re-created, nested values stay shared.
            snapshot = dict(self.last_started_snapshot)
            generic = snapshot.get("generic")
            if isinstance(generic, dict):
                snapshot["generic"] = {**generic, "session_id": session_id}
            worker = snapshot.get("worker")
            # Driver CLI-option payloads always carry worker_type (and a
            # session_id that may have been None-pruned by DB serialization);
            # the driverless {"cli_config": ...} shape has neither and is
            # left untouched.
            if isinstance(worker, dict) and ("session_id" in worker or "worker_type" in worker):
                snapshot["worker"] = {**worker, "session_id": session_id}
            self.last_started_snapshot = snapshot
            self.last_started_hash = self._restart_snapshot(snapshot)
        else:
            # Never started via start_pty (pure headless process): the running
            # worker's launch config IS the current config, so first adoption
            # establishes the full baseline snapshot.
            snapshot = self._restart_snapshot_payload()
            self.last_started_snapshot = snapshot
            self.last_started_hash = self._restart_snapshot(snapshot)
        return True

    def make_turn_session_adopter(self, log_prefix: str) -> Callable[[str | None], Any]:
        """Turn-scoped wrapper around :meth:`adopt_worker_session`.

        Every turn loop (the HTTP ``prompt`` stream in ``_run_turn`` and each
        driver's ``headless_prompt``) calls the returned coroutine function
        once per streamed frame with ``worker.get_session_id()``. Only the
        turn-INITIAL session report is adopted: a CLI establishes its session
        identity once, at turn start (claude ``system:init``, codex
        ``thread.started``), so any LATER differing id within the same turn is
        a misbehaving extractor — it is logged once and ignored, never adopted
        (previously each driver hand-rolled this and claude/copilot adopted
        every flap, churning ``session_id`` and the restart snapshot on
        garbage)."""
        turn_session_id: str | None = None
        warned_spurious = False

        async def adopt(sid: str | None) -> None:
            nonlocal turn_session_id, warned_spurious
            if not sid:
                return
            if turn_session_id is None:
                turn_session_id = sid
                if self.adopt_worker_session(sid):
                    try:
                        await self.save()
                    except Exception:
                        logger.warning("%s: session_id save failed", log_prefix, exc_info=True)
            elif sid != turn_session_id and not warned_spurious:
                warned_spurious = True
                logger.warning(
                    "%s: ignoring spurious mid-turn session_id rotation %s -> %s (process %s)",
                    log_prefix,
                    turn_session_id,
                    sid,
                    self.id,
                )

        return adopt

    def _generic_restart_snapshot_payload(self, driver: WorkerDriver | None) -> dict[str, Any]:
        worker_type: Any = driver.name if driver is not None else self.worker_type
        hook_events = tuple(sorted(set(self.process_hook_events or [])))
        hook_snapshot = {}
        if driver is not None:
            snapshot = getattr(driver, "process_hook_snapshot", None)
            if snapshot is not None:
                hook_snapshot = snapshot(hook_events)
        return {
            "worker_type": worker_type,
            "shell_mode": self.shell_mode,
            "workdir": self.workdir,
            "session_id": self.session_id,
            "additional_dirs": sorted(self.additional_dirs or []),
            "embedded_asset_refs": sorted(str(r) for r in (self.embedded_asset_refs or [])),
            "embedded_subagent_ids": sorted(self.embedded_subagent_ids or []),
            "process_hook_events": list(hook_events),
            "process_hooks": hook_snapshot,
        }

    def _restart_snapshot_payload(self) -> dict[str, Any]:
        driver = self._restart_driver()
        if driver is None:
            return {
                "generic": self._generic_restart_snapshot_payload(driver),
                "worker": {"cli_config": self.cli_config or {}},
            }
        options = self._finalized_restart_cli_options()
        worker_snapshot = driver.restart_snapshot(self, options)
        # The canonical process-assets mount is a derived implementation path,
        # not persisted user launch intent. Hook semantics are represented by
        # generic.process_hooks; generated path presence/absence must not alter
        # restart identity.
        add_dirs = worker_snapshot.get("add_dirs")
        if isinstance(add_dirs, list):
            worker_snapshot = {
                **worker_snapshot,
                "add_dirs": [directory for directory in add_dirs if not self._is_process_assets_path(directory)],
            }
        return {
            "generic": self._generic_restart_snapshot_payload(driver),
            "worker": worker_snapshot,
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
        comparable = self._comparable_restart_payload(payload)
        return hashlib.md5(_json.dumps(comparable, sort_keys=True, default=str).encode()).hexdigest()

    def _set_start_lifecycle(self, value: bool) -> None:
        """Mark whether ``start_pty()`` is currently mutating this entity.

        While True the ``save()`` hook skips the auto-flag-flip so intermediate
        saves inside ``start_pty()`` (status, session_id) don't trip the detector.
        """
        object.__getattribute__(self, "__dict__")["_in_start_lifecycle"] = bool(value)

    def _is_in_start_lifecycle(self) -> bool:
        return bool(object.__getattribute__(self, "__dict__").get("_in_start_lifecycle", False))

    def _set_display_authoritative(self, value: bool) -> None:
        """Mark that THIS save carries ``on_show``'s freshly-computed display state.

        ``on_show`` is the sole authoritative writer of ``display_stack`` /
        ``last_shown`` (it unions + dedups against the freshest DB row). While
        this flag is True the ``save()`` guard trusts the in-memory display
        verbatim; every OTHER save mirrors the DB instead (see
        ``_preserve_latest_display_pin``).
        """
        object.__getattribute__(self, "__dict__")["_display_authoritative"] = bool(value)

    def _is_display_authoritative(self) -> bool:
        return bool(object.__getattribute__(self, "__dict__").get("_display_authoritative", False))

    async def _preserve_latest_display_pin(self) -> None:
        """Keep the display state (``context_data.display_stack`` + ``last_shown``)
        from being lost — or corrupted — by a stale whole-row save.

        ``on_show`` is the SOLE authoritative writer of the display state: it
        unions + dedups the new target against the freshest DB row, then saves
        with ``_display_authoritative`` set, and this guard trusts that save
        verbatim. EVERY OTHER save (status, session, transcript bookkeeping) must
        NOT write its own copy of the display: an object loaded before a later
        ``flow show`` still carries the pre-show stack in memory, and a naive
        whole-row save would write that stale value back and drop the newer show
        (the trailing-show clobber — a `flow show` with nothing after it never
        gets a repair pass). So a non-authoritative save MIRRORS the DB's current
        display, overwriting whatever it holds in memory. Costs one PK read per
        such save — cheaper than a lost show, and shows are rare vs saves."""
        if not getattr(self, "exist_in_db", False):
            return
        if self._is_display_authoritative():
            return
        current_context = self.context_data if isinstance(self.context_data, dict) else {}
        latest = await AgenticProcess.get_by_id(self.id)
        if latest is None or latest is self:
            return
        latest_context = latest.context_data if isinstance(latest.context_data, dict) else {}
        # Drop any stale in-memory display, then re-attach the DB's authoritative
        # copy — so this save can neither clobber a newer show nor resurrect an
        # entry ``on_show`` already deduped away.
        rebuilt = {k: v for k, v in current_context.items() if k not in ("display_stack", "last_shown")}
        for k in ("display_stack", "last_shown"):
            if k in latest_context:
                rebuilt[k] = latest_context[k]
        self.context_data = rebuilt

    async def save(self, owner=None, notify: bool = True):
        """Override to maintain ``restart_required`` automatically.

        On every save, if the process is RUNNING and the worker-relevant
        snapshot differs from ``last_started_hash``, flip the flag. Skipped
        during ``start_pty()`` itself (intermediate saves there are bookkeeping,
        not config drift) — see ``_set_start_lifecycle``.

        The flag tracks the snapshot-hash contract symmetrically: it flips ON
        when the live config drifts from ``last_started_hash`` and clears again
        when the config is reverted back to the running worker's hash (so a
        change-then-undo doesn't leave a phantom "restart needed" glow). A
        successful ``start_pty()`` also clears it by re-capturing the hash.
        """
        await self._preserve_latest_display_pin()
        if not self._is_in_start_lifecycle() and self.status == ProcessStatus.RUNNING.value and self.last_started_hash:
            self.restart_required = self._restart_snapshot() != self.last_started_hash
        return await super().save(owner=owner, notify=notify)

    @action.get(action_name="get-assets")
    async def get_assets_action(self) -> "ApiSuccessResponse":
        """HTTP wrapper around ``get_asset_descriptors``."""
        items = await self.get_asset_descriptors()
        return ApiSuccessResponse(data={"assets": [d.to_row() for d in items]})

    @action.get(action_name="get-history")
    async def get_history_action(self) -> "ApiSuccessResponse":
        """Return this process's transcript as a list of FlowData dicts.

        Driver-supplied. Stateless — works for processes that have exited
        (no live worker required). Empty result is a success with
        ``history=[]``, not a 404.
        """
        from flow_sdk.builtin.agentic_process.turn_abort import (  # noqa: PLC0415
            load_abort_marker_frames,
            merge_abort_markers,
        )

        history = self.driver.load_history(self)
        # Merge flowpad-authored durable abort markers (written by
        # ``cancel-prompt``) so a cancelled turn replays as terminated instead
        # of leaving its last tool call rendered as still running. Worker-
        # generic: the vendor transcript is vendor-owned and never contains
        # these; the sidecar in the process record dir does.
        history = merge_abort_markers(
            history,
            load_abort_marker_frames(self._record_dir(), session_id=self.session_id),
        )
        return ApiSuccessResponse(
            data={
                "session_id": self.session_id,
                "use_worker_history": True,
                "count": len(history),
                "history": [fd.model_dump(mode="python") for fd in history],
            }
        )

    @action.get(action_name="continuation-prompt")
    async def continuation_prompt_action(
        self,
    ) -> "ApiSuccessResponse | ApiFailResponse":
        """Return deterministic extractive context for a different worker."""
        from flow_sdk.transcript_analyzer import worker_continuation_prompt

        try:
            descriptor = self.driver.transcript_descriptor(self)
            if descriptor is None:
                return ApiFailResponse(
                    message="No readable transcript available for continuation",
                    status_code=404,
                )
            prompt = worker_continuation_prompt(
                descriptor.path,
                self.driver.name,
                self.driver.name.capitalize(),
                transcript_format=descriptor.format,
            )
            return ApiSuccessResponse(data={"prompt": prompt})
        except Exception:
            logger.debug(
                "AgenticProcess %s continuation prompt unavailable",
                self.id,
                exc_info=True,
            )
            return ApiFailResponse(
                message="No readable transcript available for continuation",
                status_code=404,
            )

    @staticmethod
    def _diff_snapshot_fields(
        loaded: dict[str, Any] | None,
        current: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Return per-field differences between two ``{generic, worker}`` payloads.

        Normalizes both sides through ``_comparable_restart_payload`` so
        equality matches the hash semantics in ``_restart_snapshot`` exactly —
        including the shared exclusion of transport-derived worker fields
        (``TRANSPORT_DERIVED_WORKER_FIELDS``). Keys present on only one side
        are reported with the missing side as None.
        """
        if not loaded:
            return []
        norm_loaded = AgenticProcess._comparable_restart_payload(loaded)
        norm_current = AgenticProcess._comparable_restart_payload(current)
        changes: list[dict[str, Any]] = []
        for section in ("generic", "worker"):
            l_section = norm_loaded.get(section) or {}
            c_section = norm_current.get(section) or {}
            for field_name in sorted(set(l_section) | set(c_section)):
                l_val = l_section.get(field_name)
                c_val = c_section.get(field_name)
                if l_val != c_val:
                    changes.append(
                        {
                            "section": section,
                            "field": field_name,
                            "loaded": l_val,
                            "current": c_val,
                        }
                    )
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

    @action.get(action_name="cmd-line")
    async def cmd_line_action(self) -> "ApiSuccessResponse":
        """Live launch command for this process, computed on demand.

        Deliberately an explicit per-process read, NOT a serialized field:
        resolving ``cmd_line`` walks cli_options -> transcript_descriptor ->
        get_claude_session (disk I/O), which must never run inside model_dump().
        The UI fetches this only for the one process whose run drawer / session
        info popover is open. Failure-tolerant: returns ``cmd_line: None`` if a
        driver isn't wired or the cli_config is malformed.
        """
        try:
            return ApiSuccessResponse(data={"cmd_line": self.cmd_line})
        except Exception:
            return ApiSuccessResponse(data={"cmd_line": None})

    @cached_property
    def driver(self) -> WorkerDriver:
        """The vendor-specific driver for this process's ``worker_type``.

        Resolved via ``get_driver(worker_type)`` — defaults to the value of
        ``FLOWPAD_DEFAULT_WORKER`` (``claude`` if unset) when ``worker_type``
        is ``None``. Cached on the entity instance so we don't re-import
        the driver module on every property access.
        """
        return get_driver(self.worker_type)

    async def delete(self):
        """Tombstone the on-disk session transcript, then delete the entity.

        The AgenticProcess DB row is only an index. Both on-disk read paths —
        ``worker_history``'s Claude/Codex/Copilot collectors (the Chats
        side-menu) and ``scan_actions._resolve_session_record`` behind
        ``getByWorkerId`` (``terminals/get_by_worker_id``) — re-derive a session
        straight from its ``<session_id>.jsonl`` on disk. Deleting only the
        entity leaves that file, so a "deleted" chat re-appears in the list and
        stays resolvable by its worker session id (effectively undeletable).

        Renaming the transcript to ``<name>.deleted`` tombstones it: the
        ``*.jsonl`` discovery globs and the exact-``<sid>.jsonl`` resolver both
        skip it, while the data stays recoverable (no destructive unlink).
        Best-effort — a tombstone failure never blocks the entity delete.
        """
        self._tombstone_session_transcript()
        result = await super().delete()
        clear_process_hook_callbacks(str(self.id))
        # The dedup key outlives the instance by design (module-level, keyed by
        # process id), so the row has to be dropped explicitly here or it leaks
        # for the lifetime of the server — and a recycled id would start out
        # deduping against a dead process's last broadcast.
        self._last_broadcast_key = None
        return result

    def _tombstone_session_transcript(self) -> None:
        """Rename this process's on-disk transcript to ``<name>.deleted`` so the
        on-disk read paths stop re-deriving the deleted session. No-op when there
        is no session id or no transcript on disk."""
        if not self.session_id:
            return
        try:
            path = self.driver.transcript_path(self)
        except Exception as e:
            logger.debug("tombstone: transcript_path lookup failed for %s: %s", self.session_id, e)
            return
        if path is None or not path.exists():
            return
        tomb = path.with_name(path.name + ".deleted")
        try:
            if tomb.exists():
                tomb.unlink()
            path.rename(tomb)
            logger.info("tombstoned deleted session transcript %s -> %s", path.name, tomb.name)
        except OSError as e:
            logger.warning("tombstone of %s failed: %s", path, e)

    def _supports_plan_mode(self) -> bool:
        """Driver capability flag surfaced on the entity for the chat plan
        toggle. Defensive: a driver predating the capability resolves False
        rather than 500-ing the serializer."""
        try:
            fn = getattr(self.driver, "supports_plan_mode", None)
            return bool(fn(self)) if fn else False
        except Exception:
            return False

    @property
    def cli_options(self) -> "AgentOptions":
        """Deserialize cli_config into a live ``AgentOptions`` via the driver.

        The concrete class depends on ``self.worker_type`` (claude/codex/copilot),
        but callers only use the shared ``AgentOptions`` base contract
        (``workdir``, ``env_vars``, ``add_dirs``, ``fork_session_id``,
        ``cli_cmd``/``to_shell_string``) — no vendor type leaks out.
        """
        return get_driver(self.worker_type).cli_options(self)

    @property
    def agent_options(self) -> "AgentOptions":
        """The launch bundle for this process — prompt, model, skills, dirs,
        permissions. Preferred spelling; ``cli_options`` stays as the alias the
        driver layer is named after."""
        return self.cli_options

    @property
    def cmd_line(self) -> str:
        """Return the full CLI command string that would be used to launch this process."""
        return self.cli_options.to_shell_string()

    @model_serializer(mode="wrap")
    def api_json_serializer(self, nxt, info: SerializationInfo):
        data = super().api_json_serializer(nxt, info)
        if info.context and info.context.get("skip_api_serializer"):
            return data
        if data is None:
            return None
        # Emit all three status axes fresh (nothing here is persisted — the
        # skip_api_serializer path took the early-return above). See
        # docs/agent/agentic_process_statuses.md for the model.
        computed = self.fetch_worker_status()
        data["worker_status"] = str(computed) if computed else None
        # The CLI's own sentence behind a bare ERROR ("Not logged in · Please
        # run /login"). Only resolved for the error status — it costs a second
        # tail read, and there is nothing to say for any other state.
        data["worker_status_detail"] = self._worker_status_detail(computed)
        data["status"] = self.status
        busy = is_turn_busy(self, computed)
        data["busy"] = busy
        data["ready_for_input"] = is_ready_from_busy(
            self.status, busy, pty_mode=self.pty_mode, session_id=self.session_id
        )
        data["queue"] = self._queue_state()
        data["supports_plan_mode"] = self._supports_plan_mode()
        data["additional_dirs"] = [
            path for path in (data.get("additional_dirs") or []) if not self._is_process_assets_path(path)
        ]
        # NOTE: cmd_line is intentionally NOT computed here. Resolving it walks
        # cli_options -> transcript_descriptor -> get_claude_session, i.e. live
        # worker work with disk I/O — which must never run inside a model_dump()
        # (the universal currency for persistence, query-filter, WS broadcast and
        # REST response). The launch command is fetched explicitly, per-process,
        # via the "cmd-line" action below, only when the UI actually needs it.
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
                        folder_ref = FSRef(p).to_dict()
                        # The path may be intentionally unmaterialized. These
                        # four projections are directories by contract, so do
                        # not let filesystem existence mislabel them as files.
                        folder_ref["ref_type"] = "folder"
                        data[attr] = folder_ref
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
        if self.status == ProcessStatus.NEW.value:
            return None
        if self.status == ProcessStatus.STOPPED.value:
            discovered = self._discover_status_from_transcript()
            return discovered if discovered and is_worker_terminal(discovered) else None
        if self.status == ProcessStatus.FAILED.value:
            return WorkerStatus.ERROR
        return self._discover_status_from_transcript()

    def _worker_status_detail(self, worker_status: "WorkerStatus | None") -> str | None:
        """The CLI's own error sentence, when the worker status is ERROR.

        Best-effort and never raising: a missing transcript, an unreadable file
        or a driver without a detail hook all yield ``None``, and the surface
        falls back to the plain status label.
        """
        if worker_status != WorkerStatus.ERROR:
            return None
        try:
            from flow_sdk.builtin.worker_status import tail_status_detail

            path = self.driver.transcript_path(self)
            return tail_status_detail(path) if path else None
        except Exception:
            logger.debug("worker_status_detail lookup failed", exc_info=True)
            return None

    def _discover_status_from_transcript(self) -> WorkerStatus | None:
        """Derive the RAW worker status from the worker's transcript via the driver.

        "What we found" — the raw vendor state, in worker lingo, with NO logical
        projection. The logical process status (``ready``/``busy``) and the dead-PTY
        / aged-terminal meanings are derived elsewhere: ``status_predicates`` for
        busy/ready, the OS-liveness axis (``pty_recovery`` + ``_on_pty_exit``) for
        dead PTYs. This method must never synthesize a status the transcript didn't
        show.

        Internal — do NOT call directly from outside this class; use
        :meth:`fetch_worker_status`. (Tests monkeypatch THIS method as the single
        implementation point; the public accessor delegates here.)

        The one reconciliation kept is ``_post_tool_idle_complete``: when
        ``stream_transcript`` exited via the post-tool-idle settle (the worker
        finished its tool work but hasn't written its terminal marker yet), the
        transcript *will* show COMPLETE — this just agrees with the early settle
        rather than briefly reporting a stale WORKING. It is transcript-consistency,
        not a projection.

        Returns ``None`` when there is no transcript to read (nothing found); the
        busy predicate keys on the prompt lock / ``_turn_in_flight`` for the
        spin-up gap, so a null worker status does not mask an in-flight turn.
        """
        if getattr(self, "_post_tool_idle_complete", False):
            return WorkerStatus.COMPLETE
        path = self.driver.transcript_path(self)
        if path is None:
            # No transcript on disk yet. Report the raw boot state (INITIALIZING)
            # only while the lifecycle is STARTING; a RUNNING worker with no
            # transcript is spawned-and-idle (nothing found → None, which the
            # serializer surfaces as a null worker_status and the wire status
            # resolves to ``ready`` unless a turn is in flight).
            if not (self.session_id or self.shell_id):
                return None
            if self.status == ProcessStatus.STARTING.value:
                return WorkerStatus.INITIALIZING
            return None
        return self.driver.tail_status(path)

    @action.all(action_name="status")
    async def get_status(self):
        """Return the status axes: lifecycle ``status`` (FSM, verbatim), the
        derived ``busy`` boolean (turn-in-flight), raw ``worker_status``
        (nullable), and the derived ``ready_for_input``. Same derivation the
        serializer applies, so an on-demand poll and a broadcast can never
        disagree."""
        worker_status = self.fetch_worker_status()
        busy = is_turn_busy(self, worker_status)
        return ApiSuccessResponse(
            data={
                "status": self.status,
                "busy": busy,
                "worker_status": str(worker_status) if worker_status else None,
                "ready_for_input": is_ready_from_busy(
                    self.status, busy, pty_mode=self.pty_mode, session_id=self.session_id
                ),
            }
        )

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

    async def _resolve_dev_host(self, port: int) -> str:
        """Resolve the compute-node host URL for a dev-server ``port`` (shared by
        get-host). Raises ``ValueError`` with a client-safe message on a bad
        port or missing compute node."""
        int_port = int(port)
        if not 1024 <= int_port <= 65535:
            raise ValueError("Invalid port")
        compute_node = await self.get_compute_node()
        if compute_node is None:
            compute_node = await self._get_local_compute_node()
        if not compute_node:
            raise ValueError("No compute node found")
        return compute_node.get_host(int_port)

    async def _resolve_browser_dev_host(self, port: int) -> str:
        """The url a BROWSER should load for a dev-server ``port``.

        Differs from :meth:`_resolve_dev_host` in exactly one case: when THIS
        app is itself running inside a sandbox. The provider answers for the
        machine the app runs on, and a local node answers ``localhost`` -- right
        on a desktop, where the viewer sits at that machine, and wrong in a cloud
        box, where ``localhost`` is the viewer's own laptop and nothing is
        listening on it.

        Only a loopback answer is rewritten. A genuinely remote compute node
        already returns a routable host and a box has no business second-guessing
        it.

        Deliberately NOT pushed into ``LocalComputeProvider.get_host``:
        ``probe-webapp`` and the MCP client reach the same port from INSIDE the
        box, where loopback is correct and free. This is the browser's question;
        theirs is a different one with a different answer.
        """
        host = await self._resolve_dev_host(port)
        sandbox_id = own_sandbox_id()
        if not sandbox_id:
            return host
        if (urlparse(host).hostname or "").lower() not in LOOPBACK_HOSTNAMES:
            return host
        return sandbox_public_url(int(port), sandbox_id)

    @action.all(action_name="get-host")
    async def get_host(self, port: int, redirect: bool = True):
        """Resolve the public host for a dev-server ``port`` running on this
        process's compute node (e.g. the web-app-builder dev server). Mirrors the
        legacy Flow ``get-host`` so the in-app web preview / Vibe display can load
        the running app via the backend (works for @local and remote compute).
        """
        from fastapi.responses import RedirectResponse

        try:
            host = await self._resolve_browser_dev_host(port)
        except ValueError as e:
            return ApiFailResponse(message=f"get-host: {e}")

        if not redirect:
            return ApiSuccessResponse(data={"url": host, "port": int(port)})
        return RedirectResponse(url=host)

    @action.post(action_name="probe-webapp")
    async def probe_webapp_action(self, port: int):
        """Diagnose the dev server behind ``port`` and report what is wrong.

        The counterpart to get-host: get-host redirects the display's iframe at
        the app without ever checking it is there, so a dead port renders as a
        blank pane. This answers the question the browser cannot -- the guest is
        cross-origin, so the frontend can observe only "the fetch threw" and
        never *why*. Always returns a result; a probe that failed says so in
        ``probe_error`` rather than failing the request.
        """
        from flow_sdk.builtin.agentic_process.webapp_probe import probe_webapp

        try:
            host = await self._resolve_dev_host(port)
        except ValueError as e:
            return ApiFailResponse(message=f"probe-webapp: {e}")

        return ApiSuccessResponse(data=await probe_webapp(host, int(port)))

    async def set_session_id(self, session_id: str) -> None:
        """Bind this process to an existing Claude session before start_pty()."""
        self.session_id = session_id
        await self.save()
        # Binding an EXISTING session (resume/adopt) means its subject is already
        # on disk — stamp the history-style default name immediately so the row
        # reads right before the worker even starts. Non-pinning, best-effort.
        try:
            await self.stamp_default_name()
        except Exception:
            logger.debug("AgenticProcess %s: default-name stamp on bind failed", self.id, exc_info=True)

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

        ``additional_dirs`` plus the owning project's ``include_dirs`` (context
        folders) plus the Flowpad Assistant project root prepended when
        :attr:`assistant_enabled` (all de-duped so a dir listed twice doesn't
        double). Both the PTY and print-mode driver paths read this so they
        mount the same surface.

        The project's context folders are read from the ``_project_context_dirs``
        cache stamped by :meth:`get_project` (this property is sync and cannot
        await a project fetch). Launch paths call ``get_project`` first, so the
        cache is fresh as of launch.
        """
        additional = [d for d in (self.additional_dirs or []) if not self._is_process_assets_path(d)]
        context = [d for d in (self.__dict__.get("_project_context_dirs") or []) if d not in additional]
        dirs = additional + context
        assets_path = self._process_assets_path()
        hook_assets_active = bool(self.process_hook_events and getattr(self.driver, "process_hooks_use_assets", False))
        process_assets_active = bool(
            hook_assets_active
            or self.embedded_asset_refs
            or self.embedded_subagent_ids
            or self.get_agents_json()
            or self.instructions
            or self.instruction_content
        )
        if process_assets_active:
            assets_str = str(assets_path)
            if assets_str not in dirs:
                dirs.append(assets_str)
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

    # ── ContextProcess: bind a captured GraphContext to this process ──────────

    @staticmethod
    def _render_context_summary(resolved: "list[Entity]") -> str:
        """Render resolved context entities into the system-prompt block.

        Pure (no DB) so it's trivially unit-testable. Inlines each entity's id
        (``<type>-<id>``) AND its content (a message's ``text``, else ``name``)
        so the worker is told both what it is working on and how to reference it
        — without having to go fetch anything.
        """
        lines = []
        for e in resolved:
            if e is None:
                continue
            etype = str(getattr(e, "type", "") or "")
            label = etype.replace("_", " ").title()
            tid = f"{etype}-{getattr(e, 'id', '')}"
            content = getattr(e, "text", None) or getattr(e, "name", None) or getattr(e, "id", "")
            lines.append(f"- {label} [{tid}]: {content}")
        return "At creation time, the context entities are:\n" + "\n".join(lines) if lines else ""

    def set_graph_context(self, ctx: "Entity") -> "AgenticProcess":
        """Bind a captured ``GraphContext`` to this process BEFORE launch.

        See ``contextProcess.md`` §2.2. Records the GraphContext id and mirrors
        its typeids onto the queryable ``shared_context_entities`` (so the
        processes-in-context grid works with no new index). The context entities
        are resolved + rendered lazily by :meth:`resolve_context_summary` (at
        launch), so the bound entities can be saved after this call.

        Pre-launch only: once ``session_id`` exists the binding is frozen, so
        re-binding is a programming error — this raises rather than re-stamping.
        Returns ``self`` for chaining; the caller persists via ``save()``.
        """
        if self.session_id:
            raise RuntimeError(
                "set_graph_context must be called before launch; this process "
                f"already has session_id={self.session_id!r} (context is frozen)."
            )
        self.context_data = {**(self.context_data or {}), "graph_context_id": ctx.id}
        for raw in getattr(ctx, "context_typeids", None) or []:
            try:
                self.add_shared_context_entities(TypeId(str(raw)))
            except Exception:  # noqa: BLE001 — skip malformed entries, never block the bind
                continue
        return self

    async def resolve_system_instructions(self) -> str | None:
        """The worker's full system-prompt append.

        Merges the caller's standing directions (``context_data.instructions``,
        set at create time by the SDK) with the bound-context summary
        (:meth:`resolve_context_summary`). Either part may be empty; ``None``
        when both are. This is the single source both turn paths (headless
        driver + inline print-mode) must use — passing only the context
        summary silently drops caller instructions.
        """
        explicit = str((self.context_data or {}).get("instructions") or "").strip()
        summary = (await self.resolve_context_summary()) or ""
        return "\n\n".join(p for p in (explicit, summary) if p) or None

    async def resolve_context_summary(self) -> str:
        """The bound context as a system-prompt block — resolved at launch.

        Loads the bound ``GraphContext``, fetches each context entity, and renders
        them via :meth:`_render_context_summary`. ``""`` when no context is bound.

        Cached in ``context_data['context_summary']`` after the first resolve: the
        binding is frozen (``set_graph_context`` raises once a session exists), so
        the block is invariant for the process's life and needn't re-hit the DB
        (1 + N entity loads) on every headless turn.
        """
        data = self.context_data or {}
        gc_id = data.get("graph_context_id")
        if not gc_id:
            return ""
        cached = data.get("context_summary")
        if cached is not None:
            return cached
        from flow_sdk.builtin.graph_context import GraphContext  # noqa: PLC0415
        from flow_sdk.core.entity.entity_model import Entity as _Entity  # noqa: PLC0415

        gc = await GraphContext.get_one({"id": gc_id})
        if gc is None:
            return ""

        async def _load(raw) -> "Entity | None":
            try:
                return await _Entity.get_by_typeid(TypeId(str(raw)))
            except Exception:  # noqa: BLE001 — a missing entity just drops from the summary
                return None

        # Concurrent loads — this runs on the launch path (PTY open + headless
        # turn), where N serial round-trips would add directly to spawn latency.
        loaded = await asyncio.gather(*(_load(raw) for raw in (gc.context_typeids or [])))
        resolved = [ent for ent in loaded if ent is not None]
        summary = self._render_context_summary(resolved)
        self.context_data = {**data, "context_summary": summary}
        return summary

    @action.post(action_name="set-graph-context")
    async def set_graph_context_action(self, graph_context_id: str) -> "ApiResponse":
        """HTTP face of :meth:`set_graph_context`. Pre-launch only."""
        from flow_sdk.builtin.graph_context import GraphContext  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

        gc = await GraphContext.get_one({"id": graph_context_id})
        if gc is None:
            return ApiFailResponse(message=f"GraphContext not found: {graph_context_id}", status_code=404)
        self.set_graph_context(gc)
        await self.save()
        return ApiSuccessResponse(data={"id": self.id, "graph_context_id": gc.id})

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

        Visible processes: worker is left alive (API may recover); a warning is
        logged here and in the browser console.
        """
        if self.visible:
            return
        shell = await self.shell()
        if shell:
            await shell.terminate_worker()

    # ── Close ─────────────────────────────────────────────────────────────────

    # ── Tab integration (docs/tab-management.md) ──────────────────────────────
    async def teardown_for_tab(self) -> None:
        """``Tab.close`` dispatch hook: closing a process tab tears down the
        worker + linked shell (today's terminal-close semantics)."""
        await self.close()

    async def rename(self, name: str) -> None:
        """Tab-rename reflection (``Tab.rename`` → ``target.rename``): mirror the
        new name and pin it (``auto_rename=False``) so the worker title can't
        overwrite it. Extends the generic ``Entity.rename`` with that pin."""
        if name and self.name != name:
            self.name = name
            self.auto_rename = False
            await self.save()

    async def _mirror_name_to_tabs(self, name: str) -> bool:
        """Reflect ``name`` onto any open Tab for this process via ``set_label`` —
        NOT ``rename`` (set_label sets only ``Tab.name`` and never touches the
        target's ``auto_rename``). The terminal chip renders ``Tab.name`` (not the
        live entity), and the generic entity→tab sync deliberately skips terminal
        types, so without this a stamped/renamed process name never reaches the
        chip. Best-effort — a headless worker may have no open tab. Cross-project
        unscoped (the tab can live in another project than the caller's scope).
        Returns True iff a tab label changed."""
        from flow_sdk.builtin.tab import _tabs_for_target  # noqa: PLC0415

        changed = False
        for tab in await _tabs_for_target(self.type, str(self.id)):
            if tab.name != name:
                await tab.set_label(name)
                changed = True
        return changed

    async def stamp_default_name(self) -> bool:
        """Give a nameless process the SAME display title the Recent-sessions
        history list shows — the session subject (Claude ``custom_title``/``slug``,
        i.e. the auto-summary of the opening prompt) — and persist it, so every
        surface (tab chip, footer process list, sidebar) reads a real name instead
        of the ``agentic_process-<id>`` synthetic the FE would otherwise fabricate.

        Unlike :meth:`rename`, this is a STAMP, not a user rename: it leaves
        ``auto_rename`` untouched (stays True) so a later real OSC/LLM title can
        still replace it. Idempotent, first-writer-wins — a no-op once the process
        carries any name, when the user already pinned it (``auto_rename=False``),
        or before a session/subject exists (``get_worker_session_name`` returns
        ``None`` until the transcript has a title). On a write it broadcasts the
        entity and mirrors the tab itself, so callers just fire-and-forget it
        from their turn-end seams. Returns True iff it wrote a name.
        """
        if (self.name or "").strip():
            return False
        if self.auto_rename is False:
            return False
        if not self.session_id:
            return False
        from flow_sdk.builtin.worker_history import (  # noqa: PLC0415
            WorkerType,
            _normalize_worker_type,
            get_worker_session_name,
        )

        # Only Claude carries an on-file subject (and the first-prompt fallback);
        # a Codex/Copilot process titles only through its own name, which the
        # guard above just proved empty — nothing can resolve, so don't pay the
        # per-flush resolver (a DB lookup) for it.
        if _normalize_worker_type(self.worker_type) is not WorkerType.CLAUDE:
            return False
        try:
            # prompt_fallback: see get_worker_session_name — headless sessions
            # have no on-file title, so the first user prompt is the last rung.
            candidate = await get_worker_session_name(
                self.worker_type, self.session_id, jsonl_path=self.transcript_path, prompt_fallback=True
            )
        except Exception:
            logger.debug("AgenticProcess %s: default-name resolve failed", self.id, exc_info=True)
            return False
        candidate = (candidate or "").strip()
        if not candidate:
            return False

        # Turn-end/flush callbacks can outlive ``close`` on another hydrated
        # instance of this same process. A normal ``save`` is intentionally an
        # upsert, so that stale callback could recreate a row that close +
        # delete just removed. Re-read the authoritative row, then atomically
        # compare-and-set only its still-empty name. The DB primitive never
        # inserts and never rewrites lifecycle fields from this stale snapshot.
        current = await AgenticProcess.get_by_id(str(self.id))
        if current is None or (current.name or "").strip() or current.auto_rename is False:
            return False
        persisted, stamped = await self._db.compare_and_set_data_field(
            str(self.id),
            self.type,
            "name",
            current.name,
            candidate,
        )
        if not stamped or persisted is None:
            return False
        self.name = candidate

        # Close/delete may win immediately after the atomic stamp. Never mirror
        # or broadcast this stale object; use the latest durable row, and do
        # nothing further when it is already gone or a user rename won next.
        durable = await AgenticProcess.get_by_id(str(self.id))
        if durable is None or durable.name != candidate:
            return True
        # Mirror onto the chip: the terminal tab renders Tab.name, and nothing else
        # reflects a terminal entity's name change onto it — so heal it here (also
        # overwrites a legacy frozen `<type>-<id>` Tab.name). set_label keeps
        # auto_rename intact.
        if await durable._mirror_name_to_tabs(candidate):
            from flow_sdk.builtin.tab import broadcast_tabs_changed  # noqa: PLC0415

            await broadcast_tabs_changed()
        # Broadcast the entity itself so live name consumers (footer list, chat
        # header) refresh — owned here so every stamp seam gets it for free.
        try:
            await durable.notify_updated()
        except Exception:
            logger.debug("AgenticProcess %s: stamp notify failed", self.id, exc_info=True)
        logger.info("AgenticProcess %s: stamped default name %r", self.id, candidate[:80])
        return True

    async def close(self) -> bool:
        """Terminate this process and close its linked shell entity.

        The Shell row is deleted by ``shell.close()``, but ``shell_id`` stays
        reserved on the process so a future open reuses the same process-owned
        tab identity instead of allocating a second shell from a stale opener.

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

            self.sidecar_shell_id = None
            self.status = ProcessStatus.STOPPED.value
            await self.save()

            # Soft-close this process's terminal Tab(s). close() is a full
            # teardown but does NOT delete the AgenticProcess row (it persists
            # as ``stopped``), so the generic delete → orphan-Tab cleanup in
            # Entity.delete never fires and the chip would linger. Hide the Tab
            # directly (membership-only — teardown is already happening here).
            try:
                from flow_sdk.builtin.tab import hide_tabs_for_target

                await hide_tabs_for_target(self.type, str(self.id))
            except Exception as tab_exc:
                logger.warning(f"AgenticProcess {self.id}: tab hide on close failed: {tab_exc}")
            return True

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} close error: {e}")
            self.status = ProcessStatus.FAILED.value
            await self.save()
            return False

        finally:
            # Drop the process-scoped broadcast dedup key: it lives in a
            # module-level dict, so nothing else releases it when the process
            # goes down. Clearing on BOTH exits (closed / failed-to-close) also
            # means a later re-open starts with no history and broadcasts its
            # first key instead of silently deduping against the pre-close one.
            self._last_broadcast_key = None

    # ── HTTP actions ──────────────────────────────────────────────────────────

    @action.post(action_name="open")
    async def _http_open(self) -> ApiSuccessResponse | ApiFailResponse:
        """HTTP: invoke :meth:`start_pty` and move lifecycle status to starting/running.

        Action name kept as ``open`` for back-compat with existing UI / TS SDK
        clients; the underlying behaviour is PTY spawn (``start_pty``).

        POST body: {instruction?, visible?, session_id?, retry?, theme?}

        ``retry: true`` is the explicit user-retry signal — it clears the
        ``start_failure`` latch so a failed-to-start process relaunches.
        """
        request_info = get_current_request_info()
        # Capture the WebSocket connection ID so the worker can target this tab explicitly
        if request_info and request_info.request_connection_id:
            self.connection_id = request_info.request_connection_id
        body = await request_info.get_post_data() if request_info else {}
        # Palette of the terminal the client is rendering this worker into.
        # Anything other than the two known values leaves the previous value
        # in place rather than un-pinning the worker's theme.
        theme = body.get("theme")
        if theme not in ("light", "dark"):
            theme = None
        instruction = body.get("instruction")
        visible = body.get("visible")
        retry = bool(body.get("retry"))
        # Support legacy worker_session_id in POST body for older clients
        session_id_override = body.get("session_id") or body.get("worker_session_id")
        return await self.start_pty(
            instruction=instruction,
            visible=visible,
            retry=retry,
            session_id_override=session_id_override,
            terminal_theme=theme,
        )

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

        Keeps ``shell_id`` on the AgenticProcess as the reserved tab identity.

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

        # Before the @local catch-all, derive the project from this process's
        # own workdir (received/recovered processes have a cwd but no DB
        # ancestry). Reuses the same cwd→Project primitive as the indexer stamp
        # and recover_project_action, so a worker binds the real project that
        # owns its directory instead of falling through to @local.
        if not self.project_id and self.workdir:
            project = await Project.recover_by_path(self.workdir)
            if project:
                self._bind_project_id(project.id)

        # Fall back to @local project when no ancestor project is found
        if not self.project_id:
            local_project = await Project.get_by_uname("local")
            if not local_project:
                raise RuntimeError("No project found for agentic process and no @local project available")
            self._bind_project_id(local_project.id)

        # Single fetch of the owning project: derive workdir (when unset) and
        # cache its context folders (``include_dirs``) so the sync
        # ``resolved_add_dirs`` can fold them into the worker's --add-dir set
        # without an async fetch. Refreshed every call, so later edits to
        # ``project.include_dirs`` take effect on the next launch.
        context_dirs: list[str] = []
        if self.project_id:
            project = await Project.get_by_id(self.project_id)
            if project:
                if not self.workdir and project.fs_storage_mount_path:
                    self.workdir = str(project.fs_storage_mount_path)
                context_dirs = list(getattr(project, "include_dirs", []) or [])
        object.__setattr__(self, "_project_context_dirs", context_dirs)

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

    def _is_exist_resume_session(self, session_id: str | None) -> bool:
        """Worker-aware resumable-session check.

        Each vendor keeps its own transcript store, so the existence probe must
        match the worker — using claude's probe for a codex process is why a
        recovered codex used to relaunch fresh and lose its conversation. The
        per-vendor lookup lives on the driver (``has_resumable_session``) so
        this stays a single call with no ``if worker_type ==`` ladder.
        """
        if not session_id:
            return False
        try:
            return self.driver.has_resumable_session(self)
        except Exception:
            return False

    def _is_exist_claude_resume_session(self, session_id: str | None) -> bool:
        """Check if there's a resumable Claude session for this agentic process."""
        return self._discover_claude_record_session(session_id) is not None

    def _discover_claude_record_session(self, session_id: str | None) -> "FSRecord | None":
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
                self.id,
                overflow,
            )

        task = getattr(self, "_debounce_task", None)
        if task is None or task.done():
            object.__setattr__(
                self,
                "_debounce_task",
                asyncio.create_task(
                    self._flush_transcript_change(),
                    name=f"ap-flush-{self.id[:8]}",
                ),
            )

    async def _process_transcript_entries(self, entries: list) -> None:
        """Per-flush entry side effects: live reindex + plan/file events.

        Extracted from :meth:`_flush_transcript_change` so unit tests can drive
        the loop without manipulating the AP's lifecycle ``status`` field.
        Every FileWriteEntry/FileEditEntry path is deduplicated and scheduled
        for reindex immediately at this transcript flush. FileEditEntry maps to
        ``file.write`` (semantically: contents changed). ``file.write`` is
        emitted for every file type so open raw/binary-backed viewers can
        invalidate immediately; markdown cross-links, ``file.read``, and docs
        tracking remain markdown-only.
        """
        from flow_sdk.core.entity.cross_link import cross_link_entities
        from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
        from flow_sdk.transcript_analyzer.entries.file_edit import FileEditEntry
        from flow_sdk.transcript_analyzer.entries.file_read import FileReadEntry
        from flow_sdk.transcript_analyzer.entries.file_write import FileWriteEntry

        # Dedup cross-link calls per (path) within one flush — Claude/Codex
        # often write+read the same .md file multiple times in a turn, and the
        # helper hits the DB once per call (5 markdown-subclass lookups each).
        cross_linked: set[str] = set()
        touched: list[str] = []
        touched_set: set[str] = set()
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

            if isinstance(entry, (FileWriteEntry, FileEditEntry)):
                path = getattr(entry, "path", None)
                if path and path not in touched_set:
                    touched_set.add(path)
                    touched.append(path)

            if isinstance(entry, (FileReadEntry, FileWriteEntry, FileEditEntry)):
                path = getattr(entry, "path", None)
                if not path:
                    continue
                is_markdown = path.endswith(".md")
                if isinstance(entry, FileReadEntry) and not is_markdown:
                    continue
                # Cross-link save before the file.{op} broadcast — WS messages
                # are delivered in send order, so a consumer subscribed to both
                # sees the cross-link applied before acting on file.{op}.
                if is_markdown and path not in cross_linked:
                    md = await Entity.get_by_asset_ref(path)
                    if md is not None:
                        await cross_link_entities(md, self, b_data={"path": path})
                    cross_linked.add(path)
                op = "read" if isinstance(entry, FileReadEntry) else "write"
                await self.emit_entity_event(
                    f"file.{op}",
                    {"path": path, "tool_name": getattr(entry, "tool_name", "")},
                )

                # Docs chip: a user-facing markdown write produces a
                # markdown.create (Write) / markdown.update (Edit) event and is
                # tracked on the persisted ``markdown_docs`` list (parallel to
                # ``plan_path`` + ``plan.create``). Plan files and agent-internal
                # docs are excluded so they don't double up with the Open-Plan chip.
                if is_markdown and isinstance(entry, (FileWriteEntry, FileEditEntry)) and self._is_user_doc(path):
                    change = "create" if isinstance(entry, FileWriteEntry) else "update"
                    await self._track_markdown_doc(path, change)

        # This helper is the existing per-debounce-flush seam, so scheduling
        # here refreshes indexed assets while a turn is still running. The
        # transcript-tail collector below remains the transport-wide turn-end
        # fallback (including headless turns that do not populate this buffer).
        self._schedule_reindex_paths(touched, "flush")

    def _schedule_reindex_paths(self, paths: "Iterable[str]", source: str) -> None:
        """Fire-and-forget one deduplicated reindex batch.

        Shared by live transcript flushes and the transport-wide turn-end
        fallback so reindex ownership does not split into parallel paths.
        """
        unique = list(dict.fromkeys(path for path in paths if path))
        if not unique:
            return
        asyncio.create_task(
            self._reindex_touched(unique),
            name=f"ap-reindex-{source}-{self.id[:8]}",
        )

    def _schedule_turn_end_reindex(self, source: str) -> None:
        """Push-reindex the files this turn wrote/edited (fire-and-forget).

        Single seam called from every turn-end path — the PTY streamer flush,
        the driver headless tail (``end_headless_turn``), and the streaming
        ``_http_prompt`` turn. Sources the touched set from the watermarked
        transcript tail so it's transport-agnostic and each turn only reindexes
        its own new file-ops. Their entities re-parse + broadcast a
        ``data_op_msg`` (updated_date bump → frontend body re-read)."""
        try:
            touched = self._collect_touched_from_transcript_tail()
            self._schedule_reindex_paths(touched, f"turn-end-{source}")
        except Exception:
            logger.debug("AP %s: turn-end reindex schedule failed [%s]", self.id, source, exc_info=True)

    async def _reindex_touched(self, paths: list[str]) -> None:
        """Force-reindex the turn's touched files (fire-and-forget, off the turn
        path). Each resolves to its owning entity, re-parses from disk, and
        broadcasts a ``data_op_msg`` so watching clients refresh."""
        try:
            from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415

            result = await reindex_paths(paths)
            logger.debug(
                "AP %s write reindex: %s (in=%d)",
                self.id,
                result.as_dict()["counts"],
                len(paths),
            )
        except Exception:
            logger.debug("AgenticProcess %s: reindex_touched failed", self.id, exc_info=True)

    def _collect_touched_from_transcript_tail(self) -> list[str]:
        """Files this turn wrote/edited, read from the transcript tail.

        The headless turn-end seam (``end_headless_turn``) has no streamer
        ``_pending_entries`` to drain — the stream-json turn ingests via stdout,
        not the JSONL the TranscriptStreamer tails. So derive the touched set
        directly from the on-disk transcript, watermarked by entry count so each
        turn only reindexes its OWN new file-ops (not every file the session
        ever touched)."""
        tf = self._load_transcript()
        if tf is None:
            return []
        try:
            entries = list(tf.entries)
        except Exception:
            return []
        wm = int(getattr(self, "_reindex_entry_watermark", 0) or 0)
        object.__setattr__(self, "_reindex_entry_watermark", len(entries))
        # entries[wm:] clamps to [] when wm > len (a truncated/rotated transcript)
        # — safer than re-scanning all, which would re-reindex the whole history.
        return list(_iter_touched_paths(entries[wm:]))

    @property
    def _last_broadcast_key(self) -> _BroadcastKey | None:
        """Last (status, busy, worker_status) triple broadcast for this process.

        Backed by the module-level :data:`_LAST_BROADCAST_KEYS` rather than by
        ``self``: the transcript watcher hydrates a FRESH AgenticProcess for
        every streamer event, so an instance attribute dies with that event and
        always reads back as None. The property keeps the ordinary
        attribute-shaped call sites while the value lives as long as the
        process does.
        """
        return _LAST_BROADCAST_KEYS.get(str(self.id))

    @_last_broadcast_key.setter
    def _last_broadcast_key(self, key: "_BroadcastKey | tuple | None") -> None:
        if key is None:
            # Drop the row rather than storing a None, so a reader can't tell
            # "never broadcast" from "broadcast a None" — there is no such key.
            _LAST_BROADCAST_KEYS.pop(str(self.id), None)
        else:
            # Normalize on the way in — the setter is the ONLY writer, so a
            # plain triple (what the tests assign) still reads back with named
            # axes. Wrong arity raises here rather than surfacing as a silent
            # mis-index at the read.
            _LAST_BROADCAST_KEYS[str(self.id)] = _BroadcastKey(*key)

    async def _flush_transcript_change(self) -> None:
        """Run after the debounce window on this AP's transcript.

        Drains the buffer, processes plan detection (per-entry), re-derives
        worker_status via :meth:`_discover_status_from_transcript` (the same
        wrapper the serializer + get_status use, so the broadcast can never
        disagree with what consumers compute on demand), and broadcasts only
        on a status transition. Migrates the API_TIMEOUT → ``_on_timeout``
        invocation from the deleted ``_poll_for_completion``.

        The in-memory object may be stale after the sleep: lifecycle mutations
        hydrate their own AP instance while this callback retains the PTY-era
        snapshot. Re-read the durable row at both sides of the flush and never
        broadcast stale ``self`` across a transport/lifecycle transition.
        """
        try:
            await asyncio.sleep(self._DEBOUNCE_SECONDS)

            durable = await AgenticProcess.get_by_id(str(self.id))
            if durable is None or durable.status != ProcessStatus.RUNNING.value or durable.pty_mode != self.pty_mode:
                return

            entries = list(getattr(self, "_pending_entries", []))
            object.__setattr__(self, "_pending_entries", [])
            await self._process_transcript_entries(entries)

            # Raw worker status ("what we found") — same helper the serializer
            # and get_status use, so the broadcast can never disagree with what
            # consumers compute on demand.
            current = self.fetch_worker_status()
            # The busy boolean (turn-in-flight) — the axis the frontend gates on.
            # The broadcast key is the TRIPLE (status, busy, worker_status): a
            # busy⇄idle flip must broadcast even when the raw worker_status is
            # unchanged (the prompt lock is acquired/released before the JSONL tail
            # moves — this is what lets a HEADLESS turn broadcast its start/end
            # edges), and a raw worker move (thinking→tool_call) must broadcast even
            # while busy stays true so the mid-turn indicator advances. ``status``
            # is in the key too so a lifecycle flip (running→stopped) still fires.
            current_busy = is_turn_busy(self, current)
            worker_key = str(current) if current is not None else None
            key = _BroadcastKey(self.status, current_busy, worker_key)
            # Process-scoped (see the property), so it survives the per-event
            # rehydration and the busy->idle edge below can actually fire.
            previous = getattr(self, "_last_broadcast_key", None)
            prev_busy = previous.busy if previous else None

            # Generic agent-progress projection. Runs every flush (counters move
            # without a status transition), so it precedes the transition
            # early-return below. Change-gated internally.
            await self._emit_status_report(current, current_busy)

            if key == previous:
                return
            self._last_broadcast_key = key

            if current == WorkerStatus.API_TIMEOUT:
                logger.warning(
                    "AgenticProcess %s: agent is taking a long time to respond — "
                    "no LLM response since the last prompt; the Anthropic API may "
                    "be slow or unresponsive",
                    self.id,
                )
                try:
                    await self._on_timeout()
                except Exception:
                    logger.debug(
                        "AgenticProcess %s: _on_timeout failed",
                        self.id,
                        exc_info=True,
                    )

            # A switch/stop can complete while entry processing and status
            # derivation are in flight. Broadcast the latest durable object,
            # never this callback's full stale PTY snapshot (which would undo a
            # successful CLI switch for every watcher).
            durable = await AgenticProcess.get_by_id(str(self.id))
            if durable is None or durable.status != self.status or durable.pty_mode != self.pty_mode:
                return
            await durable.notify_updated()

            # Drain the prompt queue on the turn-end edge (busy→not-busy). Single
            # AP-level seam for both PTY *and* headless turns (both write the
            # transcript that lands here), so no driver coupling.
            if not current_busy and prev_busy:
                # HISTORY (QA 2026-08-21): this edge USED to be dead.
                # `_last_broadcast_key` was a plain INSTANCE attribute and every
                # flush hydrates a fresh object, so `prev_busy` was always None
                # (instrumented at a real turn end:
                # `prev_busy=None current_busy=False edge_fires=False`). A headless
                # turn's writes were therefore never reindexed from this seam. The
                # key is process-scoped now, so THIS EDGE IS LIVE and fires once
                # per turn end.
                #
                # That revives `_schedule_turn_end_reindex` with it. The same QA
                # note recorded why the reindex was left alone: moving it to the
                # IDLE GATE took `whiteboard/create_persist` C2 from 4/4 green to
                # 0/4, because a reindex on every flush races the editor's own
                # board.json/WHITE_BOARD.md writes. Waking the EDGE is not that
                # change: it fires once per turn end, not once per flush, and the
                # whiteboard scenario was re-run against this seam live and stays
                # 4/4. The load, not the seam, was what broke it.
                #
                # Second defect here, independent of the gate: the watermark
                # `_reindex_entry_watermark` is per-instance transient for the very
                # same reason `prev_busy` was, so on this seam it always reads 0 and
                # every firing reindexes the whole session history rather than the
                # turn's own files. Fixing that is likely the precondition for
                # trusting a live edge.
                self._schedule_turn_end_reindex("flush")
                # Drain the prompt queue on this same turn-end edge. A prompt
                # enqueued mid-turn bails ``not_ready``, and that bail returns
                # before the ``chain`` reschedule, so nothing ever revisits it:
                # the queue strands until the user happens to act again. Headless
                # self-heals through ``end_headless_turn``'s "complete" drain;
                # this is the PTY equivalent.
                #
                # The edge needs an earlier flush to have recorded ``busy=True``,
                # which the enqueue case always has — the UI can only offer
                # "queue" once a broadcast told it the agent is working, and that
                # broadcast IS the flush that wrote the busy key. Re-firing is
                # harmless if some other path fires it too:
                # ``_schedule_queue_drain`` returns early when no queue file
                # exists, ``_maybe_drain_queue`` bails on an empty or disabled
                # queue, and it pop-persists the head before injecting, so a
                # repeat can never double-inject.
                self._schedule_queue_drain("ready")
            if not current_busy:
                # Default-name stamp on ANY idle flush, not the busy→idle edge
                # above: a process that has not yet run a turn still needs a
                # name, and the edge would never fire for it. Naming THIS
                # hydration also keeps ``_emit_status_report``'s whole-row save
                # above from clobbering a name stamped elsewhere. No-op once
                # named.
                try:
                    await self.stamp_default_name()
                except Exception:
                    logger.debug("AgenticProcess %s: default-name stamp failed", self.id, exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug(
                "AgenticProcess %s: _flush_transcript_change failed",
                self.id,
                exc_info=True,
            )

    @classmethod
    async def get_by_session_id(cls, session_id: str) -> "AgenticProcess | None":
        """Resolve the AgenticProcess that owns ``session_id`` (None if unknown)."""
        if not session_id:
            return None
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

        procs = await cls.get_all(entities_filter=QueryFilter(match=ExpressionNode(session_id=session_id)))
        return procs[0] if procs else None

    @staticmethod
    def _is_user_doc(path: str) -> bool:
        """True for a user-facing markdown doc the agent authored.

        Excludes plan files (owned by the Open-Plan chip) and agent-internal
        docs (``CLAUDE.md``/``AGENTS.md``, anything under ``~/.claude`` or
        ``~/.codex``) so the docs chip only surfaces docs meant for the user.
        """
        if not path or not path.endswith(".md"):
            return False
        from pathlib import Path as _Path

        from flow_sdk.instance_settings import get_instance_settings

        p = _Path(path)
        if p.name in ("CLAUDE.md", "AGENTS.md"):
            return False
        try:
            plans_dir = get_instance_settings().claude_plans_dir
            if plans_dir and plans_dir in p.parents:
                return False
        except Exception:
            pass
        home = _Path.home()
        for internal in (home / ".claude", home / ".codex"):
            if internal in p.parents:
                return False
        return True

    async def _track_markdown_doc(self, path: str, change: str) -> None:
        """Upsert ``path`` into ``markdown_docs`` (tail = latest) and broadcast.

        Re-writing an existing path moves it to the tail and upgrades its change
        to ``update``. Saves before the event so the entity-update WS precedes
        the ``markdown.{change}`` broadcast (same ordering as ``plan.create``).
        """
        from os.path import basename

        name = basename(path)
        docs = list(self.markdown_docs or [])
        existing = next((d for d in docs if d.get("path") == path), None)
        if existing is not None:
            docs.remove(existing)
            # A path seen before is an update even if this entry was a Write.
            change = "update"
        docs.append({"path": path, "name": name, "change": change})
        self.markdown_docs = docs
        try:
            await self.save()
        except Exception:
            logger.debug(
                "AgenticProcess %s: markdown_docs save failed",
                self.id,
                exc_info=True,
            )
        await self.emit_entity_event(
            f"markdown.{change}",
            {"path": path, "name": name, "session_id": self.session_id},
        )

    def _derive_focused_asset(self, transcript) -> "FocusedAsset | None":
        """Most-recent asset this process is pointing at, as a URL-ref pointer.

        Stateless reverse-scan of the parsed transcript — the same entries the
        plan/docs chips inspect, unified into one ``FocusedAsset``. Both a plan
        file and a user-authored doc are markdown files opened via the same
        ``forAssetEditor('markdown', path)`` navigation, so both map to
        ``asset_type='markdown', ref_type='vfs'``. Skill/webapp/typeid focus is
        a follow-up (needs name→typeid resolution; kept out of the hot path).
        """
        from flow_sdk.transcript_analyzer.counters import FocusedAsset
        from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
        from flow_sdk.transcript_analyzer.entries.file_edit import FileEditEntry
        from flow_sdk.transcript_analyzer.entries.file_write import FileWriteEntry

        for entry in reversed(transcript.entries):
            if isinstance(entry, ExitPlanModeEntry) and entry.plan_file_path:
                return FocusedAsset(
                    asset_type="markdown",
                    ref_type="vfs",
                    ref_value=entry.plan_file_path,
                )
            if isinstance(entry, (FileWriteEntry, FileEditEntry)):
                path = getattr(entry, "path", None)
                if path and self._is_user_doc(path):
                    return FocusedAsset(
                        asset_type="markdown",
                        ref_type="vfs",
                        ref_value=path,
                    )
        return None

    async def _emit_status_report(self, current, current_busy: bool) -> None:
        """Recompute the ProcessStatusReport and push it (change-gated).

        ``current_busy`` is the already-derived turn-in-flight boolean from the
        caller, so the report doesn't recompute ``is_turn_busy`` (and its lock
        probe) again.

        Runs on every debounce flush — counters change without a worker-status
        transition — so it sits BEFORE the transition early-return. The snapshot
        is persisted (restore-on-reload) and pushed live on the shared
        ``progress_report`` flow_data envelope, both only when it actually
        changed. Watcher-scoped via ``emit_flow_data`` (only clients watching
        this process), not the global scan-pill ``broadcast_progress``.

        The whole-file parse is offloaded off the event loop (same pattern the
        streamer uses for ``parse_delta``) so N active workers folding once per
        debounce second don't serialize their parses on the loop. A fresh
        transcript object is parsed here (not the streamer's live one) to avoid
        racing its concurrent ``parse_delta`` mutation.
        """
        try:
            transcript = await asyncio.to_thread(self._load_transcript)
            if transcript is None:
                return
            from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
                FlowDataType as _FDT,
            )
            from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
                FlowElementType as _FET,
            )
            from flow_sdk.transcript_analyzer.counters import (
                PROCESS_STATUS_KIND,
                ProcessStatusReport,
            )

            report = ProcessStatusReport.from_transcript(
                transcript,
                worker_status=(current.value if current is not None else ""),
                process_status=self.status,
                busy=current_busy,
                focused_asset=self._derive_focused_asset(transcript),
            )
            report_dict = report.model_dump()
            if report_dict == self.status_report:
                return

            # Transcript debounce callbacks hold independently hydrated process
            # objects and can finish after another request closes + deletes the
            # process. Persist this projection as an update-only field patch;
            # the normal whole-entity save path is an intentional upsert and
            # would otherwise resurrect the stale RUNNING snapshot.
            durable = await AgenticProcess.get_by_id(str(self.id))
            if durable is None or durable.status != self.status:
                return
            persisted, updated = await self._db.update_existing_data_field(
                str(self.id),
                self.type,
                "status_report",
                report_dict,
            )
            if not updated or persisted is None:
                return
            self.status_report = report_dict

            # Close/delete can still win immediately after the atomic patch.
            # Suppress stale progress events once lifecycle ownership changed.
            durable = await AgenticProcess.get_by_id(str(self.id))
            if durable is None or durable.status != self.status:
                return
            # Unified-bus dual-publish AFTER the persist (a law-5 subscriber
            # fetching on receipt reads the post-write row).
            from flow_sdk.builtin.agentic_process.agent_on_tag import emit_agent_status

            emit_agent_status(self.id, current.value if current is not None else "", self.status, current_busy)
            await self.emit_flow_data(
                {
                    "attributes": {
                        "element-type": _FET.PROGRESS_REPORT,
                        "data-type": _FDT.OBJECT,
                        "kind": PROCESS_STATUS_KIND,
                    },
                    "flow_value": report_dict,
                }
            )
        except Exception:
            logger.debug(
                "AgenticProcess %s: _emit_status_report failed",
                self.id,
                exc_info=True,
            )

    async def on_plan_created(self, entry) -> None:
        """T7: Connect a freshly-detected plan to this AgenticProcess.

        Resolves the plan entity (indexing it on demand if the indexer hasn't
        caught up), sets ``plan_path`` if stale, and mutually cross-links the
        plan and this process via ``private_context_entities``. Shares the plan
        resolver with PlanHandler (indexer).
        """
        from flow_sdk.core.entity.cross_link import cross_link_entities
        from flow_sdk.fs_store.transcript_indexer.handlers.plan_handler import resolve_plan

        plan = await resolve_plan(entry.plan_file_path)
        if plan is None:
            return
        path_str = str(entry.plan_file_path)
        if self.plan_path != path_str:
            self.plan_path = path_str
            await self.save()
        await cross_link_entities(plan, self, b_data={"path": path_str})

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
                # Backfill the reverse link for shells created before the field
                # existed (or by a restart path that didn't set it).
                if shell.agentic_process_id != self.id:
                    shell.agentic_process_id = self.id
                    await shell.save()
                return shell

        # The AP owns its tab_order (base Entity): claim a slot once, then
        # every replacement shell inherits it — the tab stays put across
        # transport swaps with no carry-over state. Legacy rows that predate
        # AP ownership may still hold a slot in context_data; adopt it once.
        if not self.tab_order:
            legacy_prev = (self.context_data or {}).get("_prev_tab_order")
            self.tab_order = legacy_prev if legacy_prev else await Shell.next_tab_order()
        if isinstance(self.context_data, dict) and "_prev_tab_order" in self.context_data:
            self.context_data = {k: v for k, v in self.context_data.items() if k != "_prev_tab_order"}
        tab_order = self.tab_order

        is_resume = self._is_exist_claude_resume_session(self.session_id) if self.session_id else False
        # Fork is Claude-only; ``fork_session_id`` is a base attr (None elsewhere).
        cli_opts_local = getattr(self, "cli_options", None)
        is_fork = bool(cli_opts_local and cli_opts_local.fork_session_id)
        session_label = "fork" if is_fork else "resume" if is_resume else "new"
        worker_label = self.driver.name.capitalize() if self.driver else "Claude"
        session_name = f"{worker_label} - {self.session_id[:8]} ({session_label})" if self.session_id else worker_label

        workdir = self.workdir
        if not workdir:
            raise NotADirectoryError(f"AgenticProcess {self.id} has no workdir after project resolution")
        cn = await self._get_local_compute_node()
        if cn is None:
            raise RuntimeError(LOCAL_COMPUTE_NODE_MISSING_FAILURE)
        shell_kwargs = {
            "compute_node_id": str(cn.id),
            "compute_node_uname": getattr(cn, "uname", None),
            "name": session_name,
            "workdir": workdir,
            "tab_order": tab_order,
            "project_id": self.project_id,
            # Reverse of self.shell_id — the shell carries its owning process
            # so a bare-shell URL resolves the owner by get-by-id, no scan.
            # NB: named agentic_process_id (NOT process_id — that key is the OS
            # PID written by the PTY layer, pty_actions.py:394).
            "agentic_process_id": self.id,
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
        # Closure-bound spawn clock: the callback is created immediately before
        # the worker is launched, so ``now - spawned_at`` at exit time is the
        # worker's lifetime. Kept in the closure (not the entity) so the
        # instant-exit classification can't race a concurrent save.
        spawned_at = time.monotonic()

        def _on_pty_exit(exit_code: int | None) -> None:
            worker_lifetime = time.monotonic() - spawned_at
            logger.info(
                "AgenticProcess %s: PTY exited with code %s after %.1fs",
                agentic_process_id,
                exit_code,
                worker_lifetime,
            )

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
                    if backend_restart_requested():
                        # `flow instance restart-backend` marks its intent
                        # before reaping the backend process tree. A worker may
                        # translate TERM into a clean exit code, so the marker
                        # is the authoritative distinction from a real
                        # instant-exit failure. Leave the live state intact for
                        # the replacement backend's watched-session recovery.
                        logger.info(
                            "AgenticProcess %s: backend restart requested; preserving %s for recovery",
                            agentic_process_id,
                            proc.status,
                        )
                        return
                    if is_recoverable_worker_interruption(exit_code):
                        # TERM/KILL/HUP are external interruptions. Keep the
                        # live state intact so the watched-session recovery
                        # owner can respawn it. Explicit exit() is handled by
                        # the `_shell_exit_pending` branch above.
                        logger.info(
                            "AgenticProcess %s: worker interrupted by signal %s; preserving %s for recovery",
                            agentic_process_id,
                            -exit_code,
                            proc.status,
                        )
                        return
                    proc.sidecar_shell_id = None
                    if exit_code is not None and exit_code < 0:
                        proc.status = ProcessStatus.FAILED.value
                        proc.start_failure = f"Worker terminated by crash signal {-exit_code}."
                        logger.warning(
                            "AgenticProcess %s: %s Auto-relaunch paused until user retry.",
                            agentic_process_id,
                            proc.start_failure,
                        )
                    elif proc.status == ProcessStatus.STARTING.value or (
                        proc.status == ProcessStatus.RUNNING.value and worker_lifetime < INSTANT_EXIT_WINDOW_SECONDS
                    ):
                        # Failed start — either the worker died before the spawn
                        # completed, or it exited within the instant-exit window.
                        # Latch ``start_failure`` so auto-recovery (the 5s os-status
                        # sweep and plain open() calls) stops relaunching it; only
                        # an explicit user retry clears the latch.
                        proc.status = ProcessStatus.FAILED.value
                        proc.start_failure = (
                            f"Worker exited {worker_lifetime:.1f}s after launch (exit code {exit_code})."
                        )
                        logger.warning(
                            "AgenticProcess %s: failed to start — %s Auto-relaunch paused until user retry.",
                            agentic_process_id,
                            proc.start_failure,
                        )
                    elif proc.status not in {
                        ProcessStatus.STOPPING.value,
                        ProcessStatus.STOPPED.value,
                        ProcessStatus.FAILED.value,
                    }:
                        proc.status = ProcessStatus.STOPPED.value
                    await proc.save()

                    if session_id:
                        asyncio.create_task(_index_session_on_close(session_id, display_name=proc.name))
                except Exception as exc:
                    logger.warning("AgenticProcess %s: on_exit update failed: %s", agentic_process_id, exc)

            asyncio.run_coroutine_threadsafe(_update_state(), main_loop)

        return _on_pty_exit


AgenticProcess.on_event("wizard.close")(AgenticProcess.on_wizard_close)
