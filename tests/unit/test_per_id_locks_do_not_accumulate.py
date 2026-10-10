"""A per-id lock registry holds nothing once nobody holds or awaits the lock.

Eleven module-level registries hand out one ``asyncio.Lock`` per entity id or path
(a process, a shell, a conversation, a source, a vault root ...). Each used to be a
plain ``dict`` / ``defaultdict(asyncio.Lock)`` that was the lock's only owner and had
no removal path, so every id the backend ever touched left a lock behind for the
life of the process — and ``_PROMPT_LOCKS`` grew on a plain STATUS READ, because
``defaultdict`` mints on lookup and every save / API dump asks ``is_turn_busy``.

They are all weak-valued now (``flow_sdk/stream_inbox/_locks.py``): a lock lives
exactly as long as a coroutine holds or awaits it. These tests drive the REAL entry
functions (only their collaborators are stubbed) and assert the registry is empty
afterwards, that exclusion still holds while it matters, and that no new strong
per-id lock dict appears in ``flow_sdk/``.
"""

from __future__ import annotations

import ast
import asyncio
import gc
import types
import uuid
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import AsyncMock, PropertyMock, patch

from flow_sdk.stream_inbox._locks import any_keyed_lock_held, keyed_lock_held, keyed_loop_lock, new_registry

SDK = Path(__file__).resolve().parents[2] / "flow_sdk"


def live_locks(*registries) -> tuple[int, ...]:
    """How many locks each registry holds right now, on every loop.

    A lock with no holder and no waiter is freed by refcount the moment the last frame
    drops it, so an empty registry is empty without help. A collection can only REMOVE
    entries (a reference a caught exception's traceback still holds), so it runs only
    when something is there — a full ``gc.collect()`` over the loaded SDK costs ~0.1 s.
    """

    def count():
        return tuple(sum(len(per_loop) for per_loop in list(registry.values())) for registry in registries)

    counts = count()
    if any(counts):
        gc.collect()
        counts = count()
    return counts


# ── the helper itself ────────────────────────────────────────────────────────


async def test_a_lock_lives_only_while_held_or_awaited():
    reg = new_registry()
    assert live_locks(reg) == (0,)

    peak = 0
    active = 0
    entries_while_held = 0

    async def critical():
        nonlocal peak, active, entries_while_held
        async with keyed_loop_lock(reg, "one-key"):
            active += 1
            peak = max(peak, active)
            entries_while_held = max(entries_while_held, live_locks(reg)[0])
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            active -= 1

    await asyncio.gather(*(critical() for _ in range(5)))
    assert peak == 1, "two callers of one key overlapped"
    assert entries_while_held == 1, "a waiter minted a second lock for the same key"
    assert live_locks(reg) == (0,)


async def test_held_reads_true_and_never_mints():
    reg = new_registry()
    assert keyed_lock_held(reg, "k") is False
    assert any_keyed_lock_held(reg) is False
    assert live_locks(reg) == (0,), "a read must not create the lock it asks about"

    lock = keyed_loop_lock(reg, "k")
    assert keyed_lock_held(reg, "k") is False  # minted, not held
    async with lock:
        assert keyed_lock_held(reg, "k") is True
        assert keyed_lock_held(reg, "other") is False
        assert any_keyed_lock_held(reg) is True
    assert keyed_lock_held(reg, "k") is False
    del lock
    assert live_locks(reg) == (0,)


# ── P6: the three per-process registries in agentic_process ─────────────────


async def _fake_perform_open(self, instruction, visible, retry=False):
    # The stand-in ``tests/unit/test_agentic_open_concurrency.py`` uses; the lock
    # around it (``start_pty``) is the real code.
    from flow_sdk.builtin.process_lifecycle import ProcessStatus
    from flow_sdk.responses.response import ApiSuccessResponse

    if self.status == ProcessStatus.RUNNING.value and self.shell_id:
        return ApiSuccessResponse(data={"mode": "reattach", "shell_id": self.shell_id})
    await asyncio.sleep(0)
    self.shell_id = str(uuid.uuid4())
    self.status = ProcessStatus.RUNNING.value
    await self.save()
    return ApiSuccessResponse(data={"mode": "spawn", "shell_id": self.shell_id})


async def test_agentic_process_lifecycle_leaves_no_lock_behind():
    """save (the serializer's busy read), status, open, drain, close: 0 / 0 / 0 after each."""
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process import agentic_process as ap
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    def census():
        return live_locks(ap._PROMPT_LOCKS, ap._OPEN_LOCKS, ap._QUEUE_LOCKS)

    procs = []
    for _ in range(2):
        proc = AgenticProcess(id=str(uuid.uuid4()), status=ProcessStatus.STOPPED.value, visible=False, pty_mode=False)
        await proc.save()  # serializer -> is_turn_busy -> prompt_lock_locked: the read that used to insert
        procs.append(proc)
    assert census() == (0, 0, 0)

    for proc in procs:
        assert (await proc.get_status()).data["busy"] is False
    assert census() == (0, 0, 0)

    with patch.object(AgenticProcess, "_perform_open", new=_fake_perform_open):
        for proc in procs:
            await proc.start_pty()
    assert census() == (0, 0, 0)

    for proc in procs:
        await proc._maybe_drain_queue("census")
    assert census() == (0, 0, 0)

    for proc in procs:
        proc.shell_id = None  # the stand-in spawn has no Shell row behind it
        await proc.close()
    assert census() == (0, 0, 0)


async def test_a_held_prompt_lock_is_busy_and_is_the_only_entry():
    from flow_sdk.builtin.agentic_process import agentic_process as ap
    from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy

    pid = str(uuid.uuid4())
    fake = types.SimpleNamespace(id=pid, _turn_in_flight=False, pty_mode=False, status="stopped")
    lock = keyed_loop_lock(ap._PROMPT_LOCKS, pid)
    async with lock:
        assert is_turn_busy(fake) is True
        assert ap.any_prompt_in_flight() is True
        assert ap.try_admit_prompt(pid) is None
        assert live_locks(ap._PROMPT_LOCKS) == (1,)
    assert is_turn_busy(fake) is False
    assert ap.any_prompt_in_flight() is False
    del lock
    assert live_locks(ap._PROMPT_LOCKS) == (0,)


# ── P5: the per-shell open lock ──────────────────────────────────────────────


class _FakePty:
    def __init__(self):
        self.is_alive = True

    async def kill(self):
        self.is_alive = False

    async def close(self):
        self.is_alive = False

    async def attach(self, _client):
        pass


class _FakeNode:
    def __init__(self):
        self.ptys: dict[str, _FakePty] = {}
        self.created = 0
        self.inside = 0
        self.max_inside = 0

    def get_pty(self, sid):
        return self.ptys.get(sid)

    async def create_pty(self, sid, **_kw):
        self.inside += 1
        self.max_inside = max(self.max_inside, self.inside)
        await asyncio.sleep(0)  # a real create_pty yields; an unlocked racer would enter here
        self.ptys[sid] = _FakePty()
        self.created += 1
        self.inside -= 1


async def test_shell_open_and_close_leave_no_lock_behind():
    import flow_sdk.builtin.shell as shell_mod
    from flow_sdk.builtin.shell import Shell

    node = _FakeNode()

    async def passthru(_pid, env, process_id=None):
        return env

    with (
        patch.object(Shell, "ensure_live_compute_node_binding", new=AsyncMock(return_value=True)),
        patch.object(Shell, "compute_node", new_callable=PropertyMock, return_value=node),
        patch.object(Shell, "save", new=AsyncMock()),
        patch.object(Shell, "delete", new=AsyncMock()),
        patch.object(Shell, "get_record", new=AsyncMock(return_value=None)),
        patch.object(Shell, "terminate_worker", new=AsyncMock()),
        patch.object(shell_mod, "_with_attached_project_secrets", new=passthru),
    ):
        shells = [Shell(id=str(uuid.uuid4()), compute_node_id="n") for _ in range(20)]
        for shell in shells:
            assert await shell.start_pty() is True
        assert live_locks(shell_mod._START_PTY_LOCKS) == (0,)  # an open shell holds no open-lock
        for shell in shells:
            await shell.close()
        assert live_locks(shell_mod._START_PTY_LOCKS) == (0,)

        # The lock still serializes: dead PTY, five concurrent opens, exactly one spawn.
        shell = Shell(id=str(uuid.uuid4()), compute_node_id="n")
        await shell.start_pty()
        await node.get_pty(shell.id).kill()
        before = node.created
        node.max_inside = 0
        results = await asyncio.gather(*(shell.start_pty() for _ in range(5)))
        assert results.count(True) == 1
        assert node.created - before == 1
        assert node.max_inside == 1
    assert live_locks(shell_mod._START_PTY_LOCKS) == (0,)


# ── P13a-g: seven more per-id registries ─────────────────────────────────────


@dataclass
class _StampStats:
    files: int = 0


class _StubIndexer:
    def scan(self, _root):
        return self

    def stamp(self):
        return _StampStats()


async def test_seven_per_id_registries_are_empty_after_use(tmp_path):
    import flow_sdk.app.actions.flow_message_action as fma
    import flow_sdk.assets.hub_repo_sync as hub_repo_sync
    import flow_sdk.builtin.diagnosis_request as diagnosis_request
    import flow_sdk.builtin.project_dependencies as project_dependencies
    import flow_sdk.builtin.rag_index as rag_index
    import flow_sdk.ingest.sync as ingest_sync
    import flow_sdk.server.routes.docs_graph as docs_graph

    n = 3
    roots = []
    for i in range(n):
        root = tmp_path / f"vault-{i}"
        root.mkdir()
        roots.append(root)

    with (
        patch.object(fma, "hub_get", new=AsyncMock(return_value=None)),
        patch.object(ingest_sync, "_sync_source", new=AsyncMock(return_value=None)),
        patch.object(project_dependencies, "_resolve", new=AsyncMock(return_value=[])),
        patch.object(docs_graph, "_indexer", new=lambda _root: _StubIndexer()),
    ):
        for i in range(n):
            key = str(uuid.uuid4())
            await fma._fetch_conversation_messages(key, "user-x")
            await diagnosis_request.DiagnosisRequest.take_hub_update(key, {})
            async with rag_index.RagIndex.open_store(types.SimpleNamespace(id=key, store_dir=roots[i] / "store")):
                pass
            await ingest_sync.sync_source(types.SimpleNamespace(id=key))
            await docs_graph.docs_graph_stamp(root=str(roots[i]))
            await project_dependencies.resolve(
                types.SimpleNamespace(id=key, fs_storage_mount_path=str(roots[i])), fetch=False
            )
            async with hub_repo_sync._lock(roots[i]):
                pass

    registries = {
        "flow_message_action._conv_fetch_locks": fma._conv_fetch_locks,
        "diagnosis_request._update_locks": diagnosis_request._update_locks,
        "rag_index._STORE_LOCKS": rag_index._STORE_LOCKS,
        "ingest.sync._CYCLES": ingest_sync._CYCLES,
        "docs_graph._stamp_locks": docs_graph._stamp_locks,
        "project_dependencies._LOCKS": project_dependencies._LOCKS,
        "hub_repo_sync._locks": hub_repo_sync._locks,
    }
    kept = dict(zip(registries, live_locks(*registries.values())))
    assert all(count == 0 for count in kept.values()), f"locks kept after use: {kept}"


async def test_rag_store_door_still_excludes_per_index(tmp_path):
    """The highest-consequence site: two handles on one usearch index take the process down."""
    import flow_sdk.builtin.rag_index as rag_index

    index = types.SimpleNamespace(id=str(uuid.uuid4()), store_dir=tmp_path / "store")
    active = peak = 0

    async def use():
        nonlocal active, peak
        async with rag_index.RagIndex.open_store(index):
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1

    await asyncio.gather(*(use() for _ in range(4)))
    assert peak == 1
    assert live_locks(rag_index._STORE_LOCKS) == (0,)


# ── the guard: no new strong per-id lock dict in flow_sdk ────────────────────

#: Module-level ``dict[str, asyncio.Lock]`` globals that remove their own entries. The reason is the point.
REMOVES_ITS_OWN = {
    "builtin/tag_triggers.py:_locks": "popped on disarm (``_locks.pop(trigger_id)``), so it tracks armed triggers",
}


def _is_lock_type(node: ast.AST) -> bool:
    """``asyncio.Lock`` or the string ``"asyncio.Lock"``."""
    if isinstance(node, ast.Constant):
        return node.value == "asyncio.Lock"
    return isinstance(node, ast.Attribute) and node.attr == "Lock" and getattr(node.value, "id", "") == "asyncio"


def _strong_per_id_lock_dict(stmt: ast.stmt) -> str | None:
    """The name a module-level statement binds to a strong per-key lock dict, else None."""
    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
        ann = stmt.annotation
        if isinstance(ann, ast.Subscript) and getattr(ann.value, "id", "") == "dict":
            args = ann.slice.elts if isinstance(ann.slice, ast.Tuple) else []
            if len(args) == 2 and _is_lock_type(args[1]):
                return stmt.target.id
        return None
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
        value = stmt.value
        if isinstance(value, ast.Call) and getattr(value.func, "attr", getattr(value.func, "id", "")) == "defaultdict":
            if value.args and _is_lock_type(value.args[0]):
                return stmt.targets[0].id
    return None


def test_no_strong_per_id_lock_dict_in_flow_sdk():
    found = {}
    for path in sorted(SDK.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        if "asyncio.Lock" not in text:  # both shapes name the type; skip the parse otherwise
            continue
        tree = ast.parse(text, filename=str(path))
        for stmt in tree.body:
            name = _strong_per_id_lock_dict(stmt)
            if name:
                found[f"{path.relative_to(SDK).as_posix()}:{name}"] = stmt.lineno
    new = {k: v for k, v in found.items() if k not in REMOVES_ITS_OWN}
    assert not new, (
        "a module-level dict[str, asyncio.Lock] with no removal path keeps one lock per id for the "
        "process's life. Use keyed_loop_lock(new_registry(), key) from flow_sdk/stream_inbox/_locks.py, "
        f"or list it in REMOVES_ITS_OWN with the reason: {new}"
    )
    stale = set(REMOVES_ITS_OWN) - set(found)
    assert not stale, f"REMOVES_ITS_OWN lists a dict that no longer exists: {stale}"
