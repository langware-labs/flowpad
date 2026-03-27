"""Backward-compat shim — domain objects live in flow_sdk/builtin/ now."""

from flow_sdk.builtin.agentic_process import AgenticProcess, WorkerType
from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.agent_runner import AgentRunner as Agent

__all__ = [
    "AgenticProcess",
    "WorkerType",
    "ClaudeSession",
    "Agent",
]
