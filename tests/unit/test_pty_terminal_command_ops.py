"""Unit tests for the ComputeNode ``terminal-command`` read/admin ops and the
``_PTY_CAP`` FIFO eviction backstop.

Drives the ``PtyActionsMixin`` bodies directly (the surface behind
``terminal-command/<op>``) with a mocked provider/registry — the same
mocked-provider tier as ``test_pty_api.py``. No real OS PTY is spawned:

* ``list``  → active sessions enriched with ``agentic_process_id``
* ``rename`` → updates the handle's display name
* ``ping``  → ``{"alive": bool}`` from ``is_pty_alive``
* ``_PTY_CAP`` eviction → the oldest ``_PTY_EVICT_COUNT`` states for this node
  are closed when the cap is hit (cap lowered via the module-constant seam, so
  no 70 real PTYs are needed).
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.faas import pty_actions
from flow_sdk.builtin.faas.pty_actions import PtyActionsMixin
from flow_sdk.compute.providers.desktop.pty_session_manager import PtyState, pty_registry


class _Node(PtyActionsMixin):
    """Minimal ComputeNode stand-in carrying only what the mixin reads."""

    def __init__(self, provider: MagicMock) -> None:
        self.id = "cn-1"
        self.node_provider_id = "pn-1"
        self.compute_provider = provider
        self.active_pty_sessions: list[str] = []
        self.typeid = "compute_node-cn-1"


def _request_info(message_id: str = "msg-1") -> MagicMock:
    info = MagicMock()
    info.request_message_id = message_id
    return info


@contextmanager
def _patch_request_info(info):
    """Patch the mixin's ``get_current_request_info`` for the block. Pass a
    ``_request_info()`` for a normal caller or ``None`` for the no-context case."""
    with patch(
        "flow_sdk.builtin.faas.pty_actions.get_current_request_info", return_value=info
    ):
        yield


class _StopBeforeSpawn(Exception):
    """Sentinel: abort start_machine_pty_session right after eviction so the
    DB/disk tail never runs — we only assert the eviction decision here."""


@pytest.fixture
def eviction_registry(monkeypatch):
    """Lower the FIFO cap to a deterministic 4/evict-2, stub the registry seams so
    no OS PTY spawns, and snapshot/restore the shared ``pty_registry.states``.

    Returns a namespace with ``evicted`` (keys passed to ``close_session``); the
    test populates ``pty_registry.states`` itself, then asserts against it."""
    monkeypatch.setattr(pty_actions, "_PTY_CAP", 4)
    monkeypatch.setattr(pty_actions, "_PTY_EVICT_COUNT", 2)

    original_states = pty_registry.states
    evicted: list = []

    async def _fake_close(key):
        evicted.append(key)
        pty_registry.states.pop(key, None)

    async def _fake_generate(*_args, **_kwargs):
        # Reached only after eviction ran — stop here so no DB/disk work fires.
        raise _StopBeforeSpawn

    monkeypatch.setattr(pty_registry, "close_session", _fake_close)
    monkeypatch.setattr(pty_registry, "get_session", AsyncMock(return_value=None))
    monkeypatch.setattr(pty_registry, "generate_session", _fake_generate)
    try:
        yield SimpleNamespace(evicted=evicted)
    finally:
        pty_registry.states = original_states


# ---------------------------------------------------------------------------
# list — active sessions enriched with agentic_process_id
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_enriches_with_agentic_process_id():
    """A session whose shell_id matches an AgenticProcess.pty_pid gets the
    process id joined in; unmatched sessions are left untouched."""
    provider = MagicMock()
    provider.list_pty_sessions = MagicMock(return_value=[
        {"shell_id": "s1", "name": "one"},
        {"shell_id": "s2", "name": "two"},
    ])
    node = _Node(provider)

    procs = [SimpleNamespace(pty_pid="s1", id="proc-1"), SimpleNamespace(pty_pid=None, id="proc-x")]
    from flow_sdk.builtin.agentic_process import AgenticProcess

    with _patch_request_info(_request_info()), patch.object(
        AgenticProcess, "get_all", AsyncMock(return_value=procs)
    ):
        result = await node._list_pty_sessions()

    assert result.status == "SUCCESS"
    sessions = result.data["content"]["sessions"]
    by_id = {s["shell_id"]: s for s in sessions}
    assert by_id["s1"]["agentic_process_id"] == "proc-1"
    assert "agentic_process_id" not in by_id["s2"]


@pytest.mark.asyncio
async def test_list_requires_request_context():
    """No request context (REST caller with no message id) → FAIL, not a crash."""
    node = _Node(MagicMock())
    with _patch_request_info(None):
        result = await node._list_pty_sessions()
    assert result.status == "FAIL"


@pytest.mark.asyncio
async def test_list_fails_without_provider_node_id():
    """A node with no provider id cannot list — guarded FAIL."""
    node = _Node(MagicMock())
    node.node_provider_id = None
    with _patch_request_info(_request_info()):
        result = await node._list_pty_sessions()
    assert result.status == "FAIL"


# ---------------------------------------------------------------------------
# rename — updates the handle's display name
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_rename_sets_handle_name():
    """rename writes ``name`` onto the live Pty handle and echoes it back."""
    pty = MagicMock()
    pty.name = "old"
    provider = MagicMock()
    provider.get_pty_session = MagicMock(return_value=pty)
    node = _Node(provider)

    with _patch_request_info(_request_info()):
        result = await node._rename_pty_session({"shell_id": "s1", "name": "renamed"})

    assert result.status == "SUCCESS"
    assert pty.name == "renamed"
    assert result.data["content"] == {"shell_id": "s1", "name": "renamed"}


@pytest.mark.asyncio
async def test_rename_missing_name_fails():
    """rename without a name is rejected before touching any handle."""
    node = _Node(MagicMock())
    with _patch_request_info(_request_info()):
        result = await node._rename_pty_session({"shell_id": "s1"})
    assert result.status == "FAIL"


@pytest.mark.asyncio
async def test_rename_unknown_session_fails():
    """rename on a shell with no live PTY handle → FAIL (session not found)."""
    provider = MagicMock()
    provider.get_pty_session = MagicMock(return_value=None)
    node = _Node(provider)
    with _patch_request_info(_request_info()):
        result = await node._rename_pty_session({"shell_id": "ghost", "name": "x"})
    assert result.status == "FAIL"


# ---------------------------------------------------------------------------
# ping — {"alive": bool} from is_pty_alive
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("alive", [True, False], ids=["alive", "dead"])
async def test_ping_reports_is_pty_alive(alive):
    provider = MagicMock()
    provider.is_pty_alive = MagicMock(return_value=alive)
    node = _Node(provider)
    result = await node._ping_pty_session({"shell_id": "s1"})
    assert result.status == "SUCCESS"
    assert result.data == {"alive": alive}
    provider.is_pty_alive.assert_called_once_with("pn-1", "s1")


@pytest.mark.asyncio
async def test_ping_missing_shell_id_fails():
    node = _Node(MagicMock())
    result = await node._ping_pty_session({})
    assert result.status == "FAIL"


# ---------------------------------------------------------------------------
# _PTY_CAP FIFO eviction
# ---------------------------------------------------------------------------


def _seed_node_states(node, n: int) -> list:
    """Populate ``pty_registry.states`` with *n* states for *node* (insertion
    order = age, oldest first). Returns the node keys in order."""
    node_keys = [(node.id, node.node_provider_id, f"shell-{i}") for i in range(n)]
    for k in node_keys:
        pty_registry.states[k] = PtyState(pty_key=k, cols=80, rows=24)
    return node_keys


@pytest.mark.asyncio
async def test_pty_cap_evicts_oldest_first(eviction_registry):
    """When the per-node session count reaches ``_PTY_CAP``, opening one more
    closes exactly the oldest ``_PTY_EVICT_COUNT`` states for THIS node —
    other nodes' states are untouched and newer states survive.
    """
    node = _Node(MagicMock())
    pty_registry.states = {}
    # Four states for this node (oldest first) …
    node_keys = _seed_node_states(node, 4)
    # … plus one for a DIFFERENT node that must never be evicted.
    other_key = ("cn-OTHER", "pn-9", "shell-other")
    pty_registry.states[other_key] = PtyState(pty_key=other_key, cols=80, rows=24)

    node.compute_provider.get_or_create_pty_session = AsyncMock(return_value={"pid": 1})

    with pytest.raises(_StopBeforeSpawn):
        await node.start_machine_pty_session(shell_id="shell-new", connection_id="conn-1")

    # Exactly the two oldest THIS-node keys were closed, oldest first.
    assert eviction_registry.evicted == node_keys[:2]
    # They are gone; the two newer node states and the other node survive.
    assert node_keys[0] not in pty_registry.states
    assert node_keys[1] not in pty_registry.states
    assert node_keys[2] in pty_registry.states
    assert node_keys[3] in pty_registry.states
    assert other_key in pty_registry.states


@pytest.mark.asyncio
async def test_pty_cap_no_eviction_below_cap(eviction_registry):
    """Below the cap, opening a session evicts nothing."""
    node = _Node(MagicMock())
    pty_registry.states = {}
    _seed_node_states(node, 3)  # three < cap of four

    node.compute_provider.get_or_create_pty_session = AsyncMock(return_value={"pid": 1})

    with pytest.raises(_StopBeforeSpawn):
        await node.start_machine_pty_session(shell_id="shell-new", connection_id="conn-1")
    assert eviction_registry.evicted == []
