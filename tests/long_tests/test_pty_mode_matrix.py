"""Both-transport matrix for the ``pty_mode`` flag — every vendor, both modes.

The `pty_mode` flag selects the transport an AgenticProcess runs with WITHOUT
changing its interface: ``pty_mode=true`` → interactive PTY (``visible=true``),
``pty_mode=false`` → headless JSON-stream (``visible=false``). Routing stays
``headless == !visible``. A caller does the SAME thing in both modes — create,
``prompt``, read flow frames — so the SAME assertion must hold for both.

This is a NEW test (no existing test is edited); existing tests keep running in
PTY via the ``pty_mode`` default of true. Drives the running hub (same as
``test_agentic_process_prompt_streaming``) so it exercises the real CLIs.

Gated on ``DEEP_TESTING=true``; skips if the hub is unreachable or a vendor's
CLI binary isn't installed. Point at a dedicated instance to avoid the main
backend:

    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:6007 \
        uv run pytest tests/long_tests/test_pty_mode_matrix.py -v -s
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil

import httpx
import pytest

from tests.long_tests._model_tier import small_model_for
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

# No hardcoded default: a long/e2e test must NEVER silently target the main
# dev backend (its loaded DB makes createProcess pathologically slow and the
# port is environment-specific). Require an explicit dedicated-instance URL;
# the fixture skips with a clear message when it is unset.
HUB_URL = os.environ.get("FLOWPAD_HUB_URL")

# worker_type → CLI binary that must be on PATH for that vendor's rows to run.
_VENDOR_BINARY = {
    "claude_code": "claude",
    "codex": "codex",
    "copilot": "copilot",
}

_TURN_ONE_REPLY = "FLOWPAD_TURN_ONE_PONG"
_TURN_TWO_REPLY = "FLOWPAD_TURN_TWO_PONG"
_TURN_ONE_PROMPT = f'Respond with exactly "{_TURN_ONE_REPLY}" and nothing else.'
_TURN_TWO_PROMPT = f'Respond with exactly "{_TURN_TWO_REPLY}" and nothing else.'


@pytest.fixture
async def hub_and_node():
    """Yields (httpx.AsyncClient, compute_node_id). Skips if hub isn't reachable."""
    if not HUB_URL:
        pytest.skip(
            "FLOWPAD_HUB_URL not set — point this e2e test at a DEDICATED instance "
            "(scripts/instance_ctl.sh launch <name>), never the main dev backend."
        )
    client = httpx.AsyncClient(base_url=HUB_URL, timeout=httpx.Timeout(10.0, read=25.0))
    try:
        try:
            r = await client.get("/api/v1/graph/bootstrap", params={"domain": "localhost"})
        except httpx.ConnectError:
            await client.aclose()
            pytest.skip(f"hub not reachable at {HUB_URL}")
        if r.status_code != 200:
            await client.aclose()
            pytest.skip(f"hub bootstrap {r.status_code}")
        data = r.json().get("data") or {}
        node = data.get("default_compute_node") or {}
        cnid = node.get("id")
        if not cnid:
            await client.aclose()
            pytest.skip("no default compute node in bootstrap")
        yield client, cnid
    finally:
        await client.aclose()


def _require_binary(worker_type: str) -> None:
    binary = _VENDOR_BINARY[worker_type]
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} CLI not installed — skipping {worker_type} rows")


async def _create(hub_client, compute_node_id: str, workdir: str, worker_type: str, pty_mode: bool) -> dict:
    """Create a process in the requested transport. Returns the process row."""
    context = {
        "workdir": workdir,
        "worker_type": worker_type,
        "permission_mode": "bypassPermissions",
    }
    model = small_model_for(worker_type)
    if model:
        context["model"] = model
    body = {
        "context": context,
        # headless == !visible; pty_mode seeds visible at launch (see plan).
        "visible": pty_mode,
        "pty_mode": pty_mode,
    }
    r = await hub_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json=body,
    )
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:400]}"
    pid = (r.json().get("data") or r.json())["id"]
    # createProcess returns the full authoritative entity. GET it independently
    # to confirm the transport fields persisted before exercising the live worker.
    g = await hub_client.get(f"/api/v1/graph/agentic_process/{pid}")
    assert g.status_code == 200, f"get process {g.status_code}: {g.text[:300]}"
    return g.json().get("data") or g.json()


def _has_exact_assistant_reply(received: bytes, expected_reply: str) -> bool:
    """True only for a complete assistant chat frame with the exact reply."""
    pattern = (
        rb'<flow-chat\b(?=[^>]*\brole="assistant")[^>]*>'
        + re.escape(expected_reply.encode("utf-8"))
        + rb"</flow-chat>"
    )
    return re.search(pattern, received, re.DOTALL) is not None


def _skip_if_worker_unavailable(received: bytes, worker_type: str) -> None:
    """Skip when the PROVIDER says it cannot serve the turn (quota / rate limit).

    Keyed on the normalized ``worker-unavailable`` frame the driver emits from
    the vendor's own error event — never on a merely missing reply. A transport
    or parsing regression produces no such frame and still fails red.
    """
    # Cheap membership test first: the regex rescans the whole accumulated
    # buffer, and this runs on every chunk.
    if b"</flow-worker-unavailable>" not in received:
        return
    match = re.search(
        rb"<flow-worker-unavailable\b[^>]*>.*?</flow-worker-unavailable>",
        received,
        re.DOTALL,
    )
    if match is None:
        return
    frame = match.group(0).decode("utf-8", errors="replace")
    pytest.skip(
        f"{worker_type} CLI is provider-unavailable (account quota / rate "
        f"limit) — external infra, not a transport regression: {frame[:300]}"
    )


def _raise_on_result_before_reply(received: bytes, expected_reply: str) -> None:
    """A result before assistant content is terminal, never proof of a turn."""
    match = re.search(rb"<flow-result\b[^>]*>.*?</flow-result>", received, re.DOTALL)
    if match is not None:
        frame = match.group(0).decode("utf-8", errors="replace")
        raise AssertionError(
            f"turn ended before assistant replied with {expected_reply!r}: {frame[:300]}"
        )


async def _prompt_until_assistant(
    hub_client, process_id: str, message: str, expected_reply: str, worker_type: str
) -> str:
    """Send a prompt; return only after its exact assistant chat frame arrives.

    A startup interstitial used to produce a synthetic successful result with
    no user or assistant transcript rows. Rejecting a result before the exact
    assistant response makes that failure visible instead of accepting any
    unrelated ``flow-*`` frame.
    """
    received = b""
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{process_id}/prompt",
        json={"message": message},
    ) as r:
        assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:300]}"
        async for chunk in r.aiter_bytes():
            received += chunk
            if _has_exact_assistant_reply(received, expected_reply):
                break
            _skip_if_worker_unavailable(received, worker_type)
            _raise_on_result_before_reply(received, expected_reply)
    _skip_if_worker_unavailable(received, worker_type)
    return received.decode("utf-8", errors="replace")


async def _send_turn(
    hub_client, process_id: str, message: str, expected_reply: str, worker_type: str
) -> str:
    """Transport-agnostic turn: read through noise to the exact assistant reply.

    Retries on the 409 "another prompt turn is already in flight" — the PRIOR
    turn is still running (a PTY stream never closes, so we can't drain it; we
    break early and just wait for the worker to free up). A 409 that is NOT an
    in-flight race (e.g. ``status=failed``) is a real error and re-raised.
    Bounded so a wedged turn fails the test rather than hanging past the cap.
    """
    deadline_attempts = 20
    for _ in range(deadline_attempts):
        received = b""
        async with hub_client.stream(
            "POST",
            f"/api/v1/graph/agentic_process/{process_id}/prompt",
            json={"message": message},
        ) as r:
            if r.status_code == 409:
                txt = (await r.aread()).decode()
                if "already in flight" in txt:
                    await asyncio.sleep(1.0)
                    continue
                raise AssertionError(f"prompt 409 (not an in-flight race): {txt[:200]}")
            assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:300]}"
            async for chunk in r.aiter_bytes():
                received += chunk
                if _has_exact_assistant_reply(received, expected_reply):
                    return received.decode("utf-8", errors="replace")
                _skip_if_worker_unavailable(received, worker_type)
                _raise_on_result_before_reply(received, expected_reply)
        # Stream closed with no expected reply — let the worker settle and retry.
        _skip_if_worker_unavailable(received, worker_type)
        await asyncio.sleep(1.0)
    raise AssertionError(
        f"no assistant reply {expected_reply!r} after {deadline_attempts} attempts on {process_id}"
    )


async def _settle_session_id(hub_client, process_id: str) -> str | None:
    """Poll the process row until a session_id is persisted (or give up)."""
    for _ in range(15):
        r = await hub_client.get(f"/api/v1/graph/agentic_process/{process_id}")
        sid = (r.json().get("data") or r.json()).get("session_id")
        if sid:
            return sid
        await asyncio.sleep(1.0)
    return None


async def _full_transcript(hub_client, process_id: str) -> dict:
    """Read the normalized provider transcript after streamed content landed."""
    r = await hub_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/transcript/full",
        json={},
    )
    assert r.status_code == 200, f"transcript/full {r.status_code}: {r.text[:300]}"
    return r.json().get("data") or r.json()


def _assert_two_real_turns(transcript: dict, session_id: str) -> None:
    """Prove two distinct user→assistant exchanges in one provider session."""
    entries = [e for e in transcript.get("entries") or [] if not e.get("is_sidechain")]
    users = [
        (index, entry)
        for index, entry in enumerate(entries)
        if entry.get("kind") == "user_message" and not entry.get("is_meta")
    ]
    assert [entry.get("text") for _, entry in users] == [
        _TURN_ONE_PROMPT,
        _TURN_TWO_PROMPT,
    ], f"unexpected real user turns: {[entry.get('text') for _, entry in users]}"

    (user1_index, user1), (user2_index, user2) = users
    assistant1 = next(
        (
            (index, entry)
            for index, entry in enumerate(entries)
            if user1_index < index < user2_index
            and entry.get("kind") == "assistant_message"
            and str(entry.get("text") or "").strip() == _TURN_ONE_REPLY
        ),
        None,
    )
    assistant2 = next(
        (
            (index, entry)
            for index, entry in enumerate(entries)
            if index > user2_index
            and entry.get("kind") == "assistant_message"
            and str(entry.get("text") or "").strip() == _TURN_TWO_REPLY
        ),
        None,
    )
    assert assistant1 is not None, "turn 1 has no exact assistant response before turn 2"
    assert assistant2 is not None, "turn 2 has no exact assistant response after its user row"

    relevant = [user1, assistant1[1], user2, assistant2[1]]
    assert transcript.get("session_id") == session_id
    assert all(entry.get("session_id") == session_id for entry in relevant)
    assert len({entry.get("id") for entry in relevant}) == 4, "turn rows must be distinct"


@pytest.mark.parametrize("worker_type", ["claude_code", "codex", "copilot"])
@pytest.mark.parametrize("pty_mode", [True, False], ids=["pty", "headless"])
async def test_prompt_streams_in_both_transports(hub_and_node, tmp_path, worker_type, pty_mode):
    """The SAME create→prompt→flow-frame flow works in PTY and headless, per vendor.

    Mode-agnostic assertion (flow-* frames, not terminal bytes) so it holds for
    both transports — the whole point of `pty_mode` keeping the interface identical.
    """
    _require_binary(worker_type)
    hub_client, cnid = hub_and_node

    proc = await _create(hub_client, cnid, str(tmp_path), worker_type, pty_mode)
    pid = proc["id"]
    # The persisted transport intent must reflect the request.
    assert proc.get("pty_mode", True) is pty_mode, f"pty_mode not persisted: {proc.get('pty_mode')}"

    xml = await _prompt_until_assistant(
        hub_client, pid, _TURN_ONE_PROMPT, _TURN_ONE_REPLY, worker_type
    )
    assert _TURN_ONE_REPLY in xml, (
        f"{worker_type}/{'pty' if pty_mode else 'headless'}: "
        f"no exact assistant reply: {xml[:300]}"
    )


@pytest.mark.parametrize("worker_type", ["claude_code", "codex", "copilot"])
@pytest.mark.parametrize("pty_mode", [True, False], ids=["pty", "headless"])
async def test_multi_turn_resumes_same_session(hub_and_node, tmp_path, worker_type, pty_mode):
    """Two turns on one process stream in both modes, and the session_id is stable.

    This is where headless resume can regress (e.g. a vendor whose resume gate
    only checks the global rollout dir, not the per-process headless transcript):
    turn 2 would start fresh and split history.
    """
    _require_binary(worker_type)
    hub_client, cnid = hub_and_node

    proc = await _create(hub_client, cnid, str(tmp_path), worker_type, pty_mode)
    pid = proc["id"]

    xml1 = await _send_turn(
        hub_client, pid, _TURN_ONE_PROMPT, _TURN_ONE_REPLY, worker_type
    )
    assert _TURN_ONE_REPLY in xml1, f"turn1 missing exact assistant reply: {xml1[:200]}"

    sid1 = await _settle_session_id(hub_client, pid)
    assert sid1, "turn 1 did not establish a session_id"

    # _send_turn retries on the in-flight 409 until turn 1 frees the worker.
    xml2 = await _send_turn(
        hub_client, pid, _TURN_TWO_PROMPT, _TURN_TWO_REPLY, worker_type
    )
    assert _TURN_TWO_REPLY in xml2, f"turn2 missing exact assistant reply: {xml2[:200]}"

    sid2 = await _settle_session_id(hub_client, pid)
    assert sid2 == sid1, (
        f"{worker_type}/{'pty' if pty_mode else 'headless'}: session_id changed across turns "
        f"({sid1} → {sid2}) — turn 2 started a fresh session instead of resuming"
    )

    transcript = await _full_transcript(hub_client, pid)
    _assert_two_real_turns(transcript, sid1)
