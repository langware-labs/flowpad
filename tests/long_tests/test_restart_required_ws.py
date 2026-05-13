"""Long WS test for AgenticProcess.restart_required.

Drives the full positive + negative + edge-case matrix end-to-end:
- Mutate a tracked field via HTTP PUT (or direct entity save).
- Watch for the DataOp message on the WebSocket.
- Assert ``restart_required`` flipped (or stayed) per the field's contract.

PTY launch is mocked — we only care about the entity save → WS broadcast
pipeline plus the snapshot-hash hook on save() and start().
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, Callable

import pytest

from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.usefixtures("reset_db_for_testclient"),
]


# Cap on unrelated WS messages to drain before declaring the expected op missing.
_WS_DRAIN_LIMIT = 30


def _proc_typeid(proc_id: str) -> str:
    return f"agentic_process-{proc_id}"


def _wait_for_proc_update(
    ws,
    proc_id: str,
    *,
    matches: "Callable[[dict], bool] | None" = None,
) -> dict:
    """Drain unrelated WS traffic and return the first ``data_op_msg`` update
    for our process whose payload satisfies ``matches`` (or any update if no
    predicate is supplied).

    A predicate is necessary because background tasks (e.g.
    ``check_and_refresh_record`` chains into ``sync_to_db`` →
    ``Entity.from_record.save()`` on every entity GET) emit additional
    out-of-order broadcasts that snapshot stale entity state. Filtering by a
    field value we just wrote — same pattern used in test_bookmark.py — is
    the robust way to disambiguate.
    """
    import os as _os
    typeid = _proc_typeid(proc_id)
    for i in range(_WS_DRAIN_LIMIT):
        msg = ws.receive_json()
        if _os.environ.get("RESTART_DEBUG"):
            mt = msg.get("message_type")
            op = msg.get("op")
            te = msg.get("to_entity")
            rr = (msg.get("data") or {}).get("restart_required") if isinstance(msg.get("data"), dict) else None
            print(f"[ws-recv #{i}] mt={mt} op={op} to={te} restart_required={rr}", flush=True)
        if msg.get("message_type") != "data_op_msg":
            continue
        if msg.get("op") != "update":
            continue
        if msg.get("to_entity") != typeid:
            continue
        if matches is not None and not matches(msg.get("data") or {}):
            continue
        return msg
    raise AssertionError(
        f"Did not receive matching update for {typeid} within {_WS_DRAIN_LIMIT} messages"
    )


def _drain(ws, *, max_messages: int = 50) -> None:
    """Try to consume up to ``max_messages`` pending messages without blocking."""
    # TestClient WS receive_json blocks; use a short-timeout receive variant.
    # starlette TestClient doesn't expose a non-blocking variant directly,
    # so we limit by message count and bail on receive errors. In practice
    # we only call this between explicit triggering events.
    try:
        for _ in range(max_messages):
            ws.receive_json(mode="text")
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────────────
# Test fixture: a process forced into RUNNING with a known last_started_hash.
# We set both via direct entity save (running entirely server-side) so the
# subsequent mutations can be driven through HTTP PUTs without a real PTY.
# ──────────────────────────────────────────────────────────────────────────────


WORKER_TYPES = ["claude_code", "codex"]


def _worker_family(worker_type: str) -> str:
    return "claude" if worker_type in {"claude", "claude_code", "claude_code_cli"} else worker_type


def _setup_running_process(tc, worker_type: str) -> str:
    """Create an AgenticProcess via direct entity save. Forces status=RUNNING
    with ``last_started_hash`` SYNCED to the current snapshot so the initial
    ``restart_required`` is False — only a subsequent tracked-field mutation
    will flip it. Mirrors the post-``start()`` invariant.

    Returns the process id.
    """

    async def _create() -> str:
        from flow_sdk.builtin.agentic_process import AgenticProcess
        proc = AgenticProcess(id=str(uuid.uuid4()), worker_type=worker_type)
        # NEW state — save-hook is a no-op (gate: status != RUNNING).
        await proc.save()
        # Now force RUNNING and capture the snapshot. The save-hook is
        # suppressed during start() lifecycle; here we mimic that by setting
        # last_started_hash before the RUNNING save so the hook sees a match.
        proc.status = "running"
        proc.last_started_hash = proc._restart_snapshot()
        proc.restart_required = False
        await proc.save()
        return proc.id

    return asyncio.run(_create())


def _resync_hash(tc, proc_id: str) -> None:
    """Simulate a successful restart: read current entity, compute snapshot,
    PUT it as last_started_hash, clear restart_required.

    This mirrors what ``AgenticProcess.start()`` does on the success path,
    without needing a real PTY.
    """
    async def _sync() -> None:
        from flow_sdk.builtin.agentic_process import AgenticProcess

        proc = await AgenticProcess.get_by_id(proc_id)
        assert proc is not None
        proc.last_started_hash = proc._restart_snapshot()
        proc.restart_required = False
        await proc.save()

    asyncio.run(_sync())


# ──────────────────────────────────────────────────────────────────────────────
# Tracked-field mutations — each must flip restart_required from False → True.
# ──────────────────────────────────────────────────────────────────────────────

GENERIC_TRACKED_MUTATIONS: list[tuple[str, dict[str, Any]]] = [
    ("workdir",                    {"workdir": "/tmp/restart_required_test"}),
    ("additional_dirs",            {"additional_dirs": ["/tmp/restart_required_extra"]}),
    ("embedded_agent_ids",         {"embedded_agent_ids": ["legacy_persona"]}),
    ("shell_mode",                 {"shell_mode": True}),
    ("session_id",                 {"session_id": str(uuid.uuid4())}),
]


CLAUDE_TRACKED_MUTATIONS: list[tuple[str, dict[str, Any]]] = [
    ("cli_config.chrome",          {"cli_config": {"chrome": True}}),
    ("cli_config.debug",           {"cli_config": {"debug": True}}),
    ("cli_config.permission_mode", {"cli_config": {"permission_mode": "plan"}}),
    ("cli_config.worktree",        {"cli_config": {"worktree": True}}),
    ("cli_config.verbose",         {"cli_config": {"verbose": True}}),
    ("cli_config.output_format",   {"cli_config": {"output_format": "stream-json"}}),
    ("cli_config.model",           {"cli_config": {"model": "claude-opus-4-7"}}),
    ("cli_config.effort",          {"cli_config": {"effort": "high"}}),
    ("cli_config.print_mode",      {"cli_config": {"print_mode": True}}),
    ("cli_config.env_vars",        {"cli_config": {"env_vars": {"FOO": "bar"}}}),
    ("cli_config.agents_json",     {"cli_config": {"agents_json": {"x": {"description": "y"}}}}),
]


CODEX_TRACKED_MUTATIONS: list[tuple[str, dict[str, Any]]] = [
    ("cli_config.permission_mode", {"cli_config": {"permission_mode": "default"}}),
    ("cli_config.model",           {"cli_config": {"model": "gpt-5.2"}}),
    ("cli_config.env_vars",        {"cli_config": {"env_vars": {"FOO": "bar"}}}),
    ("cli_config.agents_json",     {"cli_config": {"agents_json": {"x": {"description": "y"}}}}),
    ("cli_config.skill_names",     {"cli_config": {"skill_names": ["reviewer"]}}),
    ("cli_config.json_stream",     {"cli_config": {"json_stream": False}}),
    ("cli_config.ephemeral",       {"cli_config": {"ephemeral": False}}),
    ("visible",                    {"visible": True}),
]


def _tracked_mutations(worker_type: str) -> list[tuple[str, dict[str, Any]]]:
    family = _worker_family(worker_type)
    worker_mutations = {
        "claude": CLAUDE_TRACKED_MUTATIONS,
        "codex": CODEX_TRACKED_MUTATIONS,
    }[family]
    return GENERIC_TRACKED_MUTATIONS + worker_mutations


# ──────────────────────────────────────────────────────────────────────────────
# Negative fields — must NOT flip restart_required.
# ──────────────────────────────────────────────────────────────────────────────

GENERIC_NEGATIVE_MUTATIONS: list[tuple[str, dict[str, Any]]] = [
    ("name",            {"name": "renamed"}),
    ("tags",            {"tags": ["a", "b"]}),
    ("labels",          {"labels": ["x"]}),
    ("target_typeid_str", {"target_typeid_str": "markdown-deadbeef-dead-beef-dead-beefdeadbeef"}),
    ("plan_path",       {"plan_path": "/tmp/some-plan.md"}),
    ("queue",           {"queue": {"jobs": []}}),
]


CLAUDE_NEGATIVE_MUTATIONS: list[tuple[str, dict[str, Any]]] = [
    ("visible", {"visible": True}),
]


CODEX_NEGATIVE_MUTATIONS: list[tuple[str, dict[str, Any]]] = [
    ("cli_config.chrome",        {"cli_config": {"chrome": True}}),
    ("cli_config.debug",         {"cli_config": {"debug": True}}),
    ("cli_config.worktree",      {"cli_config": {"worktree": True}}),
    ("cli_config.output_format", {"cli_config": {"output_format": "stream-json"}}),
]


def _negative_mutations(worker_type: str) -> list[tuple[str, dict[str, Any]]]:
    family = _worker_family(worker_type)
    worker_mutations = {
        "claude": CLAUDE_NEGATIVE_MUTATIONS,
        "codex": CODEX_NEGATIVE_MUTATIONS,
    }[family]
    return GENERIC_NEGATIVE_MUTATIONS + worker_mutations


NEGATIVE_CASES = [
    (worker_type, label, payload)
    for worker_type in WORKER_TYPES
    for label, payload in _negative_mutations(worker_type)
]


# ──────────────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────────────


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize("worker_type", WORKER_TYPES)
def test_restart_required_full_cycle(worker_type: str):
    """Walk every tracked field: mutate → flag ON → restart-equivalent → flag OFF."""
    from starlette.testclient import TestClient
    from flow_sdk.server.app import app

    with TestClient(app) as tc:
        proc_id = _setup_running_process(tc, worker_type)

        # Watch the entity for targeted updates.
        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"

            resp = tc.post(
                f"/api/v1/graph/agentic_process/{proc_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200, resp.text

            # Initial state: restart_required is False (default).
            resp = tc.get(f"/api/v1/graph/agentic_process/{proc_id}")
            assert resp.json()["data"]["restart_required"] is False

            for label, payload in _tracked_mutations(worker_type):
                # Mutate.
                resp = tc.put(f"/api/v1/graph/agentic_process/{proc_id}", json=payload)
                assert resp.status_code == 200, f"[{label}] PUT failed: {resp.text}"

                # Wait for the WS update where restart_required flipped True.
                # Background sync_to_db chains can emit out-of-order broadcasts
                # carrying stale entity state; the predicate filters those out.
                msg = _wait_for_proc_update(
                    ws, proc_id, matches=lambda d: d.get("restart_required") is True,
                )
                assert msg["data"]["restart_required"] is True, label

                # Simulate a successful restart: resync hash + clear flag.
                _resync_hash(tc, proc_id)
                msg = _wait_for_proc_update(
                    ws, proc_id, matches=lambda d: d.get("restart_required") is False,
                )
                assert msg["data"]["restart_required"] is False, (
                    f"[{label}] flag did not clear after restart"
                )


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize(
    "worker_type,label,payload",
    NEGATIVE_CASES,
    ids=[f"{worker_type}:{label}" for worker_type, label, _ in NEGATIVE_CASES],
)
def test_negative_field_does_not_flip(worker_type: str, label: str, payload: dict[str, Any]):
    """Mutating a non-tracked field must NOT flip restart_required."""
    from starlette.testclient import TestClient
    from flow_sdk.server.app import app

    with TestClient(app) as tc:
        proc_id = _setup_running_process(tc, worker_type)

        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"

            resp = tc.post(
                f"/api/v1/graph/agentic_process/{proc_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200

            # Mutate the non-tracked field.
            resp = tc.put(f"/api/v1/graph/agentic_process/{proc_id}", json=payload)
            assert resp.status_code == 200, f"[{label}] PUT failed: {resp.text}"

            # Filter to the broadcast that reflects our PUT (the field we wrote
            # appears in the data payload). Background sync_to_db chains may
            # emit additional out-of-order broadcasts that don't reflect our
            # mutation; ignore those.
            field, expected_val = next(iter(payload.items()))

            def _matches(d: dict) -> bool:
                return d.get(field) == expected_val

            msg = _wait_for_proc_update(ws, proc_id, matches=_matches)
            assert msg["data"]["restart_required"] is False, (
                f"[{label}] flag flipped on non-tracked field — should have stayed False"
            )


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize("worker_type", WORKER_TYPES)
def test_not_running_gate_blocks_flip(worker_type: str):
    """When status != RUNNING, mutating a tracked field must NOT flip the flag."""
    from starlette.testclient import TestClient
    from flow_sdk.server.app import app

    with TestClient(app) as tc:

        async def _create() -> str:
            from flow_sdk.builtin.agentic_process import AgenticProcess
            proc = AgenticProcess(id=str(uuid.uuid4()), worker_type=worker_type)
            await proc.save()
            return proc.id

        proc_id = asyncio.run(_create())

        # status defaults to "new"; explicitly seed last_started_hash so the
        # only thing keeping the flag at False is the RUNNING gate.
        resp = tc.put(
            f"/api/v1/graph/agentic_process/{proc_id}",
            json={"last_started_hash": "STALE_HASH"},
        )
        assert resp.status_code == 200

        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"
            resp = tc.post(
                f"/api/v1/graph/agentic_process/{proc_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200

            # Tracked-field mutation. status is NEW so the gate blocks the flip.
            resp = tc.put(
                f"/api/v1/graph/agentic_process/{proc_id}",
                json={"cli_config": {"model": "restart-gate-model"}},
            )
            assert resp.status_code == 200

            msg = _wait_for_proc_update(
                ws, proc_id,
                matches=lambda d: (d.get("cli_config") or {}).get("model") == "restart-gate-model",
            )
            assert msg["data"]["restart_required"] is False, (
                "Process not running — flag should not flip"
            )


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize("worker_type", WORKER_TYPES)
def test_external_set_via_api(worker_type: str):
    """External callers can set restart_required directly via PUT (e.g. signaling
    that an external dependency changed). The save-hook only flips ON; clearing
    is at the caller's discretion."""
    from starlette.testclient import TestClient
    from flow_sdk.server.app import app

    with TestClient(app) as tc:

        async def _create() -> str:
            from flow_sdk.builtin.agentic_process import AgenticProcess
            proc = AgenticProcess(id=str(uuid.uuid4()), worker_type=worker_type)
            await proc.save()
            return proc.id

        proc_id = asyncio.run(_create())

        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"
            resp = tc.post(
                f"/api/v1/graph/agentic_process/{proc_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200

            # Force flag ON via API.
            resp = tc.put(
                f"/api/v1/graph/agentic_process/{proc_id}",
                json={"restart_required": True},
            )
            assert resp.status_code == 200
            msg = _wait_for_proc_update(
                ws, proc_id, matches=lambda d: d.get("restart_required") is True,
            )
            assert msg["data"]["restart_required"] is True

            # Force flag OFF via API.
            resp = tc.put(
                f"/api/v1/graph/agentic_process/{proc_id}",
                json={"restart_required": False},
            )
            assert resp.status_code == 200
            msg = _wait_for_proc_update(
                ws, proc_id, matches=lambda d: d.get("restart_required") is False,
            )
            assert msg["data"]["restart_required"] is False


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize("worker_type", WORKER_TYPES)
def test_no_op_save_does_not_flip(worker_type: str):
    """Saving with no actual config change must not flip the flag."""
    from starlette.testclient import TestClient
    from flow_sdk.server.app import app

    with TestClient(app) as tc:
        proc_id = _setup_running_process(tc, worker_type)
        # Bring last_started_hash in sync with current state so a no-op save
        # does not mismatch the snapshot.
        _resync_hash(tc, proc_id)

        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"
            resp = tc.post(
                f"/api/v1/graph/agentic_process/{proc_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200

            # No-op save: PUT a metadata field that doesn't change worker state,
            # and isn't even different from the current value.
            resp = tc.put(
                f"/api/v1/graph/agentic_process/{proc_id}",
                json={"name": "noop"},
            )
            assert resp.status_code == 200
            msg = _wait_for_proc_update(
                ws, proc_id, matches=lambda d: d.get("name") == "noop",
            )
            assert msg["data"]["restart_required"] is False


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize("worker_type", WORKER_TYPES)
def test_two_consecutive_mutations_stays_true(worker_type: str):
    """Two tracked mutations without a restart between: flag stays True."""
    from starlette.testclient import TestClient
    from flow_sdk.server.app import app

    with TestClient(app) as tc:
        proc_id = _setup_running_process(tc, worker_type)

        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"
            resp = tc.post(
                f"/api/v1/graph/agentic_process/{proc_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200

            tc.put(
                f"/api/v1/graph/agentic_process/{proc_id}",
                json={"workdir": "/tmp/restart_required_first"},
            )
            msg = _wait_for_proc_update(
                ws, proc_id,
                matches=lambda d: d.get("workdir") == "/tmp/restart_required_first",
            )
            assert msg["data"]["restart_required"] is True

            # Second mutation without a restart in between.
            tc.put(
                f"/api/v1/graph/agentic_process/{proc_id}",
                json={"additional_dirs": ["/tmp/restart_required_second"]},
            )
            msg = _wait_for_proc_update(
                ws, proc_id,
                matches=lambda d: d.get("additional_dirs") == ["/tmp/restart_required_second"],
            )
            assert msg["data"]["restart_required"] is True


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize("worker_type", WORKER_TYPES)
def test_in_start_lifecycle_suppresses_hook(worker_type: str):
    """While ``_in_start_lifecycle`` is True, save() must NOT auto-flip
    restart_required even if the snapshot differs. This is the guard the
    real ``start()`` uses to suppress its own intermediate saves.
    """
    async def _drive():
        from flow_sdk.builtin.agentic_process import AgenticProcess

        proc = AgenticProcess(id=str(uuid.uuid4()), worker_type=worker_type)
        await proc.save()

        # Force RUNNING with stale hash so ANY save would normally flip the flag.
        proc.status = "running"
        proc.last_started_hash = "STALE"
        proc.restart_required = False
        proc._set_start_lifecycle(True)
        try:
            # Even with a snapshot mismatch, the guard suppresses the flip.
            proc.workdir = "/tmp/restart_required_lifecycle_1"
            await proc.save()
            assert proc.restart_required is False, (
                "save inside start_lifecycle should not flip the flag"
            )
        finally:
            proc._set_start_lifecycle(False)

        # Once outside the lifecycle, the next save flips it.
        proc.workdir = "/tmp/restart_required_lifecycle_2"
        await proc.save()
        assert proc.restart_required is True, (
            "save outside start_lifecycle with mismatched snapshot must flip"
        )

    asyncio.run(_drive())
