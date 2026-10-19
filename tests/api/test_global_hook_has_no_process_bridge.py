"""The global hook tier must never resolve an AgenticProcess.

Global hooks live in the harness settings and fire for *everything*; process-local
hooks are configured per process and delivered only to it (``handle_process_agent_hook``).
The two tiers used to be welded together by an id bridge: ``handle_agent_hook``
resolved ``FLOWPAD_EXECUTION_SCOPE`` / ``session_id`` into an ``AgenticProcess`` and
then did process-scoped work (prompt annotations, ExitPlanMode auto-approve,
ExitWorktree tab close, per-process FlowData fan-out).

That bridge is gone. These tests pin it gone, because re-adding "just one lookup"
is exactly how the tiers grew together the first time.
"""

import inspect
from unittest.mock import patch

import pytest

from flow_sdk.app.actions import listen as listen_module
from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.annotation import Annotation
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus

pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


def _code_only(source: str) -> str:
    """Strip comments and docstring so the guard reads code, not prose.

    The handler's own comments explain *why* there is no process lookup, and
    would otherwise trip the assertions below.
    """
    lines = []
    in_docstring = False
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith('"""') or stripped.endswith('"""'):
            if stripped.count('"""') == 1:
                in_docstring = not in_docstring
            continue
        if in_docstring or stripped.startswith("#"):
            continue
        lines.append(line.split("  # ")[0])
    return "\n".join(lines)


def test_handle_agent_hook_source_has_no_agentic_process_lookup():
    """Static guard: the global handler's body names no process lookup."""
    source = _code_only(inspect.getsource(listen_module.handle_agent_hook))

    for forbidden in (
        "AgenticProcess",
        "get_by_session_id",
        "_extract_agentic_process_id",
        "execution_scope",
    ):
        assert forbidden not in source, (
            f"handle_agent_hook references {forbidden!r} — the global tier must not "
            "resolve the process that fired the hook. Process-scoped delivery belongs "
            "in handle_process_agent_hook."
        )


def test_removed_process_bridge_helpers_are_gone():
    """The helpers that implemented the bridge must not come back."""
    for removed in (
        "_extract_agentic_process_id",
        "_create_prompt_annotation",
        "_close_worktree_process",
        "set_plan_auto_approve",
    ):
        assert not hasattr(listen_module, removed), (
            f"{removed} is back in listen.py — it was deleted with the hook-glued features."
        )


def test_route_to_source_process_takes_only_execution_scope():
    """``_route_to_source_process`` serves hook_op only — no session_id routing."""
    params = inspect.signature(listen_module._route_to_source_process).parameters
    assert "session_id" not in params, (
        "session_id routing is back — that was the agent_hook → process bridge. "
        "hook_op carries execution_scope and does not need it."
    )
    assert "execution_scope" in params


@pytest.mark.asyncio
async def test_user_prompt_submit_global_hook_creates_no_annotation(bootstrapped_client, user):
    """A global UserPromptSubmit hook is harness-wide: it writes no per-process state."""
    client = bootstrapped_client

    hook = AgentHook(
        name="test_global_hook_no_annotation",
        description="AgentHook for the no-process-bridge guard",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await hook.save(user.typeid)

    before = len(await Annotation.get_all() or [])

    payload = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": hook.id,
            "hook_data": {
                "hook_event_name": "UserPromptSubmit",
                "prompt": "Hello, world!",
                "session_id": "session-that-must-not-be-resolved",
            },
        },
    }
    response = await client.post("/api/v1/webhook/listen", json=payload)
    assert response.status_code == 200, f"Listen action failed: {response.text}"
    assert ApiResponse(**response.json()).status == ApiResponseStatus.SUCCESS.value

    after = await Annotation.get_all() or []
    assert len(after) == before, (
        "A global UserPromptSubmit hook created an Annotation. Prompt anchors are a "
        "process-local concern and must come from the process hook tier."
    )

    await hook.delete()


@pytest.mark.asyncio
async def test_no_flow_data_reaches_the_process_that_fired_the_hook(bootstrapped_client, user):
    """Even when ``session_id`` matches a real process, nothing is fanned out to it.

    This replaces ``test_agent_hook_per_process_fanout.py``, which asserted the
    opposite for the matching-session case. The global hook still reaches the
    ``AgentHook``'s own stream (the sniffer/events panel depends on that) — it just
    never reaches the process.
    """
    client = bootstrapped_client

    session_id = "test-no-bridge-session-12345"
    process = AgenticProcess(name="no-bridge-test", session_id=session_id)
    await process.save(user.typeid)

    hook = AgentHook(
        name="test_global_hook_no_fanout",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="PreToolUse",
        enabled=True,
    )
    await hook.save(user.typeid)

    captured: list[tuple[object, dict]] = []

    async def fake_send(typeid, payload):
        captured.append((typeid, payload))

    payload = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": hook.id,
            "hook_data": {
                "hook_event_name": "PreToolUse",
                "session_id": session_id,
                "tool_name": "Read",
            },
        },
    }

    with patch(
        "flow_sdk.core.network.resource_tracker.send_flow_data_to_entity",
        side_effect=fake_send,
    ):
        response = await client.post("/api/v1/webhook/listen", json=payload)

    assert response.status_code == 200, response.text

    target_types = {tid.type for tid, _ in captured}
    assert AgentHook.get_type() in target_types, (
        "The global AgentHook ingest regressed — the sniffer/events panel needs it."
    )
    assert AgenticProcess.get_type() not in target_types, (
        "FlowData was fanned out to the process whose session fired the hook. "
        "That is the global→local bridge; it must stay removed."
    )

    await hook.delete()
    await process.delete()
