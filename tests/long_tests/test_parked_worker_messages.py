"""Long test: a chat is not blocked while the agent's background work runs.

The agent starts a background command and ends its turn. ``claude -p`` keeps its process alive
for that work, so the process outlives the turn. Before the worker was taught to park, the turn's
response stream stayed open for as long as the work ran — the chat read as "working", a message the
user typed waited in the queue, and the report of the finished work could not reach them live.

Real everything: the real backend, the real ``claude``, the same ``prompt`` action the chat calls.
Event-based, not clock-based: each claim is read off a marker file the background command writes, so
the test says "the work had not ended yet" instead of guessing how fast a model answers.

Run against a DEDICATED instance (never the main dev backend)::

    scripts/instance_ctl.sh launch dev-1
    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:6001 \\
        uv run pytest tests/long_tests/test_parked_worker_messages.py -v -s
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

HUB_URL = os.environ.get("FLOWPAD_HUB_URL")

#: How long the background command runs. Longer than the two turns below put together, shorter than
#: the suite's own per-test cap — the test ends it early rather than waiting it out.
BACKGROUND_SECONDS = 20


@pytest.fixture
async def hub_and_node():
    if not HUB_URL:
        pytest.skip(
            "FLOWPAD_HUB_URL not set — point this e2e test at a DEDICATED instance "
            "(scripts/instance_ctl.sh launch <name>), never the main dev backend."
        )
    client = httpx.AsyncClient(base_url=HUB_URL, timeout=httpx.Timeout(10.0, read=120.0))
    try:
        try:
            r = await client.get("/api/v1/graph/bootstrap", params={"domain": "localhost"})
        except httpx.ConnectError:
            pytest.skip(f"hub not reachable at {HUB_URL}")
        if r.status_code != 200:
            pytest.skip(f"hub bootstrap {r.status_code}")
        node_id = ((r.json().get("data") or {}).get("default_compute_node") or {}).get("id")
        if not node_id:
            pytest.skip("no default compute node in bootstrap")
        yield client, node_id
    finally:
        await client.aclose()


async def _create_print_mode_process(client: httpx.AsyncClient, node_id: str, workdir: str) -> str:
    r = await client.post(
        f"/api/v1/graph/compute_node/{node_id}/createProcess",
        json={
            "context": {
                "workdir": workdir,
                "output_format": "stream-json",
                "permission_mode": "bypassPermissions",
                "model": ModelTier.SM.value,
            },
            "visible": False,
            "pty_mode": False,
        },
    )
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:500]}"
    payload = r.json()
    return (payload.get("data") or payload)["id"]


async def _prompt(client: httpx.AsyncClient, process_id: str, message: str) -> tuple[int, str]:
    """Send one message the way the chat does and read its response stream to the end."""
    body = b""
    async with client.stream(
        "POST", f"/api/v1/graph/agentic_process/{process_id}/prompt", json={"message": message}
    ) as r:
        status = r.status_code
        async for chunk in r.aiter_bytes():
            body += chunk
    return status, body.decode("utf-8", errors="replace")


async def _field(client: httpx.AsyncClient, process_id: str, name: str) -> bool:
    r = await client.get(f"/api/v1/graph/agentic_process/{process_id}")
    payload = r.json()
    return bool((payload.get("data") or payload).get(name))


async def _busy(client: httpx.AsyncClient, process_id: str) -> bool:
    return await _field(client, process_id, "busy")


async def test_a_message_sent_while_background_work_runs_is_answered_and_not_blocked(hub_and_node, run_workdir):
    client, node_id = hub_and_node
    workdir = Path(run_workdir)
    started, finished = workdir / "bg-started", workdir / "bg-finished"
    process_id = await _create_print_mode_process(client, node_id, str(workdir))
    first_turn = asyncio.create_task(
        _prompt(
            client,
            process_id,
            "Call the Bash tool once with run_in_background=true and this command, exactly:\n"
            f"bash -c 'echo started > {started}; sleep {BACKGROUND_SECONDS}; echo done > {finished}'\n"
            "Do not wait for it or check it. Then reply with the single word: started",
        )
    )

    try:
        # Wait for whichever comes first: the turn's response ends, or the background work does.
        # Not a budget — both are events the run itself produces. A chat that blocks until the work
        # ends shows up as the second one, and that is the failure this test exists to name.
        while not first_turn.done() and not finished.exists():
            await asyncio.sleep(0.2)
        assert first_turn.done(), (
            "the background work ended while the turn's response was still open: "
            "the chat stayed blocked for as long as the work ran"
        )
        status, _ = first_turn.result()
        assert status == 200
        assert started.exists(), "the agent never launched the background command — nothing here was exercised"
        assert not finished.exists(), "the turn's response only ended once the background work had"
        assert not await _busy(client, process_id), "a process waiting on background work reads as busy"

        # The user types while the work runs: accepted (not 409) and answered by the same process.
        status, reply = await _prompt(client, process_id, "Reply with exactly the single word: pong")
        assert status == 200, f"a message sent while background work runs was refused ({status})"
        assert "pong" in reply.lower()
        assert not finished.exists(), "the reply only arrived after the background work ended"
    finally:
        first_turn.cancel()
        # Ends the CLI and the background command with it, instead of waiting out the sleep.
        await client.post(f"/api/v1/graph/agentic_process/{process_id}/exit", json={})


async def test_stopping_background_work_ends_the_process_and_the_work_and_the_chat_carries_on(
    hub_and_node, run_workdir
):
    """Nothing in the chat could end the process a parked worker keeps alive for background work. The stop ends
    it AND the work (the command's own pid is gone), is not an error, and the next message just starts a worker."""
    client, node_id = hub_and_node
    workdir = Path(run_workdir)
    pid_file, finished = workdir / "bg-pid", workdir / "bg-finished"
    process_id = await _create_print_mode_process(client, node_id, str(workdir))

    try:
        status, _ = await _prompt(
            client,
            process_id,
            "Call the Bash tool once with run_in_background=true and this command, exactly:\n"
            f"bash -c 'echo $$ > {pid_file}; sleep {BACKGROUND_SECONDS}; echo done > {finished}'\n"
            "Do not wait for it or check it. Then reply with the single word: started",
        )
        assert status == 200
        assert pid_file.exists(), "the agent never launched the background command — nothing here was exercised"
        work_pid = int(pid_file.read_text().strip())
        os.kill(work_pid, 0)  # alive: raises if it is not

        # The chat is free, and says what is holding the process — that is what the composer's chip reads.
        assert not await _busy(client, process_id)
        assert await _field(client, process_id, "background_work"), "a parked worker did not report background work"

        r = await client.post(f"/api/v1/graph/agentic_process/{process_id}/stop-background", json={})
        assert r.status_code == 200, f"stop-background refused: {r.status_code} {r.text[:200]}"

        # Gone with the process: the command is dead and nothing claims background work any more.
        assert not await _field(client, process_id, "background_work")
        with pytest.raises(ProcessLookupError):
            os.kill(work_pid, 0)
        assert not finished.exists()

        # Stopping again is refused, not an error the user sees: there is nothing left to stop.
        r = await client.post(f"/api/v1/graph/agentic_process/{process_id}/stop-background", json={})
        assert r.status_code == 409

        # The conversation goes on: this message starts a fresh worker on the same session.
        status, reply = await _prompt(client, process_id, "Reply with exactly the single word: pong")
        assert status == 200 and "pong" in reply.lower()
    finally:
        await client.post(f"/api/v1/graph/agentic_process/{process_id}/exit", json={})
