"""A4 pinning test — the mid-turn 409 guard covers BOTH ``switch-mode``
directions AND ``restart``.

Interface invariant #3 (docs/interface/README.md): a prompt turn in flight ⇒ 409
on ``switch-mode`` and ``restart`` — tearing a worker down or spawning a second one
while a turn is in flight would put two workers on one transcript / drop the turn.

Pre-fix only ``switch-mode``→CLI carried the guard (inside ``_enter_cli_mode``);
``switch-mode``→interactive and ``restart`` had none. This drives the HTTP actions
through the in-process app (real entity, real dispatch) and holds the real
per-process prompt lock to simulate an in-flight turn — no mocks.
"""

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_LOCKS
from flow_sdk.responses.response import ApiResponse


async def _create_process(client) -> str:
    resp = await client.post(
        "/api/v1/graph/agentic_process",
        json={"worker_type": "claude_code"},
    )
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data["id"]


@pytest.mark.asyncio
async def test_switch_mode_and_restart_409_while_prompt_in_flight(bootstrapped_client):
    pid = await _create_process(bootstrapped_client)
    base = f"/api/v1/graph/agentic_process/{pid}"

    # Simulate an in-flight prompt turn by holding the real per-process lock the
    # prompt path acquires (same module-level registry the handler checks).
    lock = _PROMPT_LOCKS[pid]
    await lock.acquire()
    try:
        for body in ({"mode": "interactive"}, {"mode": "cli"}):
            resp = await bootstrapped_client.post(f"{base}/switch-mode", json=body)
            assert resp.status_code == 409, (body, resp.status_code, resp.text)

        resp = await bootstrapped_client.post(f"{base}/restart", json={})
        assert resp.status_code == 409, (resp.status_code, resp.text)
    finally:
        lock.release()

    # Lock released → the guard no longer blocks. The cli direction is cheap on a
    # freshly created process (no shell/worker to tear down — it just persists the
    # headless transport intent), so "allowed" is observable without a real spawn.
    resp = await bootstrapped_client.post(f"{base}/switch-mode", json={"mode": "cli"})
    assert resp.status_code != 409, resp.text
