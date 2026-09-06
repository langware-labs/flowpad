"""Live-session LLM matrix — every host worker runs the turn on ONE pure-direct
OpenRouter endpoint (``z-ai/glm-5.3-flash``), no hub metering, no vendor account.

``bob`` (raw HTTP, the GUEST) opens a session in a shared conversation and sends
one prompt. ``alice`` (this process, the HOST) receives it over her real hub
WebSocket bridge, which routes it through ``process_inbound_prompt``; a standing
grant pre-approves the session, and the host runs the turn on whichever CLI this
row names — claude / codex / copilot / opencode.

**Both sides are on the same direct endpoint.** The ``OPENROUTER_API_KEY`` is
stored locally and its ``api_key`` ``LLMEndpoint`` is named on the host process
itself (``ap.set_llm_endpoint``) — the resolver's hard rung, so it wins over any
device login for THIS process without re-funding anything else on the box.
Nothing here touches a native Anthropic/OpenAI/GitHub account or the hub's
metered relay — the turn's wire is ``base_url = openrouter.ai`` verbatim.

The one model differs only in how each CLI must NAME it: claude/codex/copilot take
the bare slug ``z-ai/glm-5.3-flash`` (claude via the Anthropic-skin ``ANTHROPIC_MODEL``,
which OpenRouter translates to GLM, tool use included); opencode namespaces its
slugs, so it takes ``openrouter/z-ai/glm-5.3-flash``.

Proves, per harness:
  1. naming the direct endpoint puts the SESSION worker in api-mode pointed at
     ``openrouter.ai`` on the GLM slug — a free assertion on the spawn inputs,
     before a token is spent;
  2. a REAL turn through the unified-session gate comes back with the model's
     answer IN the session, and (session rule 4) NOT as a bubble in the thread.

Gated on ``DEEP_TESTING`` (real CLIs, real tokens), a reachable local hub, a hub
login, ``OPENROUTER_API_KEY``, a second guest identity (``BOB_EMAIL``/``BOB_PW``
or the flowpad-app ``.env.local`` fallback). Skips a row when its CLI is absent.

    DEEP_TESTING=1 FLOWPAD_HUB_URL=http://localhost:8093 OPENROUTER_API_KEY=sk-or-... \
        BOB_EMAIL=bob@local.test BOB_PW=... \
        uv run pytest tests/hub_tests/test_live_session_llm_matrix.py -v

# do not increase timeout without approval
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time
import uuid

import httpx
import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.flowpad_types.enums import WorkerType
from tests.hub_tests._assignment import assert_auto_assigned
from tests.hub_tests._guest import completions, guest_login
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="needs DEEP_TESTING: real CLIs, real OpenRouter tokens",
    ),
    pytest.mark.skipif(
        not os.environ.get("OPENROUTER_API_KEY"),
        reason="OPENROUTER_API_KEY is not set; the direct endpoint would have no credential",
    ),
    pytest.mark.asyncio,
]

SLUG = "z-ai/glm-5.3-flash"

#: ``(WorkerType, cli binary, model AS THAT CLI must name the one OpenRouter slug)``.
#: One endpoint, one model; only the naming skin differs (see the module docstring).
def _worker(worker_type: WorkerType, binary: str, model: str):
    """One matrix row; a box without that CLI skips it at collection."""
    return pytest.param(
        worker_type, binary, model, id=binary,
        marks=pytest.mark.skipif(shutil.which(binary) is None, reason=f"{binary} CLI not installed"),
    )


WORKERS = [
    _worker(WorkerType.CLAUDE_CODE, "claude", SLUG),
    _worker(WorkerType.CODEX, "codex", SLUG),
    _worker(WorkerType.COPILOT, "copilot", SLUG),
    _worker(WorkerType.OPENCODE, "opencode", f"openrouter/{SLUG}"),
]

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'
EXPECTED = "pong"


async def _direct_openrouter_endpoint():
    """The LOCAL ``api_key`` endpoint for the stored OpenRouter key.

    Per-PROCESS binding, deliberately: ``ap.set_llm_endpoint(...)`` is the
    sanctioned "spend this budget" seam (ladder rung 1, hard), so it beats any
    device login for this process alone. The alternative — stamping
    ``Capability.auth_mode="api"`` — is box-wide: it re-funds every other process
    on the machine and has to be undone in teardown, and a failure before that
    teardown leaves the shared DB poisoned for later tests.
    """
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api(os.environ["OPENROUTER_API_KEY"], LMApiProvider.OPENROUTER)
    return await LLMEndpoint.ensure_for_secret(LMApiProvider.OPENROUTER.value)


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

    # ── put the host box on the pure-direct OpenRouter endpoint ────────────────
    endpoint = await _direct_openrouter_endpoint()

    # ── host: a project-mapped, shared conversation + standing grant ───────────
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

    grant = ContactPermission(
        contact_user_id=bob.user_id, project_id=None, allowed_actions=[PermissionAction.AUTO_APPROVE_SESSION.value]
    )
    await grant.save(notify=False)

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

    # (1) FREE proof it is pure-direct, before a single token is spent: the spawn
    # binding must exist (api mode, not a device login), be funded by the local
    # api_key endpoint for openrouter (not the hub relay), and carry the GLM slug.
    # Never interpolate ``auth.env`` into a message — it holds the provider key.
    assert endpoint.kind == LLMEndpointKind.API_KEY, f"{binary}: funded by {endpoint.kind}, not a direct api_key endpoint"
    assert endpoint.provider == "openrouter", f"{binary}: direct endpoint provider is {endpoint.provider!r}, not openrouter"
    auth = await resolve_worker_api_auth(ap)
    assert auth is not None, f"{binary}: api-mode did not bind — the turn would use device auth"
    assert SLUG in (auth.model_slug or ""), f"{binary}: model slug is {auth.model_slug!r}, not the GLM slug"

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
        assert session.approved_via == "standing_grant"

        print(f"\n  {binary:9s} → glm-5.3-flash direct: {answer[:60]!r}")
    finally:
        await hub.aclose()
        await asyncio.shield(safe_exit(ap))
        await hub_ws_manager.stop()
        await grant.delete()
