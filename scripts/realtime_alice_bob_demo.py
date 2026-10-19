#!/usr/bin/env python3
"""Phase 2 demo: realtime alice ↔ bob conversation via authenticated hub WebSocket.

Drives the three-state delivery receipts (created → delivered → received)
end-to-end against a real hub. Two actors connect directly to the hub WS with
Bearer auth and exchange text-only FlowMessages — proves Phase 1 hub work is
correct without needing the local server in the loop. Local-server bridge
integration is exercised in Phase 3 (UI sends route through HubWsBridge).

Usage:
    # Make sure a local hub is running at $FLOWPAD_HUB_URL (default 8093)
    uv run python scripts/realtime_alice_bob_demo.py

Env vars:
    FLOWPAD_HUB_URL     hub base URL (default http://localhost:8093)
    DEMO_ALICE_EMAIL    default alice@local.test
    DEMO_ALICE_PW       default alice-pw-1234
    DEMO_BOB_EMAIL      default bob@local.test
    DEMO_BOB_PW         default bob-pw-1234

Exit 0 = all assertions passed. Exit 1 = a step failed. Total runtime under 30s.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any, Callable

import httpx
import websockets


HUB_URL = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093").rstrip("/")
API_BASE = f"{HUB_URL}/api/v1"
ALICE_EMAIL = os.environ.get("DEMO_ALICE_EMAIL", "alice@local.test")
ALICE_PW = os.environ.get("DEMO_ALICE_PW", "alice-pw-1234")
BOB_EMAIL = os.environ.get("DEMO_BOB_EMAIL", "bob@local.test")
BOB_PW = os.environ.get("DEMO_BOB_PW", "bob-pw-1234")


async def _signup_if_missing(client: httpx.AsyncClient, email: str, password: str, first_name: str) -> None:
    try:
        await client.post(
            f"{API_BASE}/signup",
            json={"email": email, "password": password, "first_name": first_name, "last_name": "Local"},
        )
    except Exception:
        pass


async def _login(client: httpx.AsyncClient, email: str, password: str) -> tuple[str, str]:
    resp = await client.post(f"{API_BASE}/login", json={"email": email, "password": password})
    if resp.status_code != 200:
        raise RuntimeError(f"login {email} failed: {resp.status_code} {resp.text}")
    body = resp.json()
    data = body.get("data") or {}
    token = data.get("token")
    user = data.get("user") or {}
    user_id = user.get("id")
    if not token or not user_id:
        raise RuntimeError(f"login {email} returned bad data: {body}")
    return token, user_id


async def _create_project(client: httpx.AsyncClient, alice_token: str, title: str = "realtime-demo") -> str:
    resp = await client.post(
        f"{API_BASE}/graph/project",
        json={"title": title},
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    if resp.status_code != 200:
        raise RuntimeError(f"create project failed: {resp.status_code} {resp.text}")
    project_id = ((resp.json() or {}).get("data") or {}).get("id")
    if not project_id:
        raise RuntimeError(f"create project returned no id: {resp.text}")
    return project_id


async def _enable_guest(client: httpx.AsyncClient, alice_token: str, project_id: str) -> None:
    resp = await client.post(
        f"{API_BASE}/graph/project/{project_id}/enable_guest_conversations",
        json={"enabled": True},
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    if resp.status_code != 200:
        raise RuntimeError(f"enable_guest failed: {resp.status_code} {resp.text}")


def _ws_url(connection_id: str) -> str:
    base = HUB_URL.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/api/v1/connect/ws/{connection_id}"


async def _open_ws(token: str, connection_id: str):
    return await websockets.connect(
        _ws_url(connection_id),
        additional_headers={"Authorization": f"Bearer {token}"},
        open_timeout=10.0,
    )


async def _drain_until(ws, predicate: Callable[[dict], bool], timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise asyncio.TimeoutError(f"predicate not satisfied within {timeout}s")
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        if not isinstance(raw, str):
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and predicate(obj):
            return obj


def _is_response_for(message_id: str) -> Callable[[dict], bool]:
    """Match the hub's response to a rest_api_msg.

    The hub sends the raw ``ApiResponse.model_dump()`` (status/data/message/request_id)
    without wrapping in a ``response_msg`` envelope; ``request_id`` is the
    correlation key. Local servers do wrap in ``response_msg`` with
    ``response_message_id``, so check both shapes.
    """
    def _check(obj: dict) -> bool:
        if obj.get("request_id") == message_id:
            return True
        if obj.get("message_type") == "response_msg":
            return obj.get("response_message_id") == message_id or obj.get("message_id") == message_id
        return False
    return _check


def _unwrap_response_data(resp: dict) -> dict:
    """Unwrap either the local ``response_msg`` envelope or the raw hub
    ``ApiResponse`` shape into the inner ``data`` dict."""
    # Hub raw form: {"status": "...", "data": {...}, "request_id": "..."}
    if "request_id" in resp and "data" in resp and resp.get("message_type") != "response_msg":
        return resp["data"] if isinstance(resp["data"], dict) else {}
    # Local response_msg envelope: {"message_type": "response_msg", "content": {...}}
    content = resp.get("content")
    if isinstance(content, dict) and "data" in content:
        return content["data"] if isinstance(content["data"], dict) else {}
    if isinstance(content, dict):
        return content
    if "data" in resp and isinstance(resp["data"], dict):
        return resp["data"]
    return resp


def _to_entity_matches(obj: Any, etype: str, eid: str | None = None) -> bool:
    target = obj.get("to_entity") if isinstance(obj, dict) else None
    if isinstance(target, dict):
        if target.get("type") != etype:
            return False
        if eid and target.get("id") != eid:
            return False
        return True
    if isinstance(target, str):
        for sep in ("-", ":"):
            if target.startswith(f"{etype}{sep}"):
                if eid is None:
                    return True
                return target.split(sep, 1)[1] == eid
    return False


def _is_data_op(op_value: str, etype: str, eid: str | None = None) -> Callable[[dict], bool]:
    def _check(obj: dict) -> bool:
        if obj.get("message_type") != "data_op_msg":
            return False
        if str(obj.get("op", "")).lower() != op_value:
            return False
        return _to_entity_matches(obj, etype, eid)
    return _check


def _extract_to_entity_id(obj: dict) -> str | None:
    target = obj.get("to_entity")
    if isinstance(target, dict):
        return target.get("id")
    if isinstance(target, str):
        for sep in ("-", ":"):
            if sep in target:
                return target.split(sep, 1)[1]
    return None


async def _ws_send_request(ws, payload: dict, timeout: float = 5.0) -> dict:
    payload.setdefault("message_id", str(uuid.uuid4()))
    await ws.send(json.dumps(payload))
    return await _drain_until(ws, _is_response_for(payload["message_id"]), timeout=timeout)


def _make_step_logger():
    durations: list[tuple[str, float, str]] = []

    def log(label: str, t_start: float, status: str = "OK") -> None:
        durations.append((label, (time.monotonic() - t_start) * 1000, status))

    return durations, log


async def _run_demo() -> int:
    durations, log = _make_step_logger()

    async with httpx.AsyncClient(timeout=10.0) as http:
        await _signup_if_missing(http, ALICE_EMAIL, ALICE_PW, "Alice")
        await _signup_if_missing(http, BOB_EMAIL, BOB_PW, "Bob")
        alice_token, alice_id = await _login(http, ALICE_EMAIL, ALICE_PW)
        bob_token, bob_id = await _login(http, BOB_EMAIL, BOB_PW)
        project_id = await _create_project(http, alice_token)
        await _enable_guest(http, alice_token, project_id)

    print(f"alice id: {alice_id}")
    print(f"bob   id: {bob_id}")
    print(f"project : {project_id}")
    print()

    alice_ws = await _open_ws(alice_token, f"alice-{uuid.uuid4()}")
    bob_ws = await _open_ws(bob_token, f"bob-{uuid.uuid4()}")

    try:
        # ---------- (a) start_guest_conversation -> created (1✓) ----------
        t = time.monotonic()
        resp = await _ws_send_request(
            alice_ws,
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "project", "id": project_id},
                "action": "start_guest_conversation",
                "body": {
                    "text": "hi bob",
                    "receiver_address": bob_id,
                    "receiver_address_type": "id",
                },
            },
            timeout=5.0,
        )
        conv_data = _unwrap_response_data(resp)
        conv_id = conv_data.get("id")
        if not conv_id:
            raise RuntimeError(f"start_guest_conversation: missing conversation id in response: {resp}")
        log("a/start_guest_conversation -> created (response_msg)", t)

        # ---------- (b) bob receives data_op_msg(create flow_message) ----------
        t = time.monotonic()
        first_create = await _drain_until(bob_ws, _is_data_op("create", "flow_message"), timeout=5.0)
        fm_id = _extract_to_entity_id(first_create)
        if not fm_id:
            raise RuntimeError(f"bob create: could not extract flow_message id from {first_create}")
        log("b/bob receives create flow_message", t)

        # ---------- (c) bob marks delivered, alice sees update (2✓) ----------
        t = time.monotonic()
        await _ws_send_request(
            bob_ws,
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "direct_resource_type": "flow_message",
                "action": "mark_delivered",
                "body": {"flow_message_ids": [fm_id]},
            },
            timeout=5.0,
        )
        update = await _drain_until(alice_ws, _is_data_op("update", "flow_message", fm_id), timeout=5.0)
        upd_data = update.get("data") or {}
        if upd_data.get("delivery_status") != "delivered":
            raise RuntimeError(f"expected delivery_status=delivered, got {upd_data}")
        log("c/mark_delivered -> alice sees ✓✓", t)

        # ---------- (d) bob marks received, alice sees blue ✓✓ ----------
        t = time.monotonic()
        await _ws_send_request(
            bob_ws,
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "direct_resource_type": "flow_message",
                "action": "mark_received",
                "body": {"flow_message_ids": [fm_id]},
            },
            timeout=5.0,
        )
        await _drain_until(
            alice_ws,
            lambda o: _is_data_op("update", "flow_message", fm_id)(o)
            and (o.get("data") or {}).get("delivery_status") == "received",
            timeout=5.0,
        )
        log("d/mark_received -> alice sees blue ✓✓", t)

        # ---------- (e) symmetric reply: bob -> alice ----------
        t = time.monotonic()
        await _ws_send_request(
            bob_ws,
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "conversation", "id": conv_id},
                "action": "add_message",
                "body": {"text": "ack from bob"},
            },
            timeout=5.0,
        )
        # Alice (the original sender, now recipient of bob's reply) gets the create
        alice_create = await _drain_until(alice_ws, _is_data_op("create", "flow_message"), timeout=5.0)
        bob_reply_fm_id = _extract_to_entity_id(alice_create)
        if not bob_reply_fm_id:
            raise RuntimeError("symmetric reply: alice did not see bob's flow_message create")
        log("e/symmetric reply (bob -> alice) -> alice sees create", t)

    finally:
        await alice_ws.close()
        await bob_ws.close()

    print()
    print(f"{'step':<54}{'ms':>10}  {'status'}")
    print("-" * 76)
    total = 0.0
    for label, ms, status in durations:
        print(f"{label:<54}{ms:>10.1f}  {status}")
        total += ms
    print("-" * 76)
    print(f"{'total':<54}{total:>10.1f}")
    print()
    print("All steps OK ✓")
    return 0


def main() -> int:
    try:
        return asyncio.run(_run_demo())
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"\nDEMO FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
