"""Inbound mail runs through the owning Agent's launch bundle."""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.agent_runner import _reuse_or_spawn_agent_process, handle_inbound
from flow_sdk.inbox.projection import channel_of, thread_key_for
from flow_sdk.responses.response import ApiFailResponse

pytestmark = pytest.mark.asyncio


async def _agent(name: str) -> Agent:
    agent = Agent(
        name=name,
        system_prompt="Answer as the formal mail agent.",
        worker_type="claude",
        model="haiku",
        permission_mode="bypassPermissions",
        email_allowed_senders=["alice@example.com"],
    )
    await agent.save()
    return agent


async def test_mail_process_uses_agent_deployment_bundle_and_is_reused(mail_db, tmp_path):
    agent = await _agent(f"mail-runtime-{mint_uuid()[:8]}")
    conversation_id = mint_uuid()

    first = await _reuse_or_spawn_agent_process(agent, conversation_id, str(tmp_path))
    second = await _reuse_or_spawn_agent_process(agent, conversation_id, str(tmp_path))

    assert second.id == first.id
    assert first.target_typeid_str == f"conversation-{conversation_id}"
    assert first.deployment_id
    assert first.workdir == str(tmp_path)
    assert first.visible is False
    assert first.pty_mode is False
    assert first.context_data["instructions"].startswith(agent.system_prompt)
    assert first.cli_config == agent.to_agent_options().to_json()
    assert len(await AgenticProcess.get_all({"deployment_id": first.deployment_id})) == 1


async def test_prompt_refusal_is_checked_before_reply_capture(mail_db, monkeypatch):
    agent = await _agent(f"mail-prompt-fail-{mint_uuid()[:8]}")
    source = DataSource(
        name="Agent inbox",
        provider="cloud_email",
        channel="email",
        config={"agent_id": agent.id, "address": "ada@agentmail.to"},
        account_key="ada@agentmail.to",
        account_identities=["ada@agentmail.to"],
    )
    await source.save()
    item = SourceItem(
        data_source_id=source.id,
        provider="cloud_email",
        segment_key=agent.id,
        external_id=f"<{mint_uuid()}@example.com>",
        name="Question",
        body="Can you answer this?",
        author_external_id="alice@example.com",
        thread_key=f"{agent.id}:thread-1",
    )
    conversation_id = mint_uuid()
    thread = MessageThread(
        channel=channel_of(source),
        thread_key=thread_key_for(item, item.name or ""),
        conversation_id=conversation_id,
        title=item.name,
        name=item.name,
    )
    await thread.save()

    async def refuse_prompt(self, instruction):
        return ApiFailResponse(message="turn already running", status_code=409)

    async def must_not_capture(process):
        raise AssertionError("reply capture ran after prompt refusal")

    monkeypatch.setattr(AgenticProcess, "prompt", refuse_prompt)
    monkeypatch.setattr(
        "flow_sdk.app.actions.execute_prompt._capture_assistant_reply",
        must_not_capture,
    )

    assert await handle_inbound(item) is False
