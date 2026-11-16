"""Live-session LLM matrix — every host worker runs the turn on ONE hub endpoint:
the host's own allowance on the LOCAL hub, funded by the hub's Vertex root.

``bob`` (raw HTTP, the GUEST) opens a session in a shared conversation and sends
one prompt. ``alice`` (this process, the HOST) receives it over her real hub
WebSocket bridge, which routes it through ``process_inbound_prompt``; the host
approves the session, and runs the turn on whichever CLI this
row names — claude / codex / copilot / opencode.

**The host process spends one named budget.** Alice's default allowance (minted
by the hub's bootstrap, drawn on its Vertex-funded root) is named on the host
process itself (``ap.set_llm_endpoint``) — the resolver's hard rung, so it wins
over any device login for THIS process without re-funding anything else on the
box. No provider key is read or stored on this box, and nothing here touches a
native Anthropic/OpenAI/GitHub account.

The one model is the endpoint's ``sm`` size: each CLI asks for ``sm`` and the
binding names it the way that CLI must (opencode namespaces its slugs).

Proves, per harness:
  1. naming the hub endpoint puts the SESSION worker in api-mode pointed at THAT
     endpoint on its ``sm`` slug — a free assertion on the spawn inputs, before a
     token is spent;
  2. a REAL turn through the unified-session gate comes back with the model's
     answer IN the session, and (session rule 4) NOT as a bubble in the thread.

Gated on ``DEEP_TESTING`` (real CLIs, real tokens), a reachable local hub, a hub
login, a second guest identity (``BOB_EMAIL``/``BOB_PW`` or the flowpad-app
``.env.local`` fallback). Skips a row when its CLI is absent.

    DEEP_TESTING=1 FLOWPAD_HUB_URL=http://localhost:8495 \
        BOB_EMAIL=bob@local.test BOB_PW=... \
        uv run pytest tests/hub_tests/test_live_session_llm_matrix.py --long -v

# do not increase timeout without approval
"""
from __future__ import annotations

import asyncio
import shutil
import time
import uuid

import httpx
import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.flowpad_types.enums import WorkerType
from tests.hub_tests._assignment import assert_auto_assigned
from tests.hub_tests._guest import completions, guest_login, host_approves
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="needs DEEP_TESTING: real CLIs, real tokens",
    ),
    pytest.mark.asyncio,
]

SIZE = "sm"

#: ``(WorkerType, cli binary, model the process asks for)``. One endpoint, one size: the
#: binding turns ``sm`` into the endpoint's slug in each CLI's own spelling.
def _worker(worker_type: WorkerType, binary: str, model: str):
    """One matrix row; a box without that CLI skips it at collection."""
    return pytest.param(
        worker_type, binary, model, id=binary,
        marks=pytest.mark.skipif(shutil.which(binary) is None, reason=f"{binary} CLI not installed"),
    )


WORKERS = [
    _worker(WorkerType.CLAUDE_CODE, "claude", SIZE),
    _worker(WorkerType.CODEX, "codex", SIZE),
    _worker(WorkerType.COPILOT, "copilot", SIZE),
    _worker(WorkerType.OPENCODE, "opencode", SIZE),
]

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'
EXPECTED = "pong"


async def _hosts_hub_allowance(email: str):
    """The host's own default allowance on the hub (its root: the hub's Vertex funding).

    Per-PROCESS binding, deliberately: ``ap.set_llm_endpoint(...)`` is the
    sanctioned "spend this budget" seam (ladder rung 1, hard), so it beats any
    device login for this process alone. The alternative — stamping
    ``Capability.auth_mode="api"`` — is box-wide: it re-funds every other process
    on the machine and has to be undone in teardown, and a failure before that
    teardown leaves the shared DB poisoned for later tests.
    """
    from flow_sdk.cloud_client.hub_proxy import HubProxy
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints

    await HubProxy.try_call("GET", "bootstrap")  # mints the default allowance on first contact
    endpoints = await fetch_hub_llm_endpoints()
    own = [e for e in endpoints if (e.name or "") == f"{email} default"]
    if not own:
        pytest.skip(f"the local hub offered the host no default allowance (it lists {len(endpoints)} endpoint(s))")
    return own[0]


@pytest.mark.timeout(600)  # real CLI + real network; do not increase without approval
@pytest.mark.parametrize("worker_type, binary, model", WORKERS)
async def test_session_turn_runs_direct_on_glm(
    hub_base_url,
    hub_login_payload,
    isolated_hub_keyring,
    tmp_path,
    worker_type,
    binary,
    model,
) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
    from flow_sdk.cloud_client.ws_client import hub_ws_manager
    from tests.hub_tests._local_login import login_as
    from tests.long_tests._transcript_helpers import safe_exit

    login_as(hub_login_payload)  # alice = HOST (this process)
    hub = httpx.AsyncClient(timeout=10.0)
    bob = await guest_login(hub_base_url, hub)

    # ── the budget the host process spends: alice's hub allowance ─────────────
    endpoint = await _hosts_hub_allowance(hub_login_payload["user"]["email"])

    # ── host: a project-mapped, shared conversation ───────────
    host_root = tmp_path / "host-project"
    host_root.mkdir()
    project = Project(name=f"llm-matrix-{binary}", fs_storage_mount_path=str(host_root))
    await project.save(notify=False)
    conv = Conversation(
        title=f"llm-matrix-{binary}-{int(time.time())}-{uuid.uuid4().hex[:6]}",
        project_id=project.id,
    )
    await conv.share(recipients=[bob.email])
    assert conv.remote is True
    await conv.save(notify=False)
    await assert_auto_assigned(
        hub_base_url, bob.token, entity_type="conversation", entity_id=conv.id, user_id=bob.user_id, expected_role="member"
    )
    # Alice joined inside ``conv.share()``; only the guest still needs to.
    r = await hub.post(f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join", headers=bob.headers, json={})
    assert r.status_code < 300, r.text


    # ── pre-seed the host worker so the session turn REUSES this exact one ──────
    # ``_reuse_or_spawn_headless`` picks the most-recent non-failed AP for the
    # conversation target, so seeding one here pins BOTH the worker type and the
    # model the turn will run — an AUTO spawn would pick whatever the box defaults
    # to. Headless (``visible=False, pty_mode=False``) is the session-turn shape.
    ap = await AgenticProcess(
        worker_type=worker_type,
        workdir=str(host_root),
        target_typeid_str=f"conversation-{conv.id}",
        cli_config={"model": model},
        visible=False,
        pty_mode=False,
    ).save()
    # THE interface: name the budget this process spends. Nothing box-wide is
    # touched, so no other process on this machine is re-funded by the test.
    await ap.set_llm_endpoint(endpoint)

    # (1) FREE proof of the funding, before a single token is spent: the spawn
    # binding must exist (api mode, not a device login), point at THIS hub endpoint,
    # and carry the endpoint's ``sm`` slug.
    # Never interpolate ``auth.env`` into a message — it holds the hub token.
    assert endpoint.kind == LLMEndpointKind.HUB, f"{binary}: funded by {endpoint.kind}, not a hub endpoint"
    sized = (endpoint.tiers or {}).get(SIZE)
    assert sized, f"{binary}: the hub endpoint reports no {SIZE!r} model ({endpoint.tiers!r})"
    auth = await resolve_worker_api_auth(ap)
    assert auth is not None, f"{binary}: api-mode did not bind — the turn would use device auth"
    assert (auth.model_slug or "").endswith(sized), f"{binary}: model slug is {auth.model_slug!r}, not {sized!r}"
    # The RESOLVED binding, not the endpoint handed in: a pin the resolver misread
    # would spawn against some other budget.
    wired = repr((auth.env, auth.config_overrides, auth.provider_options))
    assert endpoint.invoke_path() in wired, f"{binary}: the spawn binding does not point at the host's hub endpoint"

    # ── guest opens the session and sends ONE prompt ───────────────────────────
    hub_ws_bridge.install()
    status = await hub_ws_manager.restart(wait_connected=True)
    assert status.get("hub_ws_connected") is True, status

    session_id = str(uuid.uuid4())
    try:
        r = await hub.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/add_message",
            headers=bob.headers,
            json={
                "text": PROMPT,
                "remote_worker_session_id": session_id,
                "attachment": [{"attachment_type": AttachmentType.PROMPT.value, "data": PROMPT}],
            },
        )
        assert r.status_code < 300, r.text
        await host_approves(session_id, within=30.0)

        # (2) REAL turn: wait for the completion to land in the session.
        deadline = time.monotonic() + 300.0
        reply: FlowMessage | None = None
        while time.monotonic() < deadline:
            done = completions(
                await FlowMessage.get_all({"conversation_id": conv.id, "remote_worker_session_id": session_id})
            )
            if done:
                reply = done[0]
                break
            await asyncio.sleep(2.0)
        if reply is None:
            # Say WHY nothing landed: a silent "no reply" is unactionable, and the
            # three states that produce it (worker never finished, worker finished
            # but the turn errored, turn fine but nothing was written back) are only
            # distinguishable from the process + session rows and the transcript.
            fresh = await AgenticProcess.get_by_id(ap.id)
            session_row = await RemoteWorkerSession.get_one({"id": session_id})
            history = ""
            try:
                history = str(fresh.driver.load_history(fresh))[-800:] if fresh else ""
            except Exception as exc:  # noqa: BLE001
                history = f"<load_history raised: {exc}>"
            raise AssertionError(
                f"{binary}: no reply landed in the session.\n"
                f"  process.status = {getattr(fresh, 'status', None)!r}\n"
                f"  worker_status  = {fresh.fetch_worker_status() if fresh else None!r}\n"
                f"  session.status = {getattr(session_row, 'status', None)!r}\n"
                f"  host_process   = {getattr(session_row, 'host_process_id', None)!r} (seeded {ap.id})\n"
                f"  transcript tail= {history}"
            )

        answer = (reply.text or "").lower()
        assert EXPECTED in answer, f"{binary}: session reply did not carry the model's answer: {answer[:400]!r}"

        # Session rule 4: the reply lives in the session, never as a thread bubble.
        thread = await FlowMessage.get_all({"conversation_id": conv.id})
        thread_replies = [m for m in completions(thread) if not m.remote_worker_session_id]
        assert not thread_replies, f"{binary}: a completion leaked into the main thread"

        # The session actually ran on the worker we pinned, once.
        procs, session = await asyncio.gather(
            AgenticProcess.get_all({"target_typeid_str": f"conversation-{conv.id}"}),
            RemoteWorkerSession.get_one({"id": session_id}),
        )
        assert len(procs) == 1, f"{binary}: expected ONE host process, got {len(procs)}"
        assert session is not None and session.host_process_id == procs[0].id
        assert session.approved_via == "manual"

        print(f"\n  {binary:9s} → {sized} via the hub: {answer[:60]!r}")
    finally:
        await hub.aclose()
        await asyncio.shield(safe_exit(ap))
        await hub_ws_manager.stop()
