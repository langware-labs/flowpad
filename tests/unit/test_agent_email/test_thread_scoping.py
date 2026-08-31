"""A thread id from the provider is inbox-scoped. Ours must be too.

The hub's own notes are explicit: AgentMail's `thread_id` is scoped to the
mailbox it came from — "never use it as a cross-agent key". The inbox
projection resolves a MessageThread by `(channel, thread_key)` alone, and
every cloud mailbox reports the same channel, so a bare provider id would let
two agents collapse onto one thread.

That is cosmetic today and load-bearing the moment a thread maps to an agent
process: it would be one agent answering in another agent's conversation, with
the first agent's context.
"""
from __future__ import annotations

import pytest

from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval


class _Source:
    """The two config keys the driver reads. Not a DataSource — this is about
    key derivation, and a real row would only add a database to the test."""

    def __init__(self, agent_id: str):
        self.config = {"agent_id": agent_id, "address": f"{agent_id}@agentmail.to"}
        self.channel = "email"
        self.provider = "cloud_email"


def _key(agent_id: str, thread_id: str):
    return CloudEmailDriver._thread_key(_Source(agent_id), {"thread_id": thread_id})


def test_two_agents_sharing_a_provider_thread_id_do_not_collide():
    """The whole point. Same provider id, different mailboxes, different threads."""
    assert _key("agent-a", "thr_1") != _key("agent-b", "thr_1")


def test_one_agent_keeps_one_thread_stable():
    """Scoping must not cost continuity: the same mailbox and the same provider
    thread have to keep answering to the same key, or every reply starts a new
    conversation."""
    assert _key("agent-a", "thr_1") == _key("agent-a", "thr_1")


def test_no_provider_thread_falls_back_rather_than_threading_on_a_bare_prefix():
    """Returning `"<agent>:"` for every unthreaded message would put every
    stranger in one conversation — strictly worse than the subject fallback the
    projection already has."""
    assert _key("agent-a", "") is None
