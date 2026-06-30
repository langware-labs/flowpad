"""ContextProcess — a process bound to a message resolves the key from its context."""
import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.graph_context import GraphContext


@pytest.mark.asyncio
async def test_message_key_resolves_into_context_summary():
    msg = await FlowMessage(id="11111111-1111-4111-8111-111111111111", text="the secret key is ABC123").save()
    gc = await GraphContext(context_typeids=[str(msg.typeid)]).save()
    ap = AgenticProcess()
    ap.set_graph_context(gc)
    # resolve_context_summary is exactly what the worker's system prompt gets at launch
    assert "ABC123" in await ap.resolve_context_summary()
