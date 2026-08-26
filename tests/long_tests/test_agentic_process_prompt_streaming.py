"""Long-running E2E test for ``AgenticProcess.prompt`` — hits the running hub.

Rather than bootstrap an in-process ASGI test client (the bootstrap path scans
filesystem for markdown records which hangs on transient paths under
``/private/tmp/claude-501/…``), this test drives the **already-running hub on
localhost:9008** — the same hub the UI uses. That's also what the user sees,
so it's the most realistic validation.

Gated on:
  - ``DEEP_TESTING=true`` env var (requires Claude CLI + network)
  - ``FLOWPAD_HUB_URL`` env var (defaults to ``http://localhost:9008``). If the
    hub isn't reachable, the test skips rather than fails.

Run:

    DEEP_TESTING=true uv run pytest tests/long_tests/test_agentic_process_prompt_streaming.py -v -s
"""

from __future__ import annotations

import json
import os
import re
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

# No hardcoded default: a long/e2e test must NEVER silently target the main
# dev backend (its loaded DB makes createProcess pathologically slow and the
# port is environment-specific). Require an explicit dedicated-instance URL;
# the fixture skips with a clear message when it is unset.
HUB_URL = os.environ.get("FLOWPAD_HUB_URL")


@pytest.fixture
async def hub_and_node():
    """Yields (httpx.AsyncClient, compute_node_id). Skips if hub isn't reachable."""
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


async def _create_print_mode_process(hub_client, compute_node_id: str, workdir: str) -> str:
    body = {
        "context": {
            "workdir": workdir,
            "output_format": "stream-json",
            "permission_mode": "bypassPermissions",
            "model": ModelTier.SM.value,
        },
        "visible": False,
        # pty_mode is the durable transport selector (defaults to True since the
        # commit-624ddb89 routing refactor decoupled transport from `visible`).
        # Print-mode streaming (the flow-status/flow-chat/flow-end worker frames
        # this test asserts) is reached only when pty_mode is False; visible=False
        # alone now yields the PTY transcript-entry stream.
        "pty_mode": False,
    }
    r = await hub_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json=body,
    )
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:500]}"
    payload = r.json()
    proc = payload.get("data") or payload
    pid = proc.get("id")
    assert pid, f"no process id in payload: {payload}"
    return pid


async def test_prompt_streams_xml_flowdata_for_trivial_turn(hub_and_node, tmp_path):
    """Send a one-word prompt, assert flow-status + flow-chat + flow-end arrive."""
    hub_client, local_compute_node_id = hub_and_node
    process_id = await _create_print_mode_process(hub_client, local_compute_node_id, str(tmp_path))

    body = b""
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{process_id}/prompt",
        json={"message": 'Respond with exactly the single word "pong" and nothing else.'},
    ) as r:
        assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:400]}"
        async for chunk in r.aiter_bytes():
            body += chunk

    xml = body.decode("utf-8", errors="replace")
    assert "<flow-status" in xml, f"no status frame: {xml[:400]}"
    assert "<flow-chat" in xml, f"no chat frame: {xml[:400]}"
    assert "<flow-end" in xml, f"no end frame: {xml[:400]}"

    close_tags = re.findall(r"</flow-[a-z-]+>", xml)
    assert close_tags, "no flow-* closing tags"
    assert close_tags[-1] == "</flow-end>", f"stream did not close with flow-end: last={close_tags[-1]}"


async def test_prompt_admits_visible_process_via_pty_transport(hub_and_node, tmp_path):
    """visible=true (PTY) processes are admitted to the unified prompt action.

    The prompt action is a single endpoint with two transports keyed off
    ``visible`` (the tabs/chat unification): ``visible=False`` streams a
    print-mode worker's stdout, ``visible=True`` streams the PTY session
    transcript (``_run_pty_prompt``). Both return a 200 streaming response —
    the older "PTY processes reject with 409" contract no longer holds.
    """
    hub_client, local_compute_node_id = hub_and_node
    body = {
        "context": {
            "workdir": str(tmp_path),
            "permission_mode": "bypassPermissions",
            "model": ModelTier.SM.value,
        },
        "visible": True,
    }
    r = await hub_client.post(
        f"/api/v1/graph/compute_node/{local_compute_node_id}/createProcess",
        json=body,
    )
    assert r.status_code == 200
    pid = (r.json().get("data") or r.json())["id"]

    received = b""
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{pid}/prompt",
        json={"message": 'Respond with exactly the single word "pong" and nothing else.'},
    ) as r2:
        assert r2.status_code == 200, (
            f"visible=true prompt not admitted: {r2.status_code}: {(await r2.aread()).decode()[:200]}"
        )
        async for chunk in r2.aiter_bytes():
            received += chunk
            if b"<flow-" in received:
                break

    assert b"<flow-" in received, f"no flow-* frame from PTY transport: {received.decode('utf-8', 'replace')[:300]}"


def _trust_workdir_for_claude(workdir: str) -> None:
    """Record the vendor CLI's directory-trust consent for ``workdir``.

    Claude's TUI opens a blocking "1. Yes, I trust this folder" interstitial the
    first time it is launched in an unseen directory, and a prompt typed while
    that owns the screen is eaten — the turn then dies as ``user-turn-not-landed``
    long before reaching the code under test.

    This is CLI *consent* state, the same category as ``~/.claude/.credentials.json``
    (which this suite's conftest already goes out of its way to preserve) — not a
    stand-in for anything in the failure being reproduced. Everything about the
    bug itself stays real.
    """
    path = Path(os.path.expanduser("~")) / ".claude.json"
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    projects = blob.setdefault("projects", {})
    for key in {workdir, workdir.replace("/", "\\"), workdir.replace("\\", "/")}:
        entry = projects.setdefault(key, {})
        entry["hasTrustDialogAccepted"] = True
        entry["hasCompletedProjectOnboarding"] = True
        entry["projectOnboardingSeenCount"] = 2
    path.write_text(json.dumps(blob, indent=2), encoding="utf-8")


async def test_pty_prompt_streams_the_turn_tail_past_a_quiet_tool_call(hub_and_node, tmp_path):
    """A PTY-transport turn must not be truncated because its transcript went quiet.

    FLOWPAD-2034. Reproduces the reported flow: a vibe session (``pty_mode=False``)
    is switched to the terminal, which sets ``pty_mode=True`` — and returning to
    vibe never clears it, so every later vibe ``prompt()`` lands on
    ``_run_pty_prompt``'s transcript poller instead of the healthy stream-json path.

    That poller refreshes ``last_activity`` ONLY when the transcript grows, and the
    vendor CLI writes nothing to its JSONL while a tool runs or while the model
    generates. The quiet window is therefore raced against the poller's inactivity
    fallback, and everything after it is dropped — with the stream still reporting
    ``outcome="success"``.

    The quiet window is produced the same way the reported failure produced it: by
    a genuinely long GENERATION. The vendor writes an assistant message to the JSONL
    only once that message is complete, so the whole time the model is producing
    output the transcript is untouched while the PTY paints continuously. Asking for
    a long, mechanical answer makes that window reliably outlast the fallback, and —
    unlike a tool call — the model can neither background it nor decline it.
    Real PTY, real vendor CLI, real transcript, real clock; nothing is faked.

    Deliberately NOT parameterised on ``inactivity_timeout``: shortening it would
    fabricate the race, lengthening it would mask the bug. The turn genuinely takes
    longer than the suite's 30s cap (>15s of that is the mandated quiet window), so
    this test only runs under an explicitly relaxed timeout.
    """
    hub_client, local_compute_node_id = hub_and_node
    workdir = str(tmp_path)
    _trust_workdir_for_claude(workdir)
    process_id = await _create_print_mode_process(hub_client, local_compute_node_id, workdir)

    # Step 1 — the vibe turn, on the headless transport that works today.
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{process_id}/prompt",
        json={"message": 'Reply with exactly the word "ready" and nothing else.'},
    ) as r:
        assert r.status_code == 200
        await r.aread()

    # Step 2 — go to the terminal. This is the UI's own path: the footer toggle
    # calls AgenticProcess.switchMode(Interactive), which calls start(), which
    # POSTs `open` (ts_sdk/src/process/agentic-process.ts). The `switch-mode`
    # action's INTERACTIVE branch only mirrors this for non-UI callers.
    r = await hub_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
        json={"visible": True, "retry": True},
    )
    assert r.status_code == 200, f"open {r.status_code}: {r.text[:300]}"

    r = await hub_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    entity = r.json().get("data") or {}
    assert entity.get("pty_mode") is True, "precondition: the session must be on the PTY transport"

    # Step 3 — back in vibe, prompt again. Same action, now routed to the poller.
    marker = "FLOWPAD2034MARKER"
    message = (
        "Do not use any tools at all. Write out the integers from 1 to 2500, one per line, "
        "in order, with nothing else on each line. Do not abbreviate, do not skip ranges, "
        "and do not use an ellipsis — every single integer must appear. "
        f"Then, on the very last line, write exactly {marker} ."
    )
    body = b""
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{process_id}/prompt",
        json={"message": message},
    ) as r:
        assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:300]}"
        async for chunk in r.aiter_bytes():
            body += chunk

    xml = body.decode("utf-8", errors="replace")
    chats = re.findall(r"<flow-chat[^>]*>(.*?)</flow-chat>", xml, re.S)
    assert any(marker in c for c in chats), (
        "the turn tail never reached the client: the stream closed while the worker "
        f"was still working. frames={re.findall(r'<flow-([a-z-]+)', xml)} "
        f"chats={[c[:60] for c in chats]}"
    )
